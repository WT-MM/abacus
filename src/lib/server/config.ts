// Config is read from the environment rather than SvelteKit's `$env` so that
// `scripts/sync.ts` can import this tree directly under bare Node.

import { loadEnvFile } from './env.ts';

loadEnvFile();

function req(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required environment variable ${name}. See .env.example`);
	return v;
}

function opt(name: string, fallback: string): string {
	return process.env[name] || fallback;
}

export type PlaidEnv = 'sandbox' | 'production';

export const config = {
	dbPath: opt('ABACUS_DB', 'data/abacus.db'),

	/**
	 * Exact Tailscale logins permitted to use the app. A tailnet may contain
	 * shared external users, and `tailscale serve` sends identity headers for
	 * them too — so "has a valid identity header" is not "is the owner".
	 */
	owners: opt('ABACUS_OWNERS', '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean),

	/** Public https origin, e.g. https://vault.tail1234.ts.net. Used for WebAuthn + Plaid OAuth. */
	origin: opt('ABACUS_ORIGIN', 'http://localhost:5173'),

	/**
	 * Dev-only escape hatch: pretend this login was supplied by the proxy.
	 * Refuses to apply when NODE_ENV=production.
	 */
	devUser: process.env.ABACUS_DEV_USER,

	plaid: {
		clientId: process.env.PLAID_CLIENT_ID ?? '',
		secret: process.env.PLAID_SECRET ?? '',
		env: opt('PLAID_ENV', 'production') as PlaidEnv
	},

	encryptionKey: () => req('ABACUS_ENCRYPTION_KEY'),

	get isProd() {
		return process.env.NODE_ENV === 'production';
	}
};

export function rpID(): string {
	// WebAuthn requires the RP ID to be the bare registrable hostname — no
	// scheme, no port. A mismatch here fails every assertion with an opaque error.
	try {
		return new URL(config.origin).hostname;
	} catch {
		return 'localhost';
	}
}

export function plaidConfigured(): boolean {
	return Boolean(config.plaid.clientId && config.plaid.secret);
}
