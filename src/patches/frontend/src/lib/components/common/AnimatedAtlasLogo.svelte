<script lang="ts">
	import type { AtlasModelLogoMotionTier } from '$lib/utils/modelLogoMotion';

	export let className = '';
	export let tier: AtlasModelLogoMotionTier = 'sonnet';

	// Keep the canonical irregular Atlas silhouette, but split it into radial
	// slices so the live-state animation can move only a few rays at a time.
	const atlasSymbolPath =
		'm19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z';

	const rayAngles = [-179, -146, -124, -87, -55, -24, 11, 39, 77, 101, 126, 148] as const;
	// Each tier keeps the same silhouette but fires different burst clusters:
	// Haiku = one ray, Sonnet = two or three, Opus = three or four.
	const haikuGroups = [4, 1, 9, 6, 12, 3, 8, 11, 2, 7, 10, 5] as const;
	const sonnetGroups = [3, 1, 5, 2, 4, 1, 3, 5, 2, 4, 3, 5] as const;
	const rayDirections = ['out', 'in', 'out', 'out', 'in', 'out', 'in', 'out', 'out', 'in', 'out', 'out'] as const;
	const opusGroups = [
		[2],
		[1],
		[3],
		[2],
		[1, 4],
		[3],
		[4],
		[1],
		[3],
		[2],
		[4],
		[1]
	] as const;

	const polarPoint = (angle: number, radius = 90) => {
		const radians = (angle * Math.PI) / 180;
		return `${50 + Math.sin(radians) * radius} ${50 - Math.cos(radians) * radius}`;
	};

	const rayDefinitions = rayAngles.map((angle, index) => {
		const previous = index === 0 ? rayAngles[rayAngles.length - 1] - 360 : rayAngles[index - 1];
		const next = index === rayAngles.length - 1 ? rayAngles[0] + 360 : rayAngles[index + 1];
		const start = (previous + angle) / 2;
		const end = (angle + next) / 2;
		return {
			angle,
			haikuGroup: haikuGroups[index],
			sonnetGroup: sonnetGroups[index],
			opusGroups: opusGroups[index],
			direction: rayDirections[index],
			clipPath: `M 50 50 L ${polarPoint(start)} L ${polarPoint(end)} Z`
		};
	});
</script>

<svg
	viewBox="0 0 100 100"
	class="animated-atlas-mark animated-atlas-mark--{tier} {className}"
	fill="none"
	aria-hidden="true"
	focusable="false"
>
	<defs>
		{#each rayDefinitions as ray, index}
			<clipPath id={`atlas-ray-clip-${index}`} clipPathUnits="userSpaceOnUse">
				<path d={ray.clipPath} />
			</clipPath>
		{/each}
	</defs>
	{#each rayDefinitions as ray, index}
		<g transform={`rotate(${ray.angle} 50 50)`}>
			<g
				class={`atlas-ray atlas-ray--${index + 1} atlas-ray-direction--${ray.direction} atlas-haiku-group--${ray.haikuGroup} atlas-sonnet-group--${ray.sonnetGroup} ${ray.opusGroups.map((group) => `atlas-opus-group--${group}`).join(' ')}`}
			>
				<g
					transform={`rotate(${-ray.angle} 50 50)`}
					clip-path={`url(#atlas-ray-clip-${index})`}
				>
					<path d={atlasSymbolPath} fill="currentColor" />
				</g>
			</g>
		</g>
	{/each}
	<circle cx="50" cy="50" r="9.5" fill="currentColor" class="atlas-core" />
</svg>
