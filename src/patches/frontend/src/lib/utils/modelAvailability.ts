export type ModelLike = {
	id?: string;
	name?: string;
	base_model_id?: string | null;
	baseModelId?: string | null;
	preset?: boolean;
	owned_by?: string;
	direct?: boolean;
	info?: {
		base_model_id?: string | null;
		baseModelId?: string | null;
		meta?: object | null;
	};
	meta?: object | null;
};

type ModelAvailability = {
	disabled: boolean;
	disabledReason: string | null;
};

export const normalizeModelId = (candidate: unknown): string => {
	const normalized = `${candidate ?? ''}`.trim();
	return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : '';
};

const resolveModelMeta = (model: ModelLike | null | undefined): Record<string, unknown> => ({
	...(model?.info?.meta ?? {}),
	...(model?.meta ?? {})
}) as Record<string, unknown>;

export const getModelBaseModelId = (model: ModelLike | null | undefined): string | null => {
	const candidate =
		model?.base_model_id ??
		model?.baseModelId ??
		model?.info?.base_model_id ??
		model?.info?.baseModelId ??
		null;
	const normalized = normalizeModelId(candidate);
	return normalized || null;
};

export const getModelDisabledReason = (model: ModelLike | null | undefined): string | null => {
	const candidate = resolveModelMeta(model).disabled_reason;
	if (typeof candidate !== 'string') {
		return null;
	}

	const normalized = candidate.trim();
	return normalized ? normalized : null;
};

export const isModelHidden = (model: ModelLike | null | undefined): boolean =>
	resolveModelMeta(model).hidden === true;

const isModelDirectlyDisabled = (model: ModelLike | null | undefined): boolean => {
	const meta = resolveModelMeta(model);
	return meta.disabled === true || getModelDisabledReason(model) !== null;
};

const findModelById = (models: ModelLike[], modelId: string): ModelLike | undefined =>
	models.find((candidate) => {
		const candidateId = normalizeModelId(candidate?.id);
		return candidateId === modelId || candidateId === `${modelId}:latest`;
	});

export const getModelAvailability = (
	model: ModelLike | null | undefined,
	allModels: ModelLike[] = [],
	visitedIds: Set<string> = new Set()
): ModelAvailability => {
	if (!model) {
		return { disabled: false, disabledReason: null };
	}

	if (isModelDirectlyDisabled(model)) {
		return {
			disabled: true,
			disabledReason: getModelDisabledReason(model)
		};
	}

	const baseModelId = getModelBaseModelId(model);
	if (!baseModelId) {
		return { disabled: false, disabledReason: null };
	}

	const modelId = normalizeModelId(model.id);
	if (visitedIds.has(baseModelId) || (modelId && visitedIds.has(modelId))) {
		return { disabled: false, disabledReason: null };
	}

	const baseModel = findModelById(allModels, baseModelId);
	if (!baseModel) {
		return { disabled: false, disabledReason: null };
	}

	const nextVisitedIds = new Set(visitedIds);
	if (modelId) {
		nextVisitedIds.add(modelId);
	}
	nextVisitedIds.add(baseModelId);
	return getModelAvailability(baseModel, allModels, nextVisitedIds);
};

export const getEnabledModelIds = (models: ModelLike[]): string[] =>
	models
		.filter((model) => !isModelHidden(model) && !getModelAvailability(model, models).disabled)
		.map((model) => normalizeModelId(model?.id))
		.filter(Boolean);
