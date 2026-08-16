import { getMeta, setMeta } from './db.ts';
import type { TrailingAverages } from './budget.ts';

/**
 * Figures you have stated outright, overriding what the data implies.
 *
 * Each side is independently optional: a raise is known the day it happens,
 * while spending is usually better measured than declared, so pinning income
 * and letting spending track reality is a reasonable thing to want.
 *
 * Null means "work it out from the data" — which is not the same as zero, and
 * is why these are nullable rather than defaulting to 0.
 */
export type Plan = {
	incomeCents: number | null;
	expenseCents: number | null;
};

export const EMPTY_PLAN: Plan = { incomeCents: null, expenseCents: null };

const KEY = 'forecast.plan';

export function loadPlan(): Plan {
	const raw = getMeta(KEY);
	if (!raw) return EMPTY_PLAN;
	try {
		const parsed = JSON.parse(raw) as Partial<Plan>;
		return {
			incomeCents: normalise(parsed.incomeCents),
			expenseCents: normalise(parsed.expenseCents)
		};
	} catch {
		return EMPTY_PLAN;
	}
}

export function savePlan(plan: Plan): void {
	setMeta(KEY, JSON.stringify(plan));
}

function normalise(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	return Math.round(value);
}

export type Basis = 'plan' | 'history' | 'budget';

export type ResolvedInputs = {
	incomeCents: number;
	expenseCents: number;
	incomeSource: Basis;
	expenseSource: Basis;
};

/**
 * Decides what the projection actually runs on.
 *
 * Order is a stated figure, then observed history, then the budget sheet. A
 * figure you typed wins because you know things the data does not yet — a
 * raise, a lease ending — and observed history beats the budget sheet because
 * the sheet is a plan and the transactions are what happened.
 *
 * Kept free of database access so the precedence can be tested directly; the
 * caller supplies the three candidates.
 */
export function resolveInputs(args: {
	plan: Plan;
	trailing: TrailingAverages;
	budgetIncomeCents: number;
	budgetExpenseCents: number;
}): ResolvedInputs {
	const { plan, trailing, budgetIncomeCents, budgetExpenseCents } = args;
	const hasHistory = trailing.monthsUsed > 0;

	const income =
		plan.incomeCents !== null
			? { cents: plan.incomeCents, source: 'plan' as const }
			: hasHistory
				? { cents: trailing.incomeCents, source: 'history' as const }
				: { cents: budgetIncomeCents, source: 'budget' as const };

	const expense =
		plan.expenseCents !== null
			? { cents: plan.expenseCents, source: 'plan' as const }
			: hasHistory
				? { cents: trailing.expenseCents, source: 'history' as const }
				: { cents: budgetExpenseCents, source: 'budget' as const };

	return {
		incomeCents: income.cents,
		expenseCents: expense.cents,
		incomeSource: income.source,
		expenseSource: expense.source
	};
}
