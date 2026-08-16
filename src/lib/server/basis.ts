import type { TrailingAverages } from './budget.ts';

export type Basis = 'template' | 'history' | 'budget';

export type ResolvedInputs = {
	incomeCents: number;
	expenseCents: number;
	incomeSource: Basis;
	expenseSource: Basis;
};

/**
 * Decides what the projection actually runs on.
 *
 * The master budget wins when one exists: it is a deliberate statement of what
 * each month is meant to look like, and it is the thing a person edits when
 * something changes. Observed history comes next, because transactions beat an
 * unfilled sheet. The current month's own cells are the last resort.
 *
 * Income and expense are resolved together rather than independently — the
 * master budget supplies both, and mixing a budgeted income against observed
 * spending is the apples-to-oranges comparison that made every early forecast
 * trend to ruin.
 *
 * Kept free of database access so the precedence can be tested directly.
 */
export function resolveInputs(args: {
	template: { incomeCents: number; expenseCents: number } | null;
	trailing: TrailingAverages;
	budgetIncomeCents: number;
	budgetExpenseCents: number;
}): ResolvedInputs {
	const { template, trailing, budgetIncomeCents, budgetExpenseCents } = args;

	if (template) {
		return {
			incomeCents: template.incomeCents,
			expenseCents: template.expenseCents,
			incomeSource: 'template',
			expenseSource: 'template'
		};
	}

	if (trailing.monthsUsed > 0) {
		return {
			incomeCents: trailing.incomeCents,
			expenseCents: trailing.expenseCents,
			incomeSource: 'history',
			expenseSource: 'history'
		};
	}

	return {
		incomeCents: budgetIncomeCents,
		expenseCents: budgetExpenseCents,
		incomeSource: 'budget',
		expenseSource: 'budget'
	};
}
