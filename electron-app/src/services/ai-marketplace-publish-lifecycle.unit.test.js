// Publish lifecycle: ownership-aware republish — behavioral edition.
// IPC/Communication + Chat UI + Agent Skills + State & Persistence layers.
//
// The client half (top of this file) always was behavioral and is unchanged:
// it drives ai-marketplace-client with a fake fetch. The lower half now
// drives the REAL renderer flows (vm-loaded agents.js / esbuild-bundled
// agent-skills.js / vm-loaded marketplaces.js), the REAL operations service
// (require.cache fakes, ai-marketplace-operations.unit.test.js pattern), and
// the REAL Express routes (stubbed express), instead of regexing source text.
//
// Deleted pin groups:
// - mcp-servers.js "no API key prompt" negatives: the user-facing guarantee
//   (end users never supply a marketplace key) is enforced by the bundled-key
//   client behavior ("client injects the bundled marketplace key ..." below);
//   integration publishing goes through the same client.
// - styles.css disabled-install-button rules: CSS presence is covered by live
//   visual QA; see `.agent-card-actions .btn-secondary:disabled`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const aiMarketplaceClient = require("./ai-marketplace-client");

const servicesDir = __dirname;
const componentsDir = path.join(servicesDir, "..", "renderer", "components");

function fakeResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

