// PORTICO_PATCH (multi-chat tiling): pure helpers for the shared composer's
// focus-swap. Tiles publish their composer-relevant state into the pane
// runtime store via buildPaneRuntimeSnapshot; the primary Chat muxes its
// MessageInput props through deriveComposerViewState so the composer always
// shows the FOCUSED pane's model/effort/fast-mode/context/cost/capabilities;
// edits route back to the tile as PaneCommands; sends carry the target's
// settings via buildCrossPaneRequestContext.
//
// Relative import (not $lib) so the esbuild-based node test harness can
// bundle this module without SvelteKit alias resolution.
import {
	FAST_MODE_SERVICE_TIER,
	hasGptFastModeModel,
	sanitizeFastModeEnabled
} from './chatFastModeState';

type ModelLike = {
	id?: unknown;
	name?: unknown;
	base_model_id?: unknown;
	info?: Record<string, unknown> | null;
};

export type PaneCostMetrics = {
	cost: number;
	costWithoutCache: number;
	cacheSavings: number;
	savingsRate: number;
	cachedTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
};

export type PaneCapabilities = {
	tools: unknown[];
	skills: unknown[];
};

export type PaneComposerRuntime = {
	isStreaming: boolean;
	selectedModelIds: string[];
	pendingWork: Record<string, any> | null;
	title: string;
	// Explicit per-slot selections (what the effort control displays)…
	reasoningEffortByModel: Record<string, string>;
	// …and the resolved snapshot (explicit + per-model defaults) that a
	// dispatched prompt must carry, mirroring buildPendingWorkRequestContext.
	resolvedReasoningEffortByModel: Record<string, string>;
	reasoningEffortReady: boolean;
	fastModeEnabled: boolean;
	params: Record<string, unknown>;
	contextTokens: number;
	costMetrics: PaneCostMetrics;
	activeCapabilities: PaneCapabilities;
};

const sanitizeModelIds = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((id): id is string => typeof id === 'string' && id.length > 0)
		: [];

const sanitizeStringMap = (value: unknown): Record<string, string> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === 'string' && entry.trim()) {
			result[key] = entry;
		}
	}
	return result;
};

const sanitizeParams = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return {};
	}
};

const toFiniteNumber = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const EMPTY_PANE_COST_METRICS: PaneCostMetrics = Object.freeze({
	cost: 0,
	costWithoutCache: 0,
	cacheSavings: 0,
	savingsRate: 0,
	cachedTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0
});

export const EMPTY_PANE_CAPABILITIES: PaneCapabilities = Object.freeze({
	tools: Object.freeze([]) as unknown[],
	skills: Object.freeze([]) as unknown[]
});

const sanitizeCostMetrics = (value: unknown): PaneCostMetrics => {
	const metrics = (value ?? {}) as Record<string, unknown>;
	return {
		cost: toFiniteNumber(metrics.cost),
		costWithoutCache: toFiniteNumber(metrics.costWithoutCache),
		cacheSavings: toFiniteNumber(metrics.cacheSavings),
		savingsRate: toFiniteNumber(metrics.savingsRate),
		cachedTokens: toFiniteNumber(metrics.cachedTokens),
		cacheReadTokens: toFiniteNumber(metrics.cacheReadTokens),
		cacheWriteTokens: toFiniteNumber(metrics.cacheWriteTokens)
	};
};

const sanitizeCapabilities = (value: unknown): PaneCapabilities => {
	const capabilities = (value ?? {}) as Record<string, unknown>;
	return {
		tools: Array.isArray(capabilities.tools) ? capabilities.tools : [],
		skills: Array.isArray(capabilities.skills) ? capabilities.skills : []
	};
};

export const buildPaneRuntimeSnapshot = (input: {
	isStreaming: unknown;
	selectedModelIds: unknown;
	pendingWork: Record<string, any> | null | undefined;
	title: unknown;
	reasoningEffortByModel: unknown;
	resolvedReasoningEffortByModel: unknown;
	reasoningEffortReady: unknown;
	fastModeEnabled: unknown;
	params: unknown;
	contextTokens: unknown;
	costMetrics: unknown;
	activeCapabilities: unknown;
}): PaneComposerRuntime => ({
	isStreaming: input.isStreaming === true,
	selectedModelIds: sanitizeModelIds(input.selectedModelIds),
	pendingWork: input.pendingWork ?? null,
	title: typeof input.title === 'string' ? input.title : '',
	reasoningEffortByModel: sanitizeStringMap(input.reasoningEffortByModel),
	resolvedReasoningEffortByModel: sanitizeStringMap(input.resolvedReasoningEffortByModel),
	reasoningEffortReady: input.reasoningEffortReady === true,
	fastModeEnabled: sanitizeFastModeEnabled(input.fastModeEnabled),
	params: sanitizeParams(input.params),
	contextTokens: toFiniteNumber(input.contextTokens),
	costMetrics: sanitizeCostMetrics(input.costMetrics),
	activeCapabilities: sanitizeCapabilities(input.activeCapabilities)
});

// Store-write dedupe key. pendingWork is version-keyed (its payload churns
// with server timestamps); capabilities are reduced to identity-ish fields so
// stream commits don't churn the store.
export const paneRuntimeSignature = (runtime: PaneComposerRuntime): string =>
	JSON.stringify([
		runtime.isStreaming,
		runtime.selectedModelIds,
		runtime.pendingWork?.version ?? 0,
		runtime.pendingWork?.updated_at ?? '',
		runtime.title,
		runtime.reasoningEffortByModel,
		runtime.resolvedReasoningEffortByModel,
		runtime.reasoningEffortReady,
		runtime.fastModeEnabled,
		runtime.params,
		runtime.contextTokens,
		runtime.costMetrics,
		runtime.activeCapabilities.tools.length,
		runtime.activeCapabilities.tools.map((tool) => {
			const entry = (tool ?? {}) as Record<string, unknown>;
			return `${entry.server_id ?? ''}:${entry.id ?? entry.name ?? ''}`;
		}),
		runtime.activeCapabilities.skills.length,
		runtime.activeCapabilities.skills.map((skill) => {
			const entry = (skill ?? {}) as Record<string, unknown>;
			return `${entry.id ?? entry.name ?? ''}`;
		})
	]);

