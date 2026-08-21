// PORTICO-348: which pending native-input flow (if any) should inert a chat's
// composer.
//
// Extracted from MessageInput.svelte so the rule is executable in tests. It
// previously lived inline and was pinned by a source-text regex, which broke
// the moment the expression changed and never actually exercised the logic.
//
// Rules:
//  - user_question renders INLINE in its chat's transcript, so it locks that
//    chat's composer whenever it is pending, regardless of presentation.
//  - sensitive_info and chat_workspace_consent still use the shared modal, so
//    they only lock while minimized ("hidden") and waiting to be reopened.
//  - marketplace_publish is not chat-scoped; its pill is informational and must
//    never inert a composer.

export const INLINE_NATIVE_INPUT_KINDS = new Set(['user_question']);
export const NON_BLOCKING_NATIVE_INPUT_KINDS = new Set(['marketplace_publish']);

export const findPendingInlineFlowForChat = (flows, chatId) => {
  if (!Array.isArray(flows) || !chatId) {
    return null;
  }
  return (
    flows.find(
      (flow) => INLINE_NATIVE_INPUT_KINDS.has(flow?.kind) && flow?.chat_id === chatId,
    ) ?? null
  );
};

export const findHiddenModalFlowForChat = (flows, chatId) => {
  if (!Array.isArray(flows)) {
    return null;
  }
  return (
    flows.find(
      (flow) =>
        flow?.presentation === 'hidden' &&
        !INLINE_NATIVE_INPUT_KINDS.has(flow?.kind) &&
        (flow?.chat_id === chatId || NON_BLOCKING_NATIVE_INPUT_KINDS.has(flow?.kind)),
    ) ?? null
  );
};

export const isNativeInputInteractionLocked = (flows, chatId) => {
  if (findPendingInlineFlowForChat(flows, chatId)) {
    return true;
  }
  const hidden = findHiddenModalFlowForChat(flows, chatId);
  return hidden !== null && !NON_BLOCKING_NATIVE_INPUT_KINDS.has(hidden.kind);
};
