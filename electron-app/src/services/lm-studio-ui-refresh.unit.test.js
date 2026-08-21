const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "../../..");

test("Electron API exposes OWUI model refresh bridge for LM Studio setup", () => {
  const apiSource = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");
  const preloadSource = fs.readFileSync(
    path.join(__dirname, "chat-webview-preload.js"),
    "utf8",
  );
  const chatSource = fs.readFileSync(
    path.join(
      REPO_ROOT,
      "src/patches/frontend/src/lib/components/chat/Chat.svelte",
    ),
    "utf8",
  );

  assert.match(apiSource, /apiApp\.post\('\/api\/owui\/request-model-refresh'/);
  assert.match(apiSource, /broadcastToViews\("owui-models-refresh-requested"/);
  assert.match(preloadSource, /ipcRenderer\.on\('owui-models-refresh-requested'/);
  assert.match(preloadSource, /CustomEvent\('owui-models-refresh-requested'/);
  assert.match(chatSource, /window\.addEventListener\('owui-models-refresh-requested'/);
  assert.match(chatSource, /models\.set\(\s*await getModels\(/);
});

test("health-check container mounts Application Support for LM Studio config", () => {
  const composeSource = fs.readFileSync(
    path.join(REPO_ROOT, "docker-compose.yml"),
    "utf8",
  );
  const healthCheckSection = composeSource.slice(
    composeSource.indexOf("  health-check:"),
    composeSource.indexOf("    depends_on:", composeSource.indexOf("  health-check:")),
  );

  assert.match(healthCheckSection, /PORTICO_APP_SUPPORT_DIR=\/app\/app-support/);
  assert.match(
    healthCheckSection,
    /\$\{PORTICO_APP_SUPPORT_DIR:-\.\/open-webui-data\/app-support\}:\/app\/app-support:rw/,
  );
});
