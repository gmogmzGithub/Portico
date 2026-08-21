import {
	getCelestialModelIdentity,
	getModelBrandFamily,
	isLocalModelCandidate
} from './modelBranding';

export type StreamingModelLogoMotionKind =
	| 'claude'
	| 'sol'
	| 'terra'
	| 'luna'
	| 'gemini'
	| 'gpt'
	| 'local'
	| 'other';

export type ClaudeModelLogoMotionTier = 'haiku' | 'sonnet' | 'opus';

type ModelLogoMotionCandidate = Record<string, any> | null | undefined;

export type StreamingModelLogoMotionVariables = {
	'--model-logo-breathe-duration': string;
	'--model-logo-spin-duration': string;
	'--model-logo-glow-duration': string;
	'--model-logo-breathe-delay': string;
	'--model-logo-spin-delay': string;
	'--model-logo-glow-delay': string;
	'--model-logo-terra-flourish-duration': string;
	'--model-logo-terra-flourish-delay': string;
	'--model-logo-travel': string;
	'--model-logo-sweep-direction': 'normal' | 'reverse';
	'--model-logo-claude-ray-peak': string;
	'--model-logo-claude-breathe-peak': string;
	'--model-logo-claude-cycle-delay': string;
	'--model-logo-halo-peak': string;
	'--model-logo-halo-scale': string;
};

export const getClaudeModelLogoMotionTier = (
	candidate: ModelLogoMotionCandidate
): ClaudeModelLogoMotionTier => {
	const name = `${candidate?.id ?? ''} ${candidate?.name ?? ''}`.toLowerCase();
	if (name.includes('opus')) return 'opus';
	if (name.includes('haiku')) return 'haiku';
	return 'sonnet';
};

const stableHash = (value: string): number => {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
};

const sampleUnit = (seed: string, salt: string): number =>
	stableHash(`${salt}:${seed}`) / 0xffffffff;

const sampleRange = (seed: string, salt: string, minimum: number, maximum: number): number =>
	minimum + sampleUnit(seed, salt) * (maximum - minimum);

const seconds = (value: number) => `${value.toFixed(2)}s`;

/**
 * Resolve the motion language independently from the image URL. That keeps
 * custom/dynamic profile image lookup untouched while letting base-model
 * identities receive the same family motion as their first-party model.
 */
export const getStreamingModelLogoMotionKind = (
	candidate: ModelLogoMotionCandidate
): StreamingModelLogoMotionKind => {
	if (isLocalModelCandidate(candidate)) return 'local';

	const celestialIdentity = getCelestialModelIdentity(candidate);
	if (celestialIdentity) return celestialIdentity;

	switch (getModelBrandFamily(candidate)) {
		case 'claude':
			return 'claude';
		case 'google':
			return 'gemini';
		case 'openai':
			return 'gpt';
		default:
			return 'other';
	}
};

/**
 * Give every response a slightly different, but fully deterministic, rhythm.
 * Stable message ids avoid hydration jitter and animation timers while the
 * irregular CSS keyframes still produce occasional playful quick turns.
 */
export const getStreamingModelLogoMotionVariables = (
	seedValue: unknown,
	kind: StreamingModelLogoMotionKind,
	candidate?: ModelLogoMotionCandidate
): StreamingModelLogoMotionVariables => {
	const seed = `${seedValue ?? ''}:${kind}`;
	const claudeStrength = getClaudeModelLogoMotionTier(candidate);
	const breatheDuration = sampleRange(
		seed,
		'breathe-duration',
		kind === 'sol' ? 6.5 : kind === 'claude' ? 14 : 3.35,
		kind === 'sol' ? 9.25 : kind === 'claude' ? 20 : 5.2
	);
	const spinDuration = sampleRange(
		seed,
		'spin-duration',
		kind === 'sol' ? 22 : kind === 'terra' ? 16 : kind === 'claude' ? 44 : 11.8,
		kind === 'sol' ? 31 : kind === 'terra' ? 22 : kind === 'claude' ? 62 : 18.4
	);
	const glowDuration = sampleRange(
		seed,
		'glow-duration',
		kind === 'sol' ? 7.5 : kind === 'claude' ? 12 : kind === 'terra' ? 7 : 2.7,
		kind === 'sol' ? 10.5 : kind === 'claude' ? 18 : kind === 'terra' ? 10 : 4.7
	);
	// Forty-one percent of Terra's longer motion cycle is one baseline lap.
	// That preserves the 16–22 second axial pan while leaving room for an
	// occasional hand-spun multi-revolution burst and a visible coast back to cruise.
	const terraFlourishDuration = spinDuration / 0.41;

	return {
		'--model-logo-breathe-duration': seconds(breatheDuration),
		'--model-logo-spin-duration': seconds(spinDuration),
		'--model-logo-glow-duration': seconds(glowDuration),
		'--model-logo-breathe-delay': seconds(-sampleRange(seed, 'breathe-delay', 0, breatheDuration)),
		'--model-logo-spin-delay': seconds(-sampleRange(seed, 'spin-delay', 0, spinDuration)),
		'--model-logo-glow-delay': seconds(-sampleRange(seed, 'glow-delay', 0, glowDuration)),
		'--model-logo-terra-flourish-duration': seconds(terraFlourishDuration),
		'--model-logo-terra-flourish-delay': seconds(
			-sampleRange(seed, 'terra-flourish-delay', 0, terraFlourishDuration)
		),
		'--model-logo-travel': `${sampleRange(seed, 'travel', 1.2, 2.4).toFixed(2)}px`,
		'--model-logo-sweep-direction': sampleUnit(seed, 'sweep-direction') >= 0.5 ? 'normal' : 'reverse',
		'--model-logo-claude-ray-peak': claudeStrength === 'opus' ? '1.28' : claudeStrength === 'haiku' ? '1.07' : '1.16',
		'--model-logo-claude-breathe-peak': claudeStrength === 'opus' ? '1.085' : claudeStrength === 'haiku' ? '1.025' : '1.055',
		'--model-logo-claude-cycle-delay': seconds(-sampleRange(seed, 'claude-cycle-delay', 0, 12)),
		'--model-logo-halo-peak': claudeStrength === 'opus' ? '0.82' : claudeStrength === 'haiku' ? '0.34' : '0.58',
		'--model-logo-halo-scale': claudeStrength === 'opus' ? '1.28' : claudeStrength === 'haiku' ? '1.08' : '1.16'
	};
};

export const getStreamingModelLogoMotionStyle = (
	seedValue: unknown,
	kind: StreamingModelLogoMotionKind,
	candidate?: ModelLogoMotionCandidate
): string =>
	Object.entries(getStreamingModelLogoMotionVariables(seedValue, kind, candidate))
		.map(([property, value]) => `${property}: ${value}`)
		.join('; ');
