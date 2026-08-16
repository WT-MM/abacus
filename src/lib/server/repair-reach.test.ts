import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA } from './schema.ts';

/**
 * The repair has to reach the rows that actually exist.
 *
 * Plaid ships two taxonomy versions and the detailed category name differs
 * between them, so an exact-string match can miss every row while appearing to
 * have run — the marker gets written either way.
 */

let dir: string;
let path: string;

/** A database as it would be before the repair, with no markers. */
function legacy(rows: Array<{ id: string; plaidCategory: string | null; category: string; locked: 0 | 1 }>) {
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);
	for (const [name, kind] of [
		['Fees & Interest', 'expense'],
		['Transfer', 'transfer']
	] as const) {
		db.prepare('INSERT INTO categories (name, kind, sort) VALUES (?, ?, 0)').run(name, kind);
	}
	db.exec(
		`INSERT INTO accounts (id, source, external_id, name, type) VALUES (1, 'plaid', 'a', 'Card', 'credit')`
	);

	const idOf = (n: string) =>
		(db.prepare('SELECT id FROM categories WHERE name = ?').get(n) as { id: number }).id;

	for (const r of rows) {
		db.prepare(
			`INSERT INTO transactions (account_id, source, dedupe_hash, posted_on, amount_cents,
			                           description, plaid_category, category_id, category_locked, is_transfer)
			 VALUES (1, 'plaid', ?, '2026-07-15', -210007, 'AUTOPAY', ?, ?, ?, 0)`
		).run(r.id, r.plaidCategory, idOf(r.category), r.locked);
	}
	db.close();
}

const categoryOf = (id: string) => {
	const db = new DatabaseSync(path, { readOnly: true });
	const row = db
		.prepare(
			`SELECT c.name AS category, t.is_transfer FROM transactions t
			   JOIN categories c ON c.id = t.category_id WHERE t.dedupe_hash = ?`
		)
		.get(id) as { category: string; is_transfer: number };
	db.close();
	return row;
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'abacus-reach-'));
	path = join(dir, 'test.db');
	process.env.ABACUS_ENV_FILE = '/nonexistent';
	process.env.ABACUS_DB = path;
	vi.resetModules();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the repair reaches both taxonomy spellings', () => {
	it.each([
		['v1', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'],
		// Whatever a future or v2 variant is called, it still contains the phrase.
		['a prefixed variant', 'PERSONAL_LOAN_PAYMENTS_CREDIT_CARD_PAYMENT']
	])('%s', async (_label, plaidCategory) => {
		legacy([{ id: 'x', plaidCategory, category: 'Fees & Interest', locked: 0 }]);
		const { db } = await import('./db.ts');
		db();
		expect(categoryOf('x')).toMatchObject({ category: 'Transfer', is_transfer: 1 });
	});

	it('still leaves a hand-categorised row alone', async () => {
		legacy([
			{ id: 'locked', plaidCategory: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', category: 'Fees & Interest', locked: 1 }
		]);
		const { db } = await import('./db.ts');
		db();
		expect(categoryOf('locked').category).toBe('Fees & Interest');
	});

	it('runs on a database that already ran the narrower version', async () => {
		// The earlier repair matched an exact string and may have matched nothing
		// while still recording itself as done.
		legacy([
			{ id: 'missed', plaidCategory: 'PERSONAL_LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', category: 'Fees & Interest', locked: 0 }
		]);
		const pre = new DatabaseSync(path);
		pre.prepare(`INSERT INTO meta (key, value) VALUES ('repair.card-payments-are-transfers', 'done')`).run();
		pre.close();

		const { db } = await import('./db.ts');
		db();
		expect(categoryOf('missed')).toMatchObject({ category: 'Transfer', is_transfer: 1 });
	});
});
