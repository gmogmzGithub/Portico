// PORTICO-348: when does an Ask User Question item count as answered?
//
// Mirrors doesUserQuestionAnswerCount in the Electron modal. Extracted so it is
// executable in tests: the first inline implementation only understood options
// and freeform, which left Send permanently disabled for questions answered
// purely through capability pickers.

import { areComponentsActive } from './userQuestionComponentDefaults.js';

export const NONE_OF_THE_ABOVE_OPTION_ID = 'none_of_the_above';

// Pickers can be gated behind selecting a specific option, and an option
// carrying component_defaults also reveals them (prefilled). The rule lives in
// userQuestionComponentDefaults so it stays mirror-identical to the host's
// answer-side gating; re-exported here for the card and existing tests.
export { areComponentsActive };

export const isQuestionAnswered = (question, answer = {}) => {
  if (!question) return false;
  const optionId = answer.selectedOptionId || '';
  const text = (answer.freeformText ?? '').trim();
  const picks = answer.componentSelections ?? {};

  if (areComponentsActive(question, optionId)) {
    // Picker defaults still resolving (the capability catalog has not landed):
    // not answered yet, so a fast Send cannot ship empty selections for an
    // option whose meaning is "start from the recommended set".
    if (answer.seedPending === true) return false;
    // A model_picker must carry a pick: nothing else substitutes for the base
    // model. Other picker types may stay empty -- a multi-select can mean
    // "none", and requiring a pick from a possibly-empty catalog would deadlock.
    const missingModelPick = question.components.some(
      (component) =>
        component.type === 'model_picker' &&
        !(picks[component.id] ?? []).some((id) => typeof id === 'string' && id.trim()),
    );
    if (missingModelPick) return false;
    if (optionId === NONE_OF_THE_ABOVE_OPTION_ID) return Boolean(text);
    const anySelected = Object.values(picks).some((ids) => (ids?.length ?? 0) > 0);
    if (anySelected || optionId) return true;
    return Boolean(text);
  }

  if (optionId) {
    return optionId !== NONE_OF_THE_ABOVE_OPTION_ID || Boolean(text);
  }
  const hasFallback = (question.options ?? []).some(
    (option) => option?.id === NONE_OF_THE_ABOVE_OPTION_ID,
  );
  return Boolean(text) && (hasFallback || (question.options ?? []).length === 0);
};

export const areAllQuestionsAnswered = (questions, answerFor) =>
  (questions ?? []).every((question) => isQuestionAnswered(question, answerFor(question)));

// A pending question belongs to the response branch that was active when the
// flow appeared. Editing and resending an earlier user message creates a new
// sibling branch, so the old branch's form must disappear until that branch is
// selected again.
export const isUserQuestionAnchorOnActiveBranch = (history, anchorMessageId) => {
  const anchor = typeof anchorMessageId === 'string' ? anchorMessageId.trim() : '';
  const messages = history?.messages;
  let messageId = typeof history?.currentId === 'string' ? history.currentId : '';
  if (!anchor || !messageId || !messages) return false;

  const seen = new Set();
  while (messageId && !seen.has(messageId)) {
    if (messageId === anchor) return true;
    seen.add(messageId);
    const parentId = messages[messageId]?.parentId;
    messageId = typeof parentId === 'string' ? parentId : '';
  }
  return false;
};
