#!/usr/bin/env node
// Tier-2 headless real-chat integration repro runner.
//
//   node tests/integration-chat/run.mjs [--report DIR]
//
// Env:
//   portico_INT_IMAGE_TAG    image tag for open-webui + bifrost-bridge images
//                        (default: repro-baseline — the pre-pinned baseline)
//   portico_REPRO_STRICT=1   red scenarios become hard failures (baseline evidence
//                        artifact mode: exit 0 only when EVERYTHING is green)
//   portico_INT_PATCHES_SRC  "git:HEAD" (default) | "worktree" | /path/to/snapshot
//                        Where the OWUI backend patch snapshot comes from.
//                        git:HEAD is immune to concurrent working-tree edits.
//   portico_INT_KEEP_STACK=1 skip compose down -v (debugging)
//
// Exit code contract:
//   default: 0 iff every scenario matches its expected status
//            (expected-red observed red counts as a match)
//   strict:  0 iff every scenario is green (post-fix verification)
//
// HARD SAFETY: everything runs in the isolated compose project
// `portico-integration` with its own volumes and 28xxx/29xxx host ports. This
// runner never touches the developer stack.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { OwuiClient, waitFor, sleep } from "./driver/api.mjs";
import { MockBedrockClient } from "./driver/mock.mjs";
import { buildScenarios, executeScenario } from "./scenarios.mjs";

const SUITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SUITE_DIR, "..", "..");
const COMPOSE_FILE = path.join(SUITE_DIR, "docker-compose.yml");
const RUNTIME_DIR = path.join(SUITE_DIR, ".runtime");
const PROJECT = "portico-integration";

const OWUI_URL = "http://127.0.0.1:28080";
const MOCK_URL = "http://127.0.0.1:29700";
const GATEWAY_URL = "http://127.0.0.1:24000";

const IMAGE_TAG = process.env.portico_INT_IMAGE_TAG || "repro-baseline";
const STRICT = process.env.portico_REPRO_STRICT === "1";
const PATCHES_SRC = process.env.portico_INT_PATCHES_SRC || "git:HEAD";
const KEEP_STACK = process.env.portico_INT_KEEP_STACK === "1";
const MODEL_PREFERENCE = ["Claude Opus 5", "Claude Sonnet 5", "Claude Sonnet 4.6", "Claude Haiku 4.5"];

function log(msg) {
  console.log(`[integration-chat] ${msg}`);
}

function parseArgs(argv) {
  const args = { report: path.join(SUITE_DIR, "artifacts", "latest") };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--report" && argv[i + 1]) {
      args.report = path.resolve(argv[++i]);
    }
  }
  return args;
}