test("client surfaces a server-supplied not_owner code on 403", async () => {
  const fetchImpl = async () =>
    fakeResponse({ status: 403, body: { code: "not_owner" } });

  await assert.rejects(
    () =>
      aiMarketplaceClient.request("/api/solutions/abc", {
        apiKey: "test-key",
        fetchImpl,
      }),
    (error) => {
      assert.equal(error.code, "not_owner");
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("client still maps 401 to unauthorized and other errors to http_error", async () => {
  const unauthorized = async () =>
    fakeResponse({ status: 401, body: { error: "nope" } });
  await assert.rejects(
    () =>
      aiMarketplaceClient.request("/x", {
        apiKey: "test-key",
        fetchImpl: unauthorized,
      }),
    (error) => error.code === "unauthorized",
  );

  const serverError = async () =>
    fakeResponse({ status: 500, body: { error: "boom" } });
  await assert.rejects(
    () =>
      aiMarketplaceClient.request("/x", {
        apiKey: "test-key",
        fetchImpl: serverError,
      }),
    (error) => error.code === "http_error",
  );
});

async function captureHttpDiagLines(run) {
  const captured = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => captured.push(["log", args]);
  console.warn = (...args) => captured.push(["warn", args]);
  try {
    await run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return captured.filter(([, args]) =>
    String(args[0] || "").startsWith("[Marketplace][http]"),
  );
}

test("client emits exactly one [Marketplace][http] line per call with timing and no secrets", async () => {
  const lines = await captureHttpDiagLines(() =>
    aiMarketplaceClient.request("/api/solutions/search", {
      method: "POST",
      body: { query: "confidential-query-text" },
      apiKey: "test-key-material",
      fetchImpl: async () => fakeResponse({ status: 200, body: { ok: true } }),
    }),
  );

  assert.equal(lines.length, 1);
  const [channel, args] = lines[0];
  assert.equal(channel, "log");
  assert.equal(args[0], "[Marketplace][http] ok");
  const meta = JSON.parse(args[1]);
  assert.equal(meta.method, "POST");
  assert.equal(meta.path, "/api/solutions/search");
  assert.equal(meta.status, 200);
  assert.equal(meta.ok, true);
  assert.equal(typeof meta.durationMs, "number");
  const flat = args.join(" ");
  assert.ok(!flat.includes("test-key-material"), "no api key material in the line");
  assert.ok(!flat.includes("confidential-query-text"), "no body content in the line");
});

test("client diag covers failures: one warn line per attempt for HTTP errors and thrown fetches", async () => {
  const lines = await captureHttpDiagLines(async () => {
    // 500 is not a retryable status: exactly one attempt, one line.
    await assert.rejects(() =>
      aiMarketplaceClient.request("/x", {
        apiKey: "k",
        fetchImpl: async () => fakeResponse({ status: 500, body: { error: "boom" } }),
      }),
    );
    // Thrown fetches ARE retryable on GETs by default — opt out to pin the
    // single-attempt line shape (multi-attempt coverage lives in
    // ai-marketplace-client.unit.test.js).
    await assert.rejects(() =>
      aiMarketplaceClient.request("/y", {
        apiKey: "k",
        retryable: false,
        fetchImpl: async () => {
          throw new Error("socket down");
        },
      }),
    );
  });

  assert.equal(lines.length, 2);
  assert.ok(lines.every(([channel]) => channel === "warn"));
  const httpFailure = JSON.parse(lines[0][1][1]);
  assert.equal(lines[0][1][0], "[Marketplace][http] failed");
  assert.equal(httpFailure.status, 500);
  assert.equal(httpFailure.ok, false);
  assert.equal(httpFailure.errorCode, "http_error");
  assert.equal(httpFailure.attempt, 1);
  assert.equal(typeof httpFailure.durationMs, "number");
  const networkFailure = JSON.parse(lines[1][1][1]);
  assert.equal(networkFailure.status, null);
  assert.equal(networkFailure.errorCode, "network_error");
  assert.equal(networkFailure.attempt, 1);
  assert.equal(networkFailure.path, "/y");
});

test("client injects the bundled marketplace key when callers omit apiKey", async () => {
  let capturedHeaders = null;
  await aiMarketplaceClient.request("/api/solutions/search", {
    method: "POST",
    body: { query: "agent" },
    env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
    managedRoot: os.tmpdir(),
    projectRoot: os.tmpdir(),
    resourcesPath: "",
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers;
      return fakeResponse({ status: 200, body: { ok: true } });
    },
  });

  assert.equal(typeof capturedHeaders?.["X-API-Key"], "string");
  assert.notEqual(capturedHeaders?.["X-API-Key"], "");
});

test("client prefers an explicit marketplace key override over the bundled key", async () => {
  let capturedHeaders = null;
  await aiMarketplaceClient.request("/api/solutions/search", {
    apiKey: "developer-override-key",
    env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
    managedRoot: os.tmpdir(),
    projectRoot: os.tmpdir(),
    resourcesPath: "",
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers;
      return fakeResponse({ status: 200, body: { ok: true } });
    },
  });

  assert.equal(capturedHeaders?.["X-API-Key"], "developer-override-key");
});

test("client normalizes scalar marketplace type filters and preserves arrays", async () => {
  const capturedBodies = [];
  const options = {
    apiKey: "developer-override-key",
    fetchImpl: async (_url, init) => {
      capturedBodies.push(JSON.parse(init.body));
      return fakeResponse({ status: 200, body: { results: [] } });
    },
  };

  await aiMarketplaceClient.search(
    {
      query: "helper",
      filters: {
        type: "portico-agents",
        maturity: ["production"],
      },
      page: 2,
      pageSize: 50,
    },
    options,
  );
  await aiMarketplaceClient.search(
    {
      filters: {
        type: ["skills"],
        submitted_by: ["me@example.invalid"],
      },
    },
    options,
  );

  assert.deepEqual(capturedBodies[0], {
    query: "helper",
    filters: {
      type: ["portico-agents"],
      maturity: ["production"],
    },
    sort: "relevance",
    page: 2,
    pageSize: 50,
  });
  assert.deepEqual(capturedBodies[1].filters, {
    type: ["skills"],
    submitted_by: ["me@example.invalid"],
  });
});

test("client normalizes marketplace base URLs with trailing slashes", async () => {
  let capturedUrl = null;
  await aiMarketplaceClient.request("/api/solutions/search", {
    method: "POST",
    body: { query: "agent" },
    apiKey: "test-key",
    baseUrl: "https://solutionsapi.sandbox.example.invalid/",
    fetchImpl: async (url) => {
      capturedUrl = url;
      return fakeResponse({ status: 200, body: { ok: true } });
    },
  });

  assert.equal(
    capturedUrl,
    "https://solutionsapi.sandbox.example.invalid/api/solutions/search",
  );
  assert.equal(
    aiMarketplaceClient.getBaseUrl({
      AI_MARKETPLACE_BASE_URL: "https://solutionsapi.sandbox.example.invalid/",
    }),
    "https://solutionsapi.sandbox.example.invalid",
  );
});

test("client forwards normalized viewer identity on marketplace read requests", async () => {
  let capturedHeaders = null;
  await aiMarketplaceClient.request("/api/solutions/search", {
    method: "POST",
    body: { query: "agent" },
    apiKey: "test-key",
    viewerEmail: "JDoe@example.invalid",
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers;
      return fakeResponse({ status: 200, body: { ok: true } });
    },
  });

  assert.equal(capturedHeaders?.["x-remote-user"], "jdoe@example.invalid");
});

test("client omits viewer identity header when none is available", async () => {
  let capturedHeaders = null;
  await aiMarketplaceClient.request("/api/solutions/search", {
    method: "POST",
    body: { query: "agent" },
    apiKey: "test-key",
    viewerEmail: "   ",
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers;
      return fakeResponse({ status: 200, body: { ok: true } });
    },
  });

  assert.equal(Object.prototype.hasOwnProperty.call(capturedHeaders, "x-remote-user"), false);
});

test("client unpacks resolved marketplace bundles and JSON payloads", async () => {
  const bundle = await aiMarketplaceClient.getSolutionBundle("agent-solution", {
    apiKey: "test-key",
    fetchImpl: async () =>
      fakeResponse({
        status: 200,
        body: {
          bundle: {
            type: "portico-agents",
            payload: { skill_ids: [] },
          },
          resolved_bundle_cache: JSON.stringify({
            bundle: JSON.stringify({
              type: "portico-agents",
              payload: JSON.stringify({
                name: "Resolved Agent",
                skill_ids: ["n8nkit"],
                tool_server_ids: ["server:glean"],
              }),
            }),
          }),
        },
      }),
  });

  assert.equal(bundle.type, "portico-agents");
  assert.deepEqual(bundle.payload.skill_ids, ["n8nkit"]);
  assert.deepEqual(bundle.payload.tool_server_ids, ["server:glean"]);
});

test("client returns metadata-only tombstones for unavailable solutions", async () => {
  const sentinel = "UNPUBLISHED-CONTENT-MUST-NOT-LEAK";
  const envelope = {
    id: "deleted-solution",
    solution_id: "deleted-solution-alias",
    uuid: "deleted-solution-uuid",
    name: "Deleted agent",
    description: "Lifecycle metadata",
    author: "publisher",
    submitted_by: "publisher@example.invalid",
    submittedBy: "publisher-alias@example.invalid",
    owner: { identity: "publisher", secret: sentinel },
    type: "portico-agents",
    detail_url: "https://solutions.example.test/deleted-solution",
    created_at: "2026-07-21T00:00:00Z",
    updated_at: 1784700957,
    status: " DeLeTeD ",
    has_bundle: true,
    payload: { secret: sentinel },
    bundle: { type: "portico-agents", payload: { system_prompt: sentinel } },
    resolved_bundle_cache: { bundle: { payload: { system_prompt: sentinel } } },
    system_prompt: sentinel,
    base_model_id: sentinel,
    reasoning_effort: sentinel,
    allowed_emails: [sentinel],
    skill_md: sentinel,
    references: [{ path: sentinel, content_b64: sentinel }],
    scripts: [{ path: sentinel, content_b64: sentinel }],
    files: [{ path: sentinel, content_b64: sentinel }],
    source: { git_url: sentinel },
    skill_ids: [sentinel],
    skill_refs: [{ skill_id: sentinel, solution_id: sentinel }],
    tool_server_ids: [sentinel],
    tool_server_refs: [{ tool_server_id: sentinel, solution_id: sentinel }],
    profile_image_url: sentinel,
  };

  const solution = await aiMarketplaceClient.getSolution("deleted-solution", {
    apiKey: "test-key",
    fetchImpl: async () => fakeResponse({ status: 200, body: envelope }),
  });

  assert.deepEqual(Object.keys(solution).sort(), [
    "author",
    "created_at",
    "description",
    "detail_url",
    "has_bundle",
    "id",
    "name",
    "solution_id",
    "status",
    "submittedBy",
    "submitted_by",
    "type",
    "updated_at",
    "uuid",
  ]);
  assert.equal(solution.id, "deleted-solution");
  assert.equal(solution.submitted_by, "publisher@example.invalid");
  assert.equal(solution.submittedBy, "publisher-alias@example.invalid");
  assert.equal(solution.created_at, "2026-07-21T00:00:00Z");
  assert.equal(solution.updated_at, 1784700957);
  assert.equal(solution.status, "deleted");
  assert.equal(solution.has_bundle, false);
  assert.equal(Object.prototype.hasOwnProperty.call(solution, "owner"), false);
  assert.doesNotMatch(JSON.stringify(solution), new RegExp(sentinel));
});

test("client rejects every present non-active solution status before bundle access", async () => {
  const sentinel = "UNPUBLISHED-BUNDLE-MUST-NOT-LEAK";
  const unavailableStatuses = [
    "deleted",
    "pending",
    "suspended",
    "   ",
    null,
    7,
    false,
    ["active"],
    { value: "active", secret: sentinel },
  ];

  for (const statusValue of unavailableStatuses) {
    const urls = [];
    let caught = null;
    await assert.rejects(async () => {
      try {
        await aiMarketplaceClient.getSolutionBundle("unavailable-solution", {
          apiKey: "test-key",
          fetchImpl: async (url) => {
            urls.push(url);
            return fakeResponse({
              status: 200,
              body: {
                id: "unavailable-solution",
                status: statusValue,
                bundle: {
                  type: "portico-agents",
                  payload: { system_prompt: sentinel },
                },
              },
            });
          },
        });
      } catch (error) {
        caught = error;
        throw error;
      }
    });

    assert.equal(caught.message, "Solution not found");
    assert.equal(caught.code, "not_found");
    assert.equal(caught.status, 404);
    assert.equal(caught.body, undefined);
    assert.equal(urls.length, 1);
    assert.doesNotMatch(
      `${caught.message} ${JSON.stringify(caught)}`,
      new RegExp(sentinel),
    );
  }
});

test("client preserves active and status-absent solution envelopes", async () => {
  const fixtures = [
    {
      id: "active-solution",
      status: " ACTIVE ",
      name: "Active agent",
      bundle: { type: "portico-agents", payload: { system_prompt: "active" } },
    },
    {
      id: "legacy-solution",
      name: "Legacy agent",
      bundle: { type: "portico-agents", payload: { system_prompt: "legacy" } },
    },
  ];

  for (const envelope of fixtures) {
    const solution = await aiMarketplaceClient.getSolution(envelope.id, {
      apiKey: "test-key",
      fetchImpl: async () => fakeResponse({ status: 200, body: envelope }),
    });
    assert.deepEqual(solution, envelope);
  }
});

test("client bundle fallback preserves active and legacy compatibility", async () => {
  for (const envelope of [
    { id: "active-fallback", status: "active" },
    { id: "legacy-fallback" },
  ]) {
    const urls = [];
    const bundle = await aiMarketplaceClient.getSolutionBundle(envelope.id, {
      apiKey: "test-key",
      fetchImpl: async (url) => {
        urls.push(url);
        return urls.length === 1
          ? fakeResponse({ status: 200, body: envelope })
          : fakeResponse({
              status: 200,
              body: {
                type: "skills",
                payload: JSON.stringify({ name: envelope.id }),
              },
            });
      },
    });

    assert.equal(urls.length, 2);
    assert.match(urls[1], /\/api\/solutions\/[^/]+\/bundle$/);
    assert.equal(bundle.type, "skills");
    assert.equal(bundle.payload.name, envelope.id);
  }
});

test("client bundle fallback keeps the active no-bundle error contract", async () => {
  const urls = [];
  await assert.rejects(
    () =>
      aiMarketplaceClient.getSolutionBundle("active-without-bundle", {
        apiKey: "test-key",
        fetchImpl: async (url) => {
          urls.push(url);
          return urls.length === 1
            ? fakeResponse({
                status: 200,
                body: { id: "active-without-bundle", status: "active" },
              })
            : fakeResponse({ status: 404, body: { error: "missing" } });
        },
      }),
    (error) => {
      assert.equal(error.code, "no_bundle");
      assert.equal(error.status, 404);
      assert.match(error.message, /no installable bundle/i);
      return true;
    },
  );
  assert.equal(urls.length, 2);
});

test("client sends submitted_by in delete requests when provided", async () => {
  let capturedMethod = null;
  let capturedBody = null;
  await aiMarketplaceClient.deleteSolution("solution-123", {
    apiKey: "developer-override-key",
    submittedBy: "jdoe",
    fetchImpl: async (_url, init) => {
      capturedMethod = init.method;
      capturedBody = init.body;
      return fakeResponse({ status: 200, body: { ok: true } });
    },
  });

  assert.equal(capturedMethod, "DELETE");
  assert.equal(capturedBody, JSON.stringify({ submitted_by: "jdoe" }));
});

// ============================================================================
// Harness: ai-marketplace-operations with require.cache fakes
// (slim self-contained variant of loadOps in
// ai-marketplace-operations.unit.test.js — only the write-path surface).
// ============================================================================

function resolveDep(rel) {
  return require.resolve(rel, { paths: [servicesDir] });
}

function loadOps({
  viewerEmail = "me@example.invalid",
  authenticated = true,
  apiKey = "key-123",
  createSolutionImpl = null,
  updateSolutionImpl = null,
} = {}) {
  const calls = [];
  const fakes = {
    client: {
      async search(params, opts) {
        calls.push(["client.search", params, opts]);
        return { solutions: [] };
      },
      async getSolution(id, opts) {
        calls.push(["client.getSolution", id, opts]);
        return { id, type: "skills", name: `sol-${id}`, submitted_by: viewerEmail };
      },
      async getSolutionBundle(id) {
        calls.push(["client.getSolutionBundle", id]);
        return { type: "skills", payload: { name: id } };
      },
      async createSolution(solution, opts) {
        calls.push(["client.createSolution", solution, opts]);
        if (createSolutionImpl) return createSolutionImpl(solution, opts);
        // New-backend-faithful (MISC-34): create persists the bundle and the
        // response reports it via has_bundle.
        return { id: "sol-new", status: "active", has_bundle: Boolean(solution?.bundle) };
      },
      async updateSolution(id, patch, opts) {
        calls.push(["client.updateSolution", id, patch, opts]);
        if (updateSolutionImpl) return updateSolutionImpl(id, patch, opts);
        return { id, status: "active", has_bundle: true };
      },
      async deleteSolution(id, opts) {
        calls.push(["client.deleteSolution", id, opts]);
        return { id, status: "deleted" };
      },
    },
    install: {},
    links: {
      async setPublishedLink(localAgentId, solutionId, authorIdentity) {
        calls.push(["links.setPublishedLink", localAgentId, solutionId, authorIdentity]);
        return { localAgentId, solutionId, authorIdentity };
      },
      async clearPublishedLinksBySolutionId(solutionId) {
        calls.push(["links.clearPublishedLinksBySolutionId", solutionId]);
        return [];
      },
      async clearLink() {
        return true;
      },
      async readStateStrict() {
        calls.push(["links.readStateStrict"]);
        return { schemaVersion: 2, links: {} };
      },
    },
    skillLinks: {
      canonicalSkillName: (value) =>
        String(value || "").split("/").filter(Boolean).at(-1) || "",
      async readStateStrict() {
        return { links: {} };
      },
      async setLink(localSkillName, solutionId) {
        calls.push(["skillLinks.setLink", localSkillName, solutionId]);
        return { solutionId };
      },
      async clearLinksBySolutionId(solutionId) {
        calls.push(["skillLinks.clearLinksBySolutionId", solutionId]);
        return [];
      },
      async clearLink() {
        return true;
      },
    },
    marketplaceService: {},
    currentUser: {
      async get() {
        return {
          authenticated,
          sessionSummary: { user: { email: viewerEmail } },
        };
      },
    },
    dockerMcp: {
      async invokeMcpTool(server, tool, args) {
        calls.push(["mcp", tool, args]);
        return { success: true, data: {} };
      },
    },
    bootstrap: { PROJECT_ROOT: "/tmp/does-not-exist-project" },
    secrets: {
      DEFAULT_MANAGED_ROOT: "/tmp/managed",
      resolveAiMarketplaceApiKey: () => apiKey,
    },
  };

  const OPS_PATH = path.join(servicesDir, "ai-marketplace-operations.js");
  const origLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") {
      return { app: { getPath: () => "/tmp" }, BrowserWindow: {}, dialog: {} };
    }
    return origLoad.apply(this, arguments);
  };
  const cacheKeys = {
    client: resolveDep("./ai-marketplace-client"),
    install: resolveDep("./ai-marketplace-install"),
    links: resolveDep("./ai-marketplace-agent-links"),
    skillLinks: resolveDep("./ai-marketplace-skill-links"),
    marketplaceService: resolveDep("./marketplace-service"),
    currentUser: resolveDep("./current-user"),
    dockerMcp: resolveDep("./docker-mcp"),
    bootstrap: resolveDep("./bootstrap"),
    secrets: resolveDep("../config/runtime-secrets-config"),
  };
  const saved = {};
  for (const [key, keyPath] of Object.entries(cacheKeys)) {
    saved[keyPath] = require.cache[keyPath];
    require.cache[keyPath] = {
      id: keyPath,
      filename: keyPath,
      loaded: true,
      exports: fakes[key],
    };
  }
  delete require.cache[OPS_PATH];
  let ops;
  try {
    ops = require(OPS_PATH);
  } finally {
    Module._load = origLoad;
    for (const [keyPath, prev] of Object.entries(saved)) {
      if (prev) require.cache[keyPath] = prev;
      else delete require.cache[keyPath];
    }
    delete require.cache[OPS_PATH];
  }
  return { ops, calls };
}

