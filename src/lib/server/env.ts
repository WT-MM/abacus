import { readFileSync, existsSync } from 'node:fs';

let loaded = false;

/**
 * Reads a .env file into process.env.
 *
 * Vite only surfaces VITE_-prefixed variables, and only on import.meta.env, so
 * the dev server would otherwise see none of this configuration. Real
 * environment variables always win, which is what lets the systemd unit
 * override the file in production.
 */
export function loadEnvFile(path = process.env.ABACUS_ENV_FILE ?? '.env'): void {
	if (loaded) return;
	loaded = true;

	if (!existsSync(path)) return;

	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;

		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (!(key in process.env)) process.env[key] = value;
	}
}
