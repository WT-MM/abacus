import { config } from '../config.ts';

/**
 * Resolves the Tailscale identity that `tailscale serve` attached to a request.
 *
 * These headers are only trustworthy because the Node process binds to
 * 127.0.0.1 and is therefore unreachable except through the proxy. If the app is
 * ever exposed on 0.0.0.0, any host that can route to it can set the header and
 * become the owner — bind loopback-only, always.
 */
export function tailscaleLogin(headers: Headers): string | null {
	if (config.devUser && !config.isProd) return config.devUser.toLowerCase();
	const login = headers.get('tailscale-user-login');
	return login ? login.toLowerCase() : null;
}

/**
 * A tailnet can contain shared external users, and Serve sends identity headers
 * for them too, so "presented a valid identity" is not "is the owner".
 */
export function isOwner(login: string | null): login is string {
	if (!login) return false;
	if (!config.owners.length) return false;
	return config.owners.includes(login.toLowerCase());
}

export type AuthState = {
	login: string | null;
	owner: boolean;
	/** Passkey verified for this browser session. */
	verified: boolean;
};
