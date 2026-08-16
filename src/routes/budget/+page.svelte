<script lang="ts">
	import { enhance } from '$app/forms';
	import { money } from '$lib/money.ts';
	import Money from '$lib/components/Money.svelte';
	import { monthLabel } from '$lib/dates.ts';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/** Category id of the cell currently open for editing. */
	let editing = $state<number | null>(null);
	let draft = $state('');
	let inputEl = $state<HTMLInputElement | null>(null);

	const monthName = $derived(data.template ? 'Master budget' : monthLabel(data.grid.month));

	// Rows keep their sheet position when grouped, so B7 in a formula and row 7
	// on screen are always the same row.
	const groups = $derived.by(() => {
		const out: Array<{ name: string; rows: typeof data.grid.rows }> = [];
		for (const row of data.grid.rows) {
			const name = row.group ?? 'Other';
			if (out.at(-1)?.name !== name) out.push({ name, rows: [] });
			out.at(-1)!.rows.push(row);
		}
		return out;
	});

	const income = $derived(data.grid.rows.filter((r) => r.kind === 'income'));
	const expense = $derived(data.grid.rows.filter((r) => r.kind === 'expense'));
	const actualTotal = (rows: typeof data.grid.rows) => rows.reduce((a, r) => a + r.actualCents, 0);

	// Brass is reserved for numbers that were actually extrapolated. When the
	// projection equals the observed total, it is an observation.
	const expenseActual = $derived(actualTotal(expense));
	const expenseModelled = $derived(data.grid.totals.projectedExpense !== expenseActual);

	function open(row: (typeof data.grid.rows)[number]) {
		editing = row.categoryId;
		draft = row.formula;
	}

	function close() {
		editing = null;
	}

	$effect(() => {
		if (editing !== null && inputEl) inputEl.select();
	});

	function keydown(event: KeyboardEvent, index: number) {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			return;
		}
		// Enter commits and steps down a row, the way a sheet behaves.
		if (event.key === 'Enter') {
			const next = data.grid.rows[index + 1];
			queueMicrotask(() => {
				if (next) open(next);
				else close();
			});
		}
	}
</script>

<svelte:head><title>Budget · Abacus</title></svelte:head>

