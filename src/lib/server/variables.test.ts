import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let mod: typeof import('./variables.ts');
let budget: typeof import('./budget.ts');
let conn: import('node:sqlite').DatabaseSync;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'abacus-vars-'));
	process.env.ABACUS_ENV_FILE = '/nonexistent';
	process.env.ABACUS_DB = join(dir, 'test.db');
	vi.resetModules();
	const dbmod = await import('./db.ts');
	mod = await import('./variables.ts');
	budget = await import('./budget.ts');
	conn = dbmod.db();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const idOf = (name: string) =>
	(conn.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;

describe('naming rules', () => {
	it.each([
		['a name with a space', 'avg meal cost', /not usable in a formula/],
		['a name starting with a digit', '2meals', /not usable in a formula/],
		['a name with punctuation', 'meal-cost', /not usable in a formula/],
		['an empty name', '   ', /Give the variable a name/],
		// SUM would be shadowed by the function and never resolve.
		['a built-in function name', 'sum', /built-in function/],
		// B3 tokenizes as a cell reference, so it could never be looked up.
		['a name that reads as a cell', 'B3', /cell reference/]
	])('rejects %s', (_label, name, expected) => {
		expect(() => mod.normaliseName(name)).toThrow(expected);
	});

	it.each([['avg_meal_cost'], ['_private'], ['meals2'], ['Rent_Multiplier']])('accepts %s', (name) => {
		expect(() => mod.normaliseName(name)).not.toThrow();
	});

	it('keys case-insensitively but keeps the spelling as typed', () => {
		mod.upsertVariable('Avg_Meal_Cost', 14.5);
		expect(mod.variableMap().get('AVG_MEAL_COST')).toBe(14.5);
		expect(mod.listVariables()[0].label).toBe('Avg_Meal_Cost');
	});

	it('updates rather than duplicating when redefined in another case', () => {
		mod.upsertVariable('avg_meal_cost', 14.5);
		mod.upsertVariable('AVG_MEAL_COST', 16);
		expect(mod.listVariables()).toHaveLength(1);
		expect(mod.variableMap().get('AVG_MEAL_COST')).toBe(16);
	});

	it('rejects a non-numeric value', () => {
		expect(() => mod.upsertVariable('x', Number.NaN)).toThrow(/number/);
	});
});

describe('use in budget formulas', () => {
	const month = '2026-08';
	const setCell = (category: string, formula: string) => budget.setCell(month, idOf(category), formula);
	const rowFor = (category: string) =>
		budget.buildGrid(month).rows.find((r) => r.name === category)!;

	it('resolves a variable in a formula', () => {
		mod.upsertVariable('avg_meal_cost', 14.5);
		setCell('Dining', '=avg_meal_cost * 20');
		expect(rowFor('Dining').budgetCents).toBe(29_000);
	});

	it('is case-insensitive at the point of use', () => {
		mod.upsertVariable('avg_meal_cost', 10);
		setCell('Dining', '=AVG_MEAL_COST * 3');
		expect(rowFor('Dining').budgetCents).toBe(3_000);
	});

	it('combines with cell references', () => {
		mod.upsertVariable('multiplier', 1.5);
		setCell('Groceries', '400');
		setCell('Dining', '=B[Groceries] * multiplier');
		expect(rowFor('Dining').budgetCents).toBe(60_000);
	});

	it('recalculates every dependent cell when the value changes', () => {
		mod.upsertVariable('avg_meal_cost', 10);
		setCell('Dining', '=avg_meal_cost * 20');
		expect(rowFor('Dining').budgetCents).toBe(20_000);

		mod.upsertVariable('avg_meal_cost', 12);
		expect(rowFor('Dining').budgetCents).toBe(24_000);
	});

	it('reports an undefined variable rather than treating it as zero', () => {
		// Silently evaluating to zero would produce a plausible, wrong budget.
		setCell('Dining', '=no_such_variable * 20');
		expect(rowFor('Dining').error).toBe('#NAME?');
	});

	it('still reports an unknown function as such', () => {
		setCell('Dining', '=NOPE(1)');
		expect(rowFor('Dining').error).toBe('#NAME?');
	});
});

describe('formulasUsing', () => {
	const month = '2026-08';

	it('finds the cells referencing a variable', () => {
		mod.upsertVariable('avg_meal_cost', 10);
		budget.setCell(month, idOf('Dining'), '=avg_meal_cost * 20');
		budget.setCell(month, idOf('Groceries'), '500');

		const used = mod.formulasUsing('avg_meal_cost');
		expect(used).toHaveLength(1);
		expect(used[0]).toMatchObject({ month, category: 'Dining' });
	});

	it('does not match a variable whose name is a prefix of another', () => {
		// A substring search would report `meals` as used by `meals_per_week`.
		mod.upsertVariable('meals', 3);
		mod.upsertVariable('meals_per_week', 21);
		budget.setCell(month, idOf('Dining'), '=meals_per_week * 10');

		expect(mod.formulasUsing('meals')).toHaveLength(0);
		expect(mod.formulasUsing('meals_per_week')).toHaveLength(1);
	});

	it('ignores literal cells that merely contain the text', () => {
		budget.setCell(month, idOf('Dining'), '500');
		mod.upsertVariable('x', 1);
		expect(mod.formulasUsing('x')).toHaveLength(0);
	});
});
