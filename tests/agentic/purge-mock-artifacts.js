// Cleanup engine for mock-marketplace sessions (`install_v2.sh
// --mock-marketplace`). Removes mock-session artifacts from the dev profile
// so the app can return to the real Solutions Marketplace with no residue:
//
//   - PUBLISHED-to-mock entities are UNLINKED: skill-link / agent-link
//     entries whose solutionId belongs to the mock are dropped, so the local
//     skill/agent reverts to a plain unpublished, local-only user entity.
//     The entity's files/models are never touched.
//   - INSTALLED-from-mock copies are REMOVED: their marketplaces.json
//     records and skills-marketplace/ai-marketplace/<skill>/ payload dirs
//     are mock-owned copies, not local work. (OWUI agents installed from the
//     mock stay behind as plain local agents — delete those in the app.)
//
// Identification is EXACT: the id set comes from the mock's own
// /__test/state (or --ids), never from heuristics against the real
// marketplace — a real listing that 404s is never a purge candidate.
//
// Safety: DRY-RUN by default (--apply to execute); refuses to run while the
// app looks running (external registry writes race the app's in-process
// write lock) unless --force; every changed file gets a .bak-<ts> sibling
// first; files without matches are never rewritten.
//
// Users normally reach this through `./install_v2.sh
// --unlink-mock-marketplace-entities` rather than invoking it directly.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MOCK_PORT = Number(process.env.portico_MOCK_MARKETPLACE_PORT || 18808);

function parseArgs(argv) {
  const args = {
    apply: false,
    force: false,
    projectRoot: path.resolve(__dirname, "..", ".."),
    userData: path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "portico",
    ),
    mockUrl: `http://127.0.0.1:${DEFAULT_MOCK_PORT}`,
    ids: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--project-root") args.projectRoot = path.resolve(argv[++i] || "");
    else if (arg === "--user-data") args.userData = path.resolve(argv[++i] || "");
    else if (arg === "--mock-url") args.mockUrl = String(argv[++i] || "").replace(/\/+$/, "");
    else if (arg === "--ids") {
      args.ids = String(argv[++i] || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node tests/agentic/purge-mock-artifacts.js " +
          "[--apply] [--force] [--project-root <dir>] [--user-data <dir>] " +
          "[--mock-url <url>] [--ids a,b,c]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg} (see --help)`);
      process.exit(1);
    }
  }
  return args;
}

async function probeHttp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true; // ANY http response (any status) means something is serving
  } catch {
    return false;
  }
}

async function appLooksRunning() {
  const [cdp, api] = await Promise.all([
    probeHttp("http://127.0.0.1:9223/json/version"),
    probeHttp("http://127.0.0.1:9876/"),
  ]);
  return cdp || api;
}

