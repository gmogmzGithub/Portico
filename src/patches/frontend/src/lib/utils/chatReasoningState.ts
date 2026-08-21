type ChatStateModelLike = {
	id?: unknown;
	name?: unknown;
	base_model_id?: unknown;
	info?: Record<string, unknown> | null;
};

const normalizeModelIdentity = (value: unknown): string | null => {
	const normalized = typeof value === 'string' ? value.trim() : '';
	return normalized.length > 0 ? normalized : null;
};

export const resolvePrimaryChatStateModelName = ({
	modelIds,
	models
}: {
	modelIds: unknown;
	models: ChatStateModelLike[] | null | undefined;
}): string | null => {
	const primaryModelId = Array.isArray(modelIds)
		? normalizeModelIdentity(modelIds[0])
		: null;
	if (!primaryModelId) {
		return null;
	}

	const availableModels = Array.isArray(models) ? models : [];
	const primaryModel = availableModels.find(
		(model) => normalizeModelIdentity(model?.id) === primaryModelId
	);
	const baseModelId =
		normalizeModelIdentity(primaryModel?.base_model_id) ??
		normalizeModelIdentity(primaryModel?.info?.base_model_id);
	if (baseModelId) {
		const baseModel = availableModels.find(
			(model) => normalizeModelIdentity(model?.id) === baseModelId
		);
		return (
			normalizeModelIdentity(baseModel?.name) ??
			normalizeModelIdentity(baseModel?.id) ??
			baseModelId
		);
	}

	return (
		normalizeModelIdentity(primaryModel?.name) ??
		normalizeModelIdentity(primaryModel?.id) ??
		primaryModelId
	);
};

export const sanitizeReasoningEffortByModel = (
	reasoningEffortByModel: unknown
): Record<string, string> => {
	if (
		!reasoningEffortByModel ||
		typeof reasoningEffortByModel !== 'object' ||
		Array.isArray(reasoningEffortByModel)
	) {
		return {};
	}

	const normalizedEntries = Object.entries(reasoningEffortByModel)
		.filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
		.map(([key, value]) => [key.trim(), value.trim()] as const)
		.filter(([key, value]) => key.length > 0 && value.length > 0)
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

	return Object.fromEntries(normalizedEntries);
};

const sanitizeReasoningEffortOptions = (allowedOptions: unknown): string[] => {
	if (!Array.isArray(allowedOptions)) {
		return [];
	}

	return allowedOptions
		.filter((value) => typeof value === 'string')
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
};

const coerceExplicitReasoningEffortToAllowedOptions = ({
	explicitReasoningEffort,
	allowedOptions
}: {
	explicitReasoningEffort: unknown;
	allowedOptions: string[];
}): string | null => {
	const normalizedExplicit =
		typeof explicitReasoningEffort === 'string' ? explicitReasoningEffort.trim() : '';
	if (!normalizedExplicit) {
		return null;
	}

	if (allowedOptions.includes(normalizedExplicit)) {
		return normalizedExplicit;
	}

	// Ultra remains a valid backend value, but the GUI caps GPT-5.6 Sol at Max.
	return normalizedExplicit === 'ultra' && allowedOptions.includes('max') ? 'max' : null;
};

export const reasoningEffortByModelSignature = (reasoningEffortByModel: unknown): string =>
	JSON.stringify(sanitizeReasoningEffortByModel(reasoningEffortByModel));

export const primaryReasoningEffortFromByModel = (
	reasoningEffortByModel: unknown
): string | null => {
	const normalized = sanitizeReasoningEffortByModel(reasoningEffortByModel);
	return normalized['0'] ?? null;
};

export const normalizePersistedReasoningEffortByModel = ({
	persistedState,
	selectedModelIds
}: {
	persistedState: Record<string, any> | null | undefined;
	selectedModelIds: string[];
}): Record<string, string> => {
	if (!persistedState) {
		return {};
	}

	const byModel = persistedState.reasoning_effort_by_model;
	if (byModel && typeof byModel === 'object' && !Array.isArray(byModel)) {
		return sanitizeReasoningEffortByModel(byModel);
	}

	const legacyEffort =
		typeof persistedState.reasoning_effort === 'string'
			? persistedState.reasoning_effort.trim()
			: '';
	if (!legacyEffort) {
		return {};
	}

	if (!Array.isArray(selectedModelIds) || selectedModelIds.length === 0) {
		return { '0': legacyEffort };
	}

	return Object.fromEntries(
		selectedModelIds.map((_, index) => [String(index), legacyEffort])
	);
};

