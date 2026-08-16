#!/usr/bin/env node
// Daily sync, run by the systemd timer and by the "Sync now" button.
//
// This runs as its own process on purpose: node:sqlite is synchronous, so
// doing this work inside the web server would block every other request for
// the duration of the run.
//
// Node 26 strips the types natively, so there is no build step here.

import { loadEnv } from './env.ts';

loadEnv();

const { syncAll } = await import('../src/lib/server/sync.ts');

try {
	const { status, results } = await syncAll();

	for (const r of results) {
		const detail = r.ok ? `${r.changed} records` : (r.message ?? 'failed');
		process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.institution.padEnd(24)} ${detail}\n`);
	}

	if (!results.length) process.stdout.write('No institutions linked yet.\n');
	process.stdout.write(`sync ${status}\n`);

	// A partial run exits non-zero too. Without webhooks this exit code is the
	// only signal that an institution has gone stale, and "most of them worked"
	// is exactly the case that would otherwise go unnoticed for weeks.
	process.exit(status === 'ok' ? 0 : 1);
} catch (err) {
	process.stderr.write(`sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
}