// ============================================================================
// Operations writes: viewer identity, PUT-authoritative publish, non-active
// rejection. (These are the guarantees the old "ipc marketplace writes ..."
// source pins protected.)
// ============================================================================

test("ops: publish stamps submitted_by on the single create and never issues a follow-up PUT", async () => {
  const { ops, calls } = loadOps({ viewerEmail: "me@example.invalid" });

  const result = await ops.publishSolution(
    {
      name: "notes",
      type: "skills",
      bundle: { type: "skills", payload: { name: "notes" } },
    },
    { provenanceChecked: true, localSkillId: "notes" },
  );

  const createCall = calls.find((entry) => entry[0] === "client.createSolution");
  assert.equal(createCall[1].submitted_by, "me@example.invalid");
  assert.equal(createCall[1].author, "me");
  // The backend persists the bundle on POST (MISC-34) — a fresh publish is
  // create-only; PUT stays reserved for true updates.
  assert.equal(
    calls.filter((entry) => entry[0] === "client.updateSolution").length,
    0,
  );

  // The publish result is the create body/status.
  assert.equal(result.data.has_bundle, true);
  assert.deepEqual(result.publishStatus, {
    id: "sol-new",
    status: "active",
    has_bundle: true,
  });
});

test("ops: a bundle publish whose create reports has_bundle:false fails closed before linking", async () => {
  const { ops, calls } = loadOps({
    createSolutionImpl: () => ({ id: "sol-new", status: "active", has_bundle: false }),
  });

  await assert.rejects(
    ops.publishSolution(
      {
        name: "notes",
        type: "skills",
        bundle: { type: "skills", payload: { name: "notes" } },
      },
      { provenanceChecked: true, localSkillId: "notes" },
    ),
    (error) => {
      assert.equal(error.code, "marketplace_create_dropped_bundle");
      assert.equal(error.body?.publishStatus?.id, "sol-new");
      return true;
    },
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "client.updateSolution"),
    "the guard never falls back to the legacy PUT",
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "links.setPublishedLink"),
    "no link is written for a bundle the marketplace dropped",
  );
});

test("ops: create responses without has_bundle pass the guard (fixture/legacy shape)", async () => {
  const { ops } = loadOps({
    createSolutionImpl: () => ({ id: "sol-new", status: "active" }),
  });

  const result = await ops.publishSolution(
    {
      name: "notes",
      type: "skills",
      bundle: { type: "skills", payload: { name: "notes" } },
    },
    { provenanceChecked: true, localSkillId: "notes" },
  );
  assert.equal(result.publishStatus.id, "sol-new");
  assert.equal(result.publishStatus.has_bundle, null);
});

test("ops: a bundle-less publish ignores has_bundle:false (guard scoped to bundle publishes)", async () => {
  const { ops } = loadOps({
    createSolutionImpl: () => ({ id: "sol-new", status: "active", has_bundle: false }),
  });

  const result = await ops.publishSolution(
    { name: "notes", type: "skills" },
    { provenanceChecked: true, localSkillId: "notes" },
  );
  assert.equal(result.publishStatus.id, "sol-new");
});

test("ops: a missing authenticated identity fails the write closed with missing_user_identity", async () => {
  const { ops, calls } = loadOps({ authenticated: false });

  await assert.rejects(
    ops.publishSolution(
      { name: "notes", type: "skills", bundle: { type: "skills", payload: {} } },
      { provenanceChecked: true },
    ),
    (error) => {
      assert.equal(error.code, "missing_user_identity");
      return true;
    },
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "client.createSolution"),
    "no marketplace write happens without an identity",
  );
});

test("ops: non-active marketplace write statuses are rejected", async () => {
  const { ops } = loadOps({
    createSolutionImpl: () => ({ id: "sol-new", status: "pending" }),
  });

  await assert.rejects(
    ops.publishSolution(
      { name: "notes", type: "skills", bundle: { type: "skills", payload: {} } },
      { provenanceChecked: true },
    ),
    (error) => {
      assert.equal(error.code, "marketplace_write_not_active");
      return true;
    },
  );

  const { ops: ops2 } = loadOps();
  assert.throws(
    () => ops2.assertMarketplaceWriteAccepted({ id: "x", status: "pending" }, "x"),
    (error) => error.code === "marketplace_write_not_active",
  );
  assert.equal(
    ops2.assertMarketplaceWriteAccepted({ id: "x", status: "active" }).status,
    "active",
  );
});

test("ops: publishing a linked agent records the published link with the author identity", async () => {
  const { ops, calls } = loadOps();

  await ops.publishSolution(
    {
      name: "Agent One",
      type: "portico-agents",
      bundle: { type: "portico-agents", payload: { name: "Agent One" } },
    },
    { provenanceChecked: true, localAgentId: "agent-1" },
  );

  const linkCall = calls.find((entry) => entry[0] === "links.setPublishedLink");
  assert.deepEqual(linkCall, [
    "links.setPublishedLink",
    "agent-1",
    "sol-new",
    "me@example.invalid",
  ]);
});

test("ops: delete carries the viewer identity to the marketplace and clears both link registries", async () => {
  const { ops, calls } = loadOps();

  await ops.deletePublishedSolution("sol-1", { ownershipChecked: true });

  const deleteCall = calls.find((entry) => entry[0] === "client.deleteSolution");
  assert.equal(deleteCall[1], "sol-1");
  assert.equal(deleteCall[2].submittedBy, "me@example.invalid");
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "links.clearPublishedLinksBySolutionId" && entry[1] === "sol-1",
    ),
    "agent published links are cleared",
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "skillLinks.clearLinksBySolutionId" && entry[1] === "sol-1",
    ),
    "skill links are cleared too (no stranded Published badge)",
  );
});

// ============================================================================
// Harness: FakeElement DOM + vm-loaded agents.js (self-contained per repo
// convention; same shape as marketplace-requirements-audit.unit.test.js).
// ============================================================================

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }
  add(...names) {
    names.filter(Boolean).forEach((name) => this.classes.add(name));
  }
  remove(...names) {
    names.filter(Boolean).forEach((name) => this.classes.delete(name));
  }
  contains(name) {
    return this.classes.has(name);
  }
  toggle(name, force) {
    const target = force ?? !this.classes.has(name);
    if (target) this.classes.add(name);
    else this.classes.delete(name);
    return target;
  }
}