export const resolveReasoningEffortFromAllowedOptions = ({
	explicitReasoningEffort,
	allowedOptions
}: {
	explicitReasoningEffort: unknown;
	allowedOptions: unknown;
}): string | null => {
	const normalizedOptions = sanitizeReasoningEffortOptions(allowedOptions);
	if (normalizedOptions.length === 0) {
		return null;
	}

	const coercedExplicit = coerceExplicitReasoningEffortToAllowedOptions({
		explicitReasoningEffort,
		allowedOptions: normalizedOptions
	});
	if (coercedExplicit) {
		return coercedExplicit;
	}

	if (normalizedOptions.includes('low')) {
		return 'low';
	}

	return normalizedOptions.includes('medium') ? 'medium' : normalizedOptions[0];
};

export const resolveReasoningEffortByModelEntry = ({
	reasoningEffortByModel,
	modelIndex,
	allowedOptions
}: {
	reasoningEffortByModel: unknown;
	modelIndex: number | string;
	allowedOptions: unknown;
}): string | null =>
	resolveReasoningEffortFromAllowedOptions({
		explicitReasoningEffort:
			sanitizeReasoningEffortByModel(reasoningEffortByModel)[String(modelIndex)],
		allowedOptions
	});

export const resolveReasoningEffortByModelSnapshot = ({
	reasoningEffortByModel,
	allowedOptionsByModelIndex
}: {
	reasoningEffortByModel: unknown;
	allowedOptionsByModelIndex: Record<string, unknown> | null | undefined;
}): Record<string, string> => {
	if (
		!allowedOptionsByModelIndex ||
		typeof allowedOptionsByModelIndex !== 'object' ||
		Array.isArray(allowedOptionsByModelIndex)
	) {
		return {};
	}

	const normalizedMap = sanitizeReasoningEffortByModel(reasoningEffortByModel);
	const resolvedEntries = Object.entries(allowedOptionsByModelIndex)
		.map(([key, allowedOptions]) => {
			const normalizedKey = key.trim();
			if (normalizedKey.length === 0) {
				return null;
			}

			const resolved = resolveReasoningEffortFromAllowedOptions({
				explicitReasoningEffort: normalizedMap[normalizedKey],
				allowedOptions
			});
			return resolved ? ([normalizedKey, resolved] as const) : null;
		})
		.filter((entry): entry is readonly [string, string] => Boolean(entry))
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

	return Object.fromEntries(resolvedEntries);
};

export const normalizeExplicitReasoningEffortByModel = ({
	reasoningEffortByModel,
	allowedOptionsByModelIndex,
	selectedModelCount
}: {
	reasoningEffortByModel: unknown;
	allowedOptionsByModelIndex: Record<string, unknown> | null | undefined;
	selectedModelCount: number;
}): Record<string, string> => {
	const normalizedMap = sanitizeReasoningEffortByModel(reasoningEffortByModel);
	const safeSelectedModelCount =
		typeof selectedModelCount === 'number' && Number.isFinite(selectedModelCount)
			? Math.max(0, Math.floor(selectedModelCount))
			: 0;
	const allowedOptionsLookup =
		allowedOptionsByModelIndex &&
		typeof allowedOptionsByModelIndex === 'object' &&
		!Array.isArray(allowedOptionsByModelIndex)
			? allowedOptionsByModelIndex
			: {};

	const normalizedEntries = Object.entries(normalizedMap)
		.map(([key, explicitReasoningEffort]) => {
			const normalizedKey = key.trim();
			if (normalizedKey.length === 0) {
				return null;
			}

			const numericKey = Number(normalizedKey);
			if (
				Number.isInteger(numericKey) &&
				numericKey >= 0 &&
				numericKey >= safeSelectedModelCount
			) {
				return null;
			}

			if (!(normalizedKey in allowedOptionsLookup)) {
				return [normalizedKey, explicitReasoningEffort] as const;
			}

			const normalizedAllowedOptions = sanitizeReasoningEffortOptions(
				allowedOptionsLookup[normalizedKey]
			);
			if (normalizedAllowedOptions.length === 0) {
				return null;
			}

			const coercedExplicit = coerceExplicitReasoningEffortToAllowedOptions({
				explicitReasoningEffort,
				allowedOptions: normalizedAllowedOptions
			});
			return coercedExplicit
				? ([normalizedKey, coercedExplicit] as const)
				: null;
		})
		.filter((entry): entry is readonly [string, string] => Boolean(entry))
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

	return Object.fromEntries(normalizedEntries);
};

