import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { newTempDb, removeTempDb, type TempDb } from './test-support.ts';

/**
 * The forecast's inputs.
 *
 * The defect these cover: income was read from the budget sheet while spending
 * was read from observed transactions. On a fresh install the sheet is empty,
 * so every projection showed income of zero against real spending and trended
 * to ruin regardless of what the person actually earned.
 */

let tmp: TempDb;
let mod: typeof import('./budget.ts');
let conn: import('node:sqlite').DatabaseSync;

async function boot() {
	tmp = newTempDb('abacus-trailing-');

	vi.resetModules();
	const dbmod = await import('./db.ts');
	mod = await import('./budget.ts');
	conn = dbmod.db();

	conn.exec(
		`INSERT INTO accounts (id, source, external_id, name, type) VALUES (1, 'plaid', 'a1', 'Checking', 'depository')`
	);
}

/** `amount` follows the stored convention: negative is money out. */
function txn(date: string, amount: number, category: string, isTransfer = 0) {
	const id = (conn.prepare('SELECT id FROM categories WHERE name = ?').get(category) as { id: number }).id;
	conn
		.prepare(
			`INSERT INTO transactions (account_id, source, dedupe_hash, posted_on, amount_cents, description, category_id, is_transfer)
			 VALUES (1, 'import', ?, ?, ?, 'x', ?, ?)`
		)
		.run(`${date}-${amount}-${category}-${Math.abs(amount)}${isTransfer}`, date, amount, id, isTransfer);
}

beforeEach(boot);
afterEach(() => removeTempDb(tmp));

describe('trailingMonthlyAverages', () => {
	it('reports no history for an empty database', () => {
		expect(mod.trailingMonthlyAverages('2026-08')).toEqual({
			incomeCents: 0,
			expenseCents: 0,
			monthsUsed: 0
		});
	});

	it('averages income and spending over the complete months', () => {
		for (const m of ['05', '06', '07']) {
			txn(`2026-${m}-01`, 600_000, 'Salary');
			txn(`2026-${m}-05`, -200_000, 'Groceries');
		}

		const t = mod.trailingMonthlyAverages('2026-08', 3);
		expect(t).toEqual({ incomeCents: 600_000, expenseCents: 200_000, monthsUsed: 3 });
	});

	it('excludes the current, part-way-through month', () => {
		txn('2026-07-01', 900_000, 'Salary');
		txn('2026-08-01', 10_000, 'Salary'); // current month, must not drag the average down
		expect(mod.trailingMonthlyAverages('2026-08', 3).incomeCents).toBe(900_000);
	});

	it('divides by the months that had data, not the window length', () => {
		// One month of history inside a three-month window must average to itself,
		// not to a third of itself.
		txn('2026-07-01', 900_000, 'Salary');
		txn('2026-07-02', -300_000, 'Groceries');

		const t = mod.trailingMonthlyAverages('2026-08', 3);
		expect(t).toEqual({ incomeCents: 900_000, expenseCents: 300_000, monthsUsed: 1 });
	});

	it('ignores transfers on both sides', () => {
		txn('2026-07-01', 900_000, 'Salary');
		txn('2026-07-03', 500_000, 'Transfer', 1);
		txn('2026-07-04', -500_000, 'Transfer', 1);

		const t = mod.trailingMonthlyAverages('2026-08', 3);
		expect(t.incomeCents).toBe(900_000);
		expect(t.expenseCents).toBe(0);
	});

	it('reports spending as a positive magnitude', () => {
		txn('2026-07-02', -450_000, 'Groceries');
		expect(mod.trailingMonthlyAverages('2026-08', 3).expenseCents).toBe(450_000);
	});

	it('draws income and spending from the same months', () => {
		// The heart of the bug: whatever basis produces the spending figure must
		// also produce the income figure, or the surplus is meaningless.
		txn('2026-07-01', 800_000, 'Salary');
		txn('2026-07-15', -300_000, 'Groceries');

		const t = mod.trailingMonthlyAverages('2026-08', 3);
		expect(t.monthsUsed).toBeGreaterThan(0);
		expect(t.incomeCents - t.expenseCents).toBe(500_000);
	});

	it('respects the lookback window', () => {
		txn('2026-01-01', 100_000, 'Salary'); // outside a 3-month window
		txn('2026-07-01', 900_000, 'Salary');
		expect(mod.trailingMonthlyAverages('2026-08', 3).monthsUsed).toBe(1);
		expect(mod.trailingMonthlyAverages('2026-08', 12).monthsUsed).toBe(2);
	});
});
