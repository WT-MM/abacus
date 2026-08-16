<script lang="ts">
	import { enhance } from '$app/forms';
	import { startRegistration } from '@simplewebauthn/browser';
	import { invalidateAll } from '$app/navigation';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let busy = $state(false);
	let notice = $state('');
	let problem = $state('');

	async function addPasskey() {
		busy = true;
		problem = '';
		notice = '';
		try {
			const start = await fetch('/api/webauthn/register-start', { method: 'POST' });
			if (!start.ok) throw new Error((await start.json()).message ?? 'Could not start registration');
			const { options, challengeId } = await start.json();

			const response = await startRegistration({ optionsJSON: options });
			const finish = await fetch('/api/webauthn/register-finish', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ challengeId, response, deviceName: navigator.platform || 'Passkey' })
			});
			if (!finish.ok) throw new Error((await finish.json()).message ?? 'Registration failed');

			notice = 'Passkey added.';
			await invalidateAll();
		} catch (err) {
			problem = err instanceof Error ? err.message : 'Could not add that passkey';
		} finally {
			busy = false;
		}
	}

	const when = (iso: string | null) =>
		iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' }) : 'never used';
</script>

<svelte:head><title>Settings · Abacus</title></svelte:head>

<header class="head">
	<p class="eyebrow">Configuration</p>
	<h1>Settings</h1>
</header>

{#if notice}<p class="banner ok" role="status">{notice}</p>{/if}
{#if problem}<p class="banner bad" role="alert">{problem}</p>{/if}
{#if form?.message}<p class="banner bad" role="alert">{form.message}</p>{/if}

<section class="card panel">
	<header class="panel-head">
		<h2>Passkeys</h2>
		<button class="btn" onclick={addPasskey} disabled={busy}>{busy ? 'Waiting…' : 'Add a passkey'}</button>
	</header>

	<ul class="rows">
		{#each data.passkeys as key (key.id)}
			<li>
				<div>
					<p class="name">{key.deviceName}</p>
					<p class="meta faint">Added {when(key.createdAt)} · last used {when(key.lastUsedAt)}</p>
				</div>
				<form method="POST" action="?/deletePasskey" use:enhance>
					<input type="hidden" name="id" value={key.id} />
					<button class="linkish" type="submit">Remove</button>
				</form>
			</li>
		{/each}
	</ul>

	{#if data.passkeys.length < 2}
		<p class="footnote">
			Register a second passkey on another device. With only one, losing that device means losing
			access to the ledger.
		</p>
	{/if}
</section>

<section class="card panel">
	<header class="panel-head"><h2>Categorisation rules</h2></header>
	{#if data.rules.length}
		<ul class="rows">
			{#each data.rules as rule (rule.id)}
				<li>
					<div>
						<p class="name"><code>{rule.pattern}</code> → {rule.category_name}</p>
					</div>
					<form method="POST" action="?/deleteRule" use:enhance>
						<input type="hidden" name="id" value={rule.id} />
						<button class="linkish" type="submit">Delete</button>
					</form>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="footnote">No rules yet. Add them from the Transactions page.</p>
	{/if}
</section>

<section class="card panel">
	<header class="panel-head"><h2>Categories</h2></header>
	<div class="pad">
		<ul class="chips">
			{#each data.categories as c (c.id)}
				<li class="chip" class:income={c.kind === 'income'} class:transfer={c.kind === 'transfer'}>
					{c.name}
				</li>
			{/each}
		</ul>

		<form method="POST" action="?/addCategory" use:enhance class="inline">
			<label>
				<span class="eyebrow">New category</span>
				<input name="name" placeholder="e.g. Childcare" required />
			</label>
			<label>
				<span class="eyebrow">Group</span>
				<input name="grp" placeholder="Living" />
			</label>
			<label>
				<span class="eyebrow">Kind</span>
				<select name="kind">
					<option value="expense">Expense</option>
					<option value="income">Income</option>
					<option value="transfer">Transfer</option>
				</select>
			</label>
			<button class="btn" type="submit">Add</button>
		</form>
	</div>
</section>

<section class="card panel">
	<header class="panel-head"><h2>Environment</h2></header>
	<dl>
		<div><dt>Plaid</dt><dd>{data.environment.plaidReady ? `configured · ${data.environment.plaidEnv}` : 'not configured'}</dd></div>
		<div><dt>Origin</dt><dd class="num">{data.environment.origin}</dd></div>
		<div><dt>Owners</dt><dd class="num">{data.environment.owners.join(', ') || 'none set'}</dd></div>
		<div><dt>Database</dt><dd class="num">{data.environment.dbPath}</dd></div>
		<div><dt>Stored</dt><dd class="num">{data.counts.accounts} accounts · {data.counts.transactions} transactions · {data.counts.holdings} holdings</dd></div>
	</dl>
	<p class="footnote">
		These come from the environment file on the server and cannot be changed here — secrets do not
		belong in a form that a browser can reach.
	</p>
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

	.banner {
		margin-bottom: 1rem;
		padding: 0.65rem 0.85rem;
		background: var(--surface);
		border-left: 2px solid var(--rule-strong);
		font-size: 0.875rem;
	}

	.banner.ok {
		border-left-color: var(--verdigris);
	}

	.banner.bad {
		border-left-color: var(--iron);
		color: var(--iron);
	}

	.panel {
		margin-bottom: 1.5rem;
		overflow: hidden;
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1rem;
		border-bottom: 1px solid var(--rule);
	}

	.panel-head h2 {
		font-size: 1rem;
		font-weight: 600;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.rows li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.7rem 1rem;
		border-bottom: 1px solid var(--rule);
	}

	.name {
		font-size: 0.9375rem;
		font-weight: 500;
	}

	.name code {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		padding: 0.1rem 0.3rem;
		background: var(--surface-sunk);
		border-radius: 2px;
	}

	.meta {
		font-size: 0.75rem;
	}

	.linkish {
		background: none;
		border: 0;
		padding: 0;
		color: var(--slate);
		font-size: 0.8125rem;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.linkish:hover {
		color: var(--iron);
	}

	.footnote {
		padding: 0.85rem 1rem;
		color: var(--slate);
		font-size: 0.8125rem;
		max-width: 68ch;
	}

	.pad {
		padding: 1rem;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		list-style: none;
		margin: 0 0 1.25rem;
		padding: 0;
	}

	.chip {
		padding: 0.2rem 0.55rem;
		border: 1px solid var(--rule-strong);
		border-radius: 999px;
		font-size: 0.8125rem;
	}

	.chip.income {
		border-color: var(--verdigris);
		color: var(--verdigris);
	}

	.chip.transfer {
		border-style: dashed;
		color: var(--slate);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
		padding-top: 1rem;
		border-top: 1px solid var(--rule);
	}

	.inline label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		flex: 1 1 10rem;
	}

	dl {
		margin: 0;
	}

	dl div {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		padding: 0.55rem 1rem;
		border-bottom: 1px solid var(--rule);
		font-size: 0.875rem;
	}

	dt {
		flex: 0 0 7rem;
		color: var(--slate);
	}

	dd {
		margin: 0;
		word-break: break-all;
	}
</style>
