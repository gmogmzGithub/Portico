import { buildModelLogoUrl, getModelLogoCacheVersion } from './modelLogoCache';

export type ModelBrandFamily = 'atlas' | 'openai' | 'google' | 'local' | 'other';
export type CelestialModelIdentity = 'sol' | 'terra' | 'luna';
export type ModelSelectorLogoVariant = 'compact' | 'grouped' | 'sidebar';
export type ModelLogoSources = {
	light: string;
	dark: string | null;
	isLocal: boolean;
};

type ModelBrandCandidate = {
	id?: unknown;
	name?: unknown;
	label?: unknown;
	value?: unknown;
	owned_by?: unknown;
	model?: Record<string, any> | null | undefined;
} | null | undefined;

const OPENAI_SHORT_CODE_PATTERN = /(^|\s)(o1|o3|o4)(?:[\s-]|$)/;
export const ATLAS_MODEL_LOGO_SRC = '/atlas.png';
export const OPENAI_MODEL_LOGO_SRC = '/gpt.png';
export const GOOGLE_MODEL_LOGO_SRC = '/gemini.png';
export const SOL_MODEL_LOGO_SRC = '/sol.png';
export const TERRA_MODEL_LOGO_SRC = '/terra.png';
export const LUNA_MODEL_LOGO_SRC = '/luna.png';
export const LOCAL_MODEL_LOGO_LIGHT_SRC = '/local-model-light.svg';
export const LOCAL_MODEL_LOGO_DARK_SRC = '/local-model-dark.svg';
const CELESTIAL_MODEL_LOGO_SOURCES: Record<CelestialModelIdentity, string> = {
	sol: SOL_MODEL_LOGO_SRC,
	terra: TERRA_MODEL_LOGO_SRC,
	luna: LUNA_MODEL_LOGO_SRC
};
const MODEL_SELECTOR_LOGO_SIZE_CLASSES: Record<ModelSelectorLogoVariant, string> = {
	compact: 'size-5',
	grouped: 'size-7',
	sidebar: 'size-4'
};
const LOCAL_MODEL_SELECTOR_LOGO_SIZE_CLASSES: Record<ModelSelectorLogoVariant, string> = {
	compact: 'size-6',
	grouped: 'size-8',
	sidebar: 'size-4'
};

export interface ModelSelectorLogoPresentation {
	brandFamily: ModelBrandFamily;
	needsDarkBadge: boolean;
	outerSizeClass: string;
	wrapperClassName: string;
	imageClassName: string;
}

const normalizeBrandValue = (value: unknown) => {
	const normalized = `${value ?? ''}`.trim();
	return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : '';
};

const normalizedProviderValue = (value: unknown) => normalizeBrandValue(value).toLowerCase().replace(/-/g, '_');

const getBaseModelIdValue = (candidate: ModelBrandCandidate) => {
	const model = candidate?.model ?? candidate ?? {};
	return normalizeBrandValue(
		model?.base_model_id ??
			model?.baseModelId ??
			model?.info?.base_model_id ??
			model?.info?.baseModelId ??
			model?.info?.base_model ??
			model?.info?.baseModel ??
			model?.model_info?.base_model ??
			model?.modelInfo?.baseModel
	);
};

export const isDerivedModelCandidate = (candidate: ModelBrandCandidate) =>
	getBaseModelIdValue(candidate) !== '';

// Resolve an agent (a derived model carrying base_model_id) to its BASE model
// record from the catalog, so branding/logo helpers show the base model's
// identity (and animated logo) instead of the agent's own — usually empty —
// profile image. Non-agents pass through unchanged; an unknown base falls back
// to a minimal { id } record so the id-based branding still resolves. The
// derived-model short-circuits inside the branding helpers stay intentional for
// model selectors; base-model resolution belongs at the display call site.
export const resolveBaseModelRecord = (
	model: any,
	models: readonly any[] | null | undefined
): any => {
	const baseModelId = getBaseModelIdValue(model);
	if (!baseModelId) {
		return model;
	}
	return (models ?? []).find((candidate) => candidate?.id === baseModelId) ?? { id: baseModelId };
};

const normalizeCelestialModelIdentifier = (value: unknown) => {
	const normalized = normalizeBrandValue(value).toLowerCase().replace(/:latest$/i, '');
	const routedModelId = normalized.split('/').filter(Boolean).at(-1) ?? '';
	return routedModelId.replace(/[\s_]+/g, '-').replace(/-+/g, '-');
};

