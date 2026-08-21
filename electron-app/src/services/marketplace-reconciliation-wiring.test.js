const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const servicesDir = __dirname;
const ipcSource = fs.readFileSync(path.join(servicesDir, "ipc.js"), "utf8");
const mainSource = fs.readFileSync(path.join(servicesDir, "main.js"), "utf8");
const prereqDownloadSource = fs.readFileSync(
  path.resolve(servicesDir, "../../../src/scripts/prereq-download.sh"),
  "utf8",
);
const managedRuntimeReconcileSource = fs.readFileSync(
  path.resolve(servicesDir, "../../../src/scripts/managed-runtime-reconcile.sh"),
  "utf8",
);
const applyPreparedUpdateSource = fs.readFileSync(
  path.resolve(servicesDir, "../scripts/apply-prepared-update.sh"),
  "utf8",
);
const updateCloudsmithSource = fs.readFileSync(
  path.resolve(servicesDir, "../scripts/update-cloudsmith.sh"),
  "utf8",
);
const updateInAppCloudsmithSource = fs.readFileSync(
  path.resolve(servicesDir, "../scripts/update-in-app-cloudsmith.sh"),
  "utf8",
);

test("startup marketplace reconciliation uses bundled offline helper instead of network install flow", () => {
  const startupHelperMatch = ipcSource.match(
    /async function ensureBundledMarketplaceDefaultsAtStartup\(\) \{([\s\S]*?)\n\}/,
  );
  assert.ok(startupHelperMatch, "expected startup reconcile helper in ipc.js");

  const startupHelperBody = startupHelperMatch[1];
  assert.match(
    startupHelperBody,
    /marketplaceService\.runStartupMarketplaceIntegrityPass\(\s*bootstrap\.PROJECT_ROOT/,
  );
  assert.doesNotMatch(startupHelperBody, /fetchMarketplaceManifest/);
  assert.doesNotMatch(startupHelperBody, /installMarketplaceSkillsFromManifest/);
  assert.doesNotMatch(startupHelperBody, /downloadSkillFromGitHub/);
  assert.doesNotMatch(startupHelperBody, /downloadSkillDirectory/);

  assert.match(mainSource, /ensureBundledMarketplaceDefaultsAtStartup\(\)\.catch/);
  assert.doesNotMatch(mainSource, /ensureOfficialMarketplaceInstalled/);
});

test("get-skills loads marketplace config through the marketplace service before scanning marketplace directories", () => {
  assert.match(
    ipcSource,
    /Load marketplace config for author info and reconcile legacy installs\./,
  );
  assert.match(
    ipcSource,
    /marketplacesConfig = await marketplaceService\.loadMarketplacesConfig\(\s*[\r\n\s]*bootstrap\.PROJECT_ROOT,\s*[\r\n\s]*\{\s*logger: console\s*\},?\s*[\r\n\s]*\)/,
  );
  assert.match(ipcSource, /parseSkillDirectoryMetadata/);
  assert.match(
    ipcSource,
    /\[IPC\] Failed to parse skill metadata at \$\{skillPath\}:/,
  );
});

test("startup seeds UPDATE_CHANNEL from bundled build metadata before building the app menu", () => {
  assert.match(mainSource, /bootstrap\.ensureUpdateChannelSeededFromBuildInfo\(\);\s+createMenu\(\);/);
});

test("managed runtime reconcile preserves live marketplace and chat state but not shipped MCP configs or skills", () => {
  assert.match(managedRuntimeReconcileSource, /"open-webui-data"/);
  assert.match(managedRuntimeReconcileSource, /"skills-marketplace"/);
  assert.match(managedRuntimeReconcileSource, /"marketplaces\.json"/);
  assert.match(managedRuntimeReconcileSource, /"HOST_MODE"/);
  assert.match(managedRuntimeReconcileSource, /"mcp-configs-user"/);
  assert.match(managedRuntimeReconcileSource, /"skills-user"/);
  assert.doesNotMatch(managedRuntimeReconcileSource, /"mcp-configs"/);
  assert.doesNotMatch(managedRuntimeReconcileSource, /"skills"/);
  assert.doesNotMatch(managedRuntimeReconcileSource, /"skills-marketplace-ootb"/);
  assert.doesNotMatch(managedRuntimeReconcileSource, /"marketplaces-ootb\.json"/);
});

test("install and update scripts use the shared managed-runtime reconcile helper", () => {
  assert.match(prereqDownloadSource, /MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS/);
  assert.match(prereqDownloadSource, /managed_runtime_reconcile_payload/);
  assert.match(prereqDownloadSource, /managed_runtime_remove_generated_compose_files/);
  assert.match(prereqDownloadSource, /managed_runtime_regenerate_generated_compose/);
  assert.match(prereqDownloadSource, /managed_runtime_validate_generated_compose/);

  assert.match(applyPreparedUpdateSource, /MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS/);
  assert.match(applyPreparedUpdateSource, /managed_runtime_reconcile_payload/);
  assert.match(applyPreparedUpdateSource, /managed_runtime_remove_generated_compose_files/);
  assert.match(applyPreparedUpdateSource, /PREPARED_RESOURCES_ROOT=.*managed_runtime_normalize_packaged_resources_root/);
  assert.match(applyPreparedUpdateSource, /managed_runtime_require_packaged_generator_binary "\$PREPARED_MANAGED_ROOT_DIR" "\$PREPARED_RESOURCES_ROOT"/);
  assert.match(applyPreparedUpdateSource, /managed_runtime_regenerate_generated_compose/);
  assert.match(applyPreparedUpdateSource, /managed_runtime_regenerate_generated_compose "\$MANAGED_DIR" "\$SCRIPT_DIR" "\$PREPARED_RESOURCES_ROOT"/);
  assert.match(applyPreparedUpdateSource, /managed_runtime_validate_generated_compose/);
  assert.doesNotMatch(applyPreparedUpdateSource, /--exclude "skills-marketplace\/"/);
  assert.doesNotMatch(applyPreparedUpdateSource, /--exclude "marketplaces\.json"/);

  assert.match(updateCloudsmithSource, /MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS/);
  assert.match(updateCloudsmithSource, /managed_runtime_reconcile_payload/);
  assert.match(updateCloudsmithSource, /managed_runtime_remove_generated_compose_files/);
  assert.match(updateCloudsmithSource, /PAYLOAD_RESOURCES_ROOT=.*managed_runtime_normalize_packaged_resources_root/);
  assert.match(updateCloudsmithSource, /managed_runtime_require_packaged_generator_binary "\$MANAGED_DIR" "\$PAYLOAD_RESOURCES_ROOT"/);
  assert.match(updateCloudsmithSource, /managed_runtime_regenerate_generated_compose/);
  assert.match(updateCloudsmithSource, /managed_runtime_validate_generated_compose/);

  assert.match(updateInAppCloudsmithSource, /MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS/);
  assert.match(updateInAppCloudsmithSource, /managed_runtime_reconcile_payload/);
  assert.match(updateInAppCloudsmithSource, /managed_runtime_remove_generated_compose_files/);
  assert.match(updateInAppCloudsmithSource, /PAYLOAD_RESOURCES_ROOT=.*managed_runtime_normalize_packaged_resources_root/);
  assert.match(updateInAppCloudsmithSource, /managed_runtime_require_packaged_generator_binary "\$MANAGED_DIR" "\$PAYLOAD_RESOURCES_ROOT"/);
  assert.match(updateInAppCloudsmithSource, /managed_runtime_regenerate_generated_compose/);
  assert.match(updateInAppCloudsmithSource, /managed_runtime_validate_generated_compose/);
});