// True when the selected-model id list has resolved to at least one real model.
// Used to defer reasoning-effort normalization while a chat is still loading
// (notably a delegated subagent chat, whose selectedModelIds is momentarily
// empty): normalizing against an empty selection would prune the persisted
// effort (index "0") via normalizeExplicitReasoningEffortByModel, so the picker
// would show the low/medium default instead of the effort actually used.
export const hasResolvedReasoningModelSelection = (
	modelIds: readonly (string | null | undefined)[] | null | undefined
): boolean =>
	Array.isArray(modelIds) && modelIds.some((id) => String(id ?? '').trim().length > 0);

// Seed index "0" from the loaded chat's params.reasoning_effort when there's no
// explicit per-model entry. Used for delegated subagent chats whose chat-state
// is service-owned and unreadable by the human — create_subagent_chat stamps
// params.reasoning_effort so the effort still shows. Never overrides an existing
// entry; returns the SAME reference when nothing changes (so callers can skip a
// no-op write).
export const seedReasoningEffortFromParams = (
	reasoningEffortByModel: Record<string, string>,
	params: { reasoning_effort?: unknown } | null | undefined
): Record<string, string> => {
	const effort =
		typeof params?.reasoning_effort === 'string' ? params.reasoning_effort.trim() : '';
	if (!effort) {
		return reasoningEffortByModel;
	}
	if (reasoningEffortByModel && reasoningEffortByModel['0'] !== undefined) {
		return reasoningEffortByModel;
	}
	return { ...reasoningEffortByModel, '0': effort };
};

export const normalizeTransientReasoningEffortByModel = ({
	reasoningEffortByModel,
	allowedOptionsByModelIndex
}: {
	reasoningEffortByModel: unknown;
	allowedOptionsByModelIndex: Record<string, unknown> | null | undefined;
}): Record<string, string> => {
	if (
		!allowedOptionsByModelIndex ||
		typeof allowedOptionsByModelIndex !== 'object' ||
		Array.isArray(allowedOptionsByModelIndex)
	) {
		return {};
	}

	const normalizedMap = sanitizeReasoningEffortByModel(reasoningEffortByModel);
	const normalizedEntries = Object.entries(normalizedMap)
		.map(([key, explicitReasoningEffort]) => {
			const allowedOptions = allowedOptionsByModelIndex[key];
			const normalizedAllowedOptions = sanitizeReasoningEffortOptions(allowedOptions);
			if (normalizedAllowedOptions.length === 0) {
				return null;
			}

			const coercedExplicit = coerceExplicitReasoningEffortToAllowedOptions({
				explicitReasoningEffort,
				allowedOptions: normalizedAllowedOptions
			});
			if (coercedExplicit) {
				return [key, coercedExplicit] as const;
			}

			const fallbackReasoningEffort = resolveReasoningEffortFromAllowedOptions({
				explicitReasoningEffort: null,
				allowedOptions: normalizedAllowedOptions
			});
			return fallbackReasoningEffort
				? ([key, fallbackReasoningEffort] as const)
				: null;
		})
		.filter((entry): entry is readonly [string, string] => Boolean(entry))
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

	return Object.fromEntries(normalizedEntries);
};

