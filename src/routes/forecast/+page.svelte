<script lang="ts">
	import { enhance } from '$app/forms';
	import Money from '$lib/components/Money.svelte';
	import TrendChart from '$lib/components/TrendChart.svelte';
	import { money } from '$lib/money.ts';
	import { monthShort as monthLabel } from '$lib/dates.ts';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const pct = (r: number) => Math.round(r * 1000) / 10;

	const surplus = $derived(data.monthlyIncomeCents - data.monthlyExpenseCents);

	const SOURCE_LABEL = {
		template: 'your master budget',
		history: 'observed history',
		budget: "this month's sheet"
	} as const;

	const horizonHref = (years: number) => `/forecast?years=${years}&step=${data.step}`;
	const stepHref = (step: string) => `/forecast?years=${data.years}&step=${step}`;

</script>

<svelte:head><title>Forecast · Abacus</title></svelte:head>

<header class="head">
	<div>
		<p class="eyebrow">{data.years}-year projection</p>
		<h1>Forecast</h1>
	</div>

	<div class="controls">
		{#each data.horizons as y (y)}
			<a class="btn" class:on={data.years === y} href={horizonHref(y)}>{y}y</a>
		{/each}
		<span class="sep"></span>
		<a class="btn" class:on={data.step === 'month'} href={stepHref('month')}>Monthly</a>
		<a class="btn" class:on={data.step === 'year'} href={stepHref('year')}>Yearly</a>
	</div>
</header>

<p class="caveat">
	Everything on this page is modelled, not measured — it is drawn in brass throughout. It assumes
	the pattern below repeats and returns are steady, which is exactly the assumption reality breaks.
</p>

<p class="basis">
	Running on <b>{SOURCE_LABEL[data.basis.income]}</b>.
	{#if data.basis.income === 'template'}
		<a href="/budget?month=template">Edit the master budget</a> to change the projection — every new
		month starts from it too.
	{:else if data.basis.income === 'history'}
		Averaged over the last complete months, excluding the current one: it is only part-way through,
		and a half month holds a whole rent payment but only half the groceries.
		<a href="/budget?month=template">Set a master budget</a> to project from intent instead.
	{:else}
		Nothing observed yet, so this month's sheet is standing in.
		<a href="/budget?month=template">Set a master budget</a> to make this deliberate.
	{/if}
</p>

<section class="card panel">
	<div class="pad">
		<TrendChart actual={data.history} projected={data.chart} height={160} />
	</div>
</section>

<section class="tiles">
	<article class="card tile">
		<p class="eyebrow">Monthly income</p>
		<p><Money cents={data.monthlyIncomeCents} exact={false} /></p>
	</article>
	<article class="card tile">
		<p class="eyebrow">Monthly spending</p>
		<p><Money cents={data.monthlyExpenseCents} exact={false} projected /></p>
	</article>
	<article class="card tile">
		<p class="eyebrow">Monthly surplus</p>
		<p><Money cents={surplus} exact={false} signed /></p>
	</article>
</section>

{#if data.budgetedInvestmentCents}
	<p class="basis">
		Your master budget puts <Money cents={data.budgetedInvestmentCents} exact={false} /> a month into
		investments, so that is what the projection moves across — the Assumptions figure below is
		ignored while a budgeted amount exists.
	</p>
{/if}

{#if data.observed}
	<p class="observed">
		<span>
			For comparison, the last {data.observed.monthsUsed}
			complete {data.observed.monthsUsed === 1 ? 'month' : 'months'} actually averaged
			<Money cents={data.observed.incomeCents} exact={false} /> in and
			<Money cents={data.observed.expenseCents} exact={false} /> out —
			<Money cents={data.observed.incomeCents - data.observed.expenseCents} exact={false} signed />
			a month.
		</span>
	</p>
{/if}

{#if surplus < 0}
	<p class="banner bad">
		Spending currently outruns income by {money(Math.abs(surplus), { exact: false })} a month, so the
		projection below trends down. Adjust the <a href="/budget?month=template">master budget</a>.
	</p>
{/if}

<section class="card panel">
	<header class="panel-head">
		<h2>Projected position</h2>
		<span class="eyebrow">{data.table.length} {data.step === 'month' ? 'months' : 'years'}</span>
	</header>
	<div class="sheet" class:tall={data.table.length > 14}>
		<table>
			<thead>
				<tr>
					<th scope="col">Month</th>
					<th scope="col" class="r">Cash</th>
					<th scope="col" class="r">Investments</th>
					<th scope="col" class="r">Debt</th>
					<th scope="col" class="r">Net worth</th>
				</tr>
			</thead>
			<tbody>
				<tr class="now">
					<th scope="row">Today</th>
					<td class="r"><Money cents={data.position.cashCents} exact={false} /></td>
					<td class="r"><Money cents={data.position.investmentsCents} exact={false} /></td>
					<td class="r"><Money cents={data.position.debtCents} exact={false} signed /></td>
					<td class="r"><Money cents={data.position.netWorthCents} exact={false} /></td>
				</tr>
				{#each data.table as p (p.month)}
					<tr>
						<th scope="row" class="brassy">{monthLabel(p.month)}</th>
						<td class="r"><Money cents={p.cashCents} exact={false} projected /></td>
						<td class="r"><Money cents={p.investmentsCents} exact={false} projected /></td>
						<td class="r"><Money cents={p.debtCents} exact={false} projected /></td>
						<td class="r"><Money cents={p.netWorthCents} exact={false} projected /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<section class="card panel">
	<header class="panel-head"><h2>Assumptions</h2></header>
	<div class="pad">
		{#if form?.message}<p class="banner bad" role="alert">{form.message}</p>{/if}
		{#if form?.assumptionsSaved}<p class="banner ok" role="status">Assumptions saved.</p>{/if}

		<form method="POST" action="?/save" use:enhance class="grid">
			<label>
				<span class="eyebrow">Investment return · % a year</span>
				<input name="investmentReturn" type="number" step="0.1" value={pct(data.assumptions.investmentReturn)} />
			</label>
			<label>
				<span class="eyebrow">Expense inflation · % a year</span>
				<input name="expenseInflation" type="number" step="0.1" value={pct(data.assumptions.expenseInflation)} />
			</label>
			<label>
				<span class="eyebrow">Moved to investments · $ a month</span>
				<input
					name="monthlyContribution"
					type="number"
					step="1"
					value={data.assumptions.monthlyContributionCents / 100}
				/>
			</label>
			<label>
				<span class="eyebrow">Debt paydown · $ a month</span>
				<input name="debtPaydown" type="number" step="1" value={data.assumptions.debtPaydownCents / 100} />
			</label>
			<button class="btn btn-primary" type="submit">Save assumptions</button>
		</form>

		<p class="note">
			Contributions move cash into investments rather than adding to net worth, and paydown is
			capped by the cash available — a projection that quietly creates money is worse than none.
		</p>
	</div>
</section>

<style>
	.head {
		margin-bottom: 0.75rem;
	}

	h1 {
		font-family: var(--font-display);
		font-variation-settings: 'opsz' 72, 'SOFT' 16, 'WONK' 0;
		font-weight: 600;
		font-size: clamp(1.6rem, 4vw, 2.1rem);
		letter-spacing: -0.02em;
	}

	.caveat {
		max-width: 60ch;
		margin-bottom: 0.6rem;
		color: var(--slate);
		font-size: 0.875rem;
	}

	.basis {
		max-width: 60ch;
		margin-bottom: 1.25rem;
		padding-left: 0.7rem;
		border-left: 2px solid var(--brass);
		color: var(--slate);
		font-size: 0.8125rem;
	}

	.panel {
		margin-bottom: 1.5rem;
		overflow: hidden;
	}

	.panel-head {
		padding: 0.9rem 1rem;
		border-bottom: 1px solid var(--rule);
	}

	.panel-head h2 {
		font-size: 1rem;
		font-weight: 600;
	}

	.pad {
		padding: 1rem;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem;
		margin-bottom: 1.25rem;
	}

	.tile {
		padding: 0.85rem 1rem;
	}

	.tile p:last-child {
		margin-top: 0.3rem;
		font-size: 1.35rem;
	}

	.banner {
		margin-bottom: 1rem;
		padding: 0.65rem 0.85rem;
		background: var(--surface);
		border-left: 2px solid var(--rule-strong);
		font-size: 0.875rem;
	}

	.banner.bad {
		border-left-color: var(--iron);
		color: var(--iron);
	}

	.banner.ok {
		border-left-color: var(--verdigris);
	}

	.sheet {
		overflow-x: auto;
	}

	/* A 360-row monthly table needs a frame; the header stays put inside it. */
	.sheet.tall {
		max-height: 30rem;
		overflow-y: auto;
	}

	.sheet.tall thead th {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--surface);
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
	}

	.controls .sep {
		width: 1px;
		height: 1.4rem;
		background: var(--rule);
		margin: 0 0.35rem;
	}

	.btn.on {
		border-color: var(--verdigris);
		box-shadow: inset 2px 0 0 var(--verdigris);
	}


	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
	}

	.basis b {
		font-weight: 500;
		color: var(--ink);
	}

	/* What actually happened, set apart from what the projection assumes. A
	   budget the spending has drifted from produces a confident, wrong line. */
	.observed {
		max-width: 68ch;
		margin-bottom: 1.25rem;
		padding-left: 0.7rem;
		border-left: 2px solid var(--rule-strong);
		color: var(--slate);
		font-size: 0.8125rem;
	}

	table {
		width: 100%;
		min-width: 38rem;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	th,
	td {
		padding: 0.45rem 1rem;
		text-align: left;
		font-weight: 400;
		white-space: nowrap;
	}

	thead th {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--faint);
		border-bottom: 1px solid var(--rule-strong);
	}

	tbody tr:nth-child(even) {
		background: var(--band);
	}

	tbody th {
		font-weight: 500;
	}

	/* The one observed row on the page, ruled off from the modelled ones below. */
	.now {
		border-bottom: 1px solid var(--rule-strong);
	}

	.brassy {
		color: var(--brass);
	}

	.r {
		text-align: right;
	}

	.grid {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.grid label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		flex: 1 1 11rem;
	}

	.note {
		margin-top: 1rem;
		color: var(--slate);
		font-size: 0.8125rem;
		max-width: 62ch;
	}
</style>