const getDirectModelIdentityValues = (candidate: ModelBrandCandidate) => {
	const model = candidate?.model ?? candidate ?? {};
	return [
		model?.id,
		model?.name,
		model?.litellm_params?.model,
		model?.litellmParams?.model,
		candidate?.value,
		candidate?.label
	];
};

export const getCelestialModelIdentity = (
	candidate: ModelBrandCandidate
): CelestialModelIdentity | null => {
	if (isDerivedModelCandidate(candidate)) {
		return null;
	}

	for (const value of getDirectModelIdentityValues(candidate)) {
		switch (normalizeCelestialModelIdentifier(value)) {
			case 'gpt-5.6-sol':
			case 'gpt-5.6-sol-pro':
				return 'sol';
			case 'gpt-5.6-terra':
				return 'terra';
			case 'gpt-5.6-luna':
				return 'luna';
		}
	}

	return null;
};

const getExplicitModelBrandHaystack = (candidate: ModelBrandCandidate) => {
	const model = candidate?.model ?? candidate ?? {};
	return [
		normalizeBrandValue(model?.name),
		normalizeBrandValue(model?.id),
		getBaseModelIdValue(candidate),
		normalizeBrandValue(model?.info?.base_model),
		normalizeBrandValue(model?.info?.baseModel),
		normalizeBrandValue(model?.model_info?.base_model),
		normalizeBrandValue(model?.modelInfo?.baseModel),
		normalizeBrandValue(model?.litellm_params?.model),
		normalizeBrandValue(model?.litellmParams?.model),
		normalizeBrandValue(candidate?.label),
		normalizeBrandValue(candidate?.value)
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
};

const getProviderBrandHaystack = (candidate: ModelBrandCandidate) => {
	const model = candidate?.model ?? candidate ?? {};
	return [
		normalizeBrandValue(model?.owned_by),
		normalizeBrandValue(model?.openai?.owned_by)
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
};

const haystackIsGoogle = (haystack: string) => haystack.includes('gemini') || haystack.includes('google');
const haystackIsAtlas = (haystack: string) => haystack.includes('atlas') || haystack.includes('anthropic');
const haystackIsOpenAI = (haystack: string) =>
	haystack.includes('openai') ||
	haystack.includes('chatgpt') ||
	haystack.includes('gpt') ||
	OPENAI_SHORT_CODE_PATTERN.test(haystack);

export const isLocalModelCandidate = (candidate: ModelBrandCandidate): boolean => {
	const model = candidate?.model ?? candidate ?? {};
	const meta = {
		...(model?.meta ?? {}),
		...(model?.info?.meta ?? {})
	};
	const providerValues = [
		meta?.local_provider,
		meta?.localProvider,
		model?.connection_type,
		model?.openai?.connection_type,
		model?.owned_by,
		model?.openai?.owned_by
	].map(normalizedProviderValue);

	if (
		providerValues.includes('lm_studio') ||
		providerValues.includes('local') ||
		providerValues.includes('lmstudio')
	) {
		return true;
	}

	return (model?.tags ?? []).some((tag: any) =>
		normalizeBrandValue(tag?.name).toLowerCase() === 'local models'
	);
};

export const isLocalEmbeddingModelCandidate = (candidate: ModelBrandCandidate): boolean => {
	if (!isLocalModelCandidate(candidate)) {
		return false;
	}

	const model = candidate?.model ?? candidate ?? {};
	const meta = {
		...(model?.meta ?? {}),
		...(model?.info?.meta ?? {})
	};
	const capabilities = model?.capabilities ?? meta?.capabilities ?? model?.info?.capabilities ?? {};
	const haystack = [
		model?.id,
		model?.name,
		model?.owned_by,
		candidate?.label,
		candidate?.value,
		meta?.model_type,
		meta?.modelType,
		meta?.type,
		meta?.task,
		meta?.pipeline_tag,
		meta?.pipelineTag,
		capabilities?.type
	]
		.map(normalizeBrandValue)
		.filter(Boolean)
		.join(' ')
		.toLowerCase();

	return (
		/\b(re)?rank(er|ing)?\b/.test(haystack) ||
		/\bembed(ding|dings)?\b/.test(haystack) ||
		haystack.includes('text-embedding') ||
		haystack.includes('sentence-transform')
	);
};

export const getModelLogoSources = (
	candidate: ModelBrandCandidate,
	apiBaseUrl: string,
	language: string,
	fallbackSrc: string
): ModelLogoSources => {
	if (!isDerivedModelCandidate(candidate) && isLocalModelCandidate(candidate)) {
		return {
			light: LOCAL_MODEL_LOGO_LIGHT_SRC,
			dark: LOCAL_MODEL_LOGO_DARK_SRC,
			isLocal: true
		};
	}

	const staticLogoSrc = getStaticModelLogoSrc(candidate);
	if (staticLogoSrc) {
		return {
			light: staticLogoSrc,
			dark: null,
			isLocal: false
		};
	}

	const model = candidate?.model ?? candidate ?? {};
	const modelId = normalizeBrandValue(model?.id ?? candidate?.value ?? candidate?.label);
	if (!modelId || !apiBaseUrl) {
		return {
			light: fallbackSrc,
			dark: null,
			isLocal: false
		};
	}

	return {
		light: buildModelLogoUrl(apiBaseUrl, modelId, language, getModelLogoCacheVersion(candidate)),
		dark: null,
		isLocal: false
	};
};

export const getModelBrandFamily = (candidate: ModelBrandCandidate): ModelBrandFamily => {
	if (isLocalModelCandidate(candidate)) {
		return 'local';
	}
	const explicitHaystack = getExplicitModelBrandHaystack(candidate);
	const providerHaystack = getProviderBrandHaystack(candidate);
	const haystack = [explicitHaystack, providerHaystack].filter(Boolean).join(' ');

	if (!haystack) {
		return 'other';
	}

	if (haystackIsGoogle(explicitHaystack)) {
		return 'google';
	}
	if (haystackIsAtlas(explicitHaystack)) {
		return 'atlas';
	}
	if (haystackIsOpenAI(explicitHaystack)) {
		return 'openai';
	}

	if (haystackIsGoogle(providerHaystack)) {
		return 'google';
	}
	if (haystackIsAtlas(providerHaystack)) {
		return 'atlas';
	}
	if (haystackIsOpenAI(providerHaystack)) {
		return 'openai';
	}

	return 'other';
};

export const getStaticModelLogoSrc = (candidate: ModelBrandCandidate): string | null => {
	if (isDerivedModelCandidate(candidate)) {
		return null;
	}

	if (isLocalModelCandidate(candidate)) {
		return null;
	}

	const brandFamily = getModelBrandFamily(candidate);
	if (brandFamily === 'google') {
		return GOOGLE_MODEL_LOGO_SRC;
	}

	const celestialIdentity = getCelestialModelIdentity(candidate);
	if (celestialIdentity) {
		return CELESTIAL_MODEL_LOGO_SOURCES[celestialIdentity];
	}

	if (brandFamily === 'atlas') {
		return ATLAS_MODEL_LOGO_SRC;
	}
	if (brandFamily === 'openai') {
		return OPENAI_MODEL_LOGO_SRC;
	}

	return null;
};

export const usesStaticModelLogo = (candidate: ModelBrandCandidate) => getStaticModelLogoSrc(candidate) !== null;

export const usesCelestialModelLogo = (candidate: ModelBrandCandidate) =>
	getCelestialModelIdentity(candidate) !== null;

export const usesDarkLogoBadgeInLightMode = (candidate: ModelBrandCandidate) =>
	!isDerivedModelCandidate(candidate) &&
	getModelBrandFamily(candidate) === 'openai' &&
	getCelestialModelIdentity(candidate) === null;

export const getModelSelectorLogoPresentation = (
	candidate: ModelBrandCandidate,
	variant: ModelSelectorLogoVariant = 'compact'
): ModelSelectorLogoPresentation => {
	const brandFamily = getModelBrandFamily(candidate);
	const usesCelestialLogo = usesCelestialModelLogo(candidate);
	const needsDarkBadge = usesDarkLogoBadgeInLightMode(candidate);
	const outerSizeClass =
		brandFamily === 'local'
			? LOCAL_MODEL_SELECTOR_LOGO_SIZE_CLASSES[variant]
			: MODEL_SELECTOR_LOGO_SIZE_CLASSES[variant];
	const sharedWrapperClassName = `flex ${outerSizeClass} shrink-0 items-center justify-center overflow-hidden rounded-full`;

	return {
		brandFamily,
		needsDarkBadge,
		outerSizeClass,
		wrapperClassName: needsDarkBadge
			? `${sharedWrapperClassName} bg-black shadow-sm ring-1 ring-black/10 dark:bg-transparent dark:shadow-none dark:ring-0`
			: `${sharedWrapperClassName} bg-transparent shadow-none ring-0`,
		imageClassName: `${usesCelestialLogo ? 'celestial-model-logo ' : ''}size-full rounded-full object-cover`
	};
};