// ---- model-identity-aware effort state (agent-switch sync) -------------------
//
// The wire/persisted shape keys efforts by SELECTION INDEX ('0', '1', ...),
// which cannot distinguish "the user chose this for agent A" from "leftover
// value after switching the slot to agent B" — so a stale effort used to
// shadow the new agent's configured default whenever it was also legal for
// the new base model. The session ledger keys the same values by the model id
// they were created for; rebuilding the index map from the ledger re-seeds
// any slot whose model changed, while values travel with their model
// (reorders and @-mention roundtrips included).

export type ReasoningEffortLedgerEntry = { value: string; explicit: boolean };
export type ReasoningEffortLedger = Record<string, ReasoningEffortLedgerEntry>;

// Associate the index-keyed map's values with the model ids currently at
// those indexes. Call ONLY at moments the association is knowable: applying a
// persisted chat state or draft (the map belongs to that selection), seeding
// from chat params, or an explicit user selection. Never on a generic
// selection change — that is exactly when indexes and models disagree.
export const primeReasoningEffortLedger = ({
	ledger,
	modelIds,
	reasoningEffortByModel,
	explicit = false
}: {
	ledger: ReasoningEffortLedger | null | undefined;
	modelIds: readonly (string | null | undefined)[] | null | undefined;
	reasoningEffortByModel: unknown;
	explicit?: boolean;
}): ReasoningEffortLedger => {
	const next: ReasoningEffortLedger = { ...(ledger ?? {}) };
	const map = sanitizeReasoningEffortByModel(reasoningEffortByModel);
	(Array.isArray(modelIds) ? modelIds : []).forEach((modelId, index) => {
		const id = normalizeModelIdentity(modelId);
		const value = map[String(index)];
		if (!id || !value) {
			return;
		}
		const existing = next[id];
		next[id] = { value, explicit: explicit || existing?.explicit === true };
	});
	return next;
};

export const removeReasoningEffortLedgerEntry = (
	ledger: ReasoningEffortLedger | null | undefined,
	modelId: unknown
): ReasoningEffortLedger => {
	const id = normalizeModelIdentity(modelId);
	const next: ReasoningEffortLedger = { ...(ledger ?? {}) };
	if (id) {
		delete next[id];
	}
	return next;
};

// Rebuild the index-keyed wire map for the current selection. Precedence per
// model id: the session ledger (whatever this chat already resolved for that
// model, explicit or seeded) > the agent's configured effort > the
// allowed-options fallback. Every value is validated against the model's
// allowed options; models without a reasoning control get no entry.
export const rebuildReasoningEffortSelectionState = ({
	ledger,
	modelIds,
	configuredEffortByModelId,
	allowedOptionsByModelId
}: {
	ledger: ReasoningEffortLedger | null | undefined;
	modelIds: readonly (string | null | undefined)[] | null | undefined;
	configuredEffortByModelId: Record<string, unknown> | null | undefined;
	allowedOptionsByModelId: Record<string, unknown> | null | undefined;
}): {
	reasoningEffortByModel: Record<string, string>;
	ledger: ReasoningEffortLedger;
} => {
	const nextLedger: ReasoningEffortLedger = { ...(ledger ?? {}) };
	const nextMap: Record<string, string> = {};
	(Array.isArray(modelIds) ? modelIds : []).forEach((modelId, index) => {
		const id = normalizeModelIdentity(modelId);
		if (!id) {
			return;
		}
		const allowedOptions = sanitizeReasoningEffortOptions(
			allowedOptionsByModelId?.[id]
		);
		if (allowedOptions.length === 0) {
			return;
		}
		const ledgerValue = coerceExplicitReasoningEffortToAllowedOptions({
			explicitReasoningEffort: nextLedger[id]?.value,
			allowedOptions
		});
		if (ledgerValue) {
			nextMap[String(index)] = ledgerValue;
			nextLedger[id] = {
				value: ledgerValue,
				explicit: nextLedger[id]?.explicit === true
			};
			return;
		}
		const resolved = resolveReasoningEffortFromAllowedOptions({
			explicitReasoningEffort: configuredEffortByModelId?.[id],
			allowedOptions
		});
		if (!resolved) {
			return;
		}
		nextMap[String(index)] = resolved;
		nextLedger[id] = { value: resolved, explicit: false };
	});
	return { reasoningEffortByModel: nextMap, ledger: nextLedger };
};
