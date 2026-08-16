// Pure projection maths, kept free of database access so it can be tested and
// reused on the client. Everything here is inference: callers render it in
// brass, never as observed fact.

export type Assumptions = {
	/** Annual nominal return on investment balances, e.g. 0.06. */
	investmentReturn: number;
	/** Monthly amount moved from cash into investments, in cents. */
	monthlyContributionCents: number;
	/** Monthly principal paid down against debt, in cents. */
	debtPaydownCents: number;
	/** Annual rate at which budgeted expenses grow. */
	expenseInflation: number;
};

export const DEFAULT_ASSUMPTIONS: Assumptions = {
	investmentReturn: 0.06,
	monthlyContributionCents: 0,
	debtPaydownCents: 0,
	expenseInflation: 0.03
};

export type Position = { cashCents: number; investmentsCents: number; debtCents: number };

export type ForecastPoint = {
	month: string;
	cashCents: number;
	investmentsCents: number;
	/** Held as a negative number, matching how debt contributes to net worth. */
	debtCents: number;
	netWorthCents: number;
	incomeCents: number;
	expenseCents: number;
};

function nextMonth(month: string): string {
	const [y, m] = month.split('-').map(Number);
	return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

/**
 * Rolls a starting position forward `months` times.
 *
 * Contributions move cash into investments rather than creating it, and debt
 * paydown consumes cash — otherwise a projection quietly manufactures money and
 * every long horizon looks better than it is.
 */
export function project(
	start: Position,
	startMonth: string,
	months: number,
	monthlyIncomeCents: number,
	monthlyExpenseCents: number,
	assumptions: Assumptions = DEFAULT_ASSUMPTIONS
): ForecastPoint[] {
	const monthlyReturn = assumptions.investmentReturn / 12;
	const monthlyInflation = assumptions.expenseInflation / 12;

	let cash = start.cashCents;
	let investments = start.investmentsCents;
	let debt = Math.abs(start.debtCents);
	let expense = monthlyExpenseCents;
	let month = startMonth;

	const points: ForecastPoint[] = [];

	for (let i = 0; i < months; i++) {
		month = nextMonth(month);
		expense = Math.round(expense * (1 + monthlyInflation));

		const surplus = monthlyIncomeCents - expense;
		cash += surplus;

		const contribution = Math.min(assumptions.monthlyContributionCents, Math.max(0, cash));
		cash -= contribution;
		investments = Math.round(investments * (1 + monthlyReturn)) + contribution;

		const paydown = Math.min(assumptions.debtPaydownCents, debt, Math.max(0, cash));
		cash -= paydown;
		debt -= paydown;

		points.push({
			month,
			cashCents: cash,
			investmentsCents: investments,
			// Guard against -0, which survives JSON and renders as "-$0".
			debtCents: debt === 0 ? 0 : -debt,
			netWorthCents: cash + investments - debt,
			incomeCents: monthlyIncomeCents,
			expenseCents: expense
		});
	}

	return points;
}

/** Months until net worth first reaches `targetCents`, or null within the horizon. */
export function monthsToTarget(points: ForecastPoint[], targetCents: number): number | null {
	const i = points.findIndex((p) => p.netWorthCents >= targetCents);
	return i === -1 ? null : i + 1;
}
