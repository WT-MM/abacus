import type { PageServerLoad } from './$types';
import { portfolio, byAccount } from '$lib/server/portfolio.ts';
import { liveAccounts } from '$lib/server/networth.ts';
import { loadAssumptions } from '$lib/server/assumptions.ts';
import { project } from '$lib/forecast.ts';
import { monthKey } from '$lib/server/budget.ts';
import { monthShort } from '$lib/dates.ts';

const HORIZON = 30 * 12;

export const load: PageServerLoad = async ({ url }) => {
	const position = portfolio();
	const assumptions = loadAssumptions();

	// The portfolio question is narrower than the whole-net-worth forecast:
	// "what does this pot become if left alone at rate r?" — no income, no
	// spending, no contributions unless asked for.
	const rate = Number(url.searchParams.get('rate'));
	const annualReturn = Number.isFinite(rate) && rate !== 0 ? rate / 100 : assumptions.investmentReturn;

	const monthlyContribution = Math.max(0, Number(url.searchParams.get('add')) || 0) * 100;

	const growth = project(
		{ cashCents: 0, investmentsCents: position.investmentBalanceCents, debtCents: 0 },
		monthKey(),
		HORIZON,
		// Contributions are funded from a notional cash float so the projection
		// models the portfolio alone rather than the household's whole budget.
		monthlyContribution,
		0,
		{ ...assumptions, investmentReturn: annualReturn, monthlyContributionCents: monthlyContribution }
	);

	const milestoneAt = (years: number) => growth[years * 12 - 1];

	// Investment accounts that reported no holdings at all — Wealthfront's
	// automated portfolios often do — so their balance is still counted but
	// cannot be broken down.
	const withHoldings = new Set(position.holdings.map((h) => h.accountId));
	const opaque = liveAccounts()
		.filter((a) => a.type === 'investment' && !a.hidden && !withHoldings.has(a.id))
		.map((a) => ({ name: a.name, institution: a.institution_name, cents: a.current_cents }));

	return {
		position,
		groups: byAccount(position.holdings),
		opaque,
		annualReturn,
		monthlyContributionCents: monthlyContribution,
		chart: growth
			.filter((_, i) => (i + 1) % 12 === 0)
			.map((p) => ({ label: monthShort(p.month), value: p.investmentsCents })),
		milestones: [5, 10, 20, 30]
			.map((years) => ({ years, point: milestoneAt(years) }))
			.filter((m) => m.point)
			.map((m) => ({ years: m.years, valueCents: m.point.investmentsCents }))
	};
};
