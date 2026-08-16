import { redirect, type Handle } from '@sveltejs/kit';
import { tailscaleLogin, isOwner } from '$lib/server/auth/identity.ts';
import { resolveSession, purgeExpired, SESSION_COOKIE } from '$lib/server/auth/session.ts';
import { config } from '$lib/server/config.ts';
import { assertEncryptionKeyUsable, assertEncryptionKeyMatchesDatabase } from '$lib/server/crypto.ts';
import { db, getMeta, setMeta } from '$lib/server/db.ts';

assertLoopbackOnly();
// Verified at boot rather than on first use. The first use is storing a Plaid
// access token, which happens just after an Item slot has been spent.
assertEncryptionKeyUsable();
db();
// Needs the database, so it runs after db(). Catches a key that is the right
// shape but the wrong value, which length validation cannot see.
assertEncryptionKeyMatchesDatabase(getMeta, setMeta);
purgeExpired();

/**
 * Refuses to start if the server would listen on a public interface.
 *
 * The entire auth model rests on the Tailscale-User-Login header being
 * unforgeable, and it is unforgeable only because nothing except the local
 * `tailscale serve` proxy can reach the port. adapter-node binds 0.0.0.0 unless
 * HOST says otherwise, so the safe configuration is the one that must be
 * explicit — and getting it wrong should be a failure to boot, not a silent
 * exposure of every account balance to the LAN.
 */
function assertLoopbackOnly(): void {
	if (!config.isProd) return;
	if (process.env.SOCKET_PATH) return; // A unix socket is local by construction.

	const host = process.env.HOST;
	if (host && ['127.0.0.1', 'localhost', '::1'].includes(host)) return;

	throw new Error(
		`Refusing to start: HOST is ${host ?? 'unset'}, so the server would listen on a public ` +
			`interface and any host that can reach it could forge a Tailscale identity header. ` +
			`Set HOST=127.0.0.1 (see deploy/abacus.service).`
	);
}

// Paths reachable with a valid owner identity but no passkey yet — enrolment
// and assertion must be able to run before a session exists.
const PRE_AUTH = ['/auth', '/api/webauthn'];

// Content-Security-Policy is not set here. It lives in svelte.config.js so that
// SvelteKit can hash its own inline hydration scripts; a hand-written header
// blocks them and the page never hydrates.

export const handle: Handle = async ({ event, resolve }) => {
	const login = tailscaleLogin(event.request.headers);
	const owner = isOwner(login);
	const sessionOwner = owner ? resolveSession(event.cookies.get(SESSION_COOKIE)) : null;

	event.locals.auth = {
		login,
		owner,
		// A session issued to a different login must not carry over if the
		// allowlist changes underneath it.
		verified: Boolean(sessionOwner && sessionOwner === login)
	};

	const path = event.url.pathname;
	const preAuth = PRE_AUTH.some((p) => path === p || path.startsWith(`${p}/`));

	if (!owner) {
		// Say nothing about why. An unrecognised caller learns only that the
		// resource exists behind the tailnet.
		return new Response('Not found', { status: 404 });
	}

	if (!event.locals.auth.verified && !preAuth) {
		throw redirect(303, `/auth?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}

	const response = await resolve(event);

	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
	if (config.isProd) {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
	return response;
};
