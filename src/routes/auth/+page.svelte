<script lang="ts">
	import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let busy = $state(false);
	let message = $state('');

	async function post(action: string, body: unknown = {}) {
		const res = await fetch(`/api/webauthn/${action}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `Request failed`);
		return res.json();
	}

	async function unlock() {
		busy = true;
		message = '';
		try {
			const { options, challengeId } = await post('auth-start');
			const response = await startAuthentication({ optionsJSON: options });
			await post('auth-finish', { challengeId, response });
			await goto(data.next, { invalidateAll: true });
		} catch (err) {
			message = err instanceof Error ? err.message : 'Could not verify that passkey';
		} finally {
			busy = false;
		}
	}

	async function enrol() {
		busy = true;
		message = '';
		try {
			const { options, challengeId } = await post('register-start');
			const response = await startRegistration({ optionsJSON: options });
			await post('register-finish', {
				challengeId,
				response,
				deviceName: navigator.platform || 'Passkey'
			});
			await goto(data.next, { invalidateAll: true });
		} catch (err) {
			message = err instanceof Error ? err.message : 'Could not create that passkey';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Unlock · Abacus</title></svelte:head>

<main>
	<div class="panel">
		<span class="beads" aria-hidden="true"><i></i><i></i><i></i></span>
		<h1>Abacus</h1>

		{#if data.enrolled}
			<p class="lede">Your tailnet identity is recognised. Confirm it is you.</p>
			<button class="btn btn-primary" onclick={unlock} disabled={busy}>
				{busy ? 'Waiting for passkey…' : 'Unlock with passkey'}
			</button>
		{:else}
			<p class="lede">
				First run. Create a passkey to lock this ledger to a device you hold — reaching the tailnet
				alone will not be enough after this.
			</p>
			<button class="btn btn-primary" onclick={enrol} disabled={busy}>
				{busy ? 'Waiting for passkey…' : 'Create a passkey'}
			</button>
		{/if}

		{#if message}
			<p class="error" role="alert">{message}</p>
		{/if}

		<p class="who eyebrow">{data.login}</p>
	</div>
</main>

<style>
	main {
		display: grid;
		place-items: center;
		min-height: 100dvh;
		padding: var(--gutter);
	}

	.panel {
		width: min(24rem, 100%);
		padding: 2rem;
		background: var(--surface);
		border: 1px solid var(--rule);
		border-radius: var(--radius);
		text-align: center;
	}

	.beads {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 5px 6px;
		border-top: 1.5px solid var(--brass);
		border-bottom: 1.5px solid var(--brass);
	}

	.beads i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--verdigris);
	}

	.beads i:nth-child(2) {
		background: var(--ink);
	}

	h1 {
		margin: 0.75rem 0 0.5rem;
		font-family: var(--font-display);
		font-variation-settings: 'opsz' 80, 'SOFT' 20, 'WONK' 1;
		font-weight: 600;
		font-size: 1.9rem;
		letter-spacing: -0.02em;
	}

	.lede {
		margin-bottom: 1.5rem;
		color: var(--slate);
		font-size: 0.9375rem;
		text-wrap: balance;
	}

	.btn-primary {
		width: 100%;
		justify-content: center;
		padding-block: 0.6rem;
	}

	.error {
		margin-top: 1rem;
		color: var(--iron);
		font-size: 0.875rem;
	}

	.who {
		margin-top: 1.75rem;
		padding-top: 1rem;
		border-top: 1px solid var(--rule);
	}
</style>
