import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let mod: typeof import('./plan.ts');

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'abacus-plan-'));
	process.env.ABACUS_ENV_FILE = '/nonexistent';
	process.env.ABACUS_DB = join(dir, 'test.db');
	vi.resetModules();
	await import('./db.ts');
	mod = await import('./plan.ts');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const trailing = (income: number, expense: number, monthsUsed = 3) => ({
	incomeCents: income,
	expenseCents: expense,
	monthsUsed
});

const resolve = (plan: { incomeCents: number | null; expenseCents: number | null }, t = trailing(900_000, 500_000)) =>
	mod.resolveInputs({ plan, trailing: t, budgetIncomeCents: 100_000, budgetExpenseCents: 80_000 });

describe('resolveInputs precedence', () => {
	it.each([
		['a stated figure wins over history', { incomeCents: 1_200_000, expenseCents: null }, 1_200_000, 'plan'],
		['history is used when nothing is stated', { incomeCents: null, expenseCents: null }, 900_000, 'history']
	])('%s', (_label, plan, expectedIncome, expectedSource) => {
		const r = resolve(plan);
		expect(r.incomeCents).toBe(expectedIncome);
		expect(r.incomeSource).toBe(expectedSource);
	});

	it('falls back to the budget sheet only with no history', () => {
		const r = resolve({ incomeCents: null, expenseCents: null }, trailing(0, 0, 0));
		expect(r).toMatchObject({
			incomeCents: 100_000,
			expenseCents: 80_000,
			incomeSource: 'budget',
			expenseSource: 'budget'
		});
	});

	it('overrides each side independently', () => {
		// Pinning income after a raise while letting spending keep tracking
		// reality is the case this exists for.
		const r = resolve({ incomeCents: 1_500_000, expenseCents: null });
		expect(r).toMatchObject({
			incomeCents: 1_500_000,
			incomeSource: 'plan',
			expenseCents: 500_000,
			expenseSource: 'history'
		});
	});

	it('treats a stated zero as a real figure, not as unset', () => {
		// Someone between jobs has zero income; that must not silently revert to
		// the three-month average of their old salary.
		const r = resolve({ incomeCents: 0, expenseCents: null });
		expect(r.incomeCents).toBe(0);
		expect(r.incomeSource).toBe('plan');
	});
});

describe('persistence', () => {
	it('starts empty', () => {
		expect(mod.loadPlan()).toEqual(mod.EMPTY_PLAN);
	});

	it('round-trips a saved plan', () => {
		mod.savePlan({ incomeCents: 950_000, expenseCents: null });
		expect(mod.loadPlan()).toEqual({ incomeCents: 950_000, expenseCents: null });
	});

	it('round-trips a stated zero', () => {
		mod.savePlan({ incomeCents: 0, expenseCents: 0 });
		expect(mod.loadPlan()).toEqual({ incomeCents: 0, expenseCents: 0 });
	});

	it('clears back to derived', () => {
		mod.savePlan({ incomeCents: 950_000, expenseCents: 400_000 });
		mod.savePlan(mod.EMPTY_PLAN);
		expect(mod.loadPlan()).toEqual(mod.EMPTY_PLAN);
	});

	it.each([
		['corrupt json', 'not json at all'],
		['a non-numeric value', '{"incomeCents":"lots"}'],
		['an infinite value', '{"incomeCents":1e999}']
	])('survives %s without pinning the forecast', async (_label, raw) => {
		const { setMeta } = await import('./db.ts');
		setMeta('forecast.plan', raw);
		// Anything unreadable must read as "derive it", never as zero — zero would
		// be a silent, plausible-looking forecast of destitution.
		expect(mod.loadPlan().incomeCents).toBeNull();
	});
});
