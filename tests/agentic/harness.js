// Agentic test-plan harness orchestrator. Boots the full sandboxed stack:
//
//   mock Solutions Marketplace (in-memory)  <- AI_MARKETPLACE_BASE_URL
//   mock Open WebUI (in-memory)             <- OPENWEBUI_BASE_URL
//   dedicated Redis container               <- REDIS_HOST/REDIS_PORT
//   headless REAL Electron API (api.js)     <- ELECTRON_API_BASE
//   REAL Rust MCP servers over stdio        <- driven via the HTTP broker
//
// Everything lives under a disposable fixture dir; the user's real profile,
// app, and Docker stack are never touched (the harness picks its own ports
// and its own Redis container).
//
// Usage:  node tests/agentic/harness.js [--dir /tmp/portico-agentic]
// Prints one JSON line with every endpoint when ready, writes the same to
// <dir>/endpoints.json, and stays alive until SIGINT/SIGTERM.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");

const { startMockSolutionsMarketplace } = require("./mock-solutions-marketplace");
const { startMockOwui } = require("./mock-owui");
const { startMcpBroker } = require("./mcp-broker");

const REPO_ROOT = path.join(__dirname, "..", "..");

const PORTS = {
  marketplace: Number(process.env.portico_AGENTIC_MARKETPLACE_PORT || 18800),
  owui: Number(process.env.portico_AGENTIC_OWUI_PORT || 18801),
  electron: Number(process.env.portico_AGENTIC_ELECTRON_PORT || 18976),
  broker: Number(process.env.portico_AGENTIC_BROKER_PORT || 18766),
  redis: Number(process.env.portico_AGENTIC_REDIS_PORT || 16390),
};

const REDIS_CONTAINER = "portico-agentic-redis";
const API_KEY = "agentic-harness-key";
const VIEWER_EMAIL = process.env.portico_AGENTIC_VIEWER_EMAIL || "tester@example.invalid";

function log(line) {
  process.stderr.write(`${line}\n`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--dir");
  return {
    dir:
      dirIndex !== -1
        ? args[dirIndex + 1]
        : fs.mkdtempSync(path.join(os.tmpdir(), "portico-agentic-")),
  };
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function seedFixture(baseDir) {
  const projectRoot = path.join(baseDir, "project-root");
  const userData = path.join(baseDir, "user-data");
  for (const dir of [
    "mcp-configs",
    "mcp-configs-user",
    "skills-user",
    "skills-marketplace",
    "workspaces",
    "app-support",
    "workspace-cfg",
    "health-status",
  ]) {
    fs.mkdirSync(path.join(projectRoot, dir), { recursive: true });
  }
  fs.mkdirSync(userData, { recursive: true });

  // System skills: the real OOTB catalog so read-only guards and core-skill
  // agent links behave exactly like a shipped install.
  const systemSkillsTarget = path.join(projectRoot, "skills");
  if (!fs.existsSync(systemSkillsTarget)) {
    copyDirectory(path.join(REPO_ROOT, "skills"), systemSkillsTarget);
  }

  // MCP server configs: fetchKnownToolServerIds derives server:<dir> ids from
  // mcp-configs/, and the Rust activate_skill classifies required servers the
  // same way. Seed a representative subset (core + a couple of integrations).
  for (const serverId of [
    "skills",
    "subagents",
    "mcp-assistant",
    "agent-vm",
    "artifacts",
    "web-tools",
    "slack",
    "glean",
  ]) {
    const source = path.join(REPO_ROOT, "mcp-configs", serverId);
    const target = path.join(projectRoot, "mcp-configs", serverId);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      copyDirectory(source, target);
    }
  }

  // OOTB marketplaces registry + the preinstalled skills the app ships with
  // (marketplaces-ootb carries both the registry and the skills-marketplace
  // payload the installedSkills entries point at). The marketplaces-ootb/
  // directory itself must ALSO exist in the fixture root: without it,
  // resolveMarketplaceStoragePaths falls back to treating the LIVE registry
  // as its own OOTB seed, which re-merges every installed record on load.
  const ootbMarketplaces = path.join(REPO_ROOT, "marketplaces-ootb", "marketplaces.json");
  fs.copyFileSync(ootbMarketplaces, path.join(projectRoot, "marketplaces.json"));
  // Keep a pristine copy for teardown-between-scenarios restores.
  fs.copyFileSync(ootbMarketplaces, path.join(baseDir, "marketplaces.ootb.json"));
  copyDirectory(
    path.join(REPO_ROOT, "marketplaces-ootb", "skills-marketplace"),
    path.join(projectRoot, "skills-marketplace"),
  );
  const ootbDirTarget = path.join(projectRoot, "marketplaces-ootb");
  if (!fs.existsSync(ootbDirTarget)) {
    copyDirectory(path.join(REPO_ROOT, "marketplaces-ootb"), ootbDirTarget);
  }

  return { projectRoot, userData };
}

function ensureRedis() {
  const running = execFileSync("docker", [
    "ps",
    "--filter",
    `name=^${REDIS_CONTAINER}$`,
    "--format",
    "{{.Names}}",
  ])
    .toString()
    .trim();
  if (running === REDIS_CONTAINER) {
    log(`[harness] reusing redis container ${REDIS_CONTAINER}`);
    return;
  }
  execFileSync("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    REDIS_CONTAINER,
    "-p",
    `127.0.0.1:${PORTS.redis}:6379`,
    "redis:7-alpine",
  ]);
  log(`[harness] started redis container ${REDIS_CONTAINER} on ${PORTS.redis}`);
}