function run(cmd, cmdArgs, { input, allowFailure = false, env } = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    input,
    encoding: "utf8",
    env: { ...process.env, ...(env || {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 && !allowFailure) {
    throw new Error(
      `${cmd} ${cmdArgs.join(" ")} failed (${res.status}):\n${res.stdout}\n${res.stderr}`
    );
  }
  return res;
}

function compose(args, opts = {}) {
  return run("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], {
    ...opts,
    env: { portico_INT_IMAGE_TAG: IMAGE_TAG, ...(opts.env || {}) },
  });
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

function assertImagesExist() {
  for (const image of [
    `portico-open-webui:${IMAGE_TAG}`,
    `portico-bifrost-bridge:${IMAGE_TAG}`,
  ]) {
    const res = run("docker", ["image", "inspect", image], { allowFailure: true });
    if (res.status !== 0) {
      throw new Error(
        `Required image ${image} not found locally. Set portico_INT_IMAGE_TAG or build/tag the baseline images.`
      );
    }
  }
  log(`images ok (tag: ${IMAGE_TAG})`);
}

function writeSecret(name, value) {
  const file = path.join(RUNTIME_DIR, "secrets", name);
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
}

function prepareRuntime() {
  fs.rmSync(path.join(RUNTIME_DIR, "patches"), { recursive: true, force: true });
  fs.mkdirSync(path.join(RUNTIME_DIR, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(RUNTIME_DIR, "patches"), { recursive: true });

  // Throwaway per-run secrets (never the developer's real secrets).
  const hex = (n) => crypto.randomBytes(n).toString("hex");
  writeSecret("webui_secret_key", hex(24));
  writeSecret("bifrost_bridge_local_api_key", `sk-portico-integration-${hex(16)}`);
  writeSecret("portico_llm_api_key", `test-portico-llm-key-${hex(8)}`);
  writeSecret("ultra_multi_agent_signing_secret", `ultra-sign-v1-${hex(32)}`);
  writeSecret("owui_auth_bridge_secret", hex(24));

  // Backend patch snapshot. The OWUI baseline image does NOT bake backend
  // patches — the patch entrypoint applies them at boot from /app/patches.
  // The live working tree is concurrently edited, so default to git HEAD.
  const patchesDir = path.join(RUNTIME_DIR, "patches");
  if (PATCHES_SRC === "git:HEAD") {
    const archive = spawnSync(
      "git",
      [
        "-C",
        REPO_ROOT,
        "archive",
        "HEAD",
        "src/patches/backend",
        "src/patches/patch-openwebui-entrypoint.sh",
        "model_catalog.yaml",
      ],
      { maxBuffer: 512 * 1024 * 1024 }
    );
    if (archive.status !== 0) {
      throw new Error(`git archive HEAD failed: ${archive.stderr}`);
    }
    const tar = spawnSync("tar", ["-x", "-C", patchesDir], {
      input: archive.stdout,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (tar.status !== 0) {
      throw new Error(`tar extract of git HEAD patch snapshot failed: ${tar.stderr}`);
    }
  } else if (PATCHES_SRC === "worktree") {
    fs.mkdirSync(path.join(patchesDir, "src", "patches"), { recursive: true });
    run("cp", ["-R", path.join(REPO_ROOT, "src", "patches", "backend"), path.join(patchesDir, "src", "patches", "backend")]);
    run("cp", [path.join(REPO_ROOT, "src", "patches", "patch-openwebui-entrypoint.sh"), path.join(patchesDir, "src", "patches", "patch-openwebui-entrypoint.sh")]);
    run("cp", [path.join(REPO_ROOT, "model_catalog.yaml"), path.join(patchesDir, "model_catalog.yaml")]);
  } else {
    run("cp", ["-R", `${PATCHES_SRC}/.`, patchesDir]);
  }

  fs.copyFileSync(
    path.join(patchesDir, "model_catalog.yaml"),
    path.join(RUNTIME_DIR, "model_catalog.yaml")
  );

  const middleware = path.join(
    patchesDir,
    "src",
    "patches",
    "backend",
    "open_webui",
    "utils",
    "middleware.py"
  );
  if (!fs.existsSync(middleware)) {
    throw new Error(`patch snapshot incomplete: ${middleware} missing`);
  }
  log(`runtime prepared (patches source: ${PATCHES_SRC})`);
}

// ---------------------------------------------------------------------------
// Stack lifecycle
// ---------------------------------------------------------------------------

async function waitForStack() {
  await waitFor(
    async () => {
      const res = await fetch(`${MOCK_URL}/healthz`).catch(() => null);
      return res && res.ok;
    },
    { timeoutMs: 60000, desc: "mock-bedrock /healthz" }
  );
  log("mock-bedrock up");

  await waitFor(
    async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/models`).catch(() => null);
      return res != null; // any HTTP response: port is listening
    },
    { timeoutMs: 90000, desc: "llm-gateway port" }
  );
  log("llm-gateway up");

  await waitFor(
    async () => {
      const res = await fetch(`${OWUI_URL}/api/config`).catch(() => null);
      return res && res.ok;
    },
    { timeoutMs: 300000, intervalMs: 2000, desc: "open-webui /api/config" }
  );
  log("open-webui up");
}

async function registerWebToolsServer(api) {
  // Register the mock OpenAPI tool server through the REAL admin config path
  // (POST /api/v1/configs/tool_servers). This both sets
  // TOOL_SERVER_CONNECTIONS (enrich_openapi_server_tools indexes into it —
  // a bare redis seed without a connection IndexErrors at prompt time) and
  // runs set_tool_servers(), which fetches /mocktools/openapi.json from the
  // mock and populates the redis `tool_servers` cache the prompt path reads.
  // The server id is EXACTLY "web-tools" so the C-I1 exemption defect
  // (middleware.py:5711-5725) is exercised.
  await api.request("POST", "/api/v1/configs/tool_servers", {
    body: {
      TOOL_SERVER_CONNECTIONS: [
        {
          url: "http://mock-bedrock:9700/mocktools",
          path: "openapi.json",
          type: "openapi",
          auth_type: "none",
          headers: null,
          key: "",
          config: { enable: true, access_control: null },
          info: {
            id: "web-tools",
            name: "Web Tools (mock)",
            description: "Integration mock web tools",
          },
        },
      ],
    },
  });

  const res = compose(["exec", "-T", "redis", "redis-cli", "GET", "tool_servers"], {
    allowFailure: true,
  });
  if (!res.stdout.includes('"web-tools"') || !res.stdout.includes("mock_bigfetch")) {
    throw new Error(
      `tool_servers cache did not materialize after admin registration: ${res.stdout.slice(0, 300)}`
    );
  }
  log("registered server:web-tools -> mock-bedrock/mocktools (admin config + cache verified)");
}

function saveStackLogs(reportDir) {
  try {
    const res = compose(["logs", "--no-color"], { allowFailure: true });
    fs.writeFileSync(path.join(reportDir, "stack.log"), res.stdout + "\n" + res.stderr);
  } catch (error) {
    log(`could not save stack logs: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const reportDir = args.report;
  fs.mkdirSync(reportDir, { recursive: true });

  log(`report dir: ${reportDir}`);
  log(`image tag: ${IMAGE_TAG}, strict: ${STRICT}, patches: ${PATCHES_SRC}`);

  assertImagesExist();
  prepareRuntime();

  const startedAt = new Date().toISOString();
  const outcomes = [];
  let fatalError = null;

  try {
    log("bringing up isolated stack (docker compose -p portico-integration)...");
    compose(["down", "-v", "--remove-orphans"], { allowFailure: true });
    compose(["up", "-d"]);
    await waitForStack();

    const api = new OwuiClient(OWUI_URL);
    await api.ensureAuth();
    log("authenticated (first-signup admin)");

    const models = await waitFor(
      async () => {
        const list = await api.getModels().catch(() => []);
        return Array.isArray(list) && list.length ? list : null;
      },
      { timeoutMs: 60000, intervalMs: 2000, desc: "OWUI model list from gateway" }
    );
    const modelId =
      MODEL_PREFERENCE.find((id) => models.some((m) => m.id === id)) ||
      models.find((m) => /claude/i.test(m.id))?.id;
    if (!modelId) {
      throw new Error(
        `No Claude/anthropic-route model found in catalog. Models: ${models.map((m) => m.id).join(", ")}`
      );
    }
    log(`model under test: ${modelId}`);

    await registerWebToolsServer(api);

    const mock = new MockBedrockClient(MOCK_URL);
    const ctx = { api, mock, modelId, log };

    for (const scenario of buildScenarios()) {
      log(`=== scenario ${scenario.name} (expected ${scenario.expected}) ===`);
      const outcome = await executeScenario(ctx, scenario);
      outcomes.push(outcome);

      // Full mock request log + payloads = the primary evidence artifact.
      try {
        const dump = await mock.requests(scenario.name);
        fs.writeFileSync(
          path.join(reportDir, `${scenario.name}-requests.json`),
          JSON.stringify(dump, null, 1)
        );
      } catch (error) {
        log(`  could not dump mock requests for ${scenario.name}: ${error}`);
      }
      fs.writeFileSync(
        path.join(reportDir, `${scenario.name}.json`),
        JSON.stringify(outcome, null, 1)
      );
      log(
        `  -> observed ${outcome.observed} (expected ${outcome.expected}) ${outcome.pass ? "MATCH" : "MISMATCH"}`
      );
      await sleep(500);
    }
  } catch (error) {
    fatalError = error;
    log(`FATAL: ${error?.stack || error}`);
  } finally {
    saveStackLogs(reportDir);
    if (KEEP_STACK) {
      log("portico_INT_KEEP_STACK=1 — leaving stack running (remember: docker compose -p portico-integration -f tests/integration-chat/docker-compose.yml down -v)");
    } else {
      compose(["down", "-v", "--remove-orphans"], { allowFailure: true });
      log("stack torn down (down -v)");
    }
  }

  const finishedAt = new Date().toISOString();
  const report = {
    suite: "tests/integration-chat",
    startedAt,
    finishedAt,
    imageTag: IMAGE_TAG,
    strict: STRICT,
    patchesSource: PATCHES_SRC,
    fatalError: fatalError ? String(fatalError) : null,
    scenarios: outcomes,
  };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 1));

  // Compact table
  const rows = outcomes.map((o) => ({
    scenario: o.scenario,
    expected: o.expected,
    observed: o.observed,
    match: o.pass ? "yes" : "NO",
    detail:
      o.invariants.find((i) => !i.ok)?.name ?? "all invariants ok",
  }));
  const widths = {
    scenario: Math.max(8, ...rows.map((r) => r.scenario.length)),
    expected: 8,
    observed: 8,
    match: 5,
  };
  const line = (r) =>
    `${r.scenario.padEnd(widths.scenario)}  ${r.expected.padEnd(8)}  ${r.observed.padEnd(8)}  ${r.match.padEnd(5)}  ${r.detail}`;
  console.log("\n" + line({ scenario: "SCENARIO", expected: "EXPECTED", observed: "OBSERVED", match: "MATCH", detail: "DETAIL" }));
  console.log("-".repeat(widths.scenario + 80));
  rows.forEach((r) => console.log(line(r)));
  console.log("");

  let ok;
  if (STRICT) {
    ok = !fatalError && outcomes.length > 0 && outcomes.every((o) => o.observed === "green");
    log(`strict mode: ${ok ? "ALL GREEN" : "red/error scenarios are hard failures"}`);
  } else {
    ok = !fatalError && outcomes.length > 0 && outcomes.every((o) => o.pass);
    log(`expectation mode: ${ok ? "all scenarios matched expectations" : "expectation mismatches present"}`);
  }
  log(`report: ${path.join(reportDir, "report.json")}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