class FakeElement {
  constructor(id = "", doc = null) {
    this.id = id;
    this.ownerDocument = doc;
    this.style = { display: "none" };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.innerHTML = "";
    this._textContent = "";
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.children = [];
    this.selectorChildren = new Map();
    this.selectorLists = new Map();
    this.isConnected = false;
    this.scrollTop = 0;
    this.title = "";
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener() {}
  dispatchEvent(eventOrType, extra = {}) {
    const type =
      typeof eventOrType === "string" ? eventOrType : eventOrType?.type;
    const eventProps = typeof eventOrType === "object" ? eventOrType : extra;
    for (const handler of this.listeners.get(type) || []) {
      handler({
        preventDefault() {},
        stopPropagation() {},
        target: this,
        currentTarget: this,
        ...eventProps,
      });
    }
    return true;
  }
  click() {
    this.dispatchEvent("click");
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  // DOM-parity: assigning textContent renders escaped text into innerHTML
  // (agent-skills' escapeHtml round-trips a detached div through textContent).
  get textContent() {
    return this._textContent || "";
  }
  set textContent(value) {
    this._textContent = String(value ?? "");
    this.innerHTML = this._textContent
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  querySelector(selector) {
    if (!this.selectorChildren.has(selector)) {
      const child = new FakeElement("", this.ownerDocument);
      child.parentElement = this;
      this.selectorChildren.set(selector, child);
    }
    return this.selectorChildren.get(selector);
  }
  querySelectorAll(selector) {
    return this.selectorLists.get(selector) || [];
  }
  registerQueryList(selector, elements) {
    this.selectorLists.set(selector, elements);
  }
  appendChild(child) {
    this.children.push(child);
    if (child && typeof child === "object") {
      child.parentElement = this;
      if (child.id && this.ownerDocument) {
        this.ownerDocument._registry.set(child.id, child);
      }
    }
    return child;
  }
  remove() {
    if (this.id && this.ownerDocument) {
      this.ownerDocument._registry.delete(this.id);
    }
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
    }
  }
  insertAdjacentHTML() {}
  closest() {
    return null;
  }
  contains() {
    return false;
  }
  focus() {}
  select() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

function createFakeDocument() {
  const registry = new Map();
  const queryLists = new Map();
  const doc = {
    readyState: "complete",
    _registry: registry,
    createElement(tag) {
      return new FakeElement(String(tag || ""), doc);
    },
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, new FakeElement(id, doc));
      return registry.get(id);
    },
    querySelector: () => null,
    querySelectorAll: (selector) => queryLists.get(selector) || [],
    registerQueryList: (selector, elements) => {
      queryLists.set(selector, elements);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.body = new FakeElement("body", doc);
  doc.documentElement = new FakeElement("html", doc);
  return doc;
}

// `prepareDocument` runs before the component loads — the place to register
// document-level query lists that init()-time wiring reads (mode tabs).
function loadAgentsModuleHarness({ prepareDocument = null } = {}) {
  const source = fs.readFileSync(path.join(componentsDir, "agents.js"), "utf8");
  const extraSources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
  ].map((name) => ({
    path: path.join(componentsDir, name),
    source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
  }));

  const document = createFakeDocument();
  if (prepareDocument) prepareDocument(document);
  const localStorageWrites = [];
  const localStorageStore = new Map();
  const windowObject = {
    appState: {
      controlPlaneView: "agents-tab",
      servers: [],
      toggles: {},
      healthStatus: { servers: {} },
    },
    innerWidth: 1440,
    innerHeight: 900,
    confirm: () => false,
    localStorage: {
      getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key) : null),
      setItem: (key, value) => {
        localStorageWrites.push([key, String(value)]);
        localStorageStore.set(key, String(value));
      },
      removeItem: (key) => localStorageStore.delete(key),
    },
    electronAPI: {
      invokeMcpTool: async () => ({ success: true, data: { agents: [] } }),
      getSkills: async () => ({ success: true, skills: [] }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: {} }),
      },
    },
    showNotification() {},
  };

  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    JSON,
    HTMLElement: FakeElement,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    Event: class Event {
      constructor(type, options = {}) {
        this.type = type;
        this.bubbles = Boolean(options.bubbles);
      }
    },
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb) => {
      cb();
      return 0;
    },
    encodeURIComponent,
    URL,
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, {
    filename: path.join(componentsDir, "agents.js"),
  });

  return { window: windowObject, document, localStorageWrites };
}

// Recording electronAPI fixture (identical surface to the audit-file copy).
function installMarketplaceFixture(windowObject, {
  agents = [],
  baseModels = [],
  systemPromptById = {},
  skills = [],
  links = {},
  skillLinks = {},
  installedSources = {},
  searchResults = [],
  bundlesBySolutionId = {},
  solutionsById = {},
  hasApiKey = true,
  currentUserEmail = "dsantiago@example.invalid",
  publishImpl = null,
  updateImpl = null,
  installImpl = null,
  deleteImpl = null,
  getSolutionImpl = null,
  deleteAgentImpl = null,
} = {}) {
  const calls = [];
  const notifications = [];
  const logToMainEvents = [];
  const agentsById = Object.fromEntries(
    agents.filter(Boolean).map((agent) => [agent.id, agent]),
  );

  const api = {
    hasApiKey: async () => {
      calls.push(["hasApiKey"]);
      return { hasKey: hasApiKey };
    },
    listLinks: async () => {
      calls.push(["listLinks"]);
      return { success: true, links };
    },
    getSolution: async (solutionId) => {
      calls.push(["getSolution", solutionId]);
      if (getSolutionImpl) return getSolutionImpl(solutionId);
      const solution = solutionsById[solutionId];
      // Default ACTIVE: clean-link liveness probes at publish time must see
      // a live listing unless a test opts into a tombstone via
      // solutionsById/getSolutionImpl.
      return solution
        ? { success: true, data: solution }
        : { success: true, data: { id: solutionId, status: "active" } };
    },
    getBundle: async (solutionId) => {
      calls.push(["getBundle", solutionId]);
      return (
        bundlesBySolutionId[solutionId] || { success: false, error: "no bundle" }
      );
    },
    search: async (params) => {
      calls.push(["search", params]);
      return { success: true, data: { results: searchResults } };
    },
    buildPublishBundle: async (input) => {
      if (input?.type === "skills") {
        calls.push(["buildPublishBundle", input?.skill?.name, input]);
        return {
          success: true,
          data: {
            type: "skills",
            payload: { name: input?.skill?.name, description: "d" },
          },
        };
      }
      calls.push(["buildAgentBundle", input?.agent]);
      return {
        success: true,
        data: {
          type: input?.type,
          payload: { name: input?.agent?.name, description: "agent bundle" },
        },
      };
    },
    publish: async (input, opts) => {
      calls.push(["publish", input, opts]);
      if (publishImpl) return publishImpl(input, opts);
      return {
        success: true,
        data: { id: `new-${input?.name}` },
        publishStatus: { id: `new-${input?.name}`, status: "active" },
      };
    },
    update: async (solutionId, input, opts) => {
      calls.push(["update", solutionId, input, opts]);
      if (updateImpl) return updateImpl(solutionId, input, opts);
      return {
        success: true,
        data: { id: solutionId },
        publishStatus: { id: solutionId, status: "active" },
      };
    },
    delete: async (solutionId) => {
      calls.push(["delete", solutionId]);
      if (deleteImpl) return deleteImpl(solutionId);
      return { success: true, data: { id: solutionId, status: "deleted" } };
    },
    install: async (solutionId, options) => {
      calls.push(["install", solutionId, options]);
      if (installImpl) return installImpl(solutionId, options);
      return { success: true, data: { type: "" } };
    },
    getSkillLink: async (name) => {
      calls.push(["getSkillLink", name]);
      return { success: true, link: skillLinks[name] || null };
    },
    setSkillLink: async (name, solutionId) => {
      calls.push(["setSkillLink", name, solutionId]);
      return { success: true };
    },
    clearSkillLink: async (name) => {
      calls.push(["clearSkillLink", name]);
      return { success: true };
    },
    getInstalledSkillSource: async (name) => {
      calls.push(["getInstalledSkillSource", name]);
      return { success: true, source: installedSources[name] || null };
    },
    clearLink: async (agentId) => {
      calls.push(["clearLink", agentId]);
      return { success: true };
    },
    // Soft-miss prune seam: the fixture emulates the store's CONFIRMED
    // verdict (absent -> deleted in one pass) so renderer tests can observe
    // the cleanup contract; real flag/confirm/heal timing is covered by
    // ai-marketplace-agent-links.unit.test.js and agents-link-prune.unit.test.js.
    reportLinkSightings: async (sightings) => {
      const absent = Array.isArray(sightings?.absentIds)
        ? [...sightings.absentIds]
        : [];
      calls.push(["reportLinkSightings", absent]);
      for (const agentId of absent) delete links[agentId];
      return { success: true, healed: [], flagged: [], deleted: absent };
    },
    markLinkDirty: async (agentId) => {
      calls.push(["markLinkDirty", agentId]);
      return { success: true };
    },
    repairLinkedAgentAccess: async (options) => {
      calls.push(["repairLinkedAgentAccess", options?.reason || ""]);
      return {
        success: true,
        result: { checked: 0, repaired: 0, repairedAgentIds: [] },
      };
    },
    listPublished: async (type) => {
      calls.push(["listPublished", type]);
      return { success: true, data: { solutions: [] } };
    },
    listSkillLinks: async () => {
      calls.push(["listSkillLinks"]);
      return { success: true, links: skillLinks };
    },
  };

  windowObject.electronAPI = {
    invokeMcpTool: async (serverId, tool, input) => {
      calls.push(["invokeMcpTool", serverId, tool, input]);
      if (tool === "subagents_list_agents") {
        return {
          success: true,
          data: {
            agents: input?.filter_type === "base" ? baseModels : agents,
          },
        };
      }
      if (tool === "subagents_get_agent") {
        return { success: true, data: agentsById[input?.model_id] || null };
      }
      if (tool === "subagents_get_agent_system_prompt") {
        return {
          success: true,
          data: {
            system_prompt:
              systemPromptById[input?.model_id] ?? "You are helpful.",
          },
        };
      }
      if (tool === "subagents_delete_agent") {
        if (deleteAgentImpl) return deleteAgentImpl(input);
        return { success: true, data: { success: true } };
      }
      return { success: true, data: {} };
    },
    getSkills: async () => {
      calls.push(["getSkills"]);
      return { success: true, skills };
    },
    loadMcpServers: async () => ({ success: true, data: [] }),
    getUsername: async () => ({ username: "dsantiago" }),
    currentUser: {
      get: async () => ({
        authenticated: true,
        sessionSummary: { user: { email: currentUserEmail } },
      }),
    },
    logToMain: (payload) => {
      logToMainEvents.push(payload);
    },
    openExternal: () => {},
    aiMarketplace: api,
  };
  windowObject.showNotification = (message, kind = "info") => {
    notifications.push([kind, message]);
  };
  return { api, calls, notifications, logToMainEvents };
}

