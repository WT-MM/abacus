import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { newTempDb, removeTempDb, type TempDb } from './test-support.ts';
import { resolveInputs } from './basis.ts';

let tmp: TempDb;
let budget: typeof import('./budget.ts');
let conn: import('node:sqlite').DatabaseSync;

beforeEach(async () => {
	tmp = newTempDb('abacus-tpl-');
	vi.resetModules();
	const dbmod = await import('./db.ts');
	budget = await import('./budget.ts');
	conn = dbmod.db();
});

afterEach(() => removeTempDb(tmp));

const idOf = (name: string) =>
	(conn.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;

const setTemplate = (category: string, formula: string) =>
	budget.setCell(budget.TEMPLATE_MONTH, idOf(category), formula);

const cellsIn = (month: string) =>
	(conn.prepare('SELECT COUNT(*) AS n FROM budget_cells WHERE month = ?').get(month) as { n: number }).n;

describe('the master budget sheet', () => {
	it('has no observed columns to compare against', () => {
		setTemplate('Groceries', '600');
		const grid = budget.buildGrid(budget.TEMPLATE_MONTH);
		const row = grid.rows.find((r) => r.name === 'Groceries')!;

		expect(row.budgetCents).toBe(60_000);
		expect(row.actualCents).toBe(0);
		expect(row.projectedCents).toBe(0);
	});

	it('resolves PREV to zero rather than walking off the calendar', () => {
		// shiftMonth('template', -1) is not a date; without a guard this produces
		// a garbage month key and recurses.
		setTemplate('Utilities', '=PREV()*1.03');
		const grid = budget.buildGrid(budget.TEMPLATE_MONTH);
		expect(grid.rows.find((r) => r.name === 'Utilities')!.error).toBeUndefined();
	});

	it('reports totals, or null when never set up', () => {
		expect(budget.templateTotals()).toBeNull();
		setTemplate('Salary', '9000');
		setTemplate('Groceries', '600');
		expect(budget.templateTotals()).toEqual({ incomeCents: 900_000, expenseCents: 60_000 });
	});
});

describe('seeding a month from the template', () => {
	const NOW = '2026-08';

	it('fills an untouched month', () => {
		setTemplate('Groceries', '600');
		setTemplate('Salary', '9000');

		expect(budget.seedFromTemplate(NOW, NOW)).toBe(2);
		expect(cellsIn(NOW)).toBe(2);
	});

	it('never overwrites a month that has been edited', () => {
		setTemplate('Groceries', '600');
		budget.setCell(NOW, idOf('Groceries'), '750');

		expect(budget.seedFromTemplate(NOW, NOW)).toBe(0);
		expect(budget.buildGrid(NOW).rows.find((r) => r.name === 'Groceries')!.budgetCents).toBe(75_000);
	});

	it('refuses to back-fill a month that has already happened', () => {
		// Writing a budget onto a past month would invent an intent that never
		// existed, and then compare real spending against it.
		setTemplate('Groceries', '600');
		expect(budget.seedFromTemplate('2026-05', NOW)).toBe(0);
		expect(cellsIn('2026-05')).toBe(0);
	});

	it('does fill a future month', () => {
		setTemplate('Groceries', '600');
		expect(budget.seedFromTemplate('2026-12', NOW)).toBe(1);
	});

	it('does nothing when no template exists', () => {
		expect(budget.seedFromTemplate(NOW, NOW)).toBe(0);
	});

	it('never seeds the template from itself', () => {
		setTemplate('Groceries', '600');
		expect(budget.seedFromTemplate(budget.TEMPLATE_MONTH, NOW)).toBe(0);
		expect(cellsIn(budget.TEMPLATE_MONTH)).toBe(1);
	});
});

describe('resetting a month to the master budget', () => {
	const NOW = '2026-08';

	it('replaces the month wholesale', () => {
		setTemplate('Groceries', '600');
		setTemplate('Salary', '9000');
		budget.setCell(NOW, idOf('Groceries'), '999');

		expect(budget.replaceFromTemplate(NOW)).toBe(2);
		const grid = budget.buildGrid(NOW);
		expect(grid.rows.find((r) => r.name === 'Groceries')!.budgetCents).toBe(60_000);
		expect(grid.rows.find((r) => r.name === 'Salary')!.budgetCents).toBe(900_000);
	});

	it('drops categories the master budget does not define', () => {
		// A merge would leave this behind, and the result would match neither the
		// month nor the master — "reset" would quietly mean "mostly reset".
		setTemplate('Groceries', '600');
		budget.setCell(NOW, idOf('Travel'), '1200');

		budget.replaceFromTemplate(NOW);
		expect(budget.buildGrid(NOW).rows.find((r) => r.name === 'Travel')!.budgetCents).toBe(0);
		expect(cellsIn(NOW)).toBe(1);
	});

	it('will reset a past month, unlike automatic seeding', () => {
		// Seeding refuses to invent intent for a month that already happened;
		// asking for it explicitly is a different thing.
		setTemplate('Groceries', '600');
		expect(budget.replaceFromTemplate('2026-01')).toBe(1);
	});

	it('refuses to overwrite the master budget with itself', () => {
		setTemplate('Groceries', '600');
		expect(budget.replaceFromTemplate(budget.TEMPLATE_MONTH)).toBe(0);
		expect(cellsIn(budget.TEMPLATE_MONTH)).toBe(1);
	});

	it('clears a month when the master budget is empty', () => {
		budget.setCell(NOW, idOf('Groceries'), '999');
		expect(budget.replaceFromTemplate(NOW)).toBe(0);
		expect(cellsIn(NOW)).toBe(0);
	});
});

describe('forecast basis precedence', () => {
	const trailing = (used = 3) => ({ incomeCents: 800_000, expenseCents: 500_000, monthsUsed: used });
	const args = (template: { incomeCents: number; expenseCents: number } | null, used = 3) => ({
		template,
		trailing: trailing(used),
		budgetIncomeCents: 100_000,
		budgetExpenseCents: 90_000
	});

	it('prefers the master budget over observed history', () => {
		const r = resolveInputs(args({ incomeCents: 950_000, expenseCents: 600_000 }));
		expect(r).toEqual({
			incomeCents: 950_000,
			expenseCents: 600_000,
			incomeSource: 'template',
			expenseSource: 'template'
		});
	});

	it('falls back to history when there is no master budget', () => {
		const r = resolveInputs(args(null));
		expect(r).toMatchObject({ incomeCents: 800_000, incomeSource: 'history' });
	});

	it('falls back to this month only when nothing has been observed', () => {
		const r = resolveInputs(args(null, 0));
		expect(r).toMatchObject({ incomeCents: 100_000, incomeSource: 'budget' });
	});

	it('never mixes bases across income and spending', () => {
		// Budgeted income against observed spending is the apples-to-oranges
		// comparison that made every early forecast trend to ruin.
		for (const a of [args({ incomeCents: 1, expenseCents: 2 }), args(null), args(null, 0)]) {
			const r = resolveInputs(a);
			expect(r.incomeSource).toBe(r.expenseSource);
		}
	});
});
