const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createReleaseChannelMenuItems,
  getDefaultReleaseChannel,
  resolveReleaseChannelName,
  resolveReleaseChannelPackage,
  validateCustomReleaseChannelName,
} = require("./release-channel");

test("built-in release channels retain their package and display contracts", () => {
  assert.deepEqual(resolveReleaseChannelName("stable"), {
    name: "stable",
    packageName: "portico",
    kind: "stable",
    label: "Stable",
    custom: false,
    legacy: false,
  });
  assert.equal(resolveReleaseChannelName("beta").packageName, "portico_beta");
  assert.equal(resolveReleaseChannelName("dev").label, "Development");
  assert.deepEqual(getDefaultReleaseChannel(), resolveReleaseChannelName("stable"));
});

test("custom release channel names normalize and derive package names", () => {
  assert.deepEqual(resolveReleaseChannelName("  Team-Alpha  "), {
    name: "team-alpha",
    packageName: "portico_team-alpha",
    kind: "custom",
    label: "team-alpha",
    custom: true,
    legacy: false,
  });
  assert.deepEqual(
    resolveReleaseChannelPackage("portico_team-alpha"),
    resolveReleaseChannelName("team-alpha"),
  );
});

test("custom release channel validation rejects reserved and unsafe names", () => {
  assert.match(validateCustomReleaseChannelName("").error, /Enter/);
  assert.match(validateCustomReleaseChannelName("dev").error, /menu item/);
  assert.match(validateCustomReleaseChannelName("team.alpha").error, /lowercase letters/);
  assert.match(validateCustomReleaseChannelName("-team").error, /start and end/);
  assert.match(validateCustomReleaseChannelName("team-").error, /start and end/);
  assert.match(validateCustomReleaseChannelName("a".repeat(65)).error, /64 characters/);
  assert.equal(resolveReleaseChannelName("team.alpha"), null);
  assert.equal(resolveReleaseChannelPackage("portico_team.alpha"), null);
});

test("safe historical raw package values remain readable only in legacy mode", () => {
  assert.equal(resolveReleaseChannelPackage("historic-canary"), null);
  assert.deepEqual(
    resolveReleaseChannelPackage("historic-canary", { allowLegacy: true }),
    {
      name: "historic-canary",
      packageName: "historic-canary",
      kind: "custom",
      label: "historic-canary",
      custom: true,
      legacy: true,
    },
  );
  assert.equal(
    resolveReleaseChannelPackage("../../unsafe", { allowLegacy: true }),
    null,
  );
});

test("release channel menu keeps built-ins ordered before Custom and checks Custom", () => {
  const custom = resolveReleaseChannelName("team-alpha");
  const items = createReleaseChannelMenuItems(custom);

  assert.deepEqual(items.map((item) => item.label), [
    "Stable",
    "Beta",
    "Development",
    "Custom...",
  ]);
  assert.deepEqual(items.map((item) => item.checked), [false, false, false, true]);
});
