<script lang="ts">
	import Money from '$lib/components/Money.svelte';
	import TrendChart from '$lib/components/TrendChart.svelte';
	import { money, percent } from '$lib/money.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Long-run averages, not forecasts. Labelled with what they are so the
	// number carries its own caveat.
	const PRESETS = [
		{ label: 'S&P 500 · nominal', rate: 10, note: 'long-run average including inflation' },
		{ label: 'S&P 500 · real', rate: 7, note: 'the same, after inflation' },
		{ label: '60/40 stocks & bonds', rate: 6, note: 'a balanced portfolio' },
		{ label: 'Conservative', rate: 4, note: 'bond-heavy' }
	];

	const ratePct = $derived(Math.round(data.annualReturn * 1000) / 10);
	const contribution = $derived(data.monthlyContributionCents / 100);

	const gainRatio = $derived(
		data.position.gainCents !== null && data.position.costBasisCents > 0
			? data.position.gainCents / data.position.costBasisCents
			: null
	);

	const href = (rate: number) =>
		`/portfolio?rate=${rate}${contribution ? `&add=${contribution}` : ''}`;

	const qty = (n: number) =>
		n.toLocaleString('en-US', { maximumFractionDigits: 4, minimumFractionDigits: 0 });
</script>

<svelte:head><title>Portfolio · Abacus</title></svelte:head>

