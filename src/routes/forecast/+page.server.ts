import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { setMeta } from '$lib/server/db.ts';
import { currentPosition, netWorthHistory } from '$lib/server/networth.ts';
import { buildGrid, monthKey, trailingMonthlyAverages } from '$lib/server/budget.ts';
import { project, monthsToTarget, DEFAULT_ASSUMPTIONS } from '$lib/forecast.ts';
import { loadAssumptions } from '$lib/server/assumptions.ts';
import { loadPlan, savePlan, resolveInputs, type Plan } from '$lib/server/plan.ts';
import { monthShort as label } from '$lib/dates.ts';

// Not exported: SvelteKit only permits load/actions/config and friends from a
// +page.server.ts, and rejects anything else at build time. It reaches the page
// through the returned payload instead.
const HORIZONS = [1, 5, 30] as const;

export const load: PageServerLoad = async ({ url }) => {
	const month = monthKey();
	const position = currentPosition();
	const grid = buildGrid(month);
	const assumptions = loadAssumptions();
	const plan = loadPlan();

	const requested = Number(url.searchParams.get('years'));
	const years = (HORIZONS as readonly number[]).includes(requested) ? requested : 5;

	// Month by month is the useful view over a year; over thirty it is 360 rows
	// of noise, so the default follows the horizon while staying overridable.
	const step = url.searchParams.get('step') === 'month' || (years <= 1 && url.searchParams.get('step') !== 'year')
		? 'month'
		: 'year';

	const inputs = resolveInputs({
		plan,
		trailing: trailingMonthlyAverages(month),
		budgetIncomeCents: grid.totals.income,
		budgetExpenseCents: grid.totals.projectedExpense || grid.totals.expense
	});

	const points = project(position, month, years * 12, inputs.incomeCents, inputs.expenseCents, assumptions);

	const target = Number(url.searchParams.get('target') ?? 0) * 100;

	return {
		assumptions,
		plan,
		years,
		step,
		horizons: HORIZONS,
		position: {
			cashCents: position.cashCents,
			investmentsCents: position.investmentsCents,
			debtCents: position.debtCents,
			netWorthCents: position.netWorthCents
		},
		monthlyIncomeCents: inputs.incomeCents,
		monthlyExpenseCents: inputs.expenseCents,
		// Surfaced so the page can say where each number came from. A projection
		// whose inputs are unexplained invites more trust than it has earned.
		basis: { income: inputs.incomeSource, expense: inputs.expenseSource },
		history: netWorthHistory(12),
		chart: points.map((p) => ({ label: label(p.month), value: p.netWorthCents })),
		table: step === 'month' ? points : points.filter((_, i) => (i + 1) % 12 === 0),
		target: target > 0 ? { cents: target, months: monthsToTarget(points, target) } : null
	};
};

/** Blank means "derive it"; a number means "use exactly this". */
function optionalCents(raw: FormDataEntryValue | null): number | null {
	const text = String(raw ?? '').trim();
	if (!text) return null;
	const value = Number(text);
	return Number.isFinite(value) ? Math.round(value * 100) : null;
}

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
		// Each action reports its own flag; a shared `ok` made saving the plan
		// announce "Assumptions saved" in the wrong panel.
		return { ok: true, assumptionsSaved: true };
	},

	plan: async ({ request }) => {
		const form = await request.formData();
		const plan: Plan = {
			incomeCents: optionalCents(form.get('planIncome')),
			expenseCents: optionalCents(form.get('planExpense'))
		};

		if ((plan.incomeCents ?? 0) < 0 || (plan.expenseCents ?? 0) < 0) {
			return fail(422, { message: 'Income and spending cannot be negative' });
		}

		savePlan(plan);
		return { ok: true, planSaved: true };
	},

	clearPlan: async () => {
		savePlan({ incomeCents: null, expenseCents: null });
		return { ok: true, planCleared: true };
	}
};
