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

	// ------------------------------------------------------------- inspection

	let svgEl = $state<SVGSVGElement | null>(null);
	let active = $state<number | null>(null);

	const point = $derived(active === null ? null : series[active]);
	const isObserved = $derived(active !== null && active < actual.length);

	/**
	 * Percentage rather than pixels, because the SVG is stretched horizontally
	 * (preserveAspectRatio="none") and its internal x units do not correspond to
	 * screen pixels. The y axis is 1:1, since the rendered height equals the
	 * viewBox height, so y() can be used directly for vertical placement.
	 */
	const leftPct = $derived(
		active === null || series.length < 2 ? 50 : (active / (series.length - 1)) * 100
	);

	function locate(clientX: number) {
		if (!svgEl || series.length === 0) return;
		const rect = svgEl.getBoundingClientRect();
		if (rect.width === 0) return;

		const fraction = (clientX - rect.left) / rect.width;
		const index = Math.round(fraction * (series.length - 1));
		active = Math.min(series.length - 1, Math.max(0, index));
	}

	function onKey(event: KeyboardEvent) {
		if (!series.length) return;
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (!step) {
			if (event.key === 'Escape') active = null;
			return;
		}
		event.preventDefault();
		const from = active ?? (step > 0 ? -1 : series.length);
		active = Math.min(series.length - 1, Math.max(0, from + step));
	}
</script>

<figure>
	<!--
		Focusable so the values are reachable without a pointer: arrow keys walk
		the series and the live region below announces each point. Svelte objects
		to a focusable role="img", and it is right that this is not a standard
		widget — but the alternatives are worse. A button implies activation, a
		slider implies setting a value, and neither describes reading a chart.
		This is the pattern accessible charting libraries settle on.
	-->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="plot"
		role="img"
		tabindex="0"
		aria-label="Net worth over time. Use the arrow keys to read individual months."
		onpointermove={(e) => locate(e.clientX)}
		onpointerleave={() => (active = null)}
		onblur={() => (active = null)}
		onkeydown={onKey}
	>
		<!-- Height is set inline, not in CSS. The declaration here used to be
		     `height: v-bind(...)`, which is Vue syntax that Svelte silently drops —
		     so the element sized itself from the viewBox aspect ratio instead, and
		     the y axis was never 1:1 with pixels. That went unnoticed until HTML
		     overlays had to be positioned from the same coordinates. -->
		<svg
			bind:this={svgEl}
			viewBox="0 0 {W} {height}"
			preserveAspectRatio="none"
			style="height: {height}px"
			aria-hidden="true"
		>
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

			{#if active !== null}
				<line x1={x(active)} x2={x(active)} y1="0" y2={height} class="crosshair" />
			{/if}
		</svg>

		<!-- Markers are HTML, not SVG: the horizontal stretch would render a
		     circle as an ellipse. -->
		{#if actual.length}
			<i
				class="dot knot"
				style="left: {series.length < 2 ? 50 : ((actual.length - 1) / (series.length - 1)) * 100}%; top: {y(
					actual[actual.length - 1].value
				)}px"
			></i>
		{/if}

		{#if point}
			<i class="dot cursor" class:brass={!isObserved} style="left: {leftPct}%; top: {y(point.value)}px"></i>

			<div
				class="tip"
				class:right={leftPct > 60}
				style="left: {leftPct}%; top: {y(point.value)}px"
			>
				<span class="tip-label">{point.label}</span>
				<span class="tip-value num" class:brass={!isObserved}>{money(point.value, { exact: false })}</span>
				<span class="tip-kind">{isObserved ? 'observed' : 'projected'}</span>
			</div>
		{/if}
	</div>

	<p class="sr" aria-live="polite">
		{point ? `${point.label}: ${money(point.value)}, ${isObserved ? 'observed' : 'projected'}` : ''}
	</p>

	<figcaption>
		<!-- The observed key is omitted entirely on a projection-only chart;
		     announcing "no history" would imply something is missing when the
		     chart was never meant to show any. -->
		{#if actual.length}
			<span class="key">
				<i class="swatch swatch-ink"></i>
				{actual[0].label} — {actual[actual.length - 1].label}
			</span>
		{/if}
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

	.plot {
		position: relative;
		cursor: crosshair;
		touch-action: pan-y;
	}

	svg {
		display: block;
		width: 100%;
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

	.crosshair {
		stroke: var(--rule-strong);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.zero {
		stroke: var(--rule);
		stroke-width: 1;
		stroke-dasharray: 2 3;
		vector-effect: non-scaling-stroke;
	}

	.dot {
		position: absolute;
		width: 9px;
		height: 9px;
		margin: -4.5px 0 0 -4.5px;
		border-radius: 50%;
		background: var(--paper);
		pointer-events: none;
	}

	.knot {
		border: 1.75px solid var(--ink);
	}

	.cursor {
		border: 1.75px solid var(--ink);
		box-shadow: 0 0 0 3px var(--paper);
	}

	.cursor.brass {
		border-color: var(--brass);
	}

	.tip {
		position: absolute;
		z-index: 2;
		transform: translate(-50%, calc(-100% - 0.9rem));
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		padding: 0.4rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--rule-strong);
		border-radius: var(--radius);
		white-space: nowrap;
		pointer-events: none;
		line-height: 1.3;
	}

	/* Near the right edge the tooltip would overflow its card, so it flips to
	   sit left of the cursor instead of centred on it. */
	.tip.right {
		transform: translate(calc(-100% + 0.5rem), calc(-100% - 0.9rem));
	}

	.tip-label {
		font-size: 0.6875rem;
		color: var(--slate);
	}

	.tip-value {
		font-size: 0.9375rem;
		font-weight: 500;
	}

	.tip-value.brass {
		color: var(--brass);
	}

	.tip-kind {
		font-family: var(--font-mono);
		font-size: 0.5625rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--faint);
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

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
