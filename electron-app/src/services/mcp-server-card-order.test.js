const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ENABLED_STATUS_PRIORITY,
  partitionMcpServerGridEntries,
} = require("./mcp-server-card-order");

function entry(name, overrides = {}) {
  return {
    server: {
      id: overrides.id || name.toLowerCase().replace(/\s+/g, "-"),
      name,
      display_name: overrides.displayName || name,
      isCore: overrides.isCore === true,
    },
    configured: overrides.configured ?? true,
    enabled: overrides.enabled ?? true,
    missingSetup: overrides.missingSetup === true,
    healthStatus: overrides.healthStatus || "healthy",
    setupAction: overrides.setupAction || null,
    isCore: overrides.isCore === true,
  };
}

function orderedNames(result) {
  return result.ordered.map((item) => item.server.display_name);
}

test("enabled status priority mapping keeps attention states ahead of healthy", () => {
  assert.equal(ENABLED_STATUS_PRIORITY.starting, 0);
  assert.equal(ENABLED_STATUS_PRIORITY.checking, 1);
  assert.equal(ENABLED_STATUS_PRIORITY.failed, 2);
  assert.equal(ENABLED_STATUS_PRIORITY.timeout, 3);
  assert.equal(ENABLED_STATUS_PRIORITY.not_running, 4);
  assert.equal(ENABLED_STATUS_PRIORITY.needs_oauth, 5);
  assert.equal(ENABLED_STATUS_PRIORITY.healthy, 6);
  assert.equal(ENABLED_STATUS_PRIORITY.unknown, 8);
});

test("partitionMcpServerGridEntries sorts other enabled cards by status priority then core then name", () => {
  const result = partitionMcpServerGridEntries([
    entry("Zulu Healthy", { healthStatus: "healthy" }),
    entry("Alpha Healthy Core", { healthStatus: "healthy", isCore: true }),
    entry("Delta Backend OAuth", { healthStatus: "needs_oauth" }),
    entry("Beta Failed", { healthStatus: "failed" }),
    entry("Gamma Checking", { healthStatus: "checking" }),
    entry("Omega Starting", { healthStatus: "starting" }),
    entry("Eta Timed Out", { healthStatus: "timeout" }),
    entry("Theta Not Running", { healthStatus: "not_running" }),
    entry("Lambda Unknown", { healthStatus: "unknown" }),
  ]);

  assert.deepEqual(orderedNames(result), [
    "Omega Starting",
    "Gamma Checking",
    "Beta Failed",
    "Eta Timed Out",
    "Theta Not Running",
    "Delta Backend OAuth",
    "Alpha Healthy Core",
    "Zulu Healthy",
    "Lambda Unknown",
  ]);
});

test("partitionMcpServerGridEntries applies setup, enabled, disabled, and missing-setup priority", () => {
  const result = partitionMcpServerGridEntries([
    entry("Zulu Disabled", { enabled: false }),
    entry("Zulu Config", { setupAction: "configure" }),
    entry("Zulu Auth", { setupAction: "authenticate" }),
    entry("Healthy User", { healthStatus: "healthy" }),
    entry("Alpha Missing Setup", {
      enabled: false,
      missingSetup: true,
      setupAction: "authenticate",
    }),
    entry("Alpha Auth", {
      configured: false,
      enabled: false,
      setupAction: "authenticate",
    }),
    entry("Alpha Config", {
      configured: false,
      enabled: false,
      setupAction: "configure",
    }),
    entry("Healthy Core", { healthStatus: "healthy", isCore: true }),
    entry("Starting User", { healthStatus: "starting" }),
    entry("Alpha Disabled", { enabled: false }),
  ]);

  assert.deepEqual(orderedNames(result), [
    "Alpha Auth",
    "Zulu Auth",
    "Alpha Config",
    "Zulu Config",
    "Starting User",
    "Healthy Core",
    "Healthy User",
    "Alpha Disabled",
    "Zulu Disabled",
    "Alpha Missing Setup",
  ]);
});

test("configured and unconfigured auth cards remain contiguous ahead of config cards", () => {
  const result = partitionMcpServerGridEntries([
    entry("Running", { healthStatus: "healthy" }),
    entry("Configured Auth", {
      configured: true,
      setupAction: "authenticate",
    }),
    entry("Needs Config", {
      configured: false,
      enabled: false,
      setupAction: "configure",
    }),
    entry("Unconfigured Auth", {
      configured: false,
      enabled: false,
      setupAction: "authenticate",
    }),
  ]);

  assert.deepEqual(orderedNames(result), [
    "Configured Auth",
    "Unconfigured Auth",
    "Needs Config",
    "Running",
  ]);
});

test("latent requirements do not outrank enabled cards without a visible setup action", () => {
  const result = partitionMcpServerGridEntries([
    entry("Latent OAuth", {
      enabled: false,
      healthStatus: "needs_oauth",
    }),
    entry("Running", { healthStatus: "healthy" }),
    entry("Visible OAuth", {
      enabled: false,
      setupAction: "authenticate",
    }),
  ]);

  assert.deepEqual(orderedNames(result), [
    "Visible OAuth",
    "Running",
    "Latent OAuth",
  ]);
});

test("partitionMcpServerGridEntries places missing setup cards after regular disabled cards", () => {
  const result = partitionMcpServerGridEntries([
    entry("Teamworks", { enabled: false }),
    entry("Chrome DevTools", {
      enabled: false,
      missingSetup: true,
      healthStatus: "disabled",
      setupAction: "authenticate",
    }),
    entry("Atlassian", { enabled: false }),
    entry("Browser Automation", {
      enabled: false,
      missingSetup: true,
      healthStatus: "disabled",
    }),
  ]);

  assert.deepEqual(result.configuredDisabled.map((item) => item.server.display_name), [
    "Atlassian",
    "Teamworks",
  ]);
  assert.deepEqual(
    result.configuredMissingSetup.map((item) => item.server.display_name),
    ["Browser Automation", "Chrome DevTools"],
  );
  assert.deepEqual(orderedNames(result), [
    "Atlassian",
    "Teamworks",
    "Browser Automation",
    "Chrome DevTools",
  ]);
});

test("disabled unconfigured entries sort with the regular disabled group", () => {
  const result = partitionMcpServerGridEntries([
    entry("Zulu Disabled", { enabled: false }),
    entry("Mike Disabled Unconfigured", {
      configured: false,
      enabled: false,
      setupAction: null,
    }),
    entry("Running", { healthStatus: "healthy" }),
    entry("Alpha Needs Config", {
      configured: false,
      enabled: false,
      setupAction: "configure",
    }),
  ]);

  assert.deepEqual(orderedNames(result), [
    "Alpha Needs Config",
    "Running",
    "Mike Disabled Unconfigured",
    "Zulu Disabled",
  ]);
});

test("host-supported entries stay in the regular disabled subgroup", () => {
  const result = partitionMcpServerGridEntries([
    entry("Chrome DevTools", {
      enabled: false,
      missingSetup: false,
      healthStatus: "disabled",
    }),
    entry("Datadog", {
      enabled: false,
      healthStatus: "disabled",
    }),
  ]);

  assert.deepEqual(
    result.configuredDisabled.map((item) => item.server.display_name),
    ["Chrome DevTools", "Datadog"],
  );
  assert.equal(result.configuredMissingSetup.length, 0);
});
