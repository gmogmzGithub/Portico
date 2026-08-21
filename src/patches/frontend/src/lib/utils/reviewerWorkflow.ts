// PORTICO_PATCH (reviewer workflow): pure prompt-augmentation helper for the
// composer's polymodel review & critique toggle. Kept svelte-free so the
// esbuild node test harness can bundle it directly.

// Deliberately minimal: the phrase triggers the workflows skill, whose
// "Reviewer workflows" section carries the full protocol (peer chat via
// start_chat — never run_subagent — exact default reviewer models at xhigh,
// full-context rule, approval gate ≤3 cycles). Keeping the visible
// augmentation to one line keeps the user's message readable.
export const REVIEWER_WORKFLOW_PROMPT_INSTRUCTIONS = 'Use a basic reviewer workflow.';

/**
 * Appends the reviewer-workflow directive to the user's prompt right before
 * submission. Empty / files-only prompts are left untouched — an
 * instructions-only message would start a workflow with nothing to review.
 */
export const augmentPromptWithReviewerWorkflow = (prompt: unknown): string => {
	const normalized = typeof prompt === 'string' ? prompt : '';
	if (!normalized.trim()) {
		return normalized;
	}
	return `${normalized}\n\n${REVIEWER_WORKFLOW_PROMPT_INSTRUCTIONS}`;
};

/**
 * Per-chat toggle state. The workflow is decided by the FIRST prompt of a
 * chat: before it, the toggle is armed and always starts OFF (opting into an
 * augmented prompt is an explicit per-chat choice, never a remembered
 * default); once the chat has any messages the toggle is locked read-only,
 * showing whatever was decided — from the persisted `reviewer_workflow` flag
 * on the chat record, or OFF for chats that predate the feature.
 */
// ── CTA impression budget (host-persisted in Application Support) ──────────
export const REVIEWER_WORKFLOW_CTA_KEY = 'reviewerWorkflowCta';
export const REVIEWER_WORKFLOW_CTA_MAX_IMPRESSIONS = 3;

type CalloutHostApi = {
	getUiCalloutState?: (key: string) => Promise<{ success?: boolean; data?: { impressions?: unknown } }>;
	incrementUiCalloutImpressions?: (key: string) => Promise<unknown>;
} | null | undefined;

/**
 * Reads the CTA's shown-count from the host. Deliberately graceful: no host
 * bridge (browser dev), a missing state file, or any error all report 0 —
 * "assume the tooltip needs to be shown".
 */
export const readReviewerCtaImpressions = async (hostApi: CalloutHostApi): Promise<number> => {
	try {
		const result = await hostApi?.getUiCalloutState?.(REVIEWER_WORKFLOW_CTA_KEY);
		const impressions = result?.success ? Number(result?.data?.impressions) : NaN;
		return Number.isFinite(impressions) && impressions >= 0 ? impressions : 0;
	} catch {
		return 0;
	}
};

/**
 * Best-effort impression bump. Resolves with the NEW total when the host
 * bridge is available (so callers can show an accurate "displays N more
 * times" line), or null when it isn't — the CTA budget just doesn't
 * decrement in that degraded mode.
 */
export const bumpReviewerCtaImpressions = async (
	hostApi: CalloutHostApi
): Promise<number | null> => {
	try {
		const result = (await hostApi?.incrementUiCalloutImpressions?.(
			REVIEWER_WORKFLOW_CTA_KEY
		)) as { success?: boolean; data?: { impressions?: unknown } } | undefined;
		const impressions = result?.success ? Number(result?.data?.impressions) : NaN;
		return Number.isFinite(impressions) && impressions > 0 ? impressions : null;
	} catch {
		return null;
	}
};

export const resolveReviewerWorkflowChatState = ({
	chatFlag,
	hasMessages
}: {
	chatFlag: unknown;
	hasMessages: boolean;
}): { enabled: boolean; locked: boolean } => ({
	locked: hasMessages === true,
	enabled: typeof chatFlag === 'boolean' ? chatFlag : false
});
