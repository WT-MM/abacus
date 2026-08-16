import type { PageServerLoad } from './$types';
import { currentPosition, netWorthHistory, recentTransactions } from '$lib/server/networth.ts';
import { buildGrid, monthKey, trailingMonthlyAverages } from '$lib/server/budget.ts';
import { project } from '$lib/forecast.ts';
import { loadAssumptions } from '$lib/server/assumptions.ts';
import { monthShort } from '$lib/dates.ts';

export const load: PageServerLoad = async () => {
	const month = monthKey();
	const position = currentPosition();
	const grid = buildGrid(month);
	const history = netWorthHistory(12);

	// Income and spending must come from the same basis. Reading spending from
	// observed data while reading income from the budget sheet made every
	// projection trend down until the sheet was filled in.
	const trailing = trailingMonthlyAverages(month);
	const usingHistory = trailing.monthsUsed > 0;

	const forecast = project(
		position,
		month,
		12,
		usingHistory ? trailing.incomeCents : grid.totals.income,
		usingHistory ? trailing.expenseCents : grid.totals.projectedExpense || grid.totals.expense,
		loadAssumptions()
	);

	return {
		month,
		position: {
			cashCents: position.cashCents,
			investmentsCents: position.investmentsCents,
			debtCents: position.debtCents,
			netWorthCents: position.netWorthCents,
			accountCount: position.accounts.length
		},
		history,
		forecast: forecast.map((p) => ({ label: monthShort(p.month), month: p.month, value: p.netWorthCents })),
		grid,
		recent: recentTransactions(8)
	};
};
