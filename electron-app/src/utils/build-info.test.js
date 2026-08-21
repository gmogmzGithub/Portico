const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  getResolvedBuildChannelInfo,
  getBuildChannelLabel,
  releaseChannelToPackageName,
  releasePackageNameToChannel,
  resolveBuildChannel,
  resolveBuildDisplayChannel,
} = require("./build-info");

test("packaged build channel wins over release track fallback", () => {
  const buildInfo = {
    buildNumber: "03112026-aaf3a307",
    channel: "portico_dev",
    releaseChannelKeyword: "portico",
  };

  assert.equal(resolveBuildChannel(buildInfo), "portico_dev");
  assert.equal(resolveBuildDisplayChannel(buildInfo), "dev");
  assert.equal(getBuildChannelLabel(buildInfo), "Dev");
});

test("releaseChannelKeyword is only used when packaged channel is missing", () => {
  const buildInfo = {
    buildNumber: "03112026-aaf3a307",
    releaseChannelKeyword: "portico_beta",
  };

  assert.equal(resolveBuildChannel(buildInfo), "portico_beta");
  assert.equal(resolveBuildDisplayChannel(buildInfo), "beta");
  assert.equal(getBuildChannelLabel(buildInfo), "Beta");
});

test("dev-build always resolves to dev even when other channel data says stable", () => {
  const buildInfo = {
    buildNumber: "dev-build",
    channel: "portico",
    releaseChannelKeyword: "portico",
  };

  assert.equal(resolveBuildChannel(buildInfo), "portico_dev");
  assert.equal(resolveBuildDisplayChannel(buildInfo), "dev");
  assert.equal(getBuildChannelLabel(buildInfo), "Dev");
});

test("packaged stable, beta, and dev channels resolve correctly", () => {
  assert.equal(
    resolveBuildDisplayChannel({ buildNumber: "1", channel: "portico" }),
    "stable",
  );
  assert.equal(
    resolveBuildDisplayChannel({ buildNumber: "1", channel: "portico_beta" }),
    "beta",
  );
  assert.equal(
    resolveBuildDisplayChannel({ buildNumber: "1", channel: "portico_dev" }),
    "dev",
  );
});

test("packaged custom channels retain their package identity and label", () => {
  const buildInfo = {
    buildNumber: "03112026-aaf3a307",
    channel: "portico_team-alpha",
  };

  assert.equal(resolveBuildChannel(buildInfo), "portico_team-alpha");
  assert.equal(resolveBuildDisplayChannel(buildInfo), "custom");
  assert.equal(getBuildChannelLabel(buildInfo), "team-alpha");
  assert.deepEqual(getResolvedBuildChannelInfo(buildInfo), {
    channelKeyword: "portico_team-alpha",
    displayChannel: "custom",
    label: "team-alpha",
  });
});

test("safe legacy custom package metadata remains distinguishable from stable", () => {
  const buildInfo = {
    buildNumber: "03112026-aaf3a307",
    channel: "historic-canary",
  };

  assert.equal(resolveBuildChannel(buildInfo), "historic-canary");
  assert.equal(resolveBuildDisplayChannel(buildInfo), "custom");
  assert.equal(getBuildChannelLabel(buildInfo), "historic-canary");
});

test("resolved build channel info exposes keyword, display channel, and label", () => {
  assert.deepEqual(
    getResolvedBuildChannelInfo({
      buildNumber: "03112026-aaf3a307",
      channel: "portico_dev",
      releaseChannelKeyword: "portico",
    }),
    {
      channelKeyword: "portico_dev",
      displayChannel: "dev",
      label: "Dev",
    },
  );
});
test("browser scripts can load release-channel before build-info", () => {
  const context = {
    window: {},
  };
  context.window = context;

  for (const scriptName of ["release-channel.js", "build-info.js"]) {
    const source = fs.readFileSync(path.join(__dirname, scriptName), "utf8");
    vm.runInNewContext(source, context, { filename: scriptName });
  }

  assert.equal(
    context.window.buildInfoHelpers.resolveBuildDisplayChannel({
      buildNumber: "dev-build",
    }),
    "dev",
  );
});

test("custom release channels resolve without falling back to stable", () => {
  assert.equal(releaseChannelToPackageName("sunset"), "portico_sunset");
  assert.equal(releasePackageNameToChannel("portico_sunset"), "sunset");
  assert.equal(
    resolveBuildDisplayChannel({ buildNumber: "1", channel: "portico_sunset" }),
    "custom",
  );
  assert.equal(
    getBuildChannelLabel({ buildNumber: "1", channel: "portico_sunset" }),
    "sunset",
  );
});

test("browser build-info resolves canonical custom packages without release-channel helper", () => {
  const context = {
    window: {},
  };
  context.window = context;

  const source = fs.readFileSync(path.join(__dirname, "build-info.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "build-info.js" });

  const buildInfo = {
    buildNumber: "07012026-9b3934b0",
    channel: "portico_jupiter",
  };

  assert.equal(
    context.window.buildInfoHelpers.resolveBuildChannel(buildInfo),
    "portico_jupiter",
  );
  assert.equal(
    context.window.buildInfoHelpers.resolveBuildDisplayChannel(buildInfo),
    "custom",
  );
  assert.equal(
    context.window.buildInfoHelpers.getBuildChannelLabel(buildInfo),
    "jupiter",
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        context.window.buildInfoHelpers.getResolvedBuildChannelInfo(buildInfo),
      ),
    ),
    {
      channelKeyword: "portico_jupiter",
      displayChannel: "custom",
      label: "jupiter",
    },
  );
  assert.equal(
    context.window.buildInfoHelpers.releaseChannelToPackageName("jupiter"),
    "portico_jupiter",
  );
  assert.equal(
    context.window.buildInfoHelpers.releasePackageNameToChannel(
      "portico_jupiter",
    ),
    "jupiter",
  );
});