const localAgent = (id, extra = {}) => ({
  id,
  name: extra.name || id,
  description: extra.description || `${id} description`,
  base_model_id: "atlas-sonnet-5",
  system_prompt: `You are ${id}.`,
  skill_ids: [],
  tool_server_ids: [],
  creation_source: "local",
  created_by_email: "dsantiago@example.invalid",
  ...extra,
});

const userSkill = (name) => ({
  name,
  source: "user",
  skill_path: `/tmp/skills-user/${name}`,
  description: `${name} description`,
});

async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ============================================================================
// Renderer publish lifecycle (agents.js). The dependent-skill lifecycle and
// modal ownership labels live in marketplace-requirements-audit.unit.test.js
// (requirements 4 and 5); here we cover the create branch, fail-closed
// updates, delete-with-foreign-listing, tombstone hydration, and Discover.
// ============================================================================

test("renderer: a first publish creates the solution, links it, and surfaces the marketplace status", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const { calls, notifications } = installMarketplaceFixture(window, {
    agents: [localAgent("agent-2", { name: "Agent Two" })],
  });

  await window.AgentsTabModule.publishAgent("agent-2");
  const overlay = document.getElementById("agents-modal-overlay");
  assert.ok(overlay, "publish confirmation modal opened");
  assert.match(
    overlay.innerHTML,
    /class="btn-primary agents-modal-submit"[^>]*>Publish</,
  );
  assert.match(overlay.innerHTML, /<strong>Visibility:<\/strong> Public/);

  overlay.querySelector(".agents-modal-submit").click();
  await settle();

  const publishCall = calls.find((entry) => entry[0] === "publish");
  assert.ok(publishCall, "the unlinked path creates a new solution");
  assert.equal(publishCall[1].submitted_by, "dsantiago");
  assert.deepEqual(JSON.parse(JSON.stringify(publishCall[2])), {
    localAgentId: "agent-2",
  });
  assert.ok(
    !calls.some((entry) => entry[0] === "update"),
    "a fresh publish never updates a foreign solution",
  );
  const success = notifications.find(([kind]) => kind === "success");
  assert.match(success[1], /Agent published to marketplace \(solution new-Agent Two\)/);
  assert.match(success[1], /Marketplace status: active/);
});

test("renderer: a rejected republish fails closed — error surfaced, no fork, no link rewrite", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {
    updateImpl: () => ({
      success: false,
      error: "solution belongs to someone else",
      code: "not_owner",
      status: 403,
    }),
  });

  await assert.rejects(
    window.AgentsPublishHooks.pushAgentToMarketplace({
      localId: "agent-1",
      solutionId: "sol-foreign",
      args: {
        name: "Agent One",
        description: "",
        base_model_id: "model-a",
        system_prompt: "prompt",
        skill_ids: [],
        tool_server_ids: [],
        reasoning_effort: null,
      },
    }),
    (error) => {
      assert.match(error.message, /solution belongs to someone else/);
      assert.match(error.message, /code=not_owner/);
      assert.match(error.message, /status=403/);
      return true;
    },
  );
  assert.ok(!calls.some((entry) => entry[0] === "publish"), "no fork");

  // Non-ownership failures fail closed the same way.
  const second = loadAgentsModuleHarness();
  const secondFixture = installMarketplaceFixture(second.window, {
    updateImpl: () => ({ success: false, error: "bundle rejected", status: 500 }),
  });
  await assert.rejects(
    second.window.AgentsPublishHooks.pushAgentToMarketplace({
      localId: "agent-1",
      solutionId: "sol-1",
      args: {
        name: "Agent One",
        description: "",
        base_model_id: "model-a",
        system_prompt: "prompt",
        skill_ids: [],
        tool_server_ids: [],
        reasoning_effort: null,
      },
    }),
    /bundle rejected/,
  );
  assert.ok(!secondFixture.calls.some((entry) => entry[0] === "publish"));
});

test("renderer: publish result composes marketplace status and dependent-skill summary for the toast", async () => {
  const { window } = loadAgentsModuleHarness();
  installMarketplaceFixture(window, {
    skills: [userSkill("alpha"), userSkill("beta")],
    // Dirty link: a clean one is referenced without any upload now.
    skillLinks: { beta: { solutionId: "sol-b", hasLocalChanges: true } },
  });

  const published = await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Agent One",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      skill_ids: ["alpha", "beta"],
      tool_server_ids: [],
      reasoning_effort: null,
    },
  });

  assert.equal(published.solutionId, "new-Agent One");
  assert.equal(published.publishStatus.status, "active");
  assert.deepEqual(JSON.parse(JSON.stringify(published.skillPublishSummary)), {
    published: 1,
    updated: 1,
    adopted: 0,
    referenced: 0,
    unchanged: 0,
    gitReferenced: 0,
    repaired: 0,
    visibilityUpdated: 0,
  });
});

test("renderer: deleting an installed agent keeps the listing, deletes locally, and clears the link", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls, notifications } = installMarketplaceFixture(window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
    links: { "agent-1": { solutionId: "sol-1", relationship: "installed" } },
    solutionsById: {
      "sol-1": {
        id: "sol-1",
        status: "active",
        submitted_by: "someoneelse@example.invalid",
      },
    },
  });

  await window.AgentsPublishHooks.confirmedDeleteAgent("agent-1", {});

  assert.ok(
    !calls.some((entry) => entry[0] === "delete"),
    "no marketplace delete is attempted for an installed copy",
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "invokeMcpTool" &&
        entry[2] === "subagents_delete_agent" &&
        entry[3]?.model_id === "agent-1",
    ),
    "the local agent is deleted through the Subagents MCP",
  );
  assert.ok(
    calls.some((entry) => entry[0] === "clearLink" && entry[1] === "agent-1"),
    "the stale local link is cleared",
  );
  // The listing surviving is the EXPECTED outcome for an installed copy — a
  // plain success, never a warning.
  assert.ok(!notifications.some(([kind]) => kind === "warning"));
  assert.deepEqual(notifications.at(-1), ["success", "Agent deleted."]);
});

test("renderer: a 403/not_owner marketplace delete downgrades to local-only instead of blocking", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls, notifications } = installMarketplaceFixture(window, {
    agents: [localAgent("agent-1")],
    deleteImpl: () => ({
      success: false,
      error: "not yours",
      code: "not_owner",
      status: 403,
    }),
  });

  await window.AgentsPublishHooks.performDeleteAgent("agent-1", {
    link: { solutionId: "sol-1" },
    alsoRemoveFromMarketplace: true,
  });

  assert.ok(calls.some((entry) => entry[0] === "delete" && entry[1] === "sol-1"));
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "invokeMcpTool" && entry[2] === "subagents_delete_agent",
    ),
    "the local delete continues past the ownership rejection",
  );
  assert.ok(calls.some((entry) => entry[0] === "clearLink" && entry[1] === "agent-1"));
  // The one genuinely surprising outcome keeps its warning: the user asked
  // for the listing to go and the marketplace refused.
  const warning = notifications.find(([kind]) => kind === "warning");
  assert.match(warning[1], /left in place \(someone else owns it\)/);
});

