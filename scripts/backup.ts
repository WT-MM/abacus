#!/usr/bin/env node
/**
 * Nightly backup of the ledger.
 *
 * Uses SQLite's VACUUM INTO rather than copying the file. A plain `cp` of a
 * live WAL database can capture a torn state — the -wal and -shm files move
 * independently of the main file — whereas VACUUM INTO runs inside a read
 * transaction and produces a single consistent, compacted database. It also
 * needs no sqlite3 binary on the host.
 *
 * The backup is verified after writing. An unverified backup is just a file
 * that makes you feel safe.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadEnv } from './env.ts';

loadEnv();

const { EXIT } = await import('../src/lib/server/exit-codes.ts');

const say = (msg: string) => process.stdout.write(`${msg}\n`);
const warn = (msg: string) => process.stderr.write(`WARNING: ${msg}\n`);

function fail(message: string, code: number = EXIT.CONFIG): never {
	process.stderr.write(`backup failed: ${message}\n`);
	process.exit(code);
}

const dbPath = process.env.ABACUS_DB;
const outDir = process.env.ABACUS_BACKUP_DIR;
const keep = Number(process.env.ABACUS_BACKUP_KEEP ?? 14);

if (!dbPath) fail('ABACUS_DB is not set');
if (!outDir) fail('ABACUS_BACKUP_DIR is not set — nowhere to write the backup');
if (!existsSync(dbPath)) fail(`no database at ${dbPath}`);
if (!Number.isInteger(keep) || keep < 1) fail('ABACUS_BACKUP_KEEP must be a positive integer');

mkdirSync(outDir, { recursive: true });

// A copy on the same disk survives an accidental delete but not the disk
// itself. On a striped array with no redundancy that distinction is the whole
// point, so this nags every run until the destination actually moves.
if (statSync(dirname(dbPath)).dev === statSync(outDir).dev && !process.env.ABACUS_BACKUP_SAME_DEVICE_OK) {
	warn(
		`${outDir} is on the same filesystem as the database. That protects against deleting a row, ` +
			`not against losing the disk. Point ABACUS_BACKUP_DIR somewhere else, or set ` +
			`ABACUS_BACKUP_SAME_DEVICE_OK=1 to acknowledge.`
	);
}

// The encryption key is not copied here on purpose: putting it beside the
// database would mean one stolen backup gives up both the data and the means
// to read the Plaid tokens. But losing it costs three Plaid Item slots to
// relink, so its absence is checked rather than ignored.
const keyEscrow = process.env.ABACUS_KEY_BACKUP;
if (!keyEscrow) {
	warn(
		'ABACUS_KEY_BACKUP is not set, so nothing verifies that the encryption key exists anywhere ' +
			'but this machine. Losing it means relinking every institution, which permanently spends ' +
			'Plaid Item slots. Escrow the key somewhere off this host and point ABACUS_KEY_BACKUP at it.'
	);
} else if (!existsSync(keyEscrow)) {
	fail(`ABACUS_KEY_BACKUP points at ${keyEscrow}, which does not exist`);
} else {
	const escrowed = /^\s*ABACUS_ENCRYPTION_KEY=(.*)$/m.exec(readFileSync(keyEscrow, 'utf8'));
	const current = process.env.ABACUS_ENCRYPTION_KEY;
	if (!escrowed) fail(`${keyEscrow} contains no ABACUS_ENCRYPTION_KEY line`);
	// Compared, never printed. A stale escrow is worse than none: it looks like
	// a backup and restores a database nobody can decrypt.
	if (current && escrowed[1].trim().replace(/^["']|["']$/g, '') !== current) {
		fail(`the key in ${keyEscrow} does not match the running key — the escrow is stale`);
	}
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = join(outDir, `abacus-${stamp}.db`);
if (existsSync(target)) fail(`${target} already exists`);

const source = new DatabaseSync(dbPath, { readOnly: true });
try {
	// Consistent even while the web process and the sync process are writing.
	source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} catch (err) {
	fail(`VACUUM INTO failed: ${err instanceof Error ? err.message : String(err)}`, EXIT.TEMPFAIL);
} finally {
	source.close();
}

// ------------------------------------------------------------------ verify

const TABLES = ['items', 'accounts', 'transactions', 'holdings', 'budget_cells', 'credentials'];

const live = new DatabaseSync(dbPath, { readOnly: true });
const copy = new DatabaseSync(target, { readOnly: true });

try {
	const integrity = copy.prepare('PRAGMA integrity_check').get() as Record<string, string>;
	const verdict = Object.values(integrity)[0];
	if (verdict !== 'ok') fail(`backup failed integrity_check: ${verdict}`, EXIT.TEMPFAIL);

	const counts: string[] = [];
	for (const table of TABLES) {
		const a = (live.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
		const b = (copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
		// The live database can gain rows mid-backup, so the copy may legitimately
		// be behind. It must never be ahead, and must never be empty when the
		// source is not — that would mean the wrong file was opened.
		if (b > a) fail(`${table}: backup has ${b} rows, source has ${a}`, EXIT.TEMPFAIL);
		if (a > 0 && b === 0) fail(`${table}: source has ${a} rows, backup has none`, EXIT.TEMPFAIL);
		counts.push(`${table}=${b}`);
	}
	say(`verified ${target} (${counts.join(' ')})`);
} finally {
	live.close();
	copy.close();
}

// ----------------------------------------------------------------- retention

const existing = readdirSync(outDir)
	.filter((f) => /^abacus-.*\.db$/.test(f))
	.sort();

const stale = existing.slice(0, Math.max(0, existing.length - keep));
for (const f of stale) rmSync(join(outDir, f), { force: true });
if (stale.length) say(`pruned ${stale.length} backup(s), keeping ${keep}`);

say(`backup ok — ${existing.length - stale.length} kept in ${outDir}`);
process.exit(EXIT.OK);
