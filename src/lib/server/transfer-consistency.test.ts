import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { newTempDb, removeTempDb, type TempDb } from './test-support.ts';

/**
 * category_id and is_transfer must never disagree.
 *
 * A row flagged as a transfer while sitting in an expense category is hidden
 * from every total — real spending, gone. The reverse counts money moving
 * between the owner's own accounts as spending. Both are silent.
 */

let tmp: TempDb;
let budget: typeof import('./budget.ts');
let cat: typeof import('./categorize.ts');
let conn: import('node:sqlite').DatabaseSync;

const MONTH = '2026-08';

beforeEach(async () => {
	tmp = newTempDb('abacus-xfer-');
	vi.resetModules();

	const dbmod = await import('./db.ts');
	budget = await import('./budget.ts');
	cat = await import('./categorize.ts');
	conn = dbmod.db();
	conn.exec(
		`INSERT INTO accounts (id, source, external_id, name, type) VALUES (1, 'plaid', 'a', 'Chk', 'depository')`
	);
});

afterEach(() => removeTempDb(tmp));

const nameOf = (id: number | null) =>
	id === null
		? null
		: (conn.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string }).name;

const of = (primary: string, detailed?: string) =>
	nameOf(cat.classify({ description: 'x', primary, detailed: detailed ?? null }));

describe("Plaid's transfer categories are not all internal transfers", () => {
	it.each([
		// Cash out of an ATM is spending that cannot be tracked further.
		['TRANSFER_OUT', 'TRANSFER_OUT_WITHDRAWAL', 'Uncategorised', false],
		// A deposit is money arriving from outside the household.
		['TRANSFER_IN', 'TRANSFER_IN_DEPOSIT', 'Other Income', false],
		// Moving money between own accounts genuinely is a transfer.
		['TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER', 'Transfer', true],
		['TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER', 'Transfer', true]
	])('%s / %s -> %s', (primary, detailed, expected, isTransfer) => {
		const id = cat.classify({ description: 'x', primary, detailed });
		expect(nameOf(id)).toBe(expected);
		expect(cat.isTransferCategory(id)).toBe(isTransfer);
	});
});

describe("Plaid's taxonomy versions", () => {
	it.each([
		['v1 wages', 'INCOME_WAGES'],
		['v2 salary', 'INCOME_SALARY']
	])('%s reaches Salary', (_label, detailed) => {
		// Teams created from December 2025 receive v2, where the v1 name no longer
		// exists — a single spelling would silently demote every paycheck.
		expect(of('INCOME', detailed)).toBe('Salary');
	});

	it('treats borrowed money as neither income nor spending', () => {
		expect(of('LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_CASH_ADVANCES')).toBe('Transfer');
	});
});

describe('trailing averages', () => {
	function txn(month: string, amount: number, category: string, isTransfer: number) {
		const id = (conn.prepare('SELECT id FROM categories WHERE name = ?').get(category) as { id: number })
			.id;
		conn
			.prepare(
				`INSERT INTO transactions (account_id, source, dedupe_hash, posted_on, amount_cents, description, category_id, is_transfer)
				 VALUES (1, 'plaid', ?, ?, ?, 'x', ?, ?)`
			)
			.run(`${month}${amount}${category}`, `${month}-10`, amount, id, isTransfer);
	}

	it('does not let a transfer-only month dilute the average', () => {
		// One month of real spending, one month holding only a transfer. The
		// average is 600, not 300: the transfer month contributes nothing and must
		// not count towards the divisor either.
		txn('2026-06', -60_000, 'Groceries', 0);
		txn('2026-07', -50_000, 'Transfer', 0);

		const t = budget.trailingMonthlyAverages(MONTH, 3);
		expect(t.monthsUsed).toBe(1);
		expect(t.expenseCents).toBe(60_000);
	});
});

describe('repairs on an existing database', () => {
	it('clears a transfer flag left on an expense row', async () => {
		// The damaging direction: hidden from every total with nothing to show why.
		const groceries = (
			conn.prepare(`SELECT id FROM categories WHERE name = 'Groceries'`).get() as { id: number }
		).id;
		conn
			.prepare(
				`INSERT INTO transactions (account_id, source, dedupe_hash, posted_on, amount_cents, description, category_id, is_transfer)
				 VALUES (1, 'plaid', 'stale', '2026-08-10', -12345, 'x', ?, 1)`
			)
			.run(groceries);

		// Repairs record themselves and run once, so opening the database in
		// setup already marked this one done. Dropping the marker reproduces what
		// actually matters: a database written before the repair existed, holding
		// a row the repair is meant to find.
		conn.prepare(`DELETE FROM meta WHERE key = 'repair.clear-stale-transfer-flags'`).run();
		conn.close();
		vi.resetModules();
		const again = await import('./db.ts');
		const fresh = again.db();

		const row = fresh.prepare(`SELECT is_transfer FROM transactions WHERE dedupe_hash = 'stale'`).get() as {
			is_transfer: number;
		};
		expect(row.is_transfer).toBe(0);
	});
});
