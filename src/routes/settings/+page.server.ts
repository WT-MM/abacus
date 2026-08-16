import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/server/db.ts';
import { credentialsFor } from '$lib/server/auth/webauthn.ts';
import { invalidateCategoryCache } from '$lib/server/categorize.ts';
import { config, plaidConfigured } from '$lib/server/config.ts';

export const load: PageServerLoad = async ({ locals }) => {
	const owner = locals.auth.login ?? '';
	return {
		passkeys: credentialsFor(owner).map((c) => ({
			id: c.id,
			deviceName: c.device_name,
			createdAt: c.created_at,
			lastUsedAt: c.last_used_at
		})),
		rules: db()
			.prepare(
				`SELECT r.id, r.pattern, r.priority, c.name AS category_name
				   FROM rules r JOIN categories c ON c.id = r.category_id
				  ORDER BY r.priority DESC, r.id`
			)
			.all(),
		categories: db().prepare('SELECT id, name, kind, grp FROM categories ORDER BY sort, id').all(),
		environment: {
			plaidReady: plaidConfigured(),
			plaidEnv: config.plaid.env,
			origin: config.origin,
			owners: config.owners,
			dbPath: config.dbPath
		},
		counts: db()
			.prepare(
				`SELECT (SELECT COUNT(*) FROM transactions) AS transactions,
				        (SELECT COUNT(*) FROM accounts) AS accounts,
				        (SELECT COUNT(*) FROM holdings) AS holdings`
			)
			.get() as { transactions: number; accounts: number; holdings: number }
	};
};

export const actions: Actions = {
	addCategory: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const kind = String(form.get('kind') ?? 'expense');
		const grp = String(form.get('grp') ?? '').trim() || null;

		if (!name) return fail(400, { message: 'Name the category' });
		if (!['income', 'expense', 'transfer'].includes(kind)) return fail(400, { message: 'Unknown kind' });

		const { max } = db().prepare('SELECT IFNULL(MAX(sort), 0) AS max FROM categories').get() as { max: number };
		try {
			db()
				.prepare('INSERT INTO categories (name, kind, grp, sort) VALUES (?, ?, ?, ?)')
				.run(name, kind, grp, max + 1);
		} catch {
			return fail(409, { message: `There is already a category called ${name}` });
		}

		// Row numbers in the budget sheet shift when categories change; the cache
		// that maps names to ids must not outlive that.
		invalidateCategoryCache();
		return { ok: true };
	},

	deleteRule: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { message: 'Bad request' });
		db().prepare('DELETE FROM rules WHERE id = ?').run(id);
		return { ok: true };
	},

	deletePasskey: async ({ request, locals }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const owner = locals.auth.login ?? '';

		// Removing the last passkey would lock the owner out entirely.
		if (credentialsFor(owner).length <= 1) {
			return fail(409, { message: 'Register a second passkey before removing this one' });
		}

		db().prepare('DELETE FROM credentials WHERE id = ? AND owner = ?').run(id, owner);
		return { ok: true };
	}
};
