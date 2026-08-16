import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db.ts';
import { stalenessDays } from '$lib/server/sync.ts';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.auth.verified) {
		return { auth: locals.auth, health: { needsRepair: [], staleDays: null, itemCount: 0 } };
	}

	const needsRepair = db()
		.prepare(`SELECT id, institution_name FROM items WHERE status <> 'ok' ORDER BY id`)
		.all() as Array<{ id: number; institution_name: string }>;

	const { n } = db().prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };

	return {
		auth: locals.auth,
		health: { needsRepair, staleDays: stalenessDays(), itemCount: n }
	};
};
