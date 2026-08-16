<script lang="ts">
	import { enhance } from '$app/forms';
	import Money from '$lib/components/Money.svelte';
	import { dayLabelWithYear } from '$lib/dates.ts';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const pages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));

	const dayOf = dayLabelWithYear;

	function pageHref(n: number) {
		const p = new URLSearchParams();
		if (data.filters.q) p.set('q', data.filters.q);
		if (data.filters.categoryId) p.set('category', data.filters.categoryId);
		if (data.filters.accountId) p.set('account', data.filters.accountId);
		if (n > 1) p.set('page', String(n));
		return `/transactions${p.size ? `?${p}` : ''}`;
	}
</script>

<svelte:head><title>Transactions · Abacus</title></svelte:head>

<header class="head">
	<div>
		<p class="eyebrow">{data.total.toLocaleString()} records</p>
		<h1>Transactions</h1>
	</div>
</header>

<form method="GET" class="filters card">
	<input name="q" value={data.filters.q} placeholder="Search description or merchant" />
	<select name="category">
		<option value="">All categories</option>
		<option value="none" selected={data.filters.categoryId === 'none'}>Uncategorised</option>
		{#each data.categories as c (c.id)}
			<option value={c.id} selected={String(c.id) === data.filters.categoryId}>{c.name}</option>
		{/each}
	</select>
	<select name="account">
		<option value="">All accounts</option>
		{#each data.accounts as a (a.id)}
			<option value={a.id} selected={String(a.id) === data.filters.accountId}>
				{a.institution_name} · {a.name}
			</option>
		{/each}
	</select>
	<button class="btn" type="submit">Filter</button>
</form>

{#if form?.applied !== undefined}
	<p class="banner" role="status">Rule saved and applied to {form.applied} transactions.</p>
{/if}

<div class="card sheet">
	<table>
		<thead>
			<tr>
				<th scope="col">Date</th>
				<th scope="col">Description</th>
				<th scope="col">Account</th>
				<th scope="col">Category</th>
				<th scope="col" class="r">Amount</th>
			</tr>
		</thead>
		<tbody>
			{#each data.rows as t (t.id)}
				<tr>
					<td class="num day">{dayOf(t.posted_on)}</td>
					<th scope="row">
						<span class="desc">{t.merchant ?? t.description}</span>
						{#if t.pending}<span class="pending eyebrow">pending</span>{/if}
						{#if t.source === 'import'}<span class="pending eyebrow">imported</span>{/if}
					</th>
					<td class="faint">{t.account_name}</td>
					<td>
						<form method="POST" action="?/categorise" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<select
								name="categoryId"
								class:locked={t.category_locked}
								onchange={(e) => e.currentTarget.form?.requestSubmit()}
							>
								<option value="">—</option>
								{#each data.categories as c (c.id)}
									<option value={c.id} selected={c.id === t.category_id}>{c.name}</option>
								{/each}
							</select>
						</form>
					</td>
					<td class="r"><Money cents={t.amount_cents} signed /></td>
				</tr>
			{:else}
				<tr><td colspan="5" class="empty">No transactions match those filters.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

{#if pages > 1}
	<nav class="pager" aria-label="Pages">
		{#if data.page > 1}<a class="btn" href={pageHref(data.page - 1)}>← Newer</a>{/if}
		<span class="eyebrow">Page {data.page} of {pages}</span>
		{#if data.page < pages}<a class="btn" href={pageHref(data.page + 1)}>Older →</a>{/if}
	</nav>
{/if}

<section class="card panel">
	<header class="panel-head"><h2>Categorisation rule</h2></header>
	<div class="pad">
		<p class="lede">
			Match text in a description and every future transaction lands in that category. Rules take
			precedence over Plaid's own guess, and never override a category you set by hand.
		</p>
		<form method="POST" action="?/addRule" use:enhance class="rule">
			<label>
				<span class="eyebrow">When description contains</span>
				<input name="pattern" placeholder="e.g. whole foods" required />
			</label>
			<label>
				<span class="eyebrow">Categorise as</span>
				<select name="categoryId" required>
					{#each data.categories as c (c.id)}
						<option value={c.id}>{c.name}</option>
					{/each}
				</select>
			</label>
			<button class="btn" type="submit">Save rule</button>
		</form>
	</div>
</section>

<style>
	.head {
		margin-bottom: 1.25rem;
	}

	h1 {
		font-family: var(--font-display);
		font-variation-settings: 'opsz' 72, 'SOFT' 16, 'WONK' 0;
		font-weight: 600;
		font-size: clamp(1.6rem, 4vw, 2.1rem);
		letter-spacing: -0.02em;
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0.75rem;
		margin-bottom: 1rem;
	}

	.filters input {
		flex: 1 1 14rem;
	}

	.banner {
		margin-bottom: 1rem;
		padding: 0.65rem 0.85rem;
		background: var(--surface);
		border-left: 2px solid var(--verdigris);
		font-size: 0.875rem;
	}

	.sheet {
		overflow-x: auto;
	}

	table {
		width: 100%;
		min-width: 44rem;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	th,
	td {
		padding: 0.4rem 0.75rem;
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
		padding-block: 0.55rem;
	}

	tbody tr:nth-child(even) {
		background: var(--band);
	}

	tbody th {
		font-weight: 500;
		max-width: 22rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.day {
		font-size: 0.75rem;
		color: var(--slate);
	}

	.pending {
		margin-left: 0.4rem;
	}

	.r {
		text-align: right;
	}

	select {
		max-width: 11rem;
		padding: 0.2rem 0.35rem;
		font-size: 0.8125rem;
		border-color: transparent;
		background: transparent;
	}

	select:hover {
		border-color: var(--rule-strong);
		background: var(--surface);
	}

	/* A hand-set category is marked, so it is obvious which rows sync will not touch. */
	select.locked {
		color: var(--ink);
		box-shadow: inset 2px 0 0 var(--verdigris);
	}

	.empty {
		padding: 2rem 1rem;
		text-align: center;
		color: var(--slate);
	}

	.pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		margin: 1rem 0;
	}

	.panel {
		margin: 1.5rem 0;
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

	.lede {
		margin-bottom: 1rem;
		color: var(--slate);
		font-size: 0.8125rem;
	}

	.rule {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.rule label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		flex: 1 1 12rem;
	}

	.rule select {
		border-color: var(--rule-strong);
		background: var(--surface);
		max-width: none;
		padding: 0.4rem 0.55rem;
		font-size: 0.9375rem;
	}
</style>
