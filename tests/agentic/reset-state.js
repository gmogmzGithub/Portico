// Teardown between agentic test scenarios: returns the sandboxed stack to a
// clean slate without restarting any process.
//
//   node tests/agentic/reset-state.js <fixtureDir>
//
// Clears: skills-user/, skills-marketplace/, skills-archive/, workspaces/,
// workspace-cfg + app-support state, the OOTB marketplaces.json baseline, the
// userData link registries (auto-approve preference survives), Redis, the
// mock marketplace, the mock OWUI, and the electron host broadcast log.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

async function main() {
  const fixtureDir = process.argv[2];
  if (!fixtureDir) {
    console.error("usage: node reset-state.js <fixtureDir>");
    process.exit(1);
  }
  const endpoints = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, "endpoints.json"), "utf8"),
  );
  const { projectRoot, userData } = endpoints;

  const emptyDir = (dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return;
    }
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  };

  for (const rel of [
    "skills-user",
    "skills-marketplace",
    "skills-archive",
    "workspaces",
    "workspace-cfg",
    "app-support",
  ]) {
    emptyDir(path.join(projectRoot, rel));
  }

  fs.copyFileSync(
    path.join(fixtureDir, "marketplaces.ootb.json"),
    path.join(projectRoot, "marketplaces.json"),
  );
  // Restore the OOTB preinstalled marketplace skills payload.
  const repoRoot = path.join(__dirname, "..", "..");
  fs.cpSync(
    path.join(repoRoot, "marketplaces-ootb", "skills-marketplace"),
    path.join(projectRoot, "skills-marketplace"),
    { recursive: true },
  );

  for (const file of [
    "ai-marketplace-skill-links.json",
    "ai-marketplace-agent-links.json",
  ]) {
    fs.rmSync(path.join(userData, file), { force: true });
  }

  execFileSync("docker", ["exec", endpoints.redisContainer, "redis-cli", "FLUSHALL"]);

  const post = async (url) => {
    const response = await fetch(url, { method: "POST" });
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  };
  await post(`${endpoints.marketplace}/__test/reset`);
  await post(`${endpoints.owui}/__test/reset`);
  await post(`${endpoints.electron}/__harness/clear-broadcasts`);

  console.log(JSON.stringify({ reset: true }));
}

main().catch((error) => {
  console.error("[reset-state] fatal:", error.message);
  process.exit(1);
});
