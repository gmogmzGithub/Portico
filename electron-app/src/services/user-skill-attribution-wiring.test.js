const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Skills MCP creation and update delegate to app-owned endpoints without public author input", () => {
  const spec = JSON.parse(
    source("../src/core-mcp-rust/crates/skills-server/tool_spec.json"),
  );
  for (const toolName of ["create_skill", "update_skill"]) {
    const tool = spec.find((entry) => entry.name === toolName);
    assert.ok(tool, `${toolName} must exist`);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, "author"), false);
  }

  const rust = source("../src/core-mcp-rust/crates/skills-server/src/native/skills.rs");
  assert.match(rust, /proxy_user_skill_mutation\(\s*"\/api\/user-skills\/create"/s);
  assert.match(rust, /proxy_user_skill_mutation\(\s*"\/api\/user-skills\/update"/s);
  assert.doesNotMatch(rust, /inject_author_into_frontmatter/);
  const createBlock = rust.slice(
    rust.indexOf("async fn handle_create_skill"),
    rust.indexOf("async fn handle_read_skill"),
  );
  assert.doesNotMatch(createBlock, /"author"/);
});

test("Electron routes all SKILL.md create, edit, duplicate, and detach paths through the shared service", () => {
  const api = source("src/services/api.js");
  assert.match(api, /apiApp\.post\('\/api\/user-skills\/create'/);
  assert.match(api, /userSkillService\.createSkill/);
  assert.match(api, /apiApp\.post\('\/api\/user-skills\/update'/);
  assert.match(api, /userSkillService\.updateSkill/);

  const ipc = source("src/services/ipc.js");
  assert.match(ipc, /await userSkillService\.updateSkill\(/);
  assert.match(ipc, /await userSkillService\.copySkillToUser\(/);
  assert.doesNotMatch(
    ipc.slice(ipc.indexOf('ipcMain.handle("get-skills"'), ipc.indexOf("// LEGACY: Old skill")),
    /localUsername|userInfo\(\)\.username/,
  );

  const marketplace = source("src/services/marketplace-service.js");
  const detach = marketplace.slice(
    marketplace.indexOf("async function detachMarketplaceSkillToUserSkill"),
    marketplace.indexOf("async function checkSkillUpdates"),
  );
  assert.match(detach, /copyUserSkill\(/);
  assert.match(detach, /fsPromises\.rm\(destinationPath/);
});

test("User cards use created_by_email LDAP while descriptive authors remain for other sources", () => {
  const ipc = source("src/services/ipc.js");
  assert.match(ipc, /created_by_email: createdByEmail/);

  // Round 11 moved the card shell (including the ownership-badge author
  // sourcing) into the shared SkillCardRenderer used by both the Agent Skills
  // tab and the AI Marketplace publish modal — same invariant, new home.
  const renderer = source("src/renderer/components/skill-card-renderer.js");
  assert.match(renderer, /function normalizeSkillCardLdap\(value\)/);
  assert.match(
    renderer,
    /source === "user"\s*\? normalizeSkillCardLdap\(skill\?\.created_by_email\) \|\| "Unknown"\s*:\s*skill\?\.author \|\| "Unknown"/s,
  );
});

test("startup, later health syncs, and Control Plane scans all retry idempotent reconciliation", () => {
  const main = source("src/services/main.js");
  assert.match(
    main,
    /if \(startupCoreSyncResult\?\.success\) \{[\s\S]*await userSkillReconciliation\.reconcileUserSkills\([\s\S]*loading-step-complete/s,
  );

  const docker = source("src/services/docker-mcp.js");
  assert.match(
    docker,
    /mode === "full" \|\| mode === "startup-core"[\s\S]*scheduleUserSkillReconciliation/s,
  );

  const ipc = source("src/services/ipc.js");
  const getSkills = ipc.slice(
    ipc.indexOf('ipcMain.handle("get-skills"'),
    ipc.indexOf("// LEGACY: Old skill"),
  );
  assert.match(getSkills, /await userSkillReconciliation\.reconcileUserSkills\(/);
  const currentUserHandlers = ipc.slice(
    ipc.indexOf("function registerCurrentUserHandlers"),
    ipc.indexOf("function registerGitLabMarketplaceAuthHandlers"),
  );
  assert.match(
    currentUserHandlers,
    /current-user-ensure-authenticated[\s\S]*authenticated === true[\s\S]*reconcileUserSkills/s,
  );
});
