import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { SCHEMA } from './schema.ts';

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
	if (handle) return handle;

	const dir = dirname(config.dbPath);

	// In production the directory must already exist. Creating it would be worse
	// than failing: if the database lives on a mounted array and the service
	// starts before the mount lands, mkdir would create the path on the
	// underlying root filesystem and SQLite would open a brand-new empty
	// database there. That reads as total data loss, and the real database is
	// then silently shadowed once the array mounts. The unit's
	// RequiresMountsFor= should prevent it; this is the backstop.
	if (config.isProd) {
		if (!existsSync(dir)) {
			throw new Error(
				`Database directory ${dir} does not exist. Refusing to create it — if this path is on a ` +
					`mount that has not come up yet, creating it would hide the real database behind an empty one.`
			);
		}
	} else {
		mkdirSync(dir, { recursive: true });
	}

	const conn = new DatabaseSync(config.dbPath);

	// WAL lets the daily sync process write while the web process serves reads.
	// Without it the two processes block each other and the UI stalls mid-sync.
	conn.exec('PRAGMA journal_mode = WAL');
	conn.exec('PRAGMA foreign_keys = ON');
	// Generous, because the web process and the nightly sync process share this
	// file. A SQLITE_BUSY on the write that stores a freshly exchanged Plaid
	// access token would spend a lifetime Item slot for nothing.
	conn.exec('PRAGMA busy_timeout = 30000');

	// FULL, not NORMAL. Under WAL, NORMAL does not fsync on commit, so a power
	// loss can roll back an acknowledged write — including the access token
	// whose Item slot has already been consumed and cannot be reclaimed. This
	// app commits a few times a day; the fsync cost is irrelevant next to that.
	conn.exec('PRAGMA synchronous = FULL');

	conn.exec(SCHEMA);

	handle = conn;
	seedCategories(conn);
	repair(conn);
	return conn;
}

/**
 * One-time corrections to data already on disk.
 *
 * Written as raw SQL rather than going through categorize.ts, which imports
 * this module — routing it that way would make an import cycle.
 *
 * Each repair records itself in meta so it runs once. They are cheap and
 * idempotent, but re-running them would undo any hand-categorisation made
 * afterwards, which is why they are gated rather than run every boot.
 */
function repair(conn: DatabaseSync): void {
	const done = (key: string) =>
		Boolean(conn.prepare('SELECT 1 FROM meta WHERE key = ?').get(`repair.${key}`));
	const mark = (key: string) =>
		conn.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`repair.${key}`, 'done');

	// Credit-card payoffs were classified as spending, so everything bought on
	// credit was counted twice: once at the till and once when the card was
	// paid. Rows categorised by hand are left alone.
	if (!done('card-payments-are-transfers')) {
		conn
			.prepare(
				`UPDATE transactions
				    SET category_id = (SELECT id FROM categories WHERE name = 'Transfer'),
				        is_transfer = 1
				  WHERE plaid_category = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
				    AND category_locked = 0`
			)
			.run();
		mark('card-payments-are-transfers');
	}

	// is_transfer used to be derived from Plaid's primary category alone, so a
	// transaction sitting in a transfer category could still be counted.
	if (!done('transfer-flag-follows-category')) {
		conn
			.prepare(
				`UPDATE transactions SET is_transfer = 1
				  WHERE is_transfer = 0
				    AND category_id IN (SELECT id FROM categories WHERE kind = 'transfer')`
			)
			.run();
		mark('transfer-flag-follows-category');
	}
}

/** Wrap a unit of work in a transaction; rolls back on any throw. */
export function tx<T>(fn: () => T): T {
	const conn = db();
	conn.exec('BEGIN IMMEDIATE');
	try {
		const result = fn();
		conn.exec('COMMIT');
		return result;
	} catch (err) {
		conn.exec('ROLLBACK');
		throw err;
	}
}

export function getMeta(key: string): string | null {
	const row = db().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
		| { value: string }
		| undefined;
	return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
	db()
		.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
		.run(key, value);
}

const DEFAULT_CATEGORIES: Array<[string, string, string]> = [
	['Salary', 'income', 'Income'],
	['Interest & Dividends', 'income', 'Income'],
	['Other Income', 'income', 'Income'],
	['Rent & Mortgage', 'expense', 'Housing'],
	['Utilities', 'expense', 'Housing'],
	['Groceries', 'expense', 'Living'],
	['Dining', 'expense', 'Living'],
	['Transport', 'expense', 'Living'],
	['Health', 'expense', 'Living'],
	['Shopping', 'expense', 'Discretionary'],
	['Entertainment', 'expense', 'Discretionary'],
	['Travel', 'expense', 'Discretionary'],
	['Subscriptions', 'expense', 'Discretionary'],
	['Fees & Interest', 'expense', 'Other'],
	['Taxes', 'expense', 'Other'],
	['Uncategorised', 'expense', 'Other'],
	['Transfer', 'transfer', 'Transfers'],
	['Investment', 'transfer', 'Transfers']
];

function seedCategories(conn: DatabaseSync): void {
	const count = conn.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number };
	if (count.n > 0) return;
	const insert = conn.prepare('INSERT INTO categories (name, kind, grp, sort) VALUES (?, ?, ?, ?)');
	DEFAULT_CATEGORIES.forEach(([name, kind, grp], i) => insert.run(name, kind, grp, i));
}