async function fetchMockIds(mockUrl) {
  const response = await fetch(`${mockUrl}/__test/state`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`state hook returned ${response.status}`);
  const state = await response.json();
  const rows = Array.isArray(state?.solutions) ? state.solutions : [];
  return rows.map((sol) => String(sol?.id || "").trim()).filter(Boolean);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, data: null, error: null };
  try {
    return { exists: true, data: JSON.parse(fs.readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { exists: true, data: null, error: error.message };
  }
}

// Mirrors the app's uninstall guard: the payload dir must resolve inside the
// project root AND live under skills-marketplace/ before we will remove it.
function guardedInstallDir(projectRoot, localPath) {
  const text = typeof localPath === "string" ? localPath.trim() : "";
  if (!text) return null;
  const resolved = path.resolve(projectRoot, text);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (relative.split(path.sep)[0] !== "skills-marketplace") return null;
  return fs.existsSync(resolved) ? resolved : null;
}

function backupThenWrite(filePath, data, backups) {
  const backupPath = `${filePath}.bak-${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  backups.push(backupPath);
  const tmpPath = `${filePath}.tmp-purge-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.force && (await appLooksRunning())) {
    console.error(
      "Portico looks like it is running (CDP 9223 / API 9876 answered).\n" +
        "External registry edits race the app's in-process write lock — quit " +
        "the app first, or re-run with --force to override.",
    );
    process.exit(2);
  }

  let mockIds;
  if (args.ids && args.ids.length) {
    mockIds = new Set(args.ids);
  } else {
    try {
      mockIds = new Set(await fetchMockIds(args.mockUrl));
    } catch (error) {
      console.error(
        `Could not read the mock marketplace state at ${args.mockUrl}/__test/state ` +
          `(${error.message}).\n` +
          "Restart the mock (./install_v2.sh --skip-deps --no-launch --mock-marketplace) " +
          "or pass the session's solution ids explicitly via --ids id1,id2,...",
      );
      process.exit(3);
    }
  }

  const registryPath = path.join(args.projectRoot, "marketplaces.json");
  const skillLinksPath = path.join(args.userData, "ai-marketplace-skill-links.json");
  const agentLinksPath = path.join(args.userData, "ai-marketplace-agent-links.json");

  const registry = readJsonFile(registryPath);
  const skillLinks = readJsonFile(skillLinksPath);
  const agentLinks = readJsonFile(agentLinksPath);

  const parseErrors = [];
  for (const [label, file] of [
    ["marketplaces.json", registry],
    ["ai-marketplace-skill-links.json", skillLinks],
    ["ai-marketplace-agent-links.json", agentLinks],
  ]) {
    if (file.exists && file.error) parseErrors.push({ file: label, error: file.error });
  }

  // ---- plan (pure computation) --------------------------------------------
  const registryVictims = [];
  const dirVictims = [];
  let registrySurvivors = 0;
  if (registry.data && Array.isArray(registry.data.installedSkills)) {
    for (const entry of registry.data.installedSkills) {
      const source = entry && entry.skillSource;
      const solutionId =
        source && source.type === "ai-marketplace-solution"
          ? String(source.solutionId || "").trim()
          : "";
      if (solutionId && mockIds.has(solutionId)) {
        registryVictims.push(entry);
        const dir = guardedInstallDir(args.projectRoot, entry.localPath);
        if (dir) dirVictims.push(dir);
      } else {
        registrySurvivors += 1;
      }
    }
  }

  const planLinkRemovals = (file) => {
    const removals = [];
    const links = file.data && file.data.links && typeof file.data.links === "object"
      ? file.data.links
      : null;
    if (!links) return removals;
    for (const [key, link] of Object.entries(links)) {
      const solutionId = String(link?.solutionId || "").trim();
      if (solutionId && mockIds.has(solutionId)) {
        removals.push({ key, solutionId, relationship: link?.relationship });
      }
    }
    return removals;
  };
  const skillLinkVictims = planLinkRemovals(skillLinks);
  const agentLinkVictims = planLinkRemovals(agentLinks);

  // ---- report ---------------------------------------------------------------
  const mode = args.apply ? "APPLY" : "DRY RUN";
  console.log(`Mock-artifact purge (${mode}) — ${mockIds.size} mock solution id(s)`);
  console.log(`  project root: ${args.projectRoot}`);
  console.log(`  user data:    ${args.userData}`);

  if (parseErrors.length) {
    for (const problem of parseErrors) {
      console.log(`  ⚠ unparseable ${problem.file}: ${problem.error}`);
    }
  }

  if (skillLinkVictims.length || agentLinkVictims.length) {
    console.log("\nUnlink published-to-mock entities (become local-only, files untouched):");
    for (const victim of skillLinkVictims) {
      console.log(`  skill link  ${victim.key}  ->  ${victim.solutionId}`);
    }
    for (const victim of agentLinkVictims) {
      console.log(
        `  agent link  ${victim.key}  ->  ${victim.solutionId}` +
          `${victim.relationship ? `  (${victim.relationship})` : ""}`,
      );
    }
  }
  if (registryVictims.length) {
    console.log("\nRemove installed-from-mock copies:");
    for (const entry of registryVictims) {
      console.log(
        `  install record  ${entry.skillId}  ->  ${entry.skillSource.solutionId}` +
          `${entry.localPath ? `  (${entry.localPath})` : ""}`,
      );
    }
  }
  const totalChanges =
    registryVictims.length + skillLinkVictims.length + agentLinkVictims.length;
  if (!totalChanges) {
    console.log("\nNothing to purge — no local entities reference the mock ids.");
  }
  console.log(
    `\nSurvivors: ${registrySurvivors} install records untouched, ` +
      `dirs to remove: ${dirVictims.length}`,
  );

  // ---- apply ------------------------------------------------------------------
  const backups = [];
  if (args.apply && totalChanges) {
    if (parseErrors.length) {
      console.error(
        "Refusing to --apply while a target file is unparseable — fix or " +
          "restore it first.",
      );
      process.exit(1);
    }
    if (registryVictims.length) {
      const removed = new Set(registryVictims);
      registry.data.installedSkills = registry.data.installedSkills.filter(
        (entry) => !removed.has(entry),
      );
      backupThenWrite(registryPath, registry.data, backups);
    }
    // Registry record removal FIRST, then payload dirs: a leftover dir
    // without a record is invisible (the registry is the source of truth),
    // while a record pointing at a deleted dir renders as a broken skill.
    for (const dir of dirVictims) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (skillLinkVictims.length) {
      for (const victim of skillLinkVictims) delete skillLinks.data.links[victim.key];
      backupThenWrite(skillLinksPath, skillLinks.data, backups);
    }
    if (agentLinkVictims.length) {
      for (const victim of agentLinkVictims) delete agentLinks.data.links[victim.key];
      backupThenWrite(agentLinksPath, agentLinks.data, backups);
    }
    console.log(`\nApplied. Backups: ${backups.join(", ") || "(none)"}`);
  } else if (!args.apply && totalChanges) {
    console.log("\nDry run — nothing changed. Re-run with --apply to execute.");
  }

  // Machine-readable summary (fixture tests assert on this final line).
  console.log(
    JSON.stringify({
      dryRun: !args.apply,
      mockIds: mockIds.size,
      registryRecordsRemoved: registryVictims.map((entry) => ({
        skillId: entry.skillId,
        solutionId: entry.skillSource.solutionId,
        localPath: entry.localPath || null,
      })),
      dirsRemoved: args.apply ? dirVictims : [],
      dirsPlanned: dirVictims,
      skillLinksRemoved: skillLinkVictims.map(({ key, solutionId }) => ({
        name: key,
        solutionId,
      })),
      agentLinksRemoved: agentLinkVictims.map(({ key, solutionId, relationship }) => ({
        agentId: key,
        solutionId,
        relationship: relationship || null,
      })),
      parseErrors,
      backups,
    }),
  );
}

main().catch((error) => {
  console.error(`purge-mock-artifacts failed: ${error.message}`);
  process.exit(1);
});
