<script lang="ts">
	import { money } from '$lib/money.ts';

	let {
		cents,
		exact = true,
		/**
		 * Renders in brass: this number was inferred rather than observed. Pass it
		 * only when the value genuinely differs from what was measured — marking
		 * an unmodified actual as projected makes the distinction meaningless.
		 */
		projected = false,
		/** Colour by sign. Off for neutral figures like a budget target. */
		signed = false,
		/**
		 * Flips which sign reads as good. On an income row, being under budget is
		 * the bad direction, so the default colouring is backwards.
		 */
		invert = false,
		class: className = ''
	}: {
		cents: number;
		exact?: boolean;
		projected?: boolean;
		signed?: boolean;
		invert?: boolean;
		class?: string;
	} = $props();

	const tone = $derived(
		!signed || cents === 0 ? '' : cents > 0 !== invert ? 'pos' : 'neg'
	);
</script>

<span
	class="num {tone} {className}"
	class:is-projected={projected}
	title={projected ? 'Projected — inferred from the run rate so far' : undefined}
>
	{money(cents, { exact })}
</span>
