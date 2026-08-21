import { resolveMigratedModelId } from '../config/model-capabilities';
import {
	getEnabledModelIds,
	getModelAvailability,
	normalizeModelId,
	type ModelLike
} from './modelAvailability';

export const DEFAULT_CHAT_MODEL_ID = 'Claude Sonnet 5';

export const normalizeSelectedModelIds = (candidateIds: unknown): string[] => {
	if (Array.isArray(candidateIds)) {
		return candidateIds
			.map((modelId) => normalizeModelId(resolveMigratedModelId(modelId)))
			.filter((modelId, index, ids) => modelId !== '' && ids.indexOf(modelId) === index);
	}

	if (typeof candidateIds === 'string') {
		return candidateIds
			.split(',')
			.map((modelId) => normalizeModelId(resolveMigratedModelId(modelId)))
			.filter((modelId, index, ids) => modelId !== '' && ids.indexOf(modelId) === index);
	}

	return [];
};

export const resolveEnabledSelectedModelIds = (
	candidateIds: unknown = [],
	models: ModelLike[] = [],
	{ fallback = false }: { fallback?: boolean } = {}
): string[] => {
	const enabledModelIds = getEnabledModelIds(models);
	const enabledModelIdSet = new Set(enabledModelIds);
	const selected = normalizeSelectedModelIds(candidateIds)
		.filter(
			(modelId, index, ids) =>
				modelId !== '' && enabledModelIdSet.has(modelId) && ids.indexOf(modelId) === index
		);

	if (selected.length > 0) {
		return selected;
	}

	if (!fallback) {
		return [];
	}

	if (enabledModelIds.length === 0) {
		return [DEFAULT_CHAT_MODEL_ID];
	}

	return enabledModelIds.includes(DEFAULT_CHAT_MODEL_ID)
		? [DEFAULT_CHAT_MODEL_ID]
		: [enabledModelIds[0]];
};

export const resolveEffectiveDefaultModelId = ({
	userDefaultModels,
	configDefaultModels,
	models = []
}: {
	userDefaultModels?: unknown;
	configDefaultModels?: unknown;
	models?: ModelLike[];
}): string => {
	const userDefaults = normalizeSelectedModelIds(userDefaultModels);
	const configuredDefaults =
		userDefaults.length > 0 ? userDefaults : normalizeSelectedModelIds(configDefaultModels);

	return (
		resolveEnabledSelectedModelIds(configuredDefaults, models, { fallback: true })[0] ??
		DEFAULT_CHAT_MODEL_ID
	);
};

export const getAvailableBaseModels = <T extends ModelLike>(
	models: T[] = [],
	{ currentModelId = null }: { currentModelId?: string | null } = {}
): T[] => {
	const normalizedCurrentModelId = normalizeModelId(currentModelId);

	return models.filter((model) => {
		const modelId = normalizeModelId(model?.id);
		return (
			(!normalizedCurrentModelId || modelId !== normalizedCurrentModelId) &&
			!model?.preset &&
			model?.owned_by !== 'arena' &&
			!(model?.direct ?? false) &&
			!getModelAvailability(model, models).disabled
		);
	});
};

export const resolveAvailableBaseModelId = (
	currentBaseModelId: string | null | undefined,
	models: ModelLike[] = [],
	{ currentModelId = null }: { currentModelId?: string | null } = {}
): string | null => {
	const availableBaseModels = getAvailableBaseModels(models, { currentModelId });
	const normalizedCurrentBaseModelId = normalizeModelId(
		resolveMigratedModelId(currentBaseModelId)
	);
	const hasSelectedBaseModel = availableBaseModels.some(
		(baseModel) => normalizeModelId(baseModel.id) === normalizedCurrentBaseModelId
	);

	if (hasSelectedBaseModel) {
		return normalizedCurrentBaseModelId || null;
	}

	return normalizeModelId(availableBaseModels[0]?.id) || null;
};
