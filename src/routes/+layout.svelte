<script lang="ts">
	import '@fontsource-variable/fraunces';
	import '@fontsource-variable/inter-tight';
	import '@fontsource-variable/jetbrains-mono';
	import '../app.css';
	import { page } from '$app/state';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const NAV = [
		{ href: '/', label: 'Overview' },
		{ href: '/budget', label: 'Budget' },
		{ href: '/transactions', label: 'Transactions' },
		{ href: '/accounts', label: 'Accounts' },
		{ href: '/portfolio', label: 'Portfolio' },
		{ href: '/forecast', label: 'Forecast' },
		{ href: '/settings', label: 'Settings' }
	];

	const bare = $derived(page.url.pathname.startsWith('/auth'));
	const current = (href: string) =>
		href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);

	const stale = $derived(data.health.staleDays !== null && data.health.staleDays >= 2);
</script>

{#if bare}
	{@render children()}
{:else}
	<div class="shell">
		<nav aria-label="Sections">
			<a class="brand" href="/">
				<span class="beads" aria-hidden="true">
					<i></i><i></i><i></i>
				</span>
				<span class="wordmark">Abacus</span>
			</a>

			<ul>
				{#each NAV as item (item.href)}
					<li>
						<a href={item.href} aria-current={current(item.href) ? 'page' : undefined}>
							{item.label}
						</a>
					</li>
				{/each}
			</ul>

			<div class="rail-foot">
				{#if data.health.needsRepair.length}
					<a class="alert" href="/accounts">
						{data.health.needsRepair.length} connection{data.health.needsRepair.length > 1 ? 's' : ''}
						need reconnecting
					</a>
				{:else if stale}
					<a class="alert warn" href="/accounts">
						No sync in {data.health.staleDays} days
					</a>
				{/if}
				<p class="eyebrow signed-in">{data.auth.login}</p>
			</div>
		</nav>

		<main>
			{@render children()}
		</main>
	</div>
{/if}

<style>
	.shell {
		min-height: 100dvh;
	}

	nav {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		text-decoration: none;
	}

	/* Three beads on a rod — the instrument the app is named for, and the only
	   ornament in the chrome. */
	.beads {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 4px 5px;
		border-top: 1.5px solid var(--brass);
		border-bottom: 1.5px solid var(--brass);
	}

	.beads i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--verdigris);
	}

	.beads i:nth-child(2) {
		background: var(--ink);
	}

	.wordmark {
		font-family: var(--font-display);
		font-variation-settings: 'opsz' 60, 'SOFT' 20, 'WONK' 1;
		font-weight: 600;
		font-size: 1.3rem;
		letter-spacing: -0.015em;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	nav a {
		text-decoration: none;
	}

	ul a {
		display: block;
		padding: 0.4rem 0.6rem;
		border-radius: var(--radius);
		color: var(--slate);
		font-size: 0.9375rem;
	}

	ul a:hover {
		background: var(--surface-sunk);
		color: var(--ink);
	}

	ul a[aria-current='page'] {
		background: var(--surface);
		color: var(--ink);
		font-weight: 500;
		box-shadow: inset 2px 0 0 var(--verdigris);
	}

	.rail-foot {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.alert {
		display: block;
		padding: 0.5rem 0.6rem;
		border-left: 2px solid var(--iron);
		background: var(--surface);
		color: var(--iron);
		font-size: 0.8125rem;
		text-decoration: none;
	}

	.alert.warn {
		border-left-color: var(--brass);
		color: var(--brass);
	}

	.signed-in {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	main {
		padding: var(--gutter);
		max-width: 1180px;
	}

	/* Desktop: a fixed rail. Mobile: the same list as a bottom tab bar, which is
	   where a thumb actually is. */
	@media (min-width: 62rem) {
		.shell {
			display: grid;
			grid-template-columns: var(--rail) 1fr;
		}

		nav {
			position: sticky;
			top: 0;
			height: 100dvh;
			padding: 1.5rem 1rem;
			border-right: 1px solid var(--rule);
		}

		ul {
			flex: 1;
		}
	}

	@media (max-width: 61.999rem) {
		nav {
			position: fixed;
			inset: auto 0 0 0;
			z-index: 10;
			flex-direction: row;
			align-items: center;
			gap: 0;
			padding: 0.35rem 0.5rem calc(0.35rem + env(safe-area-inset-bottom));
			background: var(--surface);
			border-top: 1px solid var(--rule);
		}

		.brand,
		.rail-foot {
			display: none;
		}

		ul {
			display: flex;
			flex: 1;
			justify-content: space-between;
		}

		ul a {
			padding: 0.45rem 0.3rem;
			font-size: 0.75rem;
			text-align: center;
		}

		ul a[aria-current='page'] {
			box-shadow: inset 0 2px 0 var(--verdigris);
		}

		main {
			padding-bottom: 5rem;
		}
	}
</style>
