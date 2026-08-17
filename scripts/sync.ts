#!/usr/bin/env node
// Daily sync, run by the systemd timer and by the "Sync now" button.
//
// Its own process on purpose: node:sqlite is synchronous, so running this
// inside the web server would block every other request for its duration.
// Node 26 strips the types, so there is no build step.

import { loadEnv } from './env.ts';

loadEnv();

const { EXIT } = await import('../src/lib/server/exit-codes.ts');

try {
	const { syncAll } = await import('../src/lib/server/sync.ts');
	const { status, results } = await syncAll();

	for (const r of results) {
		const detail = r.ok ? `${r.changed} records` : (r.message ?? 'failed');
		process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.institution.padEnd(24)} ${detail}\n`);
	}

	if (!results.length) process.stdout.write('No institutions linked yet.\n');
	process.stdout.write(`sync ${status}\n`);

	if (status === 'ok') process.exit(EXIT.OK);

	// An institution that needs reconnecting cannot be fixed by running again,
	// and a retry would hammer Plaid for nothing. Every institution failing at
	// once, by contrast, usually means the network or Plaid — worth retrying.
	//
	// Without webhooks these exit codes are the only signal that the ledger has
	// gone stale, so a partial run must not exit 0.
	const needsHuman = results.some((r) => r.needsRepair);
	process.exit(needsHuman || status === 'partial' ? EXIT.NEEDS_ATTENTION : EXIT.TEMPFAIL);
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`sync failed: ${message}\n`);

	// A configuration fault fails identically every time; the unit is told not
	// to retry it. Anything else is treated as transient.
	const isConfig =
		/ABACUS_ENCRYPTION_KEY|Plaid is not configured|Missing required environment|Database directory/.test(
			message
		);
	process.exit(isConfig ? EXIT.CONFIG : EXIT.TEMPFAIL);
}
