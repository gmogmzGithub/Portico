// Relative import (not $lib) so the esbuild-based node test harness can
// bundle this module without SvelteKit alias resolution.
import { resolveModelPickerMetadata } from '../config/model-capabilities';

/**
 * The literal sent upstream when the lightning toggle is on. OpenAI treats
 * "priority" and "fast" identically for GPT-5.6-generation models, but the
 * llm-proxy's cost/metrics accounting recognizes only "priority" — keep this
 * literal until the proxy aliases "fast".
 */
export const FAST_MODE_SERVICE_TIER = 'priority' as const;

type FastModeModelLike = {
	id?: unknown;
	name?: unknown;
	base_model_id?: unknown;
	info?: Record<string, unknown> | null;
};

export const sanitizeFastModeEnabled = (value: unknown): boolean => value === true;

export const normalizePersistedFastMode = (
	persistedState: Record<string, unknown> | null | undefined
): boolean => sanitizeFastModeEnabled(persistedState?.fast_mode);

const normalizeModelIdentity = (value: unknown): string | null => {
	const normalized = typeof value === 'string' ? value.trim() : '';
	return normalized.length > 0 ? normalized : null;
};

const findModelById = (
	models: FastModeModelLike[] | null | undefined,
	id: unknown
): FastModeModelLike | undefined => {
	const normalizedId = normalizeModelIdentity(id);
	if (!normalizedId) {
		return undefined;
	}
	return (Array.isArray(models) ? models : []).find(
		(model) => normalizeModelIdentity(model?.id) === normalizedId
	);
};

/**
 * Fast mode (OpenAI service_tier) applies to GPT models only. Resolution is
 * base-model-first so custom agents built on a GPT base qualify regardless of
 * their display name, mirroring the model picker's provider grouping.
 */
export const isGptFastModeModel = (
	model: FastModeModelLike | null | undefined,
	models?: FastModeModelLike[] | null
): boolean => {
	if (!model) {
		return false;
	}
	const baseModelId = model.info?.base_model_id ?? model.base_model_id;
	const baseModel = findModelById(models, baseModelId);
	return (
		resolveModelPickerMetadata(
			baseModelId,
			baseModel?.id,
			baseModel?.name,
			model.id,
			model.name
		)?.pickerProvider === 'openai'
	);
};

export const hasGptFastModeModel = (
	modelIds: unknown,
	models: FastModeModelLike[] | null | undefined
): boolean => {
	if (!Array.isArray(modelIds)) {
		return false;
	}
	return modelIds.some((id) => {
		const model = findModelById(models, id);
		if (model) {
			return isGptFastModeModel(model, models);
		}
		return resolveModelPickerMetadata(id)?.pickerProvider === 'openai';
	});
};

/**
 * The per-model request param for one send slot: "priority" only when the
 * lightning toggle is on AND this slot's model resolves to a GPT base;
 * undefined otherwise (JSON serialization drops the key entirely).
 */
export const deriveServiceTierParam = ({
	fastModeEnabled,
	model,
	models
}: {
	fastModeEnabled: unknown;
	model: FastModeModelLike | null | undefined;
	models?: FastModeModelLike[] | null;
}): typeof FAST_MODE_SERVICE_TIER | undefined => {
	if (!sanitizeFastModeEnabled(fastModeEnabled)) {
		return undefined;
	}
	return isGptFastModeModel(model, models) ? FAST_MODE_SERVICE_TIER : undefined;
};
