// Landing-hero model resolution (Chat UI layer).
//
// When an agent (custom model with a base_model_id) is selected, the landing
// hero shows the BASE model's animated logo/branding while keeping the agent's
// name and description. Extracted from Placeholder.svelte so the routing rule
// is unit testable in plain Node (tests/test_frontend_model_selection.cjs).

export const resolveLandingHeroModel = <ModelLike>(
	agentBaseModel: ModelLike | null | undefined,
	primaryModel: ModelLike | null | undefined
): ModelLike | null | undefined => agentBaseModel ?? primaryModel;
