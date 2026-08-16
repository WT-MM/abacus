<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import Money from '$lib/components/Money.svelte';
	import { signedCents } from '$lib/accounts.ts';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/** The slice of Plaid's Link callback metadata this app uses. */
	type LinkMetadata = { institution?: { institution_id?: string; name?: string } | null };

	let linking = $state(false);
	let syncing = $state(false);
	let notice = $state('');
	let problem = $state('');

	/**
	 * A failed call must never land in `notice`, which renders as a green
	 * success banner — a 502 shown that way reads as a working connection.
	 */
	async function post(url: string, payload: unknown) {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		const body = await res.json().catch(() => ({}));
		return {
			ok: res.ok && body.ok !== false,
			body,
			message: body.message ?? `Request failed (${res.status})`
		};
	}

	/** Plaid Link is loaded on demand, not on every page view. */
	async function loadLinkScript(): Promise<void> {
		if (typeof window !== 'undefined' && 'Plaid' in window) return;
		await new Promise<void>((resolve, reject) => {
			const el = document.createElement('script');
			el.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
			el.onload = () => resolve();
			el.onerror = () => reject(new Error('Could not load Plaid Link'));
			document.head.appendChild(el);
		});
	}

	async function link(itemId?: number) {
		linking = true;
		problem = '';
		notice = '';
		try {
			await loadLinkScript();
			const res = await fetch('/api/link/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(itemId ? { itemId } : {})
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Could not start Link');
			const { linkToken } = await res.json();

			// An OAuth institution such as Chase navigates the whole page away and
			// returns to /link/oauth, which must resume Link with this same token.
			sessionStorage.setItem('abacus.linkToken', linkToken);
			if (itemId) sessionStorage.setItem('abacus.linkItemId', String(itemId));
			else sessionStorage.removeItem('abacus.linkItemId');

			// @ts-expect-error injected by the Plaid script
			const handler = window.Plaid.create({
				token: linkToken,
				// Plaid does not await this callback, so anything thrown inside it
				// becomes an unhandled rejection and the user sees nothing at all.
				onSuccess: async (publicToken: string, metadata: LinkMetadata) => {
					try {
						// Update mode repairs the existing Item in place and returns no
						// usable public token, so there is nothing to exchange — but the
						// server still has to re-check the item, or its row stays
						// 'needs_repair' and this page keeps offering Reconnect.
						const res = itemId
							? await post('/api/link/repaired', { itemId })
							: await post('/api/link/exchange', {
									publicToken,
									// Lets the server refuse a duplicate before exchanging,
									// which is the only point at which a slot can still be saved.
									institutionId: metadata?.institution?.institution_id ?? null
								});

						if (!res.ok) {
							problem = res.message;
						} else if (itemId) {
							problem = '';
							notice = 'Connection repaired.';
						} else {
							problem = '';
							notice = `Connected ${res.body.institution}. Run a sync to pull data.`;
						}
						await invalidateAll();
					} catch (err) {
						problem = err instanceof Error ? err.message : 'Could not finish connecting';
					} finally {
						linking = false;
					}
				},
				onExit: (err: { display_message?: string } | null) => {
					if (err?.display_message) problem = err.display_message;
					linking = false;
				}
			});
			handler.open();
			// `linking` stays true while Plaid's modal is open; onSuccess and onExit
			// clear it. Clearing it here would show the button as idle mid-flow.
		} catch (err) {
			problem = err instanceof Error ? err.message : 'Could not open Plaid Link';
			linking = false;
		}
	}

	async function sync() {
		syncing = true;
		problem = '';
		try {
			const res = await fetch('/api/sync', { method: 'POST' });
			const body = await res.json();
			notice = body.started ? 'Sync started. This runs in the background.' : body.message;
			// The child process writes as it goes; refresh shortly after.
			setTimeout(() => invalidateAll(), 4000);
		} catch {
			problem = 'Could not start the sync';
		} finally {
			syncing = false;
		}
	}

	const when = (iso: string | null) =>
		iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'never';

	const byInstitution = $derived.by(() => {
		const map = new Map<string, typeof data.accounts>();
		for (const a of data.accounts) {
			const key = a.institution_name ?? 'Other';
			if (!map.has(key)) map.set(key, []);
			map.get(key)!.push(a);
		}
		return [...map];
	});
</script>

<svelte:head><title>Accounts · Abacus</title></svelte:head>

<header class="head">
	<div>
		<p class="eyebrow">Connections</p>
		<h1>Accounts</h1>
	</div>
	<div class="controls">
		<button class="btn" onclick={sync} disabled={syncing || !data.items.length}>
			{syncing ? 'Starting…' : 'Sync now'}
		</button>
		<button class="btn btn-primary" onclick={() => link()} disabled={linking || !data.plaidReady}>
			{linking ? 'Opening…' : 'Connect an institution'}
		</button>
	</div>
</header>

{#if notice}<p class="banner ok" role="status">{notice}</p>{/if}
{#if problem}<p class="banner bad" role="alert">{problem}</p>{/if}
{#if form?.message}<p class="banner bad" role="alert">{form.message}</p>{/if}
{#if form?.imported}
	<p class="banner ok" role="status">
		Imported {form.imported.inserted} transactions from a {form.imported.institution}
		{form.imported.format.toUpperCase()} file.
		{#if form.imported.duplicates}{form.imported.duplicates} were already present.{/if}
		{#if form.imported.overlapping}
			{form.imported.overlapping} matched transactions already synced from Plaid and were left out.
		{/if}
		{#if form.imported.unreadable}{form.imported.unreadable} rows could not be read.{/if}
	</p>
{/if}

{#if !data.plaidReady}
	<p class="banner note">
		Plaid is not configured, so automatic sync is off. You can still import CSV or OFX files below.
		Add <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code> to the environment to turn sync on.
	</p>
{/if}

<section class="card panel">
	<header class="panel-head">
		<h2>Linked institutions</h2>
		<span class="eyebrow">{data.itemsUsed} of 10 Plaid slots used</span>
	</header>

	{#if data.items.length}
		<ul class="items">
			{#each data.items as item (item.id)}
				<li>
					<div>
						<p class="name">{item.institution_name}</p>
						<p class="meta faint">
							Last sync {when(item.last_synced_at)}
							{#if item.consent_expires_at}· consent expires {when(item.consent_expires_at)}{/if}
						</p>
						{#if item.status !== 'ok'}
							<p class="meta bad-text">{item.error_code ?? 'Error'} — {item.error_message}</p>
						{/if}
					</div>
					{#if item.status === 'ok'}
						<span class="pill ok">Connected</span>
					{:else}
						<button class="btn" onclick={() => link(item.id)} disabled={linking}>Reconnect</button>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="footnote">
			Reconnecting repairs the existing connection rather than making a new one — Plaid's free tier
			never returns a slot once it is used.
		</p>
	{:else}
		<p class="empty">
			No institutions linked yet. Connecting Chase, Fidelity and Wealthfront uses three of your ten
			free Plaid slots.
		</p>
	{/if}
</section>

<section class="card panel">
	<header class="panel-head"><h2>Accounts</h2></header>

	{#if data.accounts.length}
		{#each byInstitution as [institution, accounts] (institution)}
			<h3 class="eyebrow inst">{institution}</h3>
			<table>
				<tbody>
					{#each accounts as a (a.id)}
						<tr class:dim={a.hidden}>
							<th scope="row">
								{a.name}
								{#if a.mask}<span class="faint num">····{a.mask}</span>{/if}
								<span class="faint type">{a.subtype ?? a.type}</span>
							</th>
							<td class="r"><Money cents={signedCents(a)} signed /></td>
							<td class="r act">
								<form method="POST" action="?/toggleHidden" use:enhance>
									<input type="hidden" name="id" value={a.id} />
									<button class="linkish" type="submit">{a.hidden ? 'Show' : 'Hide'}</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/each}
	{:else}
		<p class="empty">No accounts yet.</p>
	{/if}
</section>

<section class="card panel">
	<header class="panel-head"><h2>Import a statement</h2></header>
	<div class="pad">
		<p class="lede">
			Chase, Fidelity and Wealthfront all export CSV, and Chase also offers QFX. Columns are detected
			by name, so exports work without configuration. Anything already pulled from Plaid is matched
			on date and amount and skipped.
		</p>

		<form method="POST" action="?/import" enctype="multipart/form-data" use:enhance class="import">
			<label>
				<span class="eyebrow">Into account</span>
				<select name="accountId" required>
					{#each data.accounts as a (a.id)}
						<option value={a.id}>{a.institution_name} · {a.name}</option>
					{/each}
				</select>
			</label>
			<label>
				<span class="eyebrow">File</span>
				<input type="file" name="file" accept=".csv,.ofx,.qfx,text/csv" required />
			</label>
			<button class="btn" type="submit" disabled={!data.accounts.length}>Import</button>
		</form>

		<form method="POST" action="?/addManual" use:enhance class="import">
			<label>
				<span class="eyebrow">Or add an account by hand</span>
				<input name="name" placeholder="e.g. Cash envelope" required />
			</label>
			<label>
				<span class="eyebrow">Type</span>
				<select name="type">
					<option value="depository">Cash</option>
					<option value="investment">Investment</option>
					<option value="credit">Credit</option>
					<option value="loan">Loan</option>
				</select>
			</label>
			<button class="btn" type="submit">Add</button>
		</form>
	</div>
</section>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.25rem;
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

	.banner.note {
		border-left-color: var(--brass);
	}

	.banner code {
		font-family: var(--font-mono);
		font-size: 0.75rem;
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

	.items {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.items li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--rule);
	}

	.name {
		font-weight: 500;
	}

	.meta {
		font-size: 0.75rem;
	}

	.bad-text {
		color: var(--iron);
	}

	.pill {
		padding: 0.2rem 0.55rem;
		border: 1px solid var(--rule-strong);
		border-radius: 999px;
		font-size: 0.75rem;
		white-space: nowrap;
	}

	.pill.ok {
		border-color: var(--verdigris);
		color: var(--verdigris);
	}

	.footnote,
	.empty,
	.lede {
		padding: 0.9rem 1rem;
		color: var(--slate);
		font-size: 0.8125rem;
	}

	.lede {
		padding: 0 0 1rem;
	}

	.inst {
		padding: 0.9rem 1rem 0.25rem;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	th,
	td {
		padding: 0.45rem 1rem;
		text-align: left;
		font-weight: 400;
	}

	tbody th {
		font-weight: 500;
	}

	tbody tr:nth-child(even) {
		background: var(--band);
	}

	.dim {
		opacity: 0.45;
	}

	.type {
		margin-left: 0.4rem;
		font-size: 0.75rem;
	}

	.r {
		text-align: right;
	}

	.act {
		width: 4rem;
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
		color: var(--verdigris);
	}

	.pad {
		padding: 1rem;
	}

	.import {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
		padding-top: 1rem;
		border-top: 1px solid var(--rule);
	}

	.import label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		flex: 1 1 12rem;
	}

	.import input[type='file'] {
		padding: 0.3rem;
		font-size: 0.8125rem;
	}
</style>
