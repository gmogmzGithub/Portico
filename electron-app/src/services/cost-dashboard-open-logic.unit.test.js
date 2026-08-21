"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveCostBarChatOpenPlan } = require("./cost-dashboard-open-logic");

test("focuses an existing window before anything else (no duplicate tab)", () => {
  // A subagent chat already open as a detached window: focus it, don't add a tab.
  assert.equal(
    resolveCostBarChatOpenPlan({ isWindowOpen: true, canOpenTab: true }),
    "focus-window",
  );
  assert.equal(
    resolveCostBarChatOpenPlan({ isWindowOpen: true, canOpenTab: false }),
    "focus-window",
  );
});

test("opens/switches a tab when not a window and a tab slot is available", () => {
  assert.equal(
    resolveCostBarChatOpenPlan({ isWindowOpen: false, canOpenTab: true }),
    "open-tab",
  );
});

test("opens a new window only when all tab slots are taken", () => {
  assert.equal(
    resolveCostBarChatOpenPlan({ isWindowOpen: false, canOpenTab: false }),
    "open-window",
  );
});

test("defaults are safe (open a window) when no state is provided", () => {
  assert.equal(resolveCostBarChatOpenPlan(), "open-window");
  assert.equal(resolveCostBarChatOpenPlan({}), "open-window");
});

test("window precedence holds regardless of tab availability (full truth table)", () => {
  const expected = {
    "true|true": "focus-window",
    "true|false": "focus-window",
    "false|true": "open-tab",
    "false|false": "open-window",
  };
  for (const isWindowOpen of [true, false]) {
    for (const canOpenTab of [true, false]) {
      assert.equal(
        resolveCostBarChatOpenPlan({ isWindowOpen, canOpenTab }),
        expected[`${isWindowOpen}|${canOpenTab}`],
      );
    }
  }
});
