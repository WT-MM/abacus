import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { SCHEMA } from './schema.ts';

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
	if (handle) return handle;

	mkdirSync(dirname(config.dbPath), { recursive: true });
	const conn = new DatabaseSync(config.dbPath);

	// WAL lets the daily sync process write while the web process serves reads.
	// Without it the two processes block each other and the UI stalls mid-sync.
	conn.exec('PRAGMA journal_mode = WAL');
	conn.exec('PRAGMA foreign_keys = ON');
	conn.exec('PRAGMA busy_timeout = 5000');
	conn.exec('PRAGMA synchronous = NORMAL');

	conn.exec(SCHEMA);

	handle = conn;
	seedCategories(conn);
	return conn;
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
