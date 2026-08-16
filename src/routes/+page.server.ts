import type { PageServerLoad } from './$types';
import { currentPosition, netWorthHistory, recentTransactions } from '$lib/server/networth.ts';
import { buildGrid, monthKey } from '$lib/server/budget.ts';
import { project } from '$lib/forecast.ts';
import { loadAssumptions } from '$lib/server/assumptions.ts';
import { monthShort } from '$lib/dates.ts';

export const load: PageServerLoad = async () => {
	const month = monthKey();
	const position = currentPosition();
	const grid = buildGrid(month);
	const history = netWorthHistory(12);

	const forecast = project(
		position,
		month,
		12,
		grid.totals.income,
		// Forecast from the projected run rate rather than the budget target: the
		// run rate is what the last few weeks actually did.
		grid.totals.projectedExpense || grid.totals.expense,
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
