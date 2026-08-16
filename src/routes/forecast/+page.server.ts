import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { setMeta } from '$lib/server/db.ts';
import { currentPosition, netWorthHistory } from '$lib/server/networth.ts';
import { buildGrid, monthKey } from '$lib/server/budget.ts';
import { project, monthsToTarget, DEFAULT_ASSUMPTIONS } from '$lib/forecast.ts';
import { loadAssumptions } from '$lib/server/assumptions.ts';
import { monthShort as label } from '$lib/dates.ts';

const HORIZON = 60;

export const load: PageServerLoad = async ({ url }) => {
	const month = monthKey();
	const position = currentPosition();
	const grid = buildGrid(month);
	const assumptions = loadAssumptions();

	const income = grid.totals.income;
	const expense = grid.totals.projectedExpense || grid.totals.expense;
	const points = project(position, month, HORIZON, income, expense, assumptions);

	const target = Number(url.searchParams.get('target') ?? 0) * 100;


	return {
		assumptions,
		position: {
			cashCents: position.cashCents,
			investmentsCents: position.investmentsCents,
			debtCents: position.debtCents,
			netWorthCents: position.netWorthCents
		},
		monthlyIncomeCents: income,
		monthlyExpenseCents: expense,
		history: netWorthHistory(12),
		chart: points.map((p) => ({ label: label(p.month), value: p.netWorthCents })),
		// One row a year keeps a five-year horizon readable.
		table: points.filter((_, i) => (i + 1) % 12 === 0 || i === 0 || i === 5 || i === 11),
		target: target > 0 ? { cents: target, months: monthsToTarget(points, target) } : null
	};
};

export const actions: Actions = {
	save: async ({ request }) => {
		const form = await request.formData();

		const num = (key: string, fallback: number) => {
			const v = Number(form.get(key));
			return Number.isFinite(v) ? v : fallback;
		};

		const assumptions = {
			// Percentages arrive as whole numbers from the form.
			investmentReturn: num('investmentReturn', 6) / 100,
			expenseInflation: num('expenseInflation', 3) / 100,
			monthlyContributionCents: Math.round(num('monthlyContribution', 0) * 100),
			debtPaydownCents: Math.round(num('debtPaydown', 0) * 100)
		};

		if (assumptions.investmentReturn < -1 || assumptions.investmentReturn > 1) {
			return fail(422, { message: 'Return must be between -100% and 100%' });
		}
		if (assumptions.monthlyContributionCents < 0 || assumptions.debtPaydownCents < 0) {
			return fail(422, { message: 'Contributions cannot be negative' });
		}

		setMeta('forecast.assumptions', JSON.stringify({ ...DEFAULT_ASSUMPTIONS, ...assumptions }));
		return { ok: true };
	}
};
