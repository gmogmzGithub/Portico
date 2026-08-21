<script lang="ts">
	export let className = '';
	export let clipId = 'animated-terra-sphere-clip';

	// The same 100-unit panorama is drawn twice so it can pass continuously
	// behind the fixed spherical lighting without exposing a seam.
	const surfaceOffsets = [0, 100] as const;
</script>

<svg
	viewBox="0 0 100 100"
	class="animated-terra-mark {className}"
	fill="none"
	aria-hidden="true"
	focusable="false"
>
	<defs>
		<clipPath id={clipId} clipPathUnits="userSpaceOnUse">
			<circle cx="50" cy="50" r="44" />
		</clipPath>
	</defs>

	<g class="animated-terra-surface-clip" clip-path={`url(#${clipId})`}>
		<circle class="animated-terra-ocean" cx="50" cy="50" r="44" />
		<ellipse class="animated-terra-ocean-depth" cx="52" cy="62" rx="39" ry="27" />

		<!-- Sparkles are painted before land, so moving continents naturally hide them. -->
		<g class="animated-terra-water-glints">
			<circle class="animated-terra-sparkle animated-terra-sparkle--a" cx="18" cy="29" r="1.2" style="--terra-sparkle-duration: 2.3s; --terra-sparkle-delay: -0.6s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--b" cx="31" cy="19" r="0.9" style="--terra-sparkle-duration: 3.1s; --terra-sparkle-delay: -2.4s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--c" cx="45" cy="27" r="1.1" style="--terra-sparkle-duration: 4.7s; --terra-sparkle-delay: -1.3s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--d" cx="62" cy="18" r="0.8" style="--terra-sparkle-duration: 5.7s; --terra-sparkle-delay: -4.8s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--a" cx="78" cy="29" r="1" style="--terra-sparkle-duration: 3.8s; --terra-sparkle-delay: -2.1s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--b" cx="88" cy="44" r="1.2" style="--terra-sparkle-duration: 5.2s; --terra-sparkle-delay: -3.7s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--c" cx="75" cy="58" r="0.9" style="--terra-sparkle-duration: 2.8s; --terra-sparkle-delay: -1.9s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--d" cx="63" cy="73" r="1.1" style="--terra-sparkle-duration: 4.3s; --terra-sparkle-delay: -0.8s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--a" cx="46" cy="82" r="0.8" style="--terra-sparkle-duration: 5.5s; --terra-sparkle-delay: -4.2s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--b" cx="29" cy="72" r="1.2" style="--terra-sparkle-duration: 3.4s; --terra-sparkle-delay: -2.8s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--c" cx="15" cy="56" r="0.9" style="--terra-sparkle-duration: 4.9s; --terra-sparkle-delay: -3.1s;" />
			<circle class="animated-terra-sparkle animated-terra-sparkle--d" cx="45" cy="51" r="1" style="--terra-sparkle-duration: 2.6s; --terra-sparkle-delay: -0.9s;" />
		</g>

		<g class="animated-terra-surface-strip">
			{#each surfaceOffsets as offset}
				<g class="animated-terra-continent-copy" transform={`translate(${offset} 0)`}>
					<path
						class="animated-terra-land animated-terra-region--north-america"
						d="M3 30 L8 24 L14 20 L20 21 L24 19 L29 23 L31 27 L27 30 L29 34 L24 38 L19 37 L16 41 L14 47 L10 46 L8 41 L3 39 L1 34 Z"
					/>
					<path
						class="animated-terra-land animated-terra-region--central-america"
						d="M14 42 L19 43 L23 47 L22 51 L18 49 L15 46 Z"
					/>
					<path
						class="animated-terra-land animated-terra-land--warm animated-terra-region--south-america"
						d="M22 48 L28 45 L35 48 L39 54 L37 60 L35 66 L33 73 L29 81 L26 86 L23 82 L24 74 L21 68 L19 60 L20 53 Z"
					/>
					<path
						class="animated-terra-land animated-terra-land--ice animated-terra-region--greenland"
						d="M30 12 L36 10 L41 14 L40 19 L36 24 L31 22 L28 18 Z"
					/>
					<path
						class="animated-terra-land animated-terra-region--eurasia"
						d="M43 30 L47 26 L53 26 L57 22 L63 22 L67 19 L73 22 L79 20 L84 23 L89 24 L93 28 L98 29 L99 34 L94 37 L90 36 L86 40 L82 39 L78 44 L73 43 L69 39 L64 41 L60 38 L56 41 L51 38 L47 37 Z"
					/>
					<path
						class="animated-terra-land animated-terra-land--warm animated-terra-region--africa"
						d="M50 40 L58 38 L65 41 L69 46 L67 53 L64 58 L63 65 L59 73 L55 70 L52 64 L50 58 L47 52 L48 45 Z"
					/>
					<path
						class="animated-terra-land animated-terra-region--arabia"
						d="M66 44 L73 45 L77 50 L74 55 L69 53 L66 49 Z"
					/>
					<path
						class="animated-terra-land animated-terra-region--india"
						d="M77 42 L83 46 L82 53 L79 60 L76 54 L74 48 Z"
					/>
					<path
						class="animated-terra-land animated-terra-land--warm animated-terra-region--australia"
						d="M83 65 L88 62 L94 63 L99 67 L98 72 L94 76 L88 78 L83 75 L81 70 Z"
					/>
					<path
						class="animated-terra-island"
						d="M87 45 L89 43 L90 46 L88 49 Z M74 58 L77 57 L79 59 L76 61 Z M80 61 L82 59 L84 61 L81 63 Z M96 53 L98 51 L99 54 L97 56 Z"
					/>
				</g>
			{/each}
		</g>

		<!-- These layers never pan, so the moving map reads as a turning sphere. -->
		<ellipse class="animated-terra-daylight" cx="32" cy="31" rx="20" ry="28" transform="rotate(-28 32 31)" />
		<path
			class="animated-terra-night-shade"
			d="M54 6 A44 44 0 0 1 54 94 C76 87 91 70 94 51 C92 29 77 13 54 6 Z"
		/>
		<path
			class="animated-terra-limb-shadow"
			d="M79 16 A44 44 0 0 1 79 84 C89 76 95 64 95 50 C95 36 89 24 79 16 Z"
		/>
	</g>

	<circle class="animated-terra-atmosphere" cx="50" cy="50" r="44" />
	<path class="animated-terra-atmosphere-shine" d="M18 77 A42 42 0 0 1 20 21" />
</svg>