test("renderer: marketplace metadata without allowed_emails stays non-authoritative (no forced-public ACL)", async () => {
  // Tombstones/metadata-only reads omit allowed_emails entirely. The publish
  // modal must fall back to the local record and must NOT cache a public ACL.
  const bare = loadAgentsModuleHarness();
  installMarketplaceFixture(bare.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
    links: { "agent-1": { solutionId: "sol-1" } },
    solutionsById: {
      "sol-1": {
        id: "sol-1",
        status: "active",
        submitted_by: "dsantiago@example.invalid",
        // no allowed_emails key
      },
    },
  });
  await bare.window.AgentsTabModule.publishAgent("agent-1");
  assert.match(
    bare.document.getElementById("agents-modal-overlay").innerHTML,
    /<strong>Visibility:<\/strong> Public/,
  );
  assert.equal(
    bare.localStorageWrites.length,
    0,
    "a metadata response without allowed_emails must not seed the ACL cache",
  );

  // When the marketplace DOES report allowed_emails, they hydrate and cache.
  const hydrated = loadAgentsModuleHarness();
  installMarketplaceFixture(hydrated.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
    links: { "agent-1": { solutionId: "sol-1" } },
    solutionsById: {
      "sol-1": {
        id: "sol-1",
        status: "active",
        submitted_by: "dsantiago@example.invalid",
        allowed_emails: ["Viewer@example.invalid"],
      },
    },
  });
  await hydrated.window.AgentsTabModule.publishAgent("agent-1");
  assert.match(
    hydrated.document.getElementById("agents-modal-overlay").innerHTML,
    /<strong>Visibility:<\/strong> Restricted to viewer@example\.invalid/,
  );
  assert.ok(hydrated.localStorageWrites.length > 0, "reported ACLs are cached");
});

// ---- Discover: lenient install gating, authoritative no-bundle, cards ------

function discoverHarness({ searchResults, agents = [], links = {}, solutionsById = {}, bundlesBySolutionId = {}, installImpl = null }) {
  let discoverTab;
  const harness = loadAgentsModuleHarness({
    prepareDocument: (document) => {
      discoverTab = new FakeElement("", document);
      discoverTab.dataset.agentsMode = "discover";
      document.registerQueryList("#agents-tab-mode-tabs .mcp-filter-tab", [
        discoverTab,
      ]);
    },
  });
  const fixture = installMarketplaceFixture(harness.window, {
    searchResults,
    agents,
    links,
    solutionsById,
    bundlesBySolutionId,
    installImpl,
  });
  return { ...harness, ...fixture, discoverTab };
}

test("renderer: Discover search filters to title and author-ldap matches", async () => {
  const { window, document, discoverTab } = discoverHarness({
    searchResults: [
      // Server-side relevance ranking returns loose matches; the renderer
      // narrows to name/author hits so a query like an ldap works as users
      // expect.
      {
        id: "sol-mine",
        name: "dsantiago-Agent-AI4I-Skills",
        author: "publisher",
        type: "portico-agents",
      },
      {
        id: "sol-owned",
        name: "zzz-helper",
        author: "dsantiago",
        type: "portico-agents",
      },
      {
        id: "sol-waldo",
        name: "Waldo FP Agent",
        author: "smurakami",
        submitted_by: "smurakami@example.invalid",
        type: "portico-agents",
      },
    ],
  });

  window.AgentsTabModule.handleSearchInput("dsantiago");
  discoverTab.click();
  await settle();

  const list = document.getElementById("agents-tab-list");
  assert.match(list.innerHTML, /sol-mine/, "title matches stay");
  assert.match(list.innerHTML, /sol-owned/, "author-ldap matches stay");
  assert.doesNotMatch(
    list.innerHTML,
    /sol-waldo/,
    "listings matching neither title nor author are filtered out",
  );

  // Clearing the query restores the full ranked browse.
  window.AgentsTabModule.handleSearchInput("");
  await window.AgentsTabModule.runDiscoverSearch();
  await settle();
  assert.match(list.innerHTML, /sol-waldo/);
});

test("renderer: Discover gates Install leniently and marks installed solutions", async () => {
  const { document, discoverTab } = discoverHarness({
    searchResults: [
      // Unknown has_bundle (typical trimmed search row) → installable.
      { id: "sol-unknown", name: "Unknown Bundle", type: "portico-agents" },
      // Explicit has_bundle:false → disabled with an explanation.
      {
        id: "sol-none",
        name: "No Bundle",
        type: "portico-agents",
        has_bundle: false,
      },
      // Already installed locally → disabled "Installed".
      {
        id: "sol-installed",
        name: "Installed One",
        type: "portico-agents",
      },
    ],
    // The link's local agent must exist or the discover refresh prunes it
    // (that pruning behavior is asserted separately below).
    agents: [localAgent("local-agent")],
    links: { "local-agent": { solutionId: "sol-installed" } },
  });

  discoverTab.click();
  await settle();

  const list = document.getElementById("agents-tab-list");
  const cardFor = (id) =>
    list.innerHTML
      .split('<div class="mcp-server-card agent-card"')
      .find((chunk) => chunk.includes(`data-solution-id="${id}"`));

  const unknownCard = cardFor("sol-unknown");
  assert.match(
    unknownCard,
    /agent-install-btn" data-solution-id="sol-unknown"\s+>Install Agent</,
    "unknown has_bundle stays installable",
  );

  const noneCard = cardFor("sol-none");
  assert.match(noneCard, /disabled/);
  assert.match(noneCard, /title="No bundle attached"/);

  const installedCard = cardFor("sol-installed");
  assert.match(installedCard, /class="mcp-card-badge badge-installed"[^>]*>Installed</);
  assert.match(installedCard, /Already installed as local-agent/);
  assert.match(installedCard, /agent-install-btn" data-solution-id="sol-installed" disabled/);

  // The retired Status/Maturity/Quality meta rows stay retired.
  assert.doesNotMatch(list.innerHTML, /<strong>Status:<\/strong> Installed as/);
  assert.doesNotMatch(list.innerHTML, /Maturity/);
  assert.doesNotMatch(list.innerHTML, /Quality/);
});

test("renderer: a server-confirmed no_bundle degrades the Discover card and install button", async () => {
  const { window, document, discoverTab, notifications } = discoverHarness({
    searchResults: [
      { id: "sol-liar", name: "Claims Bundle", type: "portico-agents" },
    ],
    installImpl: async () => ({
      success: false,
      error: "no bundle",
      code: "no_bundle",
      status: 404,
    }),
  });

  discoverTab.click();
  await settle();

  const triggerBtn = new FakeElement("", document);
  const installed = await window.AgentsPublishHooks.installSolution(
    "sol-liar",
    triggerBtn,
  );

  assert.equal(installed, false, "the install reports failure");
  // The clicked button keeps the durable no-bundle explanation (its disabled
  // state is owned by the re-render below once the row is flagged).
  assert.equal(triggerBtn.title, "No bundle attached");
  const failure = notifications.find(([kind]) => kind === "error");
  assert.match(
    failure[1],
    /This marketplace entry is not installable because it has no bundle attached\./,
  );
  // The card re-renders degraded (mode is discover, so the flag re-renders).
  const list = document.getElementById("agents-tab-list");
  assert.match(list.innerHTML, /data-solution-id="sol-liar" disabled/);
});

test("renderer: the Discover agent page resolves the bundle payload and installs from its footer", async () => {
  const bundle = {
    type: "portico-agents",
    payload: {
      agent: {
        name: "Bundle Agent",
        base_model_id: "atlas-sonnet-5",
        system_prompt: "prompt",
        skill_ids: ["skills-user/notes", "notes"],
        tool_server_ids: ["glean"],
      },
    },
  };
  const { window, document, calls } = discoverHarness({
    searchResults: [
      { id: "sol-page", name: "Bundle Agent", type: "portico-agents" },
    ],
    solutionsById: {
      "sol-page": { id: "sol-page", status: "active", author: "publisher" },
    },
    bundlesBySolutionId: {
      "sol-page": { success: true, data: bundle },
    },
    installImpl: async () => ({
      success: true,
      data: { type: "portico-agents", mutation: "created" },
    }),
  });

  await window.AgentsPublishHooks.openDiscoverAgentPage("sol-page");
  await settle();

  const editor = document.getElementById("agents-tab-editor");
  const content = editor.querySelector("[data-agent-editor-content]").innerHTML;
  // The solution id renders as the grey copyable badge with a copy button.
  assert.match(content, /agents-id-badge[^>]*>sol-page</);
  assert.match(content, /agents-copy-btn" data-copy-value="sol-page"/);
  // Retired meta rows stay retired on the detail page too.
  assert.doesNotMatch(content, /Maturity/);
  assert.doesNotMatch(content, /Quality/);
  assert.match(content, /publisher/);
  // The nested agent payload renders through the installed-view presentation:
  // a Capabilities skills table (no raw "Skill IDs" boxes) and friendly MCP
  // chips with the raw id demoted to the tooltip.
  assert.doesNotMatch(content, /Skill IDs/);
  assert.doesNotMatch(content, /Tool IDs/);
  assert.match(content, /agent-view-skill-table/);
  assert.match(content, /<th>Status<\/th>\s*<th>Skill<\/th>\s*<th>Source<\/th>/);
  assert.match(content, /data-skill="notes"/);
  assert.match(content, /title="[^"]*\(server:glean\)"/);

  // Footer install: agent bundles now route to the pre-install provenance
  // modal first (router behavior covered in
  // agents-dependent-skill-publish.unit.test.js "install router: ..."); the
  // page stays up until the modal's install completes via onInstalled.
  editor.querySelector(".agents-modal-submit").click();
  await settle();
  assert.ok(
    !calls.some((entry) => entry[0] === "install"),
    "agent installs defer to the provenance modal",
  );
  assert.notEqual(
    editor.innerHTML,
    "",
    "the page stays until the modal install lands",
  );
});

test("renderer: a fresh has_bundle:false response overrides stale cached bundles on the Discover page", async () => {
  const sentinel = "stale-model-must-not-render";
  const { window, document } = discoverHarness({
    searchResults: [
      {
        id: "sol-stale",
        name: "Stale Row",
        type: "portico-agents",
        bundle: {
          type: "portico-agents",
          payload: { name: "Stale Row", base_model_id: sentinel },
        },
      },
    ],
    solutionsById: {
      // The authoritative refetch says there is no bundle any more.
      "sol-stale": { id: "sol-stale", status: "active", has_bundle: false },
    },
  });

  await window.AgentsTabModule.runDiscoverSearch();
  await settle();
  await window.AgentsPublishHooks.openDiscoverAgentPage("sol-stale");
  await settle();

  const editor = document.getElementById("agents-tab-editor");
  const content = editor.querySelector("[data-agent-editor-content]").innerHTML;
  assert.match(
    content,
    /does not currently include an installable bundle/,
    "the page explains the missing bundle",
  );
  assert.ok(
    !content.includes(sentinel),
    "the stale cached bundle content must not resurface",
  );
  const submitBtn = editor.querySelector(".agents-modal-submit");
  assert.equal(submitBtn.disabled, true, "Install is disabled");
  assert.equal(submitBtn.title, "No bundle attached");
});

test("renderer: Discover search reports stale links; only store-confirmed deletions prune", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {
    agents: [localAgent("real-agent")],
    // The link points at an agent the Subagents MCP no longer reports.
    links: { "ghost-agent": { solutionId: "sol-ghost" } },
  });

  await window.AgentsTabModule.runDiscoverSearch();
  await settle();

  // Soft-miss contract (2026-08-08 access-flap incident): the renderer never
  // hard-deletes on a missed sighting — it reports absence and prunes only
  // what the store confirms (the fixture confirms immediately).
  const reported = calls
    .filter((entry) => entry[0] === "reportLinkSightings")
    .map((entry) => entry[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(reported)), [["ghost-agent"]]);
  assert.ok(
    !calls.some((entry) => entry[0] === "clearLink"),
    "the prune must not hard-delete links directly",
  );
});

