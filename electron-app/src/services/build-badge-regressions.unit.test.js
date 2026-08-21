const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function createBadgeContext(buildInfo) {
  const elements = {
    "build-text": {
      innerHTML: "",
    },
    "copy-build": {
      innerHTML: "Copy",
      style: {},
      classList: {
        add() {},
        remove() {},
      },
    },
  };
  const context = {
    console,
    setTimeout(callback) {
      callback();
    },
    window: {},
    document: {
      getElementById(id) {
        return elements[id] || null;
      },
    },
  };
  context.window = context;
  context.window.electronAPI = {
    async getBuildInfo() {
      return buildInfo;
    },
    async copyToClipboard(value) {
      context.copiedBuildString = value;
    },
  };
  context.elements = elements;
  return context;
}

function loadRendererScripts(context, scripts) {
  for (const script of scripts) {
    vm.runInNewContext(readRepoFile(script), context, { filename: script });
  }
}

test("build badge renders custom channel from canonical package metadata", async () => {
  const context = createBadgeContext({
    buildNumber: "07012026-9b3934b0",
    channel: "portico_jupiter",
  });

  loadRendererScripts(context, [
    "electron-app/src/utils/release-channel.js",
    "electron-app/src/utils/build-info.js",
    "electron-app/src/renderer/components/build-badge.js",
  ]);

  await context.window.renderBuildBadge();

  const html = context.elements["build-text"].innerHTML;
  assert.match(html, /channel-badge custom/);
  assert.match(html, />jupiter</);
  assert.match(html, /Build: 07012026-9b3934b0/);
  assert.doesNotMatch(html, /channel-badge stable/);
});

test("build badge does not call custom packages stable when release-channel helper is absent", async () => {
  const context = createBadgeContext({
    buildNumber: "07012026-9b3934b0",
    channel: "portico_jupiter",
  });

  loadRendererScripts(context, [
    "electron-app/src/utils/build-info.js",
    "electron-app/src/renderer/components/build-badge.js",
  ]);

  await context.window.renderBuildBadge();

  const html = context.elements["build-text"].innerHTML;
  assert.match(html, /channel-badge custom/);
  assert.match(html, />jupiter</);
  assert.doesNotMatch(html, /channel-badge stable/);
});

test("build badge fails visibly instead of labeling custom builds stable when build-info helper is absent", async () => {
  const context = createBadgeContext({
    buildNumber: "07012026-9b3934b0",
    channel: "portico_jupiter",
  });

  loadRendererScripts(context, [
    "electron-app/src/renderer/components/build-badge.js",
  ]);

  await context.window.renderBuildBadge();

  const html = context.elements["build-text"].innerHTML;
  assert.match(html, /channel-badge dev/);
  assert.match(html, /dev-build/);
  assert.doesNotMatch(html, /channel-badge stable/);
});

test("main and loading views load release channel helpers before build badges", () => {
  for (const view of [
    "electron-app/src/renderer/views/index.html",
    "electron-app/src/renderer/views/loading.html",
  ]) {
    const source = readRepoFile(view);
    const releaseChannelIndex = source.indexOf("utils/release-channel.js");
    const buildInfoIndex = source.indexOf("utils/build-info.js");
    const buildBadgeIndex = source.indexOf("renderer/components/build-badge.js");

    assert.notEqual(releaseChannelIndex, -1, `${view} loads release-channel.js`);
    assert.notEqual(buildInfoIndex, -1, `${view} loads build-info.js`);
    assert.notEqual(buildBadgeIndex, -1, `${view} loads build-badge.js`);
    assert.ok(
      releaseChannelIndex < buildInfoIndex,
      `${view} loads release-channel.js before build-info.js`,
    );
    assert.ok(
      buildInfoIndex < buildBadgeIndex,
      `${view} loads build-info.js before build-badge.js`,
    );
  }
});

test("main and loading badge styles include custom-channel purple styling", () => {
  const stylesSource = readRepoFile("electron-app/src/styles.css");
  assert.match(stylesSource, /--channel-custom-bg:\s*rgba\(167,\s*139,\s*250/);
  assert.match(stylesSource, /--channel-custom-bg:\s*rgba\(124,\s*58,\s*237/);
  assert.match(
    stylesSource,
    /\.channel-badge\.custom\s*\{[\s\S]*background:\s*var\(--channel-custom-bg\);[\s\S]*color:\s*var\(--channel-custom-text\);[\s\S]*border:\s*1px solid var\(--channel-custom-border\);/,
  );

  const loadingSource = readRepoFile("electron-app/src/renderer/views/loading.html");
  assert.match(
    loadingSource,
    /\.channel-badge\.custom\s*\{[\s\S]*rgba\(167,\s*139,\s*250,\s*0\.15\)[\s\S]*#c4b5fd/,
  );
  assert.match(
    loadingSource,
    /\[data-theme="light"\] \.channel-badge\.custom\s*\{[\s\S]*rgba\(124,\s*58,\s*237,\s*0\.12\)[\s\S]*#6d28d9/,
  );
});
