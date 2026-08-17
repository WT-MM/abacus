import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { SCHEMA } from './schema.ts';

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
	if (handle) return handle;

	const dir = dirname(config.dbPath);

	// In production the directory must already exist. If the database lives on a
	// mount that has not come up, creating it would open an empty database on the
	// bare mountpoint — which reads as total data loss, and then shadows the real
	// one. The unit's RequiresMountsFor= should prevent it; this is the backstop.
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
 * Raw SQL rather than via categorize.ts, which imports this module. Each repair
 * records itself so it runs once: re-running would undo hand-categorisation
 * made afterwards.
 */
function repair(conn: DatabaseSync): void {
	const done = (key: string) =>
		Boolean(conn.prepare('SELECT 1 FROM meta WHERE key = ?').get(`repair.${key}`));
	const mark = (key: string) =>
		conn.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`repair.${key}`, 'done');

	// Card payoffs were classified as spending, so anything bought on credit
	// counted twice. LIKE rather than an exact name: Plaid has two taxonomy
	// versions and an exact match that misses does nothing, silently, while
	// still recording itself as done. New marker so a database that ran the
	// narrower version gets this one too. Hand-categorised rows are left alone.
	if (!done('card-payments-are-transfers-v2')) {
		conn
			.prepare(
				`UPDATE transactions
				    SET category_id = (SELECT id FROM categories WHERE name = 'Transfer'),
				        is_transfer = 1
				  WHERE plaid_category LIKE '%CREDIT_CARD_PAYMENT%'
				    AND category_locked = 0`
			)
			.run();
		mark('card-payments-are-transfers-v2');
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

	// The mirror of the above, and the more damaging direction: a row flagged as
	// a transfer while sitting in an income or expense category is hidden from
	// every total. That could happen when a transfer was recategorised back into
	// spending, because the flag did not move with the category.
	if (!done('clear-stale-transfer-flags')) {
		conn
			.prepare(
				`UPDATE transactions SET is_transfer = 0
				  WHERE is_transfer = 1
				    AND category_id IN (SELECT id FROM categories WHERE kind <> 'transfer')`
			)
			.run();
		mark('clear-stale-transfer-flags');
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
