// Shared derivation of the selected model's context window, used by the
// composer gauge (MessageInput) and by chat-state persistence (Chat), so both
// surfaces agree on the window even for custom agents that resolve through a
// base model.
import { getMaxTokens } from '$lib/config/model-capabilities';

type ModelLike = {
	id?: string;
	name?: string;
	info?: {
		base_model_id?: string;
		meta?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

const parseTokenLimit = (value: unknown): number | null => {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}

	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}

	return null;
};

const getModelMaxContextTokens = (model: ModelLike | undefined): number | null => {
	if (!model) return null;

	const info = (model.info ?? {}) as Record<string, unknown>;
	const meta = (info?.meta ?? {}) as Record<string, unknown>;

	return (
		parseTokenLimit(meta?.max_context_tokens) ??
		parseTokenLimit(meta?.maxContextTokens) ??
		parseTokenLimit(meta?.max_tokens) ??
		parseTokenLimit(meta?.maxTokens) ??
		parseTokenLimit(info?.max_context_tokens) ??
		parseTokenLimit(info?.maxContextTokens) ??
		parseTokenLimit(info?.max_tokens) ??
		parseTokenLimit(info?.maxTokens)
	);
};

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128000;

export const resolveModelMaxContextTokens = (
	models: ModelLike[] | undefined,
	selectedModelIds: (string | undefined)[] | undefined
): number => {
	const modelIds = Array.isArray(selectedModelIds) ? selectedModelIds : [];
	if (modelIds.length !== 1) return DEFAULT_MODEL_CONTEXT_WINDOW;
	const allModels = Array.isArray(models) ? models : [];
	const model = allModels.find((candidate) => candidate?.id === modelIds[0]);
	if (!model?.name) return DEFAULT_MODEL_CONTEXT_WINDOW;

	// For custom agents, resolve to base model
	let lookupName = model.name;
	let resolvedContextLimit = getModelMaxContextTokens(model);
	const baseModelId = model.info?.base_model_id;
	if (baseModelId) {
		const baseModel = allModels.find((candidate) => candidate?.id === baseModelId);
		if (baseModel?.name) {
			lookupName = baseModel.name;
		}
		resolvedContextLimit = getModelMaxContextTokens(baseModel) ?? resolvedContextLimit;
	}

	return resolvedContextLimit ?? (getMaxTokens(lookupName) || DEFAULT_MODEL_CONTEXT_WINDOW);
};
