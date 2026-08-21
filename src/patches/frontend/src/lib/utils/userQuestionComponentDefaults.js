// Ask User Question picker prefills: per-option component_defaults and
// per-component default_selected, ported from the retired Electron modal onto
// the inline card.
//
// The rules here MUST stay mirror-identical to the host's answer-side gating
// in electron-app/src/services/user-question-flows.js
// (optionHasComponentDefaults / areComponentsActiveForAnswer): the host drops
// component_selections for answers whose option does not reveal the pickers,
// so a drift between the two silently loses or leaks picker output.
//
// Selection state model (modal parity):
// - Each revealing option keeps its own selection bucket; UNGATED_BUCKET holds
//   the selections when reveal is not option-driven. Buckets are seeded once
//   and never reset, so flipping between options restores each option's edits.
// - Seeds resolve in two halves. Model/reasoning seeds resolve synchronously
//   from the models store when the bucket is created (buildBucketSlots).
//   Skill/MCP seeds need the capability catalog, which loads asynchronously —
//   they land via applyCatalogSeedsToSlots once the catalog settles, and
//   isSeedPending keeps the question unanswered (Send disabled) until then.
//   The slots are safe to overwrite when the seed lands: with no catalog
//   options loaded the pickers cannot take user input yet.
// - A failed catalog load seeds EMPTY rather than deferring forever — the
//   pickers are already in their degraded state and Send must not deadlock.
//
// Svelte only compiles inside the Docker frontend build, so this logic lives
// in a plain module where tests/user-question-component-defaults.unit.test.js
// can execute it.

export const UNGATED_BUCKET = '__ungated__';

const trimmedId = (value) => (typeof value === 'string' ? value.trim() : '');