<header class="head">
	<div>
		<p class="eyebrow">{data.template ? 'Template · every new month starts here' : 'Budget sheet'}</p>
		<h1>{monthName}</h1>
	</div>

	<div class="controls">
		{#if data.template}
			<a class="btn" href="/budget">Back to this month</a>
		{:else}
			<a class="btn" href="/budget?month={data.prevMonth}" aria-label="Previous month">←</a>
			{#if !data.isCurrent}<a class="btn" href="/budget">Today</a>{/if}
			<a class="btn" href="/budget?month={data.nextMonth}" aria-label="Next month">→</a>
			<form method="POST" action="?/copyForward" use:enhance>
				<input type="hidden" name="month" value={data.grid.month} />
				<button class="btn" type="submit">Copy last month</button>
			</form>
			<form method="POST" action="?/saveAsTemplate" use:enhance>
				<input type="hidden" name="month" value={data.grid.month} />
				<button class="btn" type="submit">Save as master</button>
			</form>
			<a class="btn" href="/budget?month={data.templateMonth}">Master budget</a>
		{/if}
	</div>
</header>

{#if data.template}
	<p class="hint template-note">
		This sheet is not a month. It is the standing budget that any month you have not yet touched
		inherits, and what the <a href="/forecast">forecast</a> projects from. Actual and Left are blank
		here because there is nothing to compare against — only column B applies.
	</p>
{:else if data.seeded}
	<p class="hint seeded-note">
		Started from your master budget ({data.seeded} {data.seeded === 1 ? 'row' : 'rows'}). Edits here
		affect only {monthName}.
	</p>
{/if}

<p class="hint">
	Type a number, or a formula starting with <code>=</code>. Cells can reference each other:
	<code>=SUM(B4:B9)</code>, <code>=B[Rent]*1.05</code>, <code>=PREV()</code> for this row last month.
	Named values from <a href="/settings">Settings</a> work too — <code>=avg_meal_cost*20</code>.
</p>

{#if form?.message}
	<p class="error" role="alert">{form.message}</p>
{/if}

<div class="sheet card">
	<table>
		<thead>
			<tr>
				<th class="gutter" scope="col"><span class="sr">Row</span></th>
				<th scope="col">A · Category</th>
				<th scope="col" class="r">B · Budget</th>
				<th scope="col" class="r">C · Actual</th>
				<th scope="col" class="r">D · Left</th>
				<th scope="col" class="r">E · Projected</th>
			</tr>
		</thead>

		{#each groups as group (group.name)}
			<tbody>
				<tr class="group">
					<td class="gutter"></td>
					<th colspan="5" scope="colgroup">{group.name}</th>
				</tr>

				{#each group.rows as row (row.categoryId)}
					{@const index = row.row - 1}
					{@const over = row.kind === 'expense' && row.remainingCents < 0}
					<tr class:over>
						<td class="gutter num">{row.row}</td>
						<th scope="row">{row.name}</th>

						<td class="r cell">
							{#if editing === row.categoryId}
								<form
									method="POST"
									action="?/setCell"
									use:enhance={() => {
										close();
										return async ({ update }) => update({ reset: false });
									}}
								>
									<input type="hidden" name="month" value={data.grid.month} />
									<input type="hidden" name="categoryId" value={row.categoryId} />
									<input
										bind:this={inputEl}
										bind:value={draft}
										name="formula"
										class="num editor"
										autocomplete="off"
										spellcheck="false"
										onblur={(e) => e.currentTarget.form?.requestSubmit()}
										onkeydown={(e) => keydown(e, index)}
									/>
								</form>
							{:else}
								<button type="button" class="num value" onclick={() => open(row)}>
									{#if row.error}
										<span class="err">{row.error}</span>
									{:else}
										{money(row.budgetCents, { exact: false })}
									{/if}
									{#if row.formula.startsWith('=')}<i class="fx" aria-label="formula">ƒ</i>{/if}
								</button>
							{/if}
						</td>

						<td class="r">
							<!-- An Actual figure with no way to see what is behind it is just a
							     number to be trusted. This links to exactly those rows. -->
							{#if data.template}
								<span class="faint">—</span>
							{:else if row.actualCents !== 0}
								<a
									class="drill"
									href="/transactions?category={row.categoryId}&month={data.grid.month}"
									title="Show these transactions"
								>
									<Money cents={row.actualCents} exact={false} />
								</a>
							{:else}
								<Money cents={row.actualCents} exact={false} />
							{/if}
						</td>
						<td class="r">
							{#if data.template}
								<span class="faint">—</span>
							{:else}
								<Money cents={row.remainingCents} exact={false} signed invert={row.kind === 'income'} />
							{/if}
						</td>
						<td class="r">
							{#if data.template}
								<span class="faint">—</span>
							{:else}
								<Money
									cents={row.projectedCents}
									exact={false}
									projected={row.projectedCents !== row.actualCents}
								/>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		{/each}

		<tfoot>
			<tr class="rule-double">
				<td class="gutter"></td>
				<th scope="row">Income</th>
				<td class="r"><Money cents={data.grid.totals.income} exact={false} /></td>
				<td class="r"><Money cents={actualTotal(income)} exact={false} /></td>
				<td class="r"></td>
				<td class="r"></td>
			</tr>
			<tr>
				<td class="gutter"></td>
				<th scope="row">Spending</th>
				<td class="r"><Money cents={data.grid.totals.expense} exact={false} /></td>
				<td class="r"><Money cents={expenseActual} exact={false} /></td>
				<td class="r"></td>
				<td class="r">
					<Money cents={data.grid.totals.projectedExpense} exact={false} projected={expenseModelled} />
				</td>
			</tr>
			<tr class="net rule-double">
				<td class="gutter"></td>
				<th scope="row">Net</th>
				<td class="r"><Money cents={data.grid.totals.net} exact={false} signed /></td>
				<td class="r"><Money cents={actualTotal(income) - expenseActual} exact={false} signed /></td>
				<td class="r"></td>
				<td class="r">
					<Money cents={data.grid.totals.projectedNet} exact={false} signed projected={expenseModelled} />
				</td>
			</tr>
		</tfoot>
	</table>
</div>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}

	h1 {
		font-family: var(--font-display);
		font-variation-settings: 'opsz' 72, 'SOFT' 16, 'WONK' 0;
		font-weight: 600;
		font-size: clamp(1.6rem, 4vw, 2.1rem);
		letter-spacing: -0.02em;
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.template-note,
	.seeded-note {
		padding-left: 0.7rem;
		border-left: 2px solid var(--brass);
	}

	.seeded-note {
		border-left-color: var(--verdigris);
	}

	.hint {
		margin-bottom: 1rem;
		color: var(--slate);
		font-size: 0.8125rem;
	}

	.hint code {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		padding: 0.1rem 0.3rem;
		background: var(--surface-sunk);
		border-radius: 2px;
	}

	.error {
		margin-bottom: 1rem;
		padding: 0.6rem 0.8rem;
		border-left: 2px solid var(--iron);
		background: var(--surface);
		color: var(--iron);
		font-size: 0.875rem;
	}

	/* The sheet scrolls inside its own frame; the page never scrolls sideways. */
	.sheet {
		overflow-x: auto;
	}

	table {
		width: 100%;
		min-width: 40rem;
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
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--surface);
		border-bottom: 1px solid var(--rule-strong);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--faint);
		padding-block: 0.55rem;
	}

	.r {
		text-align: right;
	}

	/* Row gutter, ruled off like the margin of a columnar pad. */
	.gutter {
		width: 2.5rem;
		padding-inline: 0.5rem;
		border-right: 1px solid var(--rule);
		color: var(--faint);
		font-size: 0.6875rem;
		text-align: right;
	}

	.group th {
		padding-top: 1rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--faint);
	}

	tbody tr:nth-child(even):not(.group) {
		background: var(--band);
	}

	tbody th {
		font-weight: 500;
	}

	.over th {
		color: var(--iron);
	}

	.cell {
		padding: 0;
	}

	.value,
	.editor {
		width: 100%;
		padding: 0.4rem 0.75rem;
		font-size: 0.875rem;
		text-align: right;
		background: none;
		border: 1px solid transparent;
		border-radius: 0;
		cursor: text;
	}

	.value:hover {
		border-color: var(--rule-strong);
		background: var(--surface);
	}

	.editor {
		background: var(--surface);
		border-color: var(--verdigris);
		outline: none;
	}

	/* Underlined only on hover: a whole column of permanently underlined figures
	   would fight the tabular alignment this sheet depends on. */
	.drill {
		color: inherit;
		text-decoration: none;
		border-bottom: 1px solid transparent;
	}

	.drill:hover {
		border-bottom-color: var(--verdigris);
	}

	/* A quiet mark that this cell holds a formula rather than a typed number. */
	.fx {
		margin-left: 0.35rem;
		color: var(--verdigris);
		font-family: var(--font-display);
		font-style: italic;
		font-size: 0.75rem;
	}

	.err {
		color: var(--iron);
		font-size: 0.75rem;
	}

	tfoot th,
	tfoot td {
		padding-block: 0.55rem;
		font-weight: 500;
	}

	.net th {
		font-weight: 600;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
