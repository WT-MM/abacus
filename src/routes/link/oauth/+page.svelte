<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	// Where an OAuth institution lands after the user approves access. Plaid
	// requires Link to be reopened with the original link token plus the full
	// redirect URL, so the handoff can be verified.
	let problem = $state('');

	onMount(async () => {
		const linkToken = sessionStorage.getItem('abacus.linkToken');
		const itemId = sessionStorage.getItem('abacus.linkItemId');

		if (!linkToken) {
			problem = 'This connection attempt has expired. Start again from Accounts.';
			return;
		}

		try {
			await new Promise<void>((resolve, reject) => {
				const el = document.createElement('script');
				el.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
				el.onload = () => resolve();
				el.onerror = () => reject(new Error('Could not load Plaid Link'));
				document.head.appendChild(el);
			});

			// @ts-expect-error injected by the Plaid script
			const handler = window.Plaid.create({
				token: linkToken,
				receivedRedirectUri: window.location.href,
				// Plaid does not await this callback, so an uncaught throw here
				// becomes an unhandled rejection and this page just sits there.
				onSuccess: async (
					publicToken: string,
					metadata: { institution?: { institution_id?: string } | null }
				) => {
					try {
						// The result is checked rather than fired and forgotten: this page
						// redirects away immediately, so an unreported failure would leave
						// the user on a healthy-looking Accounts page with nothing linked.
						const res = await fetch(itemId ? '/api/link/repaired' : '/api/link/exchange', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(
								itemId
									? { itemId }
									: { publicToken, institutionId: metadata?.institution?.institution_id ?? null }
							)
						});
						const payload = await res.json().catch(() => ({}));

						if (!res.ok || payload.ok === false) {
							problem = payload.message ?? `Could not finish connecting (${res.status})`;
							return;
						}

						// Cleared only once the server has the token. Dropping it earlier
						// would make a retry impossible after a recoverable failure.
						sessionStorage.removeItem('abacus.linkToken');
						sessionStorage.removeItem('abacus.linkItemId');
						await goto('/accounts', { invalidateAll: true });
					} catch (err) {
						problem = err instanceof Error ? err.message : 'Could not finish connecting';
					}
				},
				// Do not navigate away over the top of a reported failure.
				onExit: () => {
					if (!problem) goto('/accounts');
				}
			});
			handler.open();
		} catch (err) {
			problem = err instanceof Error ? err.message : 'Could not finish connecting';
		}
	});
</script>

<svelte:head><title>Connecting · Abacus</title></svelte:head>

<div class="wrap">
	{#if problem}
		<p class="bad">{problem}</p>
		<a class="btn" href="/accounts">Back to accounts</a>
	{:else}
		<p class="eyebrow">Finishing the connection</p>
		<p class="muted">Returning you to your bank's approval…</p>
	{/if}
</div>

<style>
	.wrap {
		display: grid;
		place-items: center;
		gap: 0.75rem;
		min-height: 50dvh;
		text-align: center;
	}

	.bad {
		color: var(--iron);
	}
</style>
