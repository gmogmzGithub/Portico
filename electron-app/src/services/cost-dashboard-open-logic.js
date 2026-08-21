"use strict";

// Decides how a Cost Dashboard bar click should open its chat, so the same chat
// never ends up in both a tab and a window (the old handler always opened a new
// window). Pure + require-testable; the renderer (cost-dashboard.js) inlines the
// same three-way decision.
//
//   isWindowOpen -> the chat is already a detached window: focus it.
//   canOpenTab   -> a tab slot is free OR the chat is already a tab: open/switch tab.
//   otherwise    -> all tab slots are taken: open a new window.
function resolveCostBarChatOpenPlan({ isWindowOpen = false, canOpenTab = false } = {}) {
  if (isWindowOpen) {
    return "focus-window";
  }
  if (canOpenTab) {
    return "open-tab";
  }
  return "open-window";
}

module.exports = { resolveCostBarChatOpenPlan };
