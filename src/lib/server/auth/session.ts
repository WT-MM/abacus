import { db } from '../db.ts';
import { randomToken, sha256 } from '../crypto.ts';

export const SESSION_COOKIE = 'abacus_session';
const TTL_DAYS = 30;

/** Only the hash is stored, so a stolen database cannot be replayed as a login. */
export function createSession(owner: string, userAgent: string | null): { token: string; expires: Date } {
	const token = randomToken(32);
	const expires = new Date(Date.now() + TTL_DAYS * 864e5);
	db()
		.prepare('INSERT INTO sessions (token_hash, owner, expires_at, user_agent) VALUES (?, ?, ?, ?)')
		.run(sha256(token), owner, expires.toISOString(), userAgent);
	return { token, expires };
}

export function resolveSession(token: string | undefined): string | null {
	if (!token) return null;
	const row = db()
		.prepare('SELECT owner, expires_at FROM sessions WHERE token_hash = ?')
		.get(sha256(token)) as { owner: string; expires_at: string } | undefined;
	if (!row) return null;
	if (Date.parse(row.expires_at) < Date.now()) {
		destroySession(token);
		return null;
	}
	return row.owner;
}

export function destroySession(token: string | undefined): void {
	if (!token) return;
	db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function purgeExpired(): void {
	const now = new Date().toISOString();
	db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
	db().prepare('DELETE FROM challenges WHERE expires_at < ?').run(now);
}

export const cookieOptions = (expires: Date, secure: boolean) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	secure,
	expires
});
