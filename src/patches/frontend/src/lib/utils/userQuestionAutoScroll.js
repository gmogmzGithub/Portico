// Auto-scroll decision for the inline ask-user-question card: an inline
// question blocks the agent run, so a card that renders below the fold makes
// the chat look stalled. The chat pane scrolls to the bottom exactly when
// this key CHANGES to a non-empty value — i.e. when a flow first appears on
// the active branch, when a follow-up appends new question pages to it, or
// when the wizard switches to a different question (Next/Back/step dots).
// Question switches re-scroll on purpose: the incoming question can be taller
// than the outgoing one, clipping its answers and Back/Next below the fold.
// Every switch is user-initiated, so the scroll lands exactly when the user
// expects the new question to be revealed — it never fights mid-answer input,
// which changes no part of the key. A dismissed/answered flow resets the key
// so a later re-ask scrolls again.
//
// Plain JS on purpose: Svelte only compiles inside the Docker image, so the
// testable logic lives here (see tests/user-question-auto-scroll.unit.test.js).
export function userQuestionAutoScrollKey(flow, currentIndex = 0) {
	if (!flow || typeof flow !== 'object') return '';
	const rawId = typeof flow.flowId === 'string' ? flow.flowId : flow.id;
	const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : '';
	const questionCount = Array.isArray(flow.questions) ? flow.questions.length : 0;
	if (!id || questionCount === 0) return '';
	// The card clamps its own stepper; this clamp only keeps a transiently
	// stale bound index (mid flow-swap) from minting phantom keys.
	const index = Number.isInteger(currentIndex)
		? Math.min(Math.max(currentIndex, 0), questionCount - 1)
		: 0;
	return `uq-scroll:${id}:${questionCount}:${index}`;
}