// Dedupe and trim a raw seed list before resolution.
const requestedIds = (rawIds) => {
	const seen = new Set();
	const ids = [];
	for (const raw of Array.isArray(rawIds) ? rawIds : []) {
		const id = trimmedId(raw);
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
};

// Mirrors the host's optionHasComponentDefaults (user-question-flows.js).
export const optionHasComponentDefaults = (option) =>
	Boolean(
		option &&
			option.component_defaults &&
			typeof option.component_defaults === 'object' &&
			!Array.isArray(option.component_defaults) &&
			Object.keys(option.component_defaults).length > 0
	);

// With a gate or any defaults-bearing option, reveal (and bucket storage) is
// per-option; otherwise the components are always visible (legacy, incl.
// component-only questions) and live in the single ungated bucket.
export const isComponentRevealOptionDriven = (question) => {
	if (!question?.components?.length) return false;
	const options = Array.isArray(question?.options) ? question.options : [];
	if (!options.length) return false;
	const gate = question?.components_gated_by_option_id;
	if (typeof gate === 'string' && gate) return true;
	return options.some(optionHasComponentDefaults);
};

// Mirrors the host's areComponentsActiveForAnswer: the gate option or a
// defaults-bearing option reveals the pickers; when either exists, every other
// option keeps them hidden; with neither, they are always active.
export const areComponentsActive = (question, selectedOptionId) => {
	if (!question?.components?.length) return false;
	if (!isComponentRevealOptionDriven(question)) return true;
	if (!selectedOptionId) return false;
	const gate = question?.components_gated_by_option_id;
	if (typeof gate === 'string' && gate && selectedOptionId === gate) return true;
	const options = Array.isArray(question?.options) ? question.options : [];
	return optionHasComponentDefaults(options.find((option) => option?.id === selectedOptionId));
};

export const bucketKeyFor = (question, selectedOptionId) =>
	isComponentRevealOptionDriven(question) ? selectedOptionId || null : UNGATED_BUCKET;

export const seededKeyFor = (questionId, bucketKey) => `${questionId}|${bucketKey}`;

// The raw (unresolved) seed for each component in a bucket. Per component:
// the revealing option's component_defaults entry wins (an explicit [] means
// "reveal this picker empty"), then the component's own default_selected, then
// null — null means "no seed", which keeps the card's stock behavior (chat
// defaults for model/reasoning, empty pickers otherwise).
export const seedDefaultsFor = (question, bucketKey) => {
	const options = Array.isArray(question?.options) ? question.options : [];
	const revealingOption =
		bucketKey && bucketKey !== UNGATED_BUCKET
			? options.find((option) => option?.id === bucketKey) || null
			: null;
	const defaults = {};
	for (const component of question?.components ?? []) {
		const perOption = revealingOption?.component_defaults?.[component.id];
		const raw = perOption !== undefined && perOption !== null ? perOption : component.default_selected;
		defaults[component.id] = Array.isArray(raw) ? raw : null;
	}
	return defaults;
};

// Skill ids resolve against the capability catalog: exact id first, then the
// legacy two-segment marketplace form (marketplace/skill) healed to its unique
// three-segment id (marketplace/plugin/skill). Unresolvable ids are dropped so
// no phantom selections round-trip into the answer.
export const resolveSkillIds = (rawIds, skillOptions) => {
	const known = new Set((skillOptions ?? []).map((option) => trimmedId(option?.id)).filter(Boolean));
	const resolved = [];
	for (const id of requestedIds(rawIds)) {
		if (known.has(id)) {
			resolved.push(id);
			continue;
		}
		const segments = id.split('/');
		if (segments.length === 2) {
			const healed = [...known].filter((candidate) => {
				const parts = candidate.split('/');
				return parts.length === 3 && parts[0] === segments[0] && parts[2] === segments[1];
			});
			if (healed.length === 1) resolved.push(healed[0]);
		}
	}
	return resolved;
};

// Server picker ids always carry the server: prefix (McpServerPicker
// normalizes its option ids the same way).
const normalizeToolServerId = (value) => {
	const normalized = trimmedId(value);
	return normalized && !normalized.startsWith('server:') ? `server:${normalized}` : normalized;
};

export const resolveServerIds = (rawIds, serverOptions) => {
	const known = new Set(
		(serverOptions ?? []).map((option) => normalizeToolServerId(option?.id)).filter(Boolean)
	);
	return requestedIds(rawIds)
		.map((id) => normalizeToolServerId(id))
		.filter((id) => known.has(id));
};

// A model seed resolves by id, then by display name; single-select.
export const resolveModelId = (rawIds, models) => {
	const wanted = requestedIds(rawIds)[0] ?? '';
	if (!wanted) return '';
	const match =
		(models ?? []).find((model) => model?.id === wanted) ??
		(models ?? []).find((model) => (model?.name ?? '') === wanted);
	return match?.id ?? '';
};

// A reasoning-effort seed must be supported by the model it will apply to.
export const resolveEffort = (rawIds, allowedOptions) => {
	const wanted = requestedIds(rawIds)[0] ?? '';
	return wanted && (allowedOptions ?? []).includes(wanted) ? wanted : '';
};

// Synchronous half of bucket creation: every component gets its slot (the
// pickers two-way bind, so every path must exist), model/reasoning seeds
// resolve immediately from the models store, and skill/MCP slots start empty
// until the catalog half lands. Models seed before reasoning so the effort
// validates against the seeded model. Returns the seeded model id so callers
// can thread it across the flow.
//
// context: { models, capabilityFor(modelId) -> capability|null,
//            chatDefaultModelId, chatDefaultEffort, effortFallbackModelId }
export const buildBucketSlots = (question, bucketKey, context = {}) => {
	const defaults = bucketKey ? seedDefaultsFor(question, bucketKey) : {};
	const models = context.models ?? [];
	const capabilityFor = typeof context.capabilityFor === 'function' ? context.capabilityFor : () => null;
	const chatDefaultModelId = trimmedId(context.chatDefaultModelId);
	const chatDefaultEffort = trimmedId(context.chatDefaultEffort);

	const slots = {};
	let seededModelId = '';

	const components = [...(question?.components ?? [])].sort(
		(a, b) =>
			(a.type === 'reasoning_effort_picker' ? 1 : 0) - (b.type === 'reasoning_effort_picker' ? 1 : 0)
	);
	for (const component of components) {
		const seed = defaults[component.id];
		if (component.type === 'model_picker') {
			// Seeded: resolve or fall empty (an unresolvable model deliberately
			// leaves the mandate unmet). Unseeded: the chat's model, like the
			// stock card. Either way the slot keeps ModelSelector's [''] shape.
			const resolved = seed !== null && seed !== undefined ? resolveModelId(seed, models) : chatDefaultModelId;
			if (resolved) seededModelId = seededModelId || resolved;
			slots[component.id] = [resolved || ''];
		} else if (component.type === 'reasoning_effort_picker') {
			const effortModelId = seededModelId || trimmedId(context.effortFallbackModelId) || chatDefaultModelId;
			const allowed = capabilityFor(effortModelId)?.reasoningEffortOptions ?? [];
			const resolved =
				seed !== null && seed !== undefined
					? resolveEffort(seed, allowed)
					: resolveEffort([chatDefaultEffort], allowed);
			slots[component.id] = resolved ? [resolved] : [];
		} else {
			slots[component.id] = [];
		}
	}
	return { slots, seededModelId };
};

// Asynchronous half: fill the skill/MCP slots from their resolved seeds once
// the catalog settles. catalog = { skills, toolServers } or null (load failed
// -> seed empty). Only seed-bearing slots are written; a null seed keeps the
// slot untouched. Returns a new slots map.
export const applyCatalogSeedsToSlots = (question, bucketKey, slots, catalog) => {
	const defaults = bucketKey ? seedDefaultsFor(question, bucketKey) : {};
	const next = { ...(slots ?? {}) };
	for (const component of question?.components ?? []) {
		if (component.type !== 'skill_picker' && component.type !== 'mcp_server_picker') continue;
		const seed = defaults[component.id];
		if (seed === null || seed === undefined) continue;
		let resolved = [];
		if (catalog) {
			resolved =
				component.type === 'skill_picker'
					? resolveSkillIds(seed, catalog.skills)
					: resolveServerIds(seed, catalog.toolServers);
		}
		next[component.id] = component.multiple === false ? resolved.slice(0, 1) : resolved;
	}
	return next;
};

// Does this bucket carry catalog-dependent seeds that still have to land?
// An explicit [] entry has nothing to fetch, so it is never pending.
export const bucketHasCatalogSeeds = (question, bucketKey) => {
	if (!bucketKey) return false;
	const defaults = seedDefaultsFor(question, bucketKey);
	return (question?.components ?? []).some(
		(component) =>
			(component.type === 'skill_picker' || component.type === 'mcp_server_picker') &&
			Array.isArray(defaults[component.id]) &&
			defaults[component.id].length > 0
	);
};

// True while the active bucket WOULD seed non-empty picker defaults but the
// catalog half has not landed. The question must not count as answered, or a
// fast Send could ship empty selections for an option whose meaning is "start
// from the recommended set".
export const isSeedPending = (question, selectedOptionId, seededBucketKeys) => {
	if (!areComponentsActive(question, selectedOptionId)) return false;
	const key = bucketKeyFor(question, selectedOptionId);
	if (!key) return false;
	if (seededBucketKeys?.has?.(seededKeyFor(question.id, key))) return false;
	return bucketHasCatalogSeeds(question, key);
};