test("renderer: the edit form allows display-name renames (input is never readonly)", () => {
  const { window } = loadAgentsModuleHarness();
  installMarketplaceFixture(window, {});
  const html = window.AgentsPublishHooks.buildAgentForm(
    localAgent("agent-1", { name: "Agent One" }),
    { baseModels: [], skills: [], toolServers: [] },
  );
  const nameInput = html.match(/<input[^>]*name="name"[^>]*>/s)?.[0];
  assert.ok(nameInput, "name input renders");
  assert.doesNotMatch(nameInput, /readonly/);
  assert.match(nameInput, /maxlength="\d+"/);
  // The update itself is keyed by the immutable model_id on the MCP wire —
  // covered behaviorally in ai-marketplace-operations.unit.test.js
  // ("agent read tools are called with model_id, never agent_id").
});

// ============================================================================
// Harness: esbuild-bundled agent-skills.js (Agent Skills layer; same shape as
// the audit-file copy).
// ============================================================================

let bundledAgentSkillsSource = null;
function bundleAgentSkills() {
  if (bundledAgentSkillsSource) return bundledAgentSkillsSource;
  const esbuild = require("esbuild");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-lifecycle-"));
  const outfile = path.join(outDir, "agent-skills.bundle.js");
  esbuild.buildSync({
    entryPoints: [path.join(componentsDir, "agent-skills.js")],
    bundle: true,
    outfile,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });
  bundledAgentSkillsSource = fs.readFileSync(outfile, "utf8");
  return bundledAgentSkillsSource;
}

function loadAgentSkillsHarness({
  skills = [],
  skillLinks = {},
  publishedSolutions = [],
  publishImpl = null,
  updateImpl = null,
  duplicateImpl = null,
} = {}) {
  const source = bundleAgentSkills();
  const document = createFakeDocument();
  const calls = [];
  const notifications = [];
  const confirmCalls = [];

  const windowObject = {
    appState: {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    electronAPI: {
      getSkills: async () => {
        calls.push(["getSkills"]);
        return { success: true, skills };
      },
      getUsername: async () => ({ username: "dsantiago" }),
      currentUser: {
        get: async () => ({
          authenticated: true,
          sessionSummary: { user: { email: "dsantiago@example.invalid" } },
        }),
      },
      duplicateSkill: async (skillPath, newName, options) => {
        calls.push(["duplicateSkill", skillPath, newName, options]);
        if (duplicateImpl) return duplicateImpl(skillPath, newName, options);
        return { success: true, skillName: newName };
      },
      logToMain: () => {},
      aiMarketplace: {
        listSkillLinks: async () => ({ success: true, links: skillLinks }),
        listPublished: async (type) => {
          calls.push(["listPublished", type]);
          return { success: true, data: { solutions: publishedSolutions } };
        },
        getSkillLink: async (name) => {
          calls.push(["getSkillLink", name]);
          return { success: true, link: skillLinks[name] || null };
        },
        setSkillLink: async (name, solutionId) => {
          calls.push(["setSkillLink", name, solutionId]);
          return { success: true };
        },
        buildPublishBundle: async (input) => {
          calls.push(["buildPublishBundle", input?.skill?.name, input]);
          return {
            success: true,
            data: { type: "skills", payload: { name: input?.skill?.name } },
          };
        },
        publish: async (input, opts) => {
          calls.push(["publish", input, opts]);
          if (publishImpl) return publishImpl(input, opts);
          return { success: true, data: { id: `new-${input?.name}` } };
        },
        update: async (solutionId, input, opts) => {
          calls.push(["update", solutionId, input, opts]);
          if (updateImpl) return updateImpl(solutionId, input, opts);
          return { success: true, data: { id: solutionId } };
        },
        hasApiKey: async () => {
          calls.push(["hasApiKey"]);
          return { hasKey: true };
        },
      },
    },
    showNotification: (message, kind = "info") =>
      notifications.push([kind, message]),
    showAgentsConfirmModal: (options) => {
      confirmCalls.push(options);
    },
  };
  windowObject.window = windowObject;

  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    Date,
    JSON,
    URL,
    HTMLElement: FakeElement,
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: (cb) => {
      cb();
      return 0;
    },
    showNotification: windowObject.showNotification,
  };
  context.globalThis = context;

  vm.runInNewContext(
    fs.readFileSync(path.join(componentsDir, "skill-card-renderer.js"), "utf8"),
    context,
    { filename: path.join(componentsDir, "skill-card-renderer.js") },
  );
  vm.runInNewContext(source, context, {
    filename: path.join(componentsDir, "agent-skills.js"),
  });

  return { window: windowObject, document, calls, notifications, confirmCalls };
}

// ============================================================================
// Direct skill publishing (Agent Skills tab).
// ============================================================================

test("skills: direct publishing uses canonical names, skill links, and no user API-key prompt", async () => {
  const { window, calls, confirmCalls } = loadAgentSkillsHarness({
    skills: [userSkill("skills-user/notes")],
  });

  // A prefixed local id publishes under its canonical bare name.
  await window.AgentSkillsHooks.publishSkillToAiMarketplace(
    userSkill("skills-user/notes"),
  );
  assert.equal(confirmCalls.length, 1);
  await confirmCalls[0].onConfirm();
  await settle();

  const linkLookup = calls.find((entry) => entry[0] === "getSkillLink");
  assert.equal(linkLookup[1], "notes", "the link registry is keyed canonically");
  const publishCall = calls.find((entry) => entry[0] === "publish");
  assert.equal(publishCall[1].name, "notes");
  assert.equal(publishCall[1].type, "skills");
  assert.deepEqual(JSON.parse(JSON.stringify(publishCall[2])), {
    localSkillId: "notes",
  });
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "setSkillLink" &&
        entry[1] === "notes" &&
        entry[2] === "new-notes",
    ),
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "hasApiKey"),
    "end users are never gated on a marketplace API key",
  );
});

test("skills: marketplace-installed copies are publish-refused with Duplicate guidance", async () => {
  const { window, calls, notifications } = loadAgentSkillsHarness({});

  await window.AgentSkillsHooks.publishSkillToAiMarketplace({
    name: "ai-marketplace/toolkit",
    source: "marketplace",
    marketplace_id: "ai-marketplace",
    skill_path: "/tmp/skills-marketplace/ai-marketplace/toolkit",
  });

  const info = notifications.find(([kind]) => kind === "info");
  assert.match(info[1], /Marketplace-installed skills are read-only/);
  assert.match(info[1], /Use Duplicate to create an editable user copy/);
  assert.ok(!calls.some((entry) => entry[0] === "publish"));
});

