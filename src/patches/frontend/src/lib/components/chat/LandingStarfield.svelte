<script>
	// PORTICO PATCH (landing starfield): dark-mode-only cosmic backdrop for the
	// chat landing page. Renders one baked SVG from frozen module-scope data —
	// the un-keyed eaches paint once and never update; all motion is CSS
	// (see the portico-landing-starfield section in app.css for the performance
	// contract). Animated stars rest at their per-star --portico-rest opacity for
	// most of each cycle and act briefly (fade out/in, glint, twirl).
	// Positioning uses baked `transform` attributes on outer <g>
	// wrappers so the CSS animations on inner elements can't clobber them.
	import { isDarkMode } from '$lib/stores/isDarkMode';
	import {
		SPARKLE_PATH,
		STARFIELD,
		STARFIELD_VIEWBOX
	} from '$lib/utils/landing-starfield.mjs';
</script>

{#if $isDarkMode}
	<div class="portico-landing-starfield" aria-hidden="true">
		<svg
			class="portico-landing-starfield-svg"
			width="100%"
			height="100%"
			viewBox="0 0 {STARFIELD_VIEWBOX.width} {STARFIELD_VIEWBOX.height}"
			preserveAspectRatio="xMidYMid slice"
			xmlns="http://www.w3.org/2000/svg"
		>
			<defs>
				<linearGradient id="portico-sf-tail-grad" x1="0" y1="0" x2="1" y2="0">
					<stop offset="0" stop-color="#eaf2ff" stop-opacity="0" />
					<stop offset="1" stop-color="#ffffff" stop-opacity="0.9" />
				</linearGradient>
			</defs>

			{#each STARFIELD.statics as s}
				<circle
					class="portico-sf-st {s.warm ? 'portico-sf-warm' : ''}"
					cx={s.x}
					cy={s.y}
					r={s.r}
					opacity={s.opacity}
				/>
			{/each}

			{#each STARFIELD.twinkles as s}
				<circle
					class="portico-sf-tw {s.warm ? 'portico-sf-warm' : ''}"
					cx={s.x}
					cy={s.y}
					r={s.r}
					style="--portico-rest:{s.rest};animation-duration:{s.duration}s;animation-delay:{s.delay}s"
				/>
			{/each}

			{#each STARFIELD.sparkles as s}
				<g transform="translate({s.x} {s.y}) scale({s.scale})">
					<path
						class="portico-sf-sp-core"
						d={SPARKLE_PATH}
						style="--portico-rest:{s.rest};animation-duration:{s.duration}s;animation-delay:{s.delay}s"
					/>
				</g>
			{/each}

			{#each STARFIELD.spinners as s}
				<g transform="translate({s.x} {s.y}) scale({s.scale})">
					<path
						class="portico-sf-spin-core"
						d={SPARKLE_PATH}
						style="--portico-rest:{s.rest};animation-duration:{s.duration}s;animation-delay:{s.delay}s"
					/>
				</g>
			{/each}

			{#each STARFIELD.shooters as s}
				<g transform="translate({s.x} {s.y})">
					<g
						class="portico-sf-shooter"
						style="--portico-shoot-dx:{s.dx}px;--portico-shoot-dy:{s.dy}px;animation-duration:{s.duration}s;animation-delay:{s.delay}s"
					>
						<g transform="rotate({s.angle})">
							<rect
								class="portico-sf-shooter-tail"
								x={-s.tailLength}
								y="-0.6"
								width={s.tailLength}
								height="1.2"
								rx="0.6"
								fill="url(#portico-sf-tail-grad)"
							/>
							<circle class="portico-sf-shooter-head" r="1.3" />
						</g>
					</g>
				</g>
			{/each}
		</svg>
	</div>
{/if}