<header class="hero">
	<p class="eyebrow">
		Portfolio · {data.position.holdings.length} holdings
		{#if data.position.asOf}· as of {data.position.asOf}{/if}
	</p>

	<div class="figure">
		<strong class="num">{money(data.position.investmentBalanceCents, { exact: false })}</strong>
		{#if data.position.gainCents !== null}
			<span class="delta {data.position.gainCents >= 0 ? 'pos' : 'neg'}">
				<span class="num">
					{data.position.gainCents >= 0 ? '▲' : '▼'}
					{money(Math.abs(data.position.gainCents), { exact: false })}
				</span>
				{#if gainRatio !== null}<span class="num ratio">{percent(gainRatio)}</span>{/if}
				<span class="since">against cost basis</span>
			</span>
		{/if}
	</div>
</header>

{#if data.position.holdings.length === 0}
	<p class="empty card">
		No holdings have synced yet. Plaid reports these separately from balances, and some
		institutions do not expose them at all — your investment balances are still counted in net
		worth either way.
	</p>
{/if}

<section class="card panel">
	<header class="panel-head">
		<h2>If this pot is left to grow</h2>
		<span class="eyebrow">{ratePct}% a year</span>
	</header>

	<div class="pad">
		<p class="lede">
			Starting from today's <Money cents={data.position.investmentBalanceCents} exact={false} /> and
			compounding monthly. Nothing here is a prediction — these are long-run historical averages,
			and the next thirty years will not be the average.
		</p>

		<div class="presets">
			{#each PRESETS as p (p.rate)}
				<a class="preset" class:on={ratePct === p.rate} href={href(p.rate)}>
					<span class="rate num">{p.rate}%</span>
					<span class="name">{p.label}</span>
					<span class="note faint">{p.note}</span>
				</a>
			{/each}
		</div>

		<form method="GET" class="custom">
			<label>
				<span class="eyebrow">Or set your own · % a year</span>
				<input name="rate" type="number" step="0.1" value={ratePct} />
			</label>
			<label>
				<span class="eyebrow">Adding · $ a month</span>
				<input name="add" type="number" step="50" min="0" value={contribution} />
			</label>
			<button class="btn" type="submit">Recalculate</button>
		</form>
	</div>

	<div class="chart">
		<TrendChart projected={data.chart} height={170} />
	</div>

	<table>
		<thead>
			<tr>
				<th scope="col">In</th>
				<th scope="col" class="r">Projected value</th>
				<th scope="col" class="r">Growth on today</th>
			</tr>
		</thead>
		<tbody>
			{#each data.milestones as m (m.years)}
				<tr>
					<th scope="row" class="brassy">{m.years} years</th>
					<td class="r"><Money cents={m.valueCents} exact={false} projected /></td>
					<td class="r">
						<Money
							cents={m.valueCents - data.position.investmentBalanceCents}
							exact={false}
							projected
						/>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</section>

{#if data.groups.length}
	<section class="card panel">
		<header class="panel-head">
			<h2>Holdings</h2>
			<span class="eyebrow">
				<Money cents={data.position.holdingsValueCents} exact={false} /> in securities
			</span>
		</header>

		<!-- One header for the whole list, with accounts as group rows — the same
		     shape the budget sheet uses, and it stops the column names repeating
		     once per account. -->
		<div class="sheet">
			<table class="holdings">
				<thead>
					<tr>
						<th scope="col">Symbol</th>
						<th scope="col" class="r">Quantity</th>
						<th scope="col" class="r">Price</th>
						<th scope="col" class="r">Value</th>
						<th scope="col" class="r">Gain</th>
						<th scope="col" class="r">Weight</th>
					</tr>
				</thead>

				{#each data.groups as group (group.accountId)}
					<tbody>
						<tr class="group">
							<th colspan="5" scope="colgroup">{group.label}</th>
							<td class="r"><Money cents={group.valueCents} exact={false} /></td>
						</tr>

						{#each group.holdings as h (h.id)}
							<tr>
								<th scope="row">
									<span class="sym num">{h.symbol ?? '—'}</span>
									<span class="secname faint">{h.name ?? ''}</span>
								</th>
								<td class="r num">{qty(h.quantity)}</td>
								<td class="r">
									{#if h.priceCents !== null}<Money cents={h.priceCents} />{:else}<span class="faint">—</span>{/if}
								</td>
								<td class="r"><Money cents={h.valueCents} exact={false} /></td>
								<td class="r">
									{#if h.gainCents !== null}
										<Money cents={h.gainCents} exact={false} signed />
									{:else}
										<span class="faint">—</span>
									{/if}
								</td>
								<td class="r num faint">{(h.weight * 100).toFixed(1)}%</td>
							</tr>
						{/each}
					</tbody>
				{/each}
			</table>
		</div>
	</section>
{/if}

{#if data.opaque.length || data.position.uninvestedCents !== 0}
	<section class="card panel">
		<header class="panel-head"><h2>Not broken down</h2></header>
		<div class="pad">
			{#if data.opaque.length}
				<p class="lede">
					These investment accounts report a balance but no individual holdings — managed
					portfolios frequently do not expose them. The balance still counts in full towards net
					worth and the projection above.
				</p>
				<ul class="plain">
					{#each data.opaque as a (a.name)}
						<li>
							<span>{a.institution} · {a.name}</span>
							<Money cents={a.cents} exact={false} />
						</li>
					{/each}
				</ul>
			{/if}

			{#if data.position.uninvestedCents !== 0}
				<p class="lede reconcile">
					Securities add up to <Money cents={data.position.holdingsValueCents} exact={false} />,
					while the accounts report
					<Money cents={data.position.investmentBalanceCents} exact={false} /> — a difference of
					<Money cents={data.position.uninvestedCents} exact={false} signed />. That is normally
					uninvested cash, and it is shown rather than hidden because the two figures almost never
					match and a silent gap looks like a bug.
				</p>
			{/if}
		</div>
	</section>
{/if}

<style>
	.hero {
		padding: 0 0 1.5rem;
		margin-bottom: 1.5rem;
		border-bottom: 1px solid var(--rule);
	}

	.figure {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.35rem 1.1rem;
		margin-top: 0.35rem;
	}

	.figure strong {
		font-family: var(--font-display);
		font-variation-settings: 'opsz' 144, 'SOFT' 12, 'WONK' 0;
		font-weight: 600;
		font-size: clamp(2.5rem, 8vw, 4rem);
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

	.pad {
		padding: 1rem;
	}

	.lede {
		max-width: 68ch;
		margin-bottom: 1rem;
		color: var(--slate);
		font-size: 0.8125rem;
	}

	.reconcile {
		margin: 0;
		padding-left: 0.7rem;
		border-left: 2px solid var(--brass);
	}

	.presets {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.preset {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--rule-strong);
		border-radius: var(--radius);
		text-decoration: none;
	}

	.preset:hover {
		border-color: var(--slate);
	}

	/* The chosen rate is marked in brass, matching the projection it drives. */
	.preset.on {
		border-color: var(--brass);
		box-shadow: inset 2px 0 0 var(--brass);
	}

	.preset .rate {
		font-size: 1.1rem;
		font-weight: 500;
	}

	.preset .name {
		font-size: 0.8125rem;
	}

	.preset .note {
		font-size: 0.6875rem;
	}

	.custom {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.custom label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		flex: 1 1 11rem;
	}

	.chart {
		padding: 0 1rem 1rem;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	.sheet {
		overflow-x: auto;
	}

	.holdings {
		min-width: 42rem;
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

	.r {
		text-align: right;
	}

	.brassy {
		color: var(--brass);
	}

	.sym {
		font-weight: 500;
	}

	.secname {
		display: block;
		font-size: 0.75rem;
		max-width: 22rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.group th,
	.group td {
		padding-top: 1rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--faint);
		font-weight: 500;
	}

	/* Group rows sit outside the banding, or the stripes restart per account. */
	tbody tr.group {
		background: none;
	}

	.plain {
		list-style: none;
		margin: 0;
		padding: 0 0 1rem;
	}

	.plain li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 0;
		font-size: 0.875rem;
		border-bottom: 1px solid var(--rule);
	}

	.empty {
		padding: 1.5rem 1rem;
		margin-bottom: 1.5rem;
		color: var(--slate);
		font-size: 0.9375rem;
	}
</style>