function waitForLine(child, predicate, label, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not become ready in ${timeoutMs}ms`)),
      timeoutMs,
    );
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const hit = predicate(line);
        if (hit) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          return resolve(hit);
        }
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited early with code ${code}`));
    });
  });
}

async function main() {
  const { dir } = parseArgs();
  fs.mkdirSync(dir, { recursive: true });
  const { projectRoot, userData } = seedFixture(dir);
  log(`[harness] fixture at ${dir}`);

  ensureRedis();

  const marketplace = await startMockSolutionsMarketplace({
    port: PORTS.marketplace,
    apiKey: API_KEY,
    log,
  });
  log(`[harness] mock marketplace at ${marketplace.baseUrl}`);

  const owui = await startMockOwui({ port: PORTS.owui, log });
  log(`[harness] mock owui at ${owui.baseUrl}`);

  // Headless Electron API host (child process so its Module._load hook and
  // require.cache surgery stay isolated from this orchestrator).
  const electronChild = spawn(
    process.execPath,
    [path.join(__dirname, "electron-api-host.js")],
    {
      env: {
        ...process.env,
        portico_HARNESS_PROJECT_ROOT: projectRoot,
        portico_HARNESS_USER_DATA: userData,
        portico_HARNESS_VIEWER_EMAIL: VIEWER_EMAIL,
        portico_HARNESS_PORT: String(PORTS.electron),
        portico_HARNESS_BROKER_URL: `http://127.0.0.1:${PORTS.broker}`,
        AI_MARKETPLACE_BASE_URL: marketplace.baseUrl,
        AI_MARKETPLACE_API_KEY: API_KEY,
        portico_AGENTIC_AUTO_APPROVE: process.env.portico_AGENTIC_AUTO_APPROVE || "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  electronChild.stderr.on("data", (chunk) =>
    log(`[electron-host stderr] ${chunk.toString().trimEnd()}`),
  );
  const electronReady = await waitForLine(
    electronChild,
    (line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.ready ? parsed : null;
      } catch {
        return null;
      }
    },
    "electron-api-host",
  );
  const electronBaseUrl = electronReady.baseUrl;
  log(`[harness] electron api host at ${electronBaseUrl}`);

  // REAL Rust MCP servers over stdio behind the HTTP broker.
  const rustTarget = path.join(REPO_ROOT, "src", "core-mcp-rust", "target", "debug");
  const serverEnv = {
    CONTAINER_PROJECT_ROOT: projectRoot,
    HOST_PROJECT_ROOT: projectRoot,
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: String(PORTS.redis),
    ELECTRON_API_BASE: electronBaseUrl,
    OPENWEBUI_BASE_URL: owui.baseUrl,
    OPENWEBUI_API_TOKEN: "mock-owui-token",
    CHAT_STATE_API_BASE_URL: "http://127.0.0.1:9",
    PORTICO_APP_SUPPORT_DIR: path.join(projectRoot, "app-support"),
    PORTICO_WORKSPACE_CFG_DIR: path.join(projectRoot, "workspace-cfg"),
    RUST_LOG: "info",
  };
  const broker = await startMcpBroker({
    port: PORTS.broker,
    servers: {
      skills: {
        command: path.join(rustTarget, "skills-server"),
        env: serverEnv,
        cwd: projectRoot,
      },
      subagents: {
        command: path.join(rustTarget, "subagents-server"),
        env: serverEnv,
        cwd: projectRoot,
      },
    },
    log,
  });
  log(`[harness] mcp broker at ${broker.baseUrl}`);

  const endpoints = {
    fixtureDir: dir,
    projectRoot,
    userData,
    marketplace: marketplace.baseUrl,
    owui: owui.baseUrl,
    electron: electronBaseUrl,
    broker: broker.baseUrl,
    redisContainer: REDIS_CONTAINER,
    redisPort: PORTS.redis,
    viewerEmail: VIEWER_EMAIL,
    apiKey: API_KEY,
  };
  fs.writeFileSync(path.join(dir, "endpoints.json"), JSON.stringify(endpoints, null, 2));
  console.log(JSON.stringify(endpoints));

  const shutdown = async () => {
    log("[harness] shutting down");
    try {
      electronChild.kill("SIGTERM");
    } catch {}
    try {
      await broker.close();
    } catch {}
    try {
      await marketplace.close();
    } catch {}
    try {
      await owui.close();
    } catch {}
    try {
      execFileSync("docker", ["stop", REDIS_CONTAINER]);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  electronChild.on("exit", (code) => {
    log(`[harness] electron-api-host exited unexpectedly (code ${code})`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error("[harness] fatal:", error);
  process.exit(1);
});
