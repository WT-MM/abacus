import { json, error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db.ts';
import { config, plaidConfigured } from '$lib/server/config.ts';
import * as plaid from '$lib/server/plaid.ts';
import { accessTokenOf, storeAccessToken, type ItemRow } from '$lib/server/sync.ts';

const REDIRECT_URI = () => `${config.origin}/link/oauth`;

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.auth.verified) throw error(404, 'Not found');
	if (!plaidConfigured()) throw error(400, 'Plaid is not configured yet — add credentials in Settings.');

	const body = await request.json().catch(() => ({}));

	switch (params.action) {
		case 'token': {
			// Repairing an existing Item MUST go through update mode. Linking it
			// afresh would consume another of the ten lifetime Trial Item slots,
			// which are never returned even if the old Item is deleted.
			let accessToken: string | undefined;
			if (body.itemId) {
				const item = db().prepare('SELECT * FROM items WHERE id = ?').get(Number(body.itemId)) as
					| ItemRow
					| undefined;
				if (!item) throw error(404, 'No such connection');
				accessToken = accessTokenOf(item);
			}

			const token = await plaid.createLinkToken({
				userId: locals.auth.login ?? 'owner',
				accessToken,
				redirectUri: REDIRECT_URI()
			});
			return json({ linkToken: token.link_token });
		}

		case 'exchange': {
			if (!body.publicToken) throw error(400, 'Missing public token');
			const { access_token, item_id } = await plaid.exchangePublicToken(body.publicToken);

			const status = await plaid.getItem(access_token);
			const institutionId = status.item.institution_id;
			let name = 'Linked institution';
			if (institutionId) {
				try {
					name = (await plaid.getInstitution(institutionId)).institution.name;
				} catch {
					// A missing display name must not abort an otherwise good link.
				}
			}

			db()
				.prepare(
					`INSERT INTO items (plaid_item_id, institution_id, institution_name, access_token_ct)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(plaid_item_id) DO UPDATE SET
					   access_token_ct = excluded.access_token_ct,
					   status = 'ok', error_code = NULL, error_message = NULL`
				)
				.run(item_id, institutionId, name, storeAccessToken(access_token));

			return json({ ok: true, institution: name });
		}

		default:
			throw error(404, 'Not found');
	}
};
