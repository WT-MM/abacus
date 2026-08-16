import { json, error, type RequestHandler } from '@sveltejs/kit';
import {
	startRegistration,
	finishRegistration,
	startAuthentication,
	finishAuthentication,
	credentialsFor
} from '$lib/server/auth/webauthn.ts';
import { createSession, cookieOptions, SESSION_COOKIE } from '$lib/server/auth/session.ts';
import { config } from '$lib/server/config.ts';

/**
 * Every branch below re-derives the owner from `locals.auth`, which hooks
 * resolved from the Tailscale identity header. Enrolment is never granted to
 * "whoever asks first" — only to a login on the owner allowlist.
 */
export const POST: RequestHandler = async ({ params, request, locals, cookies }) => {
	const owner = locals.auth.login;
	if (!owner || !locals.auth.owner) throw error(404, 'Not found');

	const body = await request.json().catch(() => ({}));

	switch (params.action) {
		case 'register-start': {
			// An existing passkey must be presented before adding another, so a
			// borrowed unlocked device cannot silently enrol itself.
			if (credentialsFor(owner).length && !locals.auth.verified) {
				throw error(403, 'Unlock with an existing passkey before adding another');
			}
			const { options, challengeId } = await startRegistration(owner);
			return json({ options, challengeId });
		}

		case 'register-finish': {
			if (credentialsFor(owner).length && !locals.auth.verified) {
				throw error(403, 'Unlock with an existing passkey before adding another');
			}
			try {
				await finishRegistration(owner, body.challengeId, body.response, body.deviceName ?? 'Passkey');
			} catch (err) {
				throw error(400, err instanceof Error ? err.message : 'Registration failed');
			}
			const { token, expires } = createSession(owner, request.headers.get('user-agent'));
			cookies.set(SESSION_COOKIE, token, cookieOptions(expires, config.isProd));
			return json({ ok: true });
		}

		case 'auth-start': {
			if (!credentialsFor(owner).length) throw error(400, 'No passkey registered yet');
			const { options, challengeId } = await startAuthentication(owner);
			return json({ options, challengeId });
		}

		case 'auth-finish': {
			try {
				await finishAuthentication(owner, body.challengeId, body.response);
			} catch (err) {
				throw error(400, err instanceof Error ? err.message : 'Sign-in failed');
			}
			const { token, expires } = createSession(owner, request.headers.get('user-agent'));
			cookies.set(SESSION_COOKIE, token, cookieOptions(expires, config.isProd));
			return json({ ok: true });
		}

		default:
			throw error(404, 'Not found');
	}
};
