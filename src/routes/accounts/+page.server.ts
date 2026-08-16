import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/server/db.ts';
import { liveAccounts } from '$lib/server/networth.ts';
import { plaidConfigured } from '$lib/server/config.ts';
import { parseStatement, importRows } from '$lib/server/importers/index.ts';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export const load: PageServerLoad = async () => {
	const items = db()
		.prepare(
			`SELECT id, institution_name, status, error_code, error_message,
			        last_synced_at, consent_expires_at
			   FROM items ORDER BY institution_name`
		)
		.all() as Array<{
		id: number;
		institution_name: string;
		status: string;
		error_code: string | null;
		error_message: string | null;
		last_synced_at: string | null;
		consent_expires_at: string | null;
	}>;

	const accounts = liveAccounts();
	const lastRun = db()
		.prepare('SELECT started_at, finished_at, status FROM sync_runs ORDER BY id DESC LIMIT 1')
		.get() as { started_at: string; finished_at: string | null; status: string } | undefined;

	return {
		items,
		accounts,
		lastRun: lastRun ?? null,
		plaidReady: plaidConfigured(),
		// Trial Item slots are consumed permanently, so the count that matters is
		// how many have ever been created, not how many are live.
		itemsUsed: items.length
	};
};

export const actions: Actions = {
	import: async ({ request }) => {
		const form = await request.formData();
		const file = form.get('file');
		const accountId = Number(form.get('accountId'));

		if (!(file instanceof File) || !file.size) return fail(400, { message: 'Choose a file to import' });
		if (file.size > MAX_UPLOAD_BYTES) return fail(413, { message: 'That file is larger than 8 MB' });
		if (!Number.isInteger(accountId)) return fail(400, { message: 'Choose an account' });

		const exists = db().prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId);
		if (!exists) return fail(404, { message: 'No such account' });

		try {
			const preview = parseStatement(await file.text(), file.name);
			const result = importRows(accountId, preview.rows);
			return {
				imported: {
					...result,
					unreadable: preview.skipped,
					institution: preview.institution,
					format: preview.format
				}
			};
		} catch (err) {
			return fail(422, { message: err instanceof Error ? err.message : 'Could not read that file' });
		}
	},

	addManual: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const type = String(form.get('type') ?? 'depository');

		if (!name) return fail(400, { message: 'Give the account a name' });
		if (!['depository', 'credit', 'investment', 'loan', 'other'].includes(type)) {
			return fail(400, { message: 'Unknown account type' });
		}

		db()
			.prepare(
				`INSERT INTO accounts (source, name, type, institution_name, current_cents)
				 VALUES ('import', ?, ?, 'Manual', 0)`
			)
			.run(name, type);

		return { ok: true };
	},

	toggleHidden: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { message: 'Bad request' });
		db().prepare('UPDATE accounts SET hidden = 1 - hidden WHERE id = ?').run(id);
		return { ok: true };
	}
};
