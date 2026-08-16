<script lang="ts">
	import { money, moneyCompact } from '$lib/money.ts';

	type Point = { label: string; value: number };

	let {
		actual = [],
		projected = [],
		height = 132
	}: { actual?: Point[]; projected?: Point[]; height?: number } = $props();

	// The projected line starts at the last observed point so the two segments
	// meet, making the handover from fact to model a visible seam rather than a gap.
	const series = $derived(actual.length ? [...actual, ...projected] : projected);

	const W = 720;
	const PAD = 4;

	// The scale fits the data rather than being anchored to zero. A net worth in
	// the hundreds of thousands moving by a few thousand a month is invisible on
	// a zero-based axis, which is the whole thing this chart exists to show.
	const bounds = $derived.by(() => {
		const values = series.map((p) => p.value);
		if (!values.length) return { min: 0, max: 1 };
		const min = Math.min(...values);
		const max = Math.max(...values);
		const pad = (max - min) * 0.15 || Math.abs(max) * 0.1 || 1;
		return { min: min - pad, max: max + pad };
	});

	const x = (i: number) => (series.length < 2 ? W / 2 : (i / (series.length - 1)) * W);
	const y = (v: number) =>
		height - PAD - ((v - bounds.min) / (bounds.max - bounds.min)) * (height - PAD * 2);

	const path = (pts: Point[], offset: number) =>
		pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i + offset).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

	const actualPath = $derived(path(actual, 0));
	// Re-include the final actual point as the projected line's origin.
	const projectedPath = $derived(
		actual.length && projected.length
			? path([actual[actual.length - 1], ...projected], actual.length - 1)
			: path(projected, 0)
	);
	const areaPath = $derived(
		actual.length > 1 ? `${actualPath} L${x(actual.length - 1).toFixed(1)},${height} L0,${height} Z` : ''
	);

	const zeroY = $derived(bounds.min < 0 && bounds.max > 0 ? y(0) : null);
</script>

<figure>
	<svg viewBox="0 0 {W} {height}" preserveAspectRatio="none" role="img" aria-label="Net worth trend">
		<defs>
			<linearGradient id="abacus-fade" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%" stop-color="var(--ink)" stop-opacity="0.10" />
				<stop offset="100%" stop-color="var(--ink)" stop-opacity="0" />
			</linearGradient>
		</defs>

		{#if zeroY !== null}
			<line x1="0" x2={W} y1={zeroY} y2={zeroY} class="zero" />
		{/if}

		{#if areaPath}
			<path d={areaPath} class="area" />
		{/if}

		{#if actualPath}
			<path d={actualPath} class="line-actual" />
		{/if}

		{#if projected.length}
			<path d={projectedPath} class="line-projected" />
		{/if}

		{#if actual.length}
			<circle cx={x(actual.length - 1)} cy={y(actual[actual.length - 1].value)} r="3.5" class="knot" />
		{/if}
	</svg>

	<figcaption>
		<span class="key">
			<i class="swatch swatch-ink"></i>
			{actual.length ? `${actual[0].label} — ${actual[actual.length - 1].label}` : 'No history yet'}
		</span>
		{#if projected.length}
			<span class="key">
				<i class="swatch swatch-brass"></i>
				Projected to {projected[projected.length - 1].label}
				<b class="num">{moneyCompact(projected[projected.length - 1].value)}</b>
			</span>
		{/if}
	</figcaption>
</figure>

<style>
	figure {
		margin: 0;
	}

	svg {
		display: block;
		width: 100%;
		height: v-bind('height + "px"');
		overflow: visible;
	}

	.area {
		fill: url(#abacus-fade);
	}

	.line-actual {
		fill: none;
		stroke: var(--ink);
		stroke-width: 1.75;
		stroke-linejoin: round;
		stroke-linecap: round;
		vector-effect: non-scaling-stroke;
	}

	/* Dashed brass: this segment is a model, not a measurement. */
	.line-projected {
		fill: none;
		stroke: var(--brass);
		stroke-width: 1.75;
		stroke-dasharray: 3 4;
		stroke-linecap: round;
		vector-effect: non-scaling-stroke;
	}

	.knot {
		fill: var(--paper);
		stroke: var(--ink);
		stroke-width: 1.75;
		vector-effect: non-scaling-stroke;
	}

	.zero {
		stroke: var(--rule);
		stroke-width: 1;
		stroke-dasharray: 2 3;
		vector-effect: non-scaling-stroke;
	}

	figcaption {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 1.25rem;
		margin-top: 0.7rem;
		font-size: 0.75rem;
		color: var(--slate);
	}

	.key {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.swatch {
		width: 14px;
		height: 0;
		border-top-width: 2px;
		border-top-style: solid;
	}

	.swatch-ink {
		border-top-color: var(--ink);
	}

	.swatch-brass {
		border-top-color: var(--brass);
		border-top-style: dashed;
	}

	b {
		font-weight: 500;
		color: var(--brass);
	}
</style>
