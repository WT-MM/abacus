<script lang="ts">
	import Money from '$lib/components/Money.svelte';
	import TrendChart from '$lib/components/TrendChart.svelte';
	import { money, moneyCompact, percent } from '$lib/money.ts';
	import { monthLabel, dayLabel } from '$lib/dates.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const previous = $derived(data.history.length > 1 ? data.history[data.history.length - 2].value : null);
	const delta = $derived(previous === null ? null : data.position.netWorthCents - previous);
	const deltaRatio = $derived(previous && previous !== 0 ? (delta ?? 0) / Math.abs(previous) : null);

	const tiles = $derived([
		{ label: 'Cash', cents: data.position.cashCents },
		{ label: 'Investments', cents: data.position.investmentsCents },
		{ label: 'Debt', cents: data.position.debtCents }
	]);

	// The overview shows only what is moving; the full sheet lives in /budget.
	const active = $derived(
		data.grid.rows
			.filter((r) => r.kind === 'expense' && (r.budgetCents !== 0 || r.actualCents !== 0))
			.sort((a, b) => b.actualCents - a.actualCents)
			.slice(0, 6)
	);

	const expenseActual = $derived(
		data.grid.rows.filter((r) => r.kind === 'expense').reduce((a, r) => a + r.actualCents, 0)
	);

	const monthName = $derived(monthLabel(data.month));

	const dayOf = dayLabel;
</script>

<svelte:head><title>Overview · Abacus</title></svelte:head>