test("skills: installed marketplace skills become editable via Duplicate (named copy, user facet)", async () => {
  const installedSkill = {
    name: "ai-marketplace/toolkit",
    display_name: "Toolkit",
    source: "marketplace",
    marketplace_id: "ai-marketplace",
    skill_path: "/tmp/skills-marketplace/ai-marketplace/toolkit",
  };
  const { window, document, calls, notifications } = loadAgentSkillsHarness({
    skills: [installedSkill],
    duplicateImpl: async (skillPath, newName) => ({
      success: true,
      skillName: newName,
    }),
  });
  await window.loadSkills();

  const duplicatePromise =
    window.AgentSkillsHooks.duplicateSkillAction(installedSkill);
  await settle();

  // The name prompt opened (discard-modal chrome) with a suggested copy name.
  const overlay = document.body.children.at(-1);
  assert.match(overlay.innerHTML, /Duplicate skill/);
  const input = overlay.querySelector(".skill-name-modal-input");
  assert.equal(input.value, "Toolkit Copy");
  assert.equal(
    calls.some((entry) => entry[0] === "duplicateSkill"),
    false,
    "nothing is copied before the user confirms a name",
  );

  input.value = "Toolkit Editable";
  overlay.querySelector(".skill-name-modal-confirm").click();
  await duplicatePromise;
  await settle();

  const duplicateCall = calls.find((entry) => entry[0] === "duplicateSkill");
  assert.equal(duplicateCall[1], "/tmp/skills-marketplace/ai-marketplace/toolkit");
  assert.equal(duplicateCall[2], "Toolkit Editable");
  assert.deepEqual(JSON.parse(JSON.stringify(duplicateCall[3])), { exact: true });
  const success = notifications.find(([kind]) => kind === "success");
  assert.match(success[1], /Created editable copy "Toolkit Editable" in your User skills\./);
});

// ============================================================================
// Solutions Marketplace sync (marketplaces.js): refresh authority comes from
// persisted solution provenance, never a remote name match. The IPC handler's
// refreshInstalledSkillId forwarding is covered in
// marketplace-requirements-audit.unit.test.js ("ipc: install/publish/update/
// delete delegate ...").
// ============================================================================

function loadMarketplacesHarness({
  installedSkills = [],
  marketplaces = [],
  installImpl = null,
} = {}) {
  const document = createFakeDocument();
  const calls = [];
  const notifications = [];

  const windowObject = {
    appState: {},
    electronAPI: {
      getMarketplaces: async () => {
        calls.push(["getMarketplaces"]);
        return {
          success: true,
          data: { marketplaces, installedSkills },
        };
      },
      syncAllMarketplaces: async () => {
        calls.push(["syncAllMarketplaces"]);
        return { success: true };
      },
      checkSkillUpdates: async () => {
        calls.push(["checkSkillUpdates"]);
        return { success: true, hasUpdates: false, updates: [] };
      },
      aiMarketplace: {
        install: async (solutionId, options) => {
          calls.push(["install", solutionId, options]);
          if (installImpl) return installImpl(solutionId, options);
          return { success: true, data: { type: "skills" } };
        },
        search: async (params) => {
          calls.push(["search", params]);
          return { success: true, data: { results: [] } };
        },
      },
    },
    showNotification: (message, kind = "info") =>
      notifications.push([kind, message]),
  };
  windowObject.window = windowObject;

  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    Date,
    JSON,
    URL,
    HTMLElement: FakeElement,
    requestAnimationFrame: (cb) => {
      cb();
      return 0;
    },
    showNotification: windowObject.showNotification,
  };
  context.globalThis = context;

  vm.runInNewContext(
    fs.readFileSync(path.join(componentsDir, "marketplaces.js"), "utf8"),
    context,
    { filename: path.join(componentsDir, "marketplaces.js") },
  );

  return { window: windowObject, document, calls, notifications };
}

const solutionsInstalledSkill = (skillId, solutionId) => ({
  marketplaceId: "ai-marketplace",
  skillId,
  localPath: `skills-marketplace/ai-marketplace/${skillId}`,
  skillSource: { type: "ai-marketplace-solution", solutionId },
});

test("marketplaces: Check Updates refreshes only persisted Solutions Marketplace provenance", async () => {
  const { window, calls } = loadMarketplacesHarness({
    installedSkills: [
      // Sync refreshes only rows the update check flagged (hasUpdate).
      { ...solutionsInstalledSkill("notes", "sol-notes"), hasUpdate: true },
      // Duplicate provenance rows collapse to one refresh.
      { ...solutionsInstalledSkill("notes", "sol-notes"), hasUpdate: true },
      // Up-to-date rows are never blind-reinstalled.
      solutionsInstalledSkill("current", "sol-current"),
      // No recorded solution provenance → never refreshed by name.
      { marketplaceId: "ai-marketplace", skillId: "legacy", skillSource: null, hasUpdate: true },
      // Git-marketplace installs are not Solutions Marketplace rows.
      {
        marketplaceId: "anthropic-agent-skills",
        skillId: "art",
        skillSource: { type: "ai-marketplace-solution", solutionId: "sol-art" },
        hasUpdate: true,
      },
    ],
  });

  await window.checkForMarketplaceUpdates();

  const installCalls = calls.filter((entry) => entry[0] === "install");
  assert.equal(installCalls.length, 1, "exactly one provenance-backed refresh");
  assert.equal(installCalls[0][1], "sol-notes");
  assert.deepEqual(JSON.parse(JSON.stringify(installCalls[0][2])), {
    refreshInstalledSkillId: "notes",
  });
  assert.ok(
    !calls.some((entry) => entry[0] === "search"),
    "refresh authority never comes from a remote name search",
  );
});

test("marketplaces: the list renders git marketplaces only — no synthetic Solutions card", async () => {
  // Solutions browse/install moved to the Agent Skills tab's inline Discover
  // mode (skills-discover.unit.test.js); solutions provenance refresh stays on
  // the header Sync All path (previous test).
  const { window, document, calls } = loadMarketplacesHarness({
    marketplaces: [
      {
        id: "anthropic-agent-skills",
        name: "anthropic-agent-skills",
        description: "Anthropic skills",
        owner: { name: "anthropic" },
        cachedManifest: null,
        lastSynced: null,
      },
    ],
    installedSkills: [
      { ...solutionsInstalledSkill("notes", "sol-notes"), hasUpdate: true },
    ],
  });

  await window.loadMarketplaces();

  const listHtml = document.getElementById("marketplaces-list").innerHTML;
  assert.match(listHtml, /anthropic-agent-skills/);
  assert.doesNotMatch(listHtml, /Solutions Marketplace/);
  assert.doesNotMatch(listHtml, /solutions-marketplace-sync-btn/);
  assert.ok(
    !calls.some((entry) => entry[0] === "search"),
    "the marketplaces list never queries remote solutions",
  );
});

// ============================================================================
// HTTP API route (api.js): the install route forwards refresh provenance and
// expected type into the shared operations service.
// Harness: Module._load-stubbed express/electron with recorded route table.
// ============================================================================

function loadApiRoutes() {
  const apiModulePath = require.resolve("./api");
  const previousModule = require.cache[apiModulePath];
  const originalLoad = Module._load;
  const routes = new Map();
  const calls = [];

  const expressStub = () => ({
    use() {},
    get(routePath, handler) {
      routes.set(`GET ${routePath}`, handler);
    },
    post(routePath, handler) {
      routes.set(`POST ${routePath}`, handler);
    },
    listen() {
      return { on() {}, close() {} };
    },
  });
  expressStub.json = () => (_req, _res, next) => next?.();

  const fakeOperations = {
    install: async (id, options) => {
      calls.push(["operations.install", id, options]);
      return { type: "skills" };
    },
  };

  const fakesByRequest = new Map([
    ["./ai-marketplace-operations", fakeOperations],
  ]);

  // api.js calls a handful of its imports during route registration
  // (registerWorkspaceFileRoute etc.), so unmatched relative requires get a
  // permissive callable stub instead of {}.
  const makePermissiveStub = () => {
    const stub = new Proxy(function permissiveStub() {}, {
      get(_target, prop) {
        if (
          prop === "then" ||
          prop === Symbol.toPrimitive ||
          prop === Symbol.iterator ||
          prop === Symbol.toStringTag
        ) {
          return undefined;
        }
        if (prop === "toString" || prop === "valueOf") return () => "";
        return stub;
      },
      apply() {
        return stub;
      },
      construct() {
        return {};
      },
    });
    return stub;
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => "/tmp" },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
      };
    }
    if (request === "express") return expressStub;
    if (
      parent?.filename === apiModulePath &&
      (request.startsWith("./") || request.startsWith("../"))
    ) {
      return fakesByRequest.get(request) || makePermissiveStub();
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[apiModulePath];
  let api;
  try {
    api = require("./api");
    api.createApiServer();
  } finally {
    Module._load = originalLoad;
    delete require.cache[apiModulePath];
    if (previousModule) require.cache[apiModulePath] = previousModule;
  }

  return { routes, calls };
}

test("api: the HTTP install route forwards refresh provenance and expected type to operations.install", async () => {
  const { routes, calls } = loadApiRoutes();
  const handler = routes.get("POST /api/ai-marketplace/install");
  assert.ok(handler, "the install route is registered");

  const responses = [];
  const res = {
    json: (body) => {
      responses.push(body);
      return res;
    },
    status: () => res,
  };
  await handler(
    {
      body: {
        id: "sol-notes",
        refresh_installed_skill_id: "notes",
        expected_type: "skills",
      },
    },
    res,
  );

  const installCall = calls.find((entry) => entry[0] === "operations.install");
  assert.equal(installCall[1], "sol-notes");
  assert.equal(installCall[2].refreshInstalledSkillId, "notes");
  assert.equal(installCall[2].expectedType, "skills");
  assert.equal(responses[0].success, true);
});
