import { resolveModelPricing } from './model-pricing';
import { resolveModelPickerMetadata } from './model-capabilities';
import { isLocalModelCandidate } from '../utils/modelBranding';

export type ModelTraitKey = 'general' | 'lightweight' | 'heavy' | 'premium';

export interface ModelTraitDefinition {
	key: ModelTraitKey;
	label: string;
	description: string;
}

export interface ModelTraitResolutionInput {
	modelId?: string | null;
	modelName?: string | null;
	baseModelId?: string | null;
	baseModelName?: string | null;
}

export const MODEL_TRAIT_DEFINITIONS: Record<ModelTraitKey, ModelTraitDefinition> = {
	general: {
		key: 'general',
		label: 'Everyday',
		description: 'General purpose. Great for everyday work and balanced tasks.'
	},
	lightweight: {
		key: 'lightweight',
		label: 'Lightweight',
		description: 'Fast and nimble. Best for simpler work and quick turns.'
	},
	heavy: {
		key: 'heavy',
		label: 'Heavy',
		description: 'Better for complex work, but slower and more expensive.'
	},
	premium: {
		key: 'premium',
		label: 'Extreme',
		description:
			'Extremely capable for very complex work, but very slow and very expensive.'
	}
};

export const MODEL_TRAIT_LEGEND_ORDER: ModelTraitKey[] = [
	'general',
	'heavy',
	'premium',
	'lightweight'
];

function normalizeModelValue(value: unknown): string | null {
	const normalized = String(value ?? '').trim();
	return normalized.length > 0 ? normalized : null;
}

export function resolveModelTraitKeys(input: ModelTraitResolutionInput = {}): ModelTraitKey[] {
	const candidates = [
		{ modelId: normalizeModelValue(input.baseModelId), modelName: normalizeModelValue(input.baseModelName) },
		{ modelId: normalizeModelValue(input.modelId), modelName: normalizeModelValue(input.modelName) }
	];

	for (const candidate of candidates) {
		if (!candidate.modelId && !candidate.modelName) {
			continue;
		}

		const spec = resolveModelPricing(candidate.modelId, candidate.modelName);
		const metadata = resolveModelPickerMetadata(
			candidate.modelId,
			candidate.modelName,
			spec?.displayName,
			spec?.key
		);
		if (metadata) return [metadata.pickerTier];
	}

	return [];
}

export function resolveModelTraits(input: ModelTraitResolutionInput = {}): ModelTraitDefinition[] {
	return resolveModelTraitKeys(input).map((key) => MODEL_TRAIT_DEFINITIONS[key]);
}

export function resolveModelTraitKeysForModel(model: Record<string, any> | null | undefined): ModelTraitKey[] {
	if (isLocalModelCandidate(model)) {
		return [];
	}
	const info = model?.info ?? null;

	return resolveModelTraitKeys({
		modelId: normalizeModelValue(model?.id),
		modelName: normalizeModelValue(model?.name),
		baseModelId:
			normalizeModelValue(model?.base_model_id) ??
			normalizeModelValue(model?.baseModelId) ??
			normalizeModelValue(info?.base_model_id) ??
			normalizeModelValue(info?.baseModelId),
		baseModelName:
			normalizeModelValue(info?.base_model_name) ??
			normalizeModelValue(info?.baseModelName) ??
			null
	});
}

export function getModelTraitSortRankForModel(
	model: Record<string, any> | null | undefined
): number {
	const [trait] = resolveModelTraitKeysForModel(model);
	const rank = trait ? MODEL_TRAIT_LEGEND_ORDER.indexOf(trait) : -1;
	return rank >= 0 ? rank : MODEL_TRAIT_LEGEND_ORDER.length;
}
