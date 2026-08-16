import { createHmac } from 'node:crypto';
import { json, error, isHttpError, type RequestHandler } from '@sveltejs/kit';
import { db, getMeta } from '$lib/server/db.ts';
import { config, plaidConfigured } from '$lib/server/config.ts';
import { assertEncryptionKeyUsable, randomToken, redact } from '$lib/server/crypto.ts';
import * as plaid from '$lib/server/plaid.ts';
import { PlaidError } from '$lib/server/plaid.ts';
import {
	accessTokenOf,
	storeAccessToken,
	UNNAMED_INSTITUTION,
	type ItemRow
} from '$lib/server/sync.ts';

const REDIRECT_URI = () => `${config.origin}/link/oauth`;

/**
 * A stable, non-identifying `client_user_id` for Plaid.
 *
 * Plaid rejects values carrying PII, and the login this app authenticates with
 * is a Tailscale identity — always an email address — so passing it straight
 * through fails every link attempt.
 *
 * Keyed with a persisted random salt rather than a bare digest: an email is
 * low-entropy, so plain sha256(login) is recoverable from a dictionary in
 * seconds and is pseudonymous at best. The salt lives in the database so the
 * value stays stable for the same owner across Link sessions, which Plaid
 * requires — it ties returning-user behaviour to this id.
 */
function clientUserId(login: string): string {
	let salt = getMeta('plaid.user_salt');
	if (!salt) {
		// INSERT OR IGNORE rather than setMeta: the salt must be first-write-wins.
		// setMeta overwrites, so two concurrent first links would each generate a
		// salt and the loser's client_user_id would silently change.
		db()
			.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
			.run('plaid.user_salt', randomToken(16));
		salt = getMeta('plaid.user_salt') as string;
	}
	return createHmac('sha256', salt).update(login).digest('hex').slice(0, 32);
}

function itemById(id: unknown): ItemRow {
	const item = db().prepare('SELECT * FROM items WHERE id = ?').get(Number(id)) as ItemRow | undefined;
	if (!item) throw error(404, 'No such connection');
	return item;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.auth.verified) throw error(404, 'Not found');
	if (!plaidConfigured()) throw error(400, 'Plaid is not configured yet — add credentials in Settings.');

	const body = await request.json().catch(() => ({}));

	try {
		switch (params.action) {
			case 'token': {
				// Repairing an existing Item MUST go through update mode. Linking it
				// afresh would consume another of the ten lifetime Trial Item slots,
				// which are never returned even if the old Item is deleted.
				const accessToken = body.itemId ? accessTokenOf(itemById(body.itemId)) : undefined;

				const token = await plaid.createLinkToken({
					userId: clientUserId(locals.auth.login ?? 'owner'),
					accessToken,
					redirectUri: REDIRECT_URI()
				});
				return json({ linkToken: token.link_token });
			}

			case 'exchange': {
				if (!body.publicToken) throw error(400, 'Missing public token');

				// Plaid reports the chosen institution in the Link callback, before
				// any Item exists. Refusing a duplicate here is the only chance to
				// avoid it: the exchange below creates the Item and spends one of ten
				// lifetime slots, and re-linking an institution that is merely broken
				// is the most likely way to waste one.
				const institutionId: string | null = body.institutionId ?? null;
				if (institutionId) {
					const existing = db()
						.prepare('SELECT institution_name FROM items WHERE institution_id = ?')
						.get(institutionId) as { institution_name: string } | undefined;
					if (existing) {
						throw error(
							409,
							`${existing.institution_name} is already connected. Use Reconnect on it instead — ` +
								`linking it again would permanently consume one of your ten Plaid slots.`
						);
					}
				}

				// Checked before the exchange, not after. Exchanging is what consumes
				// a lifetime Item slot; discovering an unusable key afterwards would
				// spend the slot and strand a token that cannot be re-obtained.
				assertEncryptionKeyUsable();

				const { access_token, item_id } = await plaid.exchangePublicToken(body.publicToken);

				// The slot is spent from here on. Persist immediately — nothing
				// fallible may sit between the exchange and this write, or a
				// transient fault costs a slot with no record and no recovery path.
				const ciphertext = storeAccessToken(access_token);
				db()
					.prepare(
						`INSERT INTO items (plaid_item_id, institution_id, institution_name, access_token_ct)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT(plaid_item_id) DO UPDATE SET
						   access_token_ct = excluded.access_token_ct,
						   status = 'ok', error_code = NULL, error_message = NULL`
					)
					// The id from the Link callback is recorded now rather than during
					// enrichment, so the duplicate check above still works for this
					// institution even if every enrichment call fails.
					.run(item_id, institutionId, UNNAMED_INSTITUTION, ciphertext);

				// Everything below is enrichment. The connection already works
				// without it, and the next sync fills in whatever failed here.
				let name: string = UNNAMED_INSTITUTION;
				try {
					const status = await plaid.getItem(access_token);
					const institutionId = status.item.institution_id;
					if (institutionId) {
						try {
							name = (await plaid.getInstitution(institutionId)).institution.name;
						} catch {
							// A missing display name must not downgrade a good link.
						}
					}
					db()
						.prepare(
							`UPDATE items SET institution_id = ?, institution_name = ?, consent_expires_at = ?
							  WHERE plaid_item_id = ?`
						)
						.run(institutionId, name, status.item.consent_expiration_time, item_id);
				} catch {
					// Item is linked and stored; naming it can wait for the sync.
				}

				return json({ ok: true, institution: name });
			}

			case 'repaired': {
				// Called after Link update mode reports success. The client's word is
				// not taken for it: /item/get is the authority on whether the item is
				// actually healthy again, and without this the row stays
				// 'needs_repair' until the next nightly sync and the UI keeps
				// offering Reconnect on a connection that is already fixed.
				const item = itemById(body.itemId);
				const status = await plaid.getItem(accessTokenOf(item));
				const itemError = status.item.error;

				db()
					.prepare(
						`UPDATE items SET status = ?, error_code = ?, error_message = ?, consent_expires_at = ?
						  WHERE id = ?`
					)
					.run(
						itemError ? 'needs_repair' : 'ok',
						itemError?.error_code ?? null,
						itemError ? redact(itemError.error_message) : null,
						status.item.consent_expiration_time,
						item.id
					);

				return json({ ok: !itemError, message: itemError?.error_code ?? null });
			}

			default:
				throw error(404, 'Not found');
		}
	} catch (err) {
		// `error()` above throws HttpError, which is already a considered response.
		if (isHttpError(err)) throw err;

		// Without this, every Plaid failure — bad keys, unregistered redirect URI,
		// product not enabled — reaches the browser as an indistinguishable
		// "Internal Error" and can only be told apart by reading the journal.
		if (err instanceof PlaidError) throw error(502, `${err.code}: ${redact(err.message)}`);

		// fetch failures (DNS, TLS, no route) surface as TypeError with a message
		// that says nothing about Plaid; label them so they are not mistaken for
		// an API rejection.
		if (err instanceof TypeError) throw error(502, `Could not reach Plaid: ${redact(err.message)}`);

		// Anything else is a fault in this app — a SQLite error, a decryption
		// failure, a programming mistake. Blaming Plaid for those would send the
		// owner to check their dashboard instead of the journal, so let it
		// propagate as a genuine 500.
		throw err;
	}
};
