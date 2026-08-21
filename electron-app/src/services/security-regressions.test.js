const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("agent skills sanitizes rendered markdown before injecting HTML", () => {
  const source = readRepoFile("electron-app/src/renderer/components/agent-skills.js");

  assert.match(source, /function sanitizeRenderedHtml\(html\)/);
  assert.match(source, /sanitizeRenderedHtml\(marked\.parse\(body\)\)/);
  assert.match(source, /escapeHtmlAttribute/);
});

test("renderer bridge no longer exposes generic shell execution", () => {
  const preloadSource = readRepoFile("electron-app/src/services/preload.js");
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");

  assert.match(preloadSource, /dockerStopWithLogs:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('docker-stop-with-logs'\)/);
  assert.match(preloadSource, /openLocalPath:\s*\(targetPath\)\s*=>\s*ipcRenderer\.invoke\('open-local-path', targetPath\)/);
  assert.doesNotMatch(preloadSource, /executeWithLogs:/);
  assert.doesNotMatch(preloadSource, /executeCommand:/);
  assert.doesNotMatch(preloadSource, /killProcess:/);
  assert.match(ipcSource, /ipcMain\.handle\("docker-stop-with-logs"/);
  assert.doesNotMatch(ipcSource, /ipcMain\.handle\("execute-with-logs"/);
  assert.doesNotMatch(ipcSource, /ipcMain\.handle\(\s*"execute-command"/);
  assert.doesNotMatch(ipcSource, /ipcMain\.handle\("kill-process"/);
});

test("legacy debugger webviews keep context isolation enabled", () => {
  const source = readRepoFile("electron-app/src/renderer/components/chat-tab.js");

  assert.match(source, /contextIsolation=yes, nodeIntegration=no/);
  assert.doesNotMatch(source, /contextIsolation=no, nodeIntegration=no/);
});

test("chat execute events use typed actions instead of dynamic code execution", () => {
  const source = readRepoFile("src/patches/frontend/src/lib/components/chat/Chat.svelte");

  assert.match(source, /const runTrustedExecuteAction = async/);
  assert.doesNotMatch(source, /new Function\(/);
});

test("packaged builds harden Electron fuses and separate update credentials from runtime secrets", () => {
  const packageJson = JSON.parse(readRepoFile("electron-app/package.json"));
  const extraResources = packageJson.build.extraResources;

  assert.equal(packageJson.build.electronFuses.runAsNode, false);
  assert.equal(packageJson.build.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(packageJson.build.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(packageJson.build.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(packageJson.build.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(packageJson.build.electronFuses.loadBrowserProcessSpecificV8Snapshot, false);
  assert.equal(packageJson.build.electronFuses.grantFileProtocolExtraPrivileges, false);
  assert.doesNotMatch(JSON.stringify(packageJson.build.extraResources), /browser_v8_context_snapshot/);
  assert.deepEqual(
    extraResources.find((resource) => resource.to === "cloudsmith.env"),
    {
      from: "build-resources/cloudsmith.env",
      to: "cloudsmith.env",
    },
  );

  const resourcePrepSource = readRepoFile(
    "electron-app/scripts/prepare-cloudsmith-resource.js",
  );
  const releasePackageSource = readRepoFile("package_for_release.sh");
  const dockerBuildSource = readRepoFile(
    "electron-app/src/scripts/build-with-docker.sh",
  );
  const runtimeSecretsSource = readRepoFile(
    "electron-app/src/config/runtime-secrets-config.js",
  );
  const dockerComposeSource = readRepoFile("src/scripts/docker-compose.sh");
  assert.match(resourcePrepSource, /CLOUDSMITH_ENTITLEMENT_TOKEN is required for packaged builds/);
  assert.match(resourcePrepSource, /CLOUDSMITH_API_KEY is required for packaged update discovery/);
  assert.match(resourcePrepSource, /validatePackagedCloudsmithEnvFile/);
  assert.match(releasePackageSource, /prepare_cloudsmith_release_resource/);
  assert.match(releasePackageSource, /npm run prepare:packaged-build/);
  assert.match(dockerBuildSource, /npm run prepare:packaged-build/);
  assert.match(dockerBuildSource, /resolve_packaged_cloudsmith_entitlement_token/);
  assert.match(dockerBuildSource, /-e CLOUDSMITH_API_KEY/);
  assert.match(dockerBuildSource, /-e CLOUDSMITH_ENTITLEMENT_TOKEN/);
  assert.ok(
    dockerBuildSource.indexOf("resolve_packaged_cloudsmith_entitlement_token") <
      dockerBuildSource.indexOf("docker run --rm"),
    "Docker packaged-build token resolution must happen before container work",
  );
  assert.match(
    runtimeSecretsSource,
    /CLOUDSMITH_API_KEY:\s*Object\.freeze\(\{[\s\S]*scope:\s*RUNTIME_SECRET_SCOPE\.DEV_ONLY,[\s\S]*allowRuntimeWrites:\s*false,/,
  );
  const cleanEnvFileSource = dockerComposeSource.slice(
    dockerComposeSource.indexOf("clean_env_file()"),
    dockerComposeSource.indexOf("# Directory holding runtime secret files"),
  );
  assert.doesNotMatch(cleanEnvFileSource, /"CLOUDSMITH_API_KEY"/);
  assert.match(
    runtimeSecretsSource,
    /CLOUDSMITH_API_KEY is intentionally excluded:[\s\S]*resolveCloudsmithApiKey/,
  );
});

test("Cloudsmith update diagnostics redact credential-bearing URL paths", () => {
  const prepSource = readRepoFile(
    "electron-app/src/services/update-preparation.js",
  );
  const prereqSource = readRepoFile("src/scripts/prereq-download.sh");
  const detachedUpdateSource = readRepoFile(
    "electron-app/src/scripts/update-cloudsmith.sh",
  );
  const inAppUpdateSource = readRepoFile(
    "electron-app/src/scripts/update-in-app-cloudsmith.sh",
  );

  assert.match(prepSource, /redactDownloadUrl/);
  assert.match(prereqSource, /redact_url_for_log/);
  assert.doesNotMatch(prereqSource, /Found download URL: \$DOWNLOAD_URL/);
  assert.doesNotMatch(detachedUpdateSource, /Download URL: \$DOWNLOAD_URL/);
  assert.doesNotMatch(inAppUpdateSource, /Downloading from: \$DOWNLOAD_URL/);
});

test("local Electron shell pages load through the hardened app protocol", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");
  const protocolSource = readRepoFile(
    "electron-app/src/services/app-protocol.js",
  );
  const packageJson = JSON.parse(readRepoFile("electron-app/package.json"));
  const expectedPages = [
    "guided-setup.html",
    "loading.html",
    "index.html",
    "mcp-tooltip.html",
    "local-find-overlay.html",
    "artifact-version-menu.html",
    "artifact-divider-overlay.html",
    "conversation-window.html",
  ];

  assert.doesNotMatch(windowsSource, /\.loadFile\s*\(/);
  for (const page of expectedPages) {
    assert.match(windowsSource, new RegExp(page.replace(".", "\\.")));
  }
  assert.match(windowsSource, /loadAppPage\(/);
  assert.match(windowsSource, /dialog\.showErrorBox\(/);
  assert.match(protocolSource, /standard:\s*true/);
  assert.match(protocolSource, /secure:\s*true/);
  assert.match(protocolSource, /supportFetchAPI:\s*true/);
  assert.doesNotMatch(protocolSource, /bypassCSP:\s*true/);
  assert.doesNotMatch(protocolSource, /allowServiceWorkers:\s*true/);
  assert.doesNotMatch(protocolSource, /corsEnabled:\s*true/);

  const registrationIndex = mainSource.indexOf("registerAppScheme(protocol);");
  const readyIndex = mainSource.indexOf(".whenReady()");
  assert.ok(registrationIndex >= 0 && registrationIndex < readyIndex);
  assert.match(mainSource, /installAppProtocol\(\{\s*protocol,\s*net,\s*appRoot: APP_ROOT,/);
  assert.match(
    packageJson.scripts.bundle,
    /verify:app-protocol.*bundle-renderer\.js/,
  );
  assert.match(
    packageJson.scripts["prepare:packaged-build"],
    /verify:app-protocol.*bundle-renderer\.js/,
  );
});

test("skill logos are returned as renderer-safe data URLs", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");

  assert.doesNotMatch(ipcSource, /logo\s*=\s*`file:\/\//);
  assert.match(
    ipcSource,
    /logo\s*=\s*`data:\$\{mimeType\};base64,\$\{logoBuffer\.toString\("base64"\)\}`/,
  );
});

test("update integrity fails closed without checksums and verifies staged signatures", () => {
  const updatesSource = readRepoFile("electron-app/src/services/updates.js");
  const prepScriptSource = readRepoFile(
    "electron-app/src/scripts/prepare-update-cloudsmith.sh",
  );

  assert.doesNotMatch(updatesSource, /legacy-lastModified/);
  assert.match(updatesSource, /buildMissingChecksumErrorMessage/);
  assert.match(prepScriptSource, /function verify_macos_artifact_signature|verify_macos_artifact_signature\(\)/);
  assert.match(prepScriptSource, /\[UPDATE_PREP:STEP:SIGNATURE:START\]/);
  assert.match(prepScriptSource, /codesign --verify --deep --strict/);
  assert.match(prepScriptSource, /spctl --assess --type execute/);
});
