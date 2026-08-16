import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA } from './schema.ts';

/**
 * The repairs run against databases that already exist, so they are tested
 * against rows written the old way rather than through the current ingest.
 */

let dir: string;
let path: string;

function seedLegacyRows() {
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);

	// Categories, as db() would have seeded them.
	const cats: Array<[string, string]> = [
		['Fees & Interest', 'expense'],
		['Groceries', 'expense'],
		['Transfer', 'transfer']
	];
	const ins = db.prepare('INSERT INTO categories (name, kind, sort) VALUES (?, ?, 0)');
	for (const [name, kind] of cats) ins.run(name, kind);

	db.exec(
		`INSERT INTO accounts (id, source, external_id, name, type) VALUES (1, 'plaid', 'a', 'Card', 'credit')`
	);

	const idOf = (name: string) =>
		(db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;

	const txn = db.prepare(
		`INSERT INTO transactions (account_id, source, dedupe_hash, posted_on, amount_cents,
		                           description, plaid_category, category_id, category_locked, is_transfer)
		 VALUES (1, 'plaid', ?, '2026-08-10', ?, ?, ?, ?, ?, 0)`
	);

	// A card payoff, filed as spending the old way.
	txn.run('a', -50_000, 'AUTOPAY', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', idOf('Fees & Interest'), 0);
	// The same, but categorised by hand — must be left alone.
	txn.run('b', -60_000, 'AUTOPAY LOCKED', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', idOf('Groceries'), 1);
	// Sitting in a transfer category but never flagged.
	txn.run('c', -10_000, 'MOVE', 'TRANSFER_OUT', idOf('Transfer'), 0);
	// Ordinary spending, untouched.
	txn.run('d', -8_000, 'SHOP', 'FOOD_AND_DRINK_GROCERIES', idOf('Groceries'), 0);

	db.close();
}

const rows = () => {
	const db = new DatabaseSync(path, { readOnly: true });
	const out = db
		.prepare(
			`SELECT t.dedupe_hash AS id, c.name AS category, t.is_transfer
			   FROM transactions t JOIN categories c ON c.id = t.category_id ORDER BY t.dedupe_hash`
		)
		.all() as Array<{ id: string; category: string; is_transfer: number }>;
	db.close();
	return Object.fromEntries(out.map((r) => [r.id, r]));
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'abacus-repair-'));
	path = join(dir, 'test.db');
	process.env.ABACUS_ENV_FILE = '/nonexistent';
	process.env.ABACUS_DB = path;
	seedLegacyRows();
	vi.resetModules();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('opening an existing database', () => {
	it.each([
		['reclassifies card payoffs as transfers', 'a', 'Transfer', 1],
		// Someone who deliberately filed a payoff elsewhere meant it.
		['leaves a hand-categorised row alone', 'b', 'Groceries', 0],
		['flags anything already sitting in a transfer category', 'c', 'Transfer', 1],
		['does not touch ordinary spending', 'd', 'Groceries', 0]
	])('%s', async (_label, id, category, is_transfer) => {
		const { db } = await import('./db.ts');
		db();
		expect(rows()[id]).toMatchObject({ category, is_transfer });
	});

	it('runs once, so later hand-categorisation survives a restart', async () => {
		const { db } = await import('./db.ts');
		db();

		// Recategorise the repaired row by hand, then reopen.
		const edit = new DatabaseSync(path);
		const groceries = (
			edit.prepare(`SELECT id FROM categories WHERE name = 'Groceries'`).get() as { id: number }
		).id;
		edit
			.prepare(`UPDATE transactions SET category_id = ?, category_locked = 1, is_transfer = 0 WHERE dedupe_hash = 'a'`)
			.run(groceries);
		edit.close();

		vi.resetModules();
		const again = await import('./db.ts');
		again.db();

		expect(rows()['a']).toMatchObject({ category: 'Groceries', is_transfer: 0 });
	});
});
