import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/server/db.ts';

const PAGE_SIZE = 100;

type TransactionRow = {
	id: number;
	posted_on: string;
	amount_cents: number;
	description: string;
	merchant: string | null;
	pending: number;
	category_id: number | null;
	category_locked: number;
	source: string;
	account_name: string;
	category_name: string | null;
};

type CategoryRow = { id: number; name: string; kind: string };
type AccountRow = { id: number; name: string; institution_name: string | null };

export const load: PageServerLoad = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	const categoryId = url.searchParams.get('category');
	const accountId = url.searchParams.get('account');
	const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);

	const where: string[] = [];
	const args: Array<string | number> = [];

	if (q) {
		where.push('(t.description LIKE ? OR t.merchant LIKE ?)');
		args.push(`%${q}%`, `%${q}%`);
	}
	if (categoryId === 'none') {
		where.push('t.category_id IS NULL');
	} else if (categoryId) {
		where.push('t.category_id = ?');
		args.push(Number(categoryId));
	}
	if (accountId) {
		where.push('t.account_id = ?');
		args.push(Number(accountId));
	}

	// Lets a budget row link straight to the transactions behind its Actual
	// figure, which is otherwise a number with no way to check it.
	const month = url.searchParams.get('month');
	if (month && /^\d{4}-\d{2}$/.test(month)) {
		where.push('substr(t.posted_on, 1, 7) = ?');
		args.push(month);
	}

	const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

	const rows = db()
		.prepare(
			`SELECT t.id, t.posted_on, t.amount_cents, t.description, t.merchant, t.pending,
			        t.category_id, t.category_locked, t.source,
			        a.name AS account_name, c.name AS category_name
			   FROM transactions t
			   JOIN accounts a ON a.id = t.account_id
			   LEFT JOIN categories c ON c.id = t.category_id
			   ${clause}
			  ORDER BY t.posted_on DESC, t.id DESC
			  LIMIT ? OFFSET ?`
		)
		.all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE) as TransactionRow[];

	const { n } = db()
		.prepare(`SELECT COUNT(*) AS n FROM transactions t ${clause}`)
		.get(...args) as { n: number };

	return {
		rows,
		total: n,
		page,
		pageSize: PAGE_SIZE,
		filters: {
			q,
			categoryId: categoryId ?? '',
			accountId: accountId ?? '',
			month: month && /^\d{4}-\d{2}$/.test(month) ? month : ''
		},
		// The sum of everything matching, not just this page — otherwise drilling
		// into a budget row shows rows that cannot be reconciled against it.
		matchedCents: (
			db()
				.prepare(`SELECT IFNULL(SUM(t.amount_cents), 0) AS total FROM transactions t ${clause}`)
				.get(...args) as { total: number }
		).total,
		categories: db()
			.prepare(`SELECT id, name, kind FROM categories WHERE archived = 0 ORDER BY sort, id`)
			.all() as CategoryRow[],
		accounts: db()
			.prepare('SELECT id, name, institution_name FROM accounts ORDER BY name')
			.all() as AccountRow[]
	};
};

export const actions: Actions = {
	categorise: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		const raw = String(form.get('categoryId') ?? '');
		const categoryId = raw === '' ? null : Number(raw);

		if (!Number.isInteger(id)) return fail(400, { message: 'Bad request' });
		if (categoryId !== null && !Number.isInteger(categoryId)) return fail(400, { message: 'Bad request' });

		// Locking it stops the next sync from reverting the choice to Plaid's guess.
		db()
			.prepare('UPDATE transactions SET category_id = ?, category_locked = 1 WHERE id = ?')
			.run(categoryId, id);
		return { ok: true };
	},

	addRule: async ({ request }) => {
		const form = await request.formData();
		const pattern = String(form.get('pattern') ?? '').trim();
		const categoryId = Number(form.get('categoryId'));
		if (!pattern || !Number.isInteger(categoryId)) return fail(400, { message: 'Bad request' });

		db().prepare('INSERT INTO rules (pattern, category_id, priority) VALUES (?, ?, 10)').run(pattern, categoryId);

		// Apply immediately to anything not hand-categorised.
		const { changes } = db()
			.prepare(
				`UPDATE transactions SET category_id = ?
				  WHERE category_locked = 0
				    AND (LOWER(description) LIKE ? OR LOWER(IFNULL(merchant,'')) LIKE ?)`
			)
			.run(categoryId, `%${pattern.toLowerCase()}%`, `%${pattern.toLowerCase()}%`);

		return { ok: true, applied: Number(changes) };
	}
};