<header class="hero">
	<p class="eyebrow">Net worth · {data.position.accountCount} accounts</p>

	<div class="figure">
		<strong class="num">{money(data.position.netWorthCents, { exact: false })}</strong>
		{#if delta !== null}
			<span class="delta {delta >= 0 ? 'pos' : 'neg'}">
				<span class="num">{delta >= 0 ? '▲' : '▼'} {moneyCompact(Math.abs(delta))}</span>
				{#if deltaRatio !== null}<span class="num ratio">{percent(deltaRatio)}</span>{/if}
				<span class="since">since last month</span>
			</span>
		{:else}
			<span class="delta faint">History builds from your first sync</span>
		{/if}
	</div>

	<TrendChart actual={data.history} projected={data.forecast} />
</header>

<section class="tiles">
	{#each tiles as tile (tile.label)}
		<article class="card tile">
			<p class="eyebrow">{tile.label}</p>
			<p><Money cents={tile.cents} exact={false} signed={tile.label === 'Debt'} /></p>
		</article>
	{/each}
</section>

<section class="card panel">
	<header class="panel-head">
		<h2>Budget · {monthName}</h2>
		<a href="/budget">Open sheet →</a>
	</header>

	{#if active.length}
		<table>
			<thead>
				<tr>
					<th scope="col">Category</th>
					<th scope="col" class="r">Budget</th>
					<th scope="col" class="r">Actual</th>
					<th scope="col" class="r">Left</th>
					<th scope="col" class="r">Proj</th>
				</tr>
			</thead>
			<tbody>
				{#each active as row (row.categoryId)}
					<tr>
						<th scope="row">{row.name}</th>
						<td class="r"><Money cents={row.budgetCents} exact={false} /></td>
						<td class="r"><Money cents={row.actualCents} exact={false} /></td>
						<td class="r">
							<Money cents={row.remainingCents} exact={false} signed />
						</td>
						<td class="r">
							<Money
								cents={row.projectedCents}
								exact={false}
								projected={row.projectedCents !== row.actualCents}
							/>
						</td>
					</tr>
				{/each}
			</tbody>
			<tfoot>
				<tr class="rule-double">
					<th scope="row">Total spending</th>
					<td class="r"><Money cents={data.grid.totals.expense} exact={false} /></td>
					<td class="r"><Money cents={expenseActual} exact={false} /></td>
					<td class="r"></td>
					<td class="r">
						<Money
							cents={data.grid.totals.projectedExpense}
							exact={false}
							projected={data.grid.totals.projectedExpense !== expenseActual}
						/>
					</td>
				</tr>
			</tfoot>
		</table>
	{:else}
		<p class="empty">
			No spending recorded for {monthName} yet. Connect an account or import a statement to fill the sheet.
			<a href="/accounts">Add an account →</a>
		</p>
	{/if}
</section>

<section class="card panel">
	<header class="panel-head">
		<h2>Recent activity</h2>
		<a href="/transactions">All transactions →</a>
	</header>

	{#if data.recent.length}
		<ul class="feed">
			{#each data.recent as t (t.id)}
				<li>
					<span class="num day">{dayOf(t.posted_on)}</span>
					<span class="what">
						<span class="desc">{t.merchant ?? t.description}</span>
						<span class="meta faint">
							{t.account_name}{t.category_name ? ` · ${t.category_name}` : ''}{t.pending ? ' · pending' : ''}
						</span>
					</span>
					<Money cents={t.amount_cents} signed class="amount" />
				</li>
			{/each}
		</ul>
	{:else}
		<p class="empty">Nothing here yet.</p>
	{/if}
</section>

<style>
	.hero {
		padding: 0 0 1.75rem;
		margin-bottom: 1.5rem;
		border-bottom: 1px solid var(--rule);
	}

	.figure {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.35rem 1.1rem;
		margin: 0.35rem 0 1.25rem;
	}

	/* Fraunces at a high optical size reads like engraved banknote type — the
	   one place in the app where the display face appears. */
	.figure strong {
		font-family: var(--font-display);
		font-variation-settings: 'opsz' 144, 'SOFT' 12, 'WONK' 0;
		font-weight: 600;
		font-size: clamp(2.75rem, 9vw, 4.5rem);
		line-height: 0.95;
		letter-spacing: -0.035em;
	}

	.delta {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.9375rem;
	}

	.ratio {
		opacity: 0.75;
	}

	.since {
		color: var(--slate);
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}

	.tile {
		padding: 0.85rem 1rem;
	}

	.tile p:last-child {
		margin-top: 0.3rem;
		font-size: 1.5rem;
	}

	.panel {
		margin-bottom: 1.5rem;
		overflow: hidden;
	}

	.panel-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1rem;
		border-bottom: 1px solid var(--rule);
	}

	.panel-head h2 {
		font-size: 1rem;
		font-weight: 600;
	}

	.panel-head a {
		font-size: 0.8125rem;
		color: var(--slate);
		text-decoration: none;
		white-space: nowrap;
	}

	.panel-head a:hover {
		color: var(--verdigris);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	th,
	td {
		padding: 0.5rem 1rem;
		text-align: left;
		font-weight: 400;
	}

	thead th {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--faint);
		padding-block: 0.55rem;
	}

	.r {
		text-align: right;
	}

	/* Faint alternating bands, the way columnar ledger paper is ruled. */
	tbody tr:nth-child(even) {
		background: var(--band);
	}

	tbody th {
		font-weight: 500;
	}

	tfoot th,
	tfoot td {
		padding-top: 0.6rem;
		font-weight: 500;
	}

	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.feed li {
		display: grid;
		grid-template-columns: 4.25rem 1fr auto;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0.55rem 1rem;
		font-size: 0.875rem;
	}

	.feed li:nth-child(even) {
		background: var(--band);
	}

	.day {
		font-size: 0.75rem;
		color: var(--slate);
	}

	.what {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.desc {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		font-size: 0.75rem;
	}

	.empty {
		padding: 1.5rem 1rem;
		color: var(--slate);
		font-size: 0.9375rem;
	}

	.empty a {
		color: var(--verdigris);
		text-decoration: none;
	}

	@media (max-width: 34rem) {
		table :is(th, td):nth-child(4) {
			display: none;
		}
	}
</style>