export type ComposerViewState = {
	selectedModels: string[];
	reasoningEffortByModel: Record<string, string>;
	reasoningEffortReady: boolean;
	fastModeEnabled: boolean;
	contextTokens: number;
	costMetrics: PaneCostMetrics;
	activeCapabilities: PaneCapabilities;
};

/**
 * The composer's widget props for the current focus. When a tile is focused
 * but its runtime hasn't been published yet (pane still hydrating), the
 * fallbacks are EMPTY — never the primary's values, which would misattribute
 * the orchestrator's settings to the tile for a paint or two.
 */
export const deriveComposerViewState = ({
	crossPaneActive,
	runtime,
	primary
}: {
	crossPaneActive: boolean;
	runtime: Partial<PaneComposerRuntime> | null | undefined;
	primary: ComposerViewState;
}): ComposerViewState => {
	if (!crossPaneActive) {
		return primary;
	}
	const modelIds = sanitizeModelIds(runtime?.selectedModelIds);
	return {
		selectedModels: modelIds.length > 0 ? modelIds : [''],
		reasoningEffortByModel: sanitizeStringMap(runtime?.reasoningEffortByModel),
		reasoningEffortReady: runtime?.reasoningEffortReady === true,
		fastModeEnabled: sanitizeFastModeEnabled(runtime?.fastModeEnabled),
		contextTokens: toFiniteNumber(runtime?.contextTokens),
		costMetrics: sanitizeCostMetrics(runtime?.costMetrics),
		activeCapabilities: sanitizeCapabilities(runtime?.activeCapabilities)
	};
};

/**
 * Request context for a message dispatched into a focused tile's chat: the
 * TARGET's models, params (incl. the fast-mode service tier when the target
 * runs a GPT model with the toggle on), and resolved reasoning effort —
 * mirroring what buildPendingWorkRequestContext captures for a local send.
 * tool_ids are deliberately omitted: the dispatch-time backfill replays the
 * target chat's own tools, exactly like send_message_to_chat. features are
 * likewise omitted (deferred — composer feature toggles stay primary-scoped).
 */
export const buildCrossPaneRequestContext = ({
	runtime,
	models
}: {
	runtime: Partial<PaneComposerRuntime> | null | undefined;
	models: ModelLike[] | null | undefined;
}) => {
	const modelIds = sanitizeModelIds(runtime?.selectedModelIds);
	const selectedModelItems = Object.fromEntries(
		modelIds.map((modelId) => {
			const model = (models ?? []).find((item) => item?.id === modelId);
			return [modelId, model ? JSON.parse(JSON.stringify(model)) : {}];
		})
	);
	return {
		selected_model_ids: modelIds,
		selected_model_items: selectedModelItems,
		reasoning_effort_by_model: sanitizeStringMap(runtime?.resolvedReasoningEffortByModel),
		params: {
			...sanitizeParams(runtime?.params),
			...(sanitizeFastModeEnabled(runtime?.fastModeEnabled) &&
			hasGptFastModeModel(modelIds, models as any)
				? { service_tier: FAST_MODE_SERVICE_TIER }
				: {})
		},
		background_tasks: {
			title_generation: true,
			tags_generation: true,
			follow_up_generation: true
		}
	};
};

// ── write-back command channel (primary composer → tile instance) ──────────
export type PaneCommand =
	| { seq: number; chatId: string; type: 'set-models'; payload: { modelIds: string[] } }
	| {
			seq: number;
			chatId: string;
			type: 'set-reasoning-effort';
			payload: { modelIndex: number | string; value: string };
	  }
	| { seq: number; chatId: string; type: 'set-fast-mode'; payload: { enabled: boolean } };

export const shouldApplyPaneCommand = (
	command: PaneCommand | null | undefined,
	{ chatId, lastAppliedSeq }: { chatId: string; lastAppliedSeq: number }
): boolean =>
	Boolean(
		command &&
			chatId &&
			command.chatId === chatId &&
			Number.isFinite(command.seq) &&
			command.seq > lastAppliedSeq
	);

/**
 * Draft-pollution guard: while a tile is focused the composer's onChange
 * payload carries the TARGET's muxed effort/fast-mode values — the primary's
 * sessionStorage draft must keep the primary's own.
 */
export const buildPrimaryDraftPayload = <T extends Record<string, unknown>>({
	data,
	crossPaneActive,
	primaryReasoningEffortByModel,
	primaryFastModeEnabled
}: {
	data: T;
	crossPaneActive: boolean;
	primaryReasoningEffortByModel: Record<string, string>;
	primaryFastModeEnabled: boolean;
}): T =>
	crossPaneActive
		? {
				...data,
				reasoningEffortByModel: primaryReasoningEffortByModel,
				fastModeEnabled: primaryFastModeEnabled
			}
		: data;

// ── model-bind mux sync guards ──────────────────────────────────────────────
export const modelIdsSignature = (ids: unknown): string => JSON.stringify(sanitizeModelIds(ids));

// ModelSelector transiently normalizes unknown/loading selections to [''] —
// never treat those as a user's model change.
export const isTransientModelSelection = (ids: unknown): boolean =>
	sanitizeModelIds(ids).length === 0;
