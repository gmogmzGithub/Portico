// Integration-test fixture for the AI-Marketplace stack: a mock marketplace
// HTTP server, a loader that runs the REAL service modules (client, install,
// operations, marketplace-service, both link registries, diagnostics)
// against it under plain `node --test`, a stateful subagents fake, a GitHub
// fetch router for git-marketplace flows, and a renderer bridge that drives
// the real agents.js planners against the real stack.
//
// Machine model: one process hosts several simulated "machines" (publisher /
// consumer). The electron hook and the bootstrap/current-user stubs read
// MUTABLE fixture state, so tests switch machines with setActiveMachine().
// The Module._load hook and require.cache stubs are installed permanently
// for the process (skill-links re-requires electron per call; node:test runs
// each test FILE in its own child process, so nothing leaks across files).

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");

const SERVICES_DIR = __dirname;

// ---------------------------------------------------------------------------
// Mock marketplace HTTP server
// ---------------------------------------------------------------------------

function startMockMarketplace() {
  const solutions = new Map(); // id -> envelope
  let nextId = 1;
  const notOwnerIds = new Set();

  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
      });
    });

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    // /api/solutions[/:id[/bundle]]
    if (parts[0] !== "api" || parts[1] !== "solutions") {
      return send(res, 404, { error: "not found" });
    }
    const id = parts[2] ? decodeURIComponent(parts[2]) : null;

    if (req.method === "POST" && id === "search") {
      const body = (await readJson(req)) || {};
      const query = String(body.query || "").toLowerCase();
      const types = Array.isArray(body.filters?.type) ? body.filters.type : null;
      const results = [...solutions.values()].filter((sol) => {
        if (sol.status !== "active") return false;
        if (types && !types.includes(sol.type)) return false;
        if (query && !String(sol.name || "").toLowerCase().includes(query)) {
          return false;
        }
        return true;
      });
      return send(res, 200, { solutions: results.slice(0, body.pageSize || 20) });
    }

    if (req.method === "POST" && !id) {
      const body = (await readJson(req)) || {};
      const newId = `sol-${nextId++}`;
      const envelope = {
        ...body,
        id: newId,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      solutions.set(newId, envelope);
      return send(res, 200, envelope);
    }

    if (!id) return send(res, 404, { error: "not found" });
    const existing = solutions.get(id);

    if (req.method === "GET" && parts[3] === "bundle") {
      if (!existing || existing.status !== "active" || !existing.bundle) {
        return send(res, 404, { error: "no bundle", code: "no_bundle" });
      }
      return send(res, 200, existing.bundle);
    }

    if (req.method === "GET") {
      if (!existing) return send(res, 404, { error: "Solution not found", code: "not_found" });
      return send(res, 200, existing);
    }

    if (req.method === "PUT") {
      if (!existing) return send(res, 404, { error: "Solution not found", code: "not_found" });
      if (existing.status !== "active") {
        return send(res, 404, { error: "Solution is deleted", code: "not_found" });
      }
      if (notOwnerIds.has(id)) {
        return send(res, 403, { error: "not the owner", code: "not_owner" });
      }
      const body = (await readJson(req)) || {};
      Object.assign(existing, body, {
        id,
        status: "active",
        updated_at: new Date().toISOString(),
      });
      return send(res, 200, existing);
    }

    if (req.method === "DELETE") {
      if (!existing) return send(res, 404, { error: "Solution not found", code: "not_found" });
      existing.status = "deleted";
      existing.has_bundle = false;
      delete existing.bundle;
      return send(res, 200, { id, status: "deleted" });
    }

    return send(res, 405, { error: "method not allowed" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        solutions,
        primeNotOwner(solutionId) {
          notOwnerIds.add(solutionId);
        },
        bumpListing(solutionId, patch = {}) {
          const sol = solutions.get(solutionId);
          assert.ok(sol, `bumpListing: unknown solution ${solutionId}`);
          Object.assign(sol, patch, {
            updated_at: patch.updated_at || new Date(Date.now() + 60_000).toISOString(),
          });
          return sol;
        },
        deleteListing(solutionId) {
          const sol = solutions.get(solutionId);
          assert.ok(sol, `deleteListing: unknown solution ${solutionId}`);
          sol.status = "deleted";
          delete sol.bundle;
          sol.has_bundle = false;
        },
        findByName(name) {
          return [...solutions.values()].find((sol) => sol.name === name) || null;
        },
        close() {
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Stateful subagents fake (the OWUI agent store of one machine)
// ---------------------------------------------------------------------------

class FakeSubagents {
  constructor({ attributionEmail = "" } = {}) {
    this.agents = new Map();
    this.attributionEmail = attributionEmail;
  }

  async invokeMcpTool(serverId, toolName, args = {}) {
    if (toolName === "subagents_list_agents") {
      return {
        success: true,
        data: { agents: [...this.agents.values()].map((agent) => ({ ...agent })) },
      };
    }
    if (toolName === "subagents_create_agent") {
      const id = args.model_id || String(args.name || "agent").toLowerCase();
      const record = {
        id,
        name: args.name,
        base_model_id: args.base_model_id,
        system_prompt: args.system_prompt,
        description: args.description || "",
        skill_ids: [...(args.skill_ids || [])],
        tool_server_ids: [...(args.tool_server_ids || [])],
        reasoning_effort: args.reasoning_effort || null,
      };
      this.agents.set(id, record);
      return { success: true, data: { id, ...structuredClone(record) } };
    }
    if (toolName === "subagents_get_agent") {
      const agent = this.agents.get(args.model_id);
      return agent
        ? { success: true, data: structuredClone(agent) }
        : { success: false, data: { error: "not found" } };
    }
    if (toolName === "subagents_update_agent") {
      const agent = this.agents.get(args.model_id);
      if (!agent) return { success: false, data: { error: "not found" } };
      const next = { ...agent };
      for (const [key, value] of Object.entries(args)) {
        if (key === "model_id" || value === undefined || value === null) continue;
        next[key] = value;
      }
      this.agents.set(agent.id, next);
      return { success: true, data: structuredClone(next) };
    }
    if (toolName === "subagents_delete_agent") {
      return { success: this.agents.delete(args.model_id), data: { id: args.model_id } };
    }
    if (toolName === "subagents_reconcile_agent_attribution") {
      // Fleet-wide reconcile (the real tool takes no target): stamp creator
      // attribution like the Rust service does, and report every known
      // agent as finalized so pending-attribution gates pass.
      for (const agent of this.agents.values()) {
        if (!agent.created_by_email && this.attributionEmail) {
          agent.created_by_email = this.attributionEmail;
        }
      }
      return {
        success: true,
        data: {
          failures: [],
          finalized_pending_ids: [...this.agents.keys()],
          repaired_ids: [],
          // Confirmed provenance for every known agent (the strict reclaim
          // reconcile requires the target in repaired|unchanged).
          unchanged_ids: [...this.agents.keys()],
          skipped_linked_ids: [],
          missing_creator_linked_ids: [],
        },
      };
    }
    throw new Error(`FakeSubagents: unexpected tool ${toolName}`);
  }
}

// ---------------------------------------------------------------------------
// GitHub fetch router (git-marketplace flows without git/network)
// ---------------------------------------------------------------------------

// repoSpec: { "owner/repo": { ref, marketplaceName, skills: { skillId: {"SKILL.md": "..."} } } }
function installGitFetchRouter(repos) {
  const realFetch = global.fetch;

  const buildManifest = (spec) => ({
    name: spec.marketplaceName,
    owner: { name: "Fixture Owner" },
    metadata: { description: "fixture marketplace", version: "1.0.0" },
    plugins: [
      {
        name: spec.marketplaceName,
        description: "fixture skills",
        skills: Object.keys(spec.skills).map((skillId) => `./skills/${skillId}`),
      },
    ],
  });

  const buildTarball = (repoName, spec) => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "portico-fixture-tar-"));
    const rootName = `${repoName.split("/")[1]}-${spec.ref}`;
    const rootDir = path.join(stage, rootName);
    fs.mkdirSync(path.join(rootDir, ".atlas-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".atlas-plugin", "marketplace.json"),
      JSON.stringify(buildManifest(spec)),
    );
    for (const [skillId, files] of Object.entries(spec.skills)) {
      const dir = path.join(rootDir, "skills", skillId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, file), content);
      }
    }
    const tarPath = path.join(stage, "repo.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", stage, rootName]);
    return fs.readFileSync(tarPath);
  };

  const textResponse = (body, status = 200, type = "text/plain") =>
    new Response(body, { status, headers: { "Content-Type": type } });

  global.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      return realFetch(input, init);
    }
    const matchRepo = () => {
      for (const [repoName, spec] of Object.entries(repos)) {
        if (url.includes(repoName)) return { repoName, spec };
      }
      return null;
    };
    const hit = matchRepo();
    if (!hit) return textResponse("not found", 404);
    const { repoName, spec } = hit;

    if (parsed.hostname === "codeload.github.com") {
      const body = buildTarball(repoName, spec);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      });
    }
    if (parsed.hostname === "raw.githubusercontent.com") {
      // /{owner}/{repo}/{ref}/{path...}
      const parts = parsed.pathname.split("/").filter(Boolean);
      const filePath = parts.slice(3).join("/");
      if (filePath === ".atlas-plugin/marketplace.json") {
        return textResponse(JSON.stringify(buildManifest(spec)), 200, "application/json");
      }
      const skillMatch = filePath.match(/^skills\/([^/]+)\/(.+)$/);
      if (skillMatch && spec.skills[skillMatch[1]]?.[skillMatch[2]] !== undefined) {
        return textResponse(spec.skills[skillMatch[1]][skillMatch[2]]);
      }
      return textResponse("not found", 404);
    }
    if (parsed.hostname === "api.github.com") {
      if (/\/repos\/[^/]+\/[^/]+$/.test(parsed.pathname)) {
        return textResponse(
          JSON.stringify({ default_branch: spec.ref }),
          200,
          "application/json",
        );
      }
      return textResponse(JSON.stringify({ message: "not found" }), 404, "application/json");
    }
    return textResponse("not found", 404);
  };

  return () => {
    global.fetch = realFetch;
  };
}

// ---------------------------------------------------------------------------
// Real-stack loader (permanent hook + stubs; mutable machine state)
// ---------------------------------------------------------------------------

const machineState = {
  projectRoot: "/tmp/portico-fixture-unset",
  userDataPath: "/tmp/portico-fixture-unset",
  viewerEmail: "publisher@example.invalid",
  subagents: new FakeSubagents(),
};

let stackLoaded = null;

function loadRealMarketplaceStack({ baseUrl }) {
  if (stackLoaded) return stackLoaded;

  process.env.AI_MARKETPLACE_BASE_URL = baseUrl;
  process.env.AI_MARKETPLACE_API_KEY = "integration-test-key";
  process.env.PORTICO_RUNTIME_DISABLE_KEYCHAIN = "1";

  // Permanent electron hook: skill-links re-requires electron on every
  // registry access; agent-links destructures app at module load.
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => machineState.userDataPath, isPackaged: false },
        BrowserWindow: {},
        dialog: {},
        shell: {},
      };
    }
    return originalLoad.apply(this, arguments);
  };

  const resolveDep = (rel) => require.resolve(rel, { paths: [SERVICES_DIR] });
  const stubs = {
    [resolveDep("./bootstrap")]: {
      get PROJECT_ROOT() {
        return machineState.projectRoot;
      },
    },
    [resolveDep("./docker-mcp")]: {
      invokeMcpTool: async (serverId, toolName, args, port) => {
        // The real Rust reconcile stamps marketplace metas onto the models
        // from the sidecar link registry; ops gates (publishable/read-only)
        // read those metas. Emulate the stamping before delegating.
        if (toolName === "subagents_reconcile_agent_attribution") {
          try {
            const agentLinksModule = require(resolveDep(
              "./ai-marketplace-agent-links",
            ));
            const links = await agentLinksModule.listLinks({
              userDataPath: machineState.userDataPath,
            });
            for (const [agentId, link] of Object.entries(links || {})) {
              const agent = machineState.subagents.agents.get(agentId);
              if (!agent) continue;
              agent.marketplace_relationship = link.relationship;
              agent.marketplace_solution_id = link.solutionId;
              if (!agent.created_by_email) {
                agent.created_by_email = link.authorIdentity || machineState.viewerEmail;
              }
              if (link.relationship === "published") {
                agent.creation_source = "local";
                agent.is_read_only = false;
              } else if (link.relationship === "installed") {
                agent.creation_source = "marketplace";
                agent.is_read_only = true;
              }
            }
          } catch {
            // Best-effort stamping; the fleet response below still answers.
          }
        }
        // The skills MCP server: serve reads from the active machine's
        // on-disk skills so provenance gates see real frontmatter.
        if (serverId === "skills") {
          if (toolName === "skills_read_skill") {
            const metadata = await readSkillFrontmatter(
              machineState.projectRoot,
              args?.skill_name,
            );
            if (!metadata) {
              return {
                success: true,
                data: { is_error: true, message: "skill not found" },
              };
            }
            return { success: true, data: { metadata } };
          }
          return { success: true, data: {} };
        }
        return machineState.subagents.invokeMcpTool(serverId, toolName, args, port);
      },
    },
    [resolveDep("./current-user")]: {
      get: async () => ({
        authenticated: true,
        sessionSummary: { user: { email: machineState.viewerEmail } },
      }),
      onChange: () => () => {},
    },
  };
  for (const [keyPath, exportsObject] of Object.entries(stubs)) {
    require.cache[keyPath] = {
      id: keyPath,
      filename: keyPath,
      loaded: true,
      exports: exportsObject,
    };
  }

  // Fresh-load the whole real stack AFTER the hook + stubs are planted so
  // module-load electron destructures capture the stub app.
  const stackModules = [
    "./marketplace-diagnostics",
    "./ai-marketplace-skill-links",
    "./ai-marketplace-agent-links",
    "./ai-marketplace-client",
    "./marketplace-service",
    "./ai-marketplace-install",
    "./ai-marketplace-operations",
    "./user-skill-service",
  ];
  for (const rel of stackModules) {
    const keyPath = resolveDep(rel);
    if (!stubs[keyPath]) delete require.cache[keyPath];
  }

  stackLoaded = {
    ops: require(resolveDep("./ai-marketplace-operations")),
    installModule: require(resolveDep("./ai-marketplace-install")),
    marketplaceService: require(resolveDep("./marketplace-service")),
    client: require(resolveDep("./ai-marketplace-client")),
    skillLinks: require(resolveDep("./ai-marketplace-skill-links")),
    agentLinks: require(resolveDep("./ai-marketplace-agent-links")),
    machineState,
  };
  return stackLoaded;
}

async function readSkillFrontmatter(projectRoot, skillName) {
  const clean = String(skillName || "").trim();
  if (!clean) return null;
  const roots = [path.join(projectRoot, "skills-user"), path.join(projectRoot, "skills")];
  try {
    const marketRoot = path.join(projectRoot, "skills-marketplace");
    for (const entry of await fsp.readdir(marketRoot)) {
      roots.push(path.join(marketRoot, entry));
    }
  } catch {}
  for (const root of roots) {
    try {
      const raw = await fsp.readFile(path.join(root, clean, "SKILL.md"), "utf8");
      const match = raw.match(/^---\n([\s\S]*?)\n---/);
      const metadata = {};
      if (match) {
        for (const line of match[1].split("\n")) {
          const kv = line.match(/^([A-Za-z_]+):\s*(.+)$/);
          if (kv) metadata[kv[1]] = kv[2].replace(/^"|"$/g, "");
        }
      }
      return metadata;
    } catch {}
  }
  return null;
}

async function createMachine(label, { viewerEmail }) {
  const projectRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), `portico-integration-${label}-root-`),
  );
  const userDataPath = await fsp.mkdtemp(
    path.join(os.tmpdir(), `portico-integration-${label}-data-`),
  );
  return {
    label,
    projectRoot,
    userDataPath,
    viewerEmail,
    subagents: new FakeSubagents({ attributionEmail: viewerEmail }),
  };
}

function setActiveMachine(machine) {
  machineState.projectRoot = machine.projectRoot;
  machineState.userDataPath = machine.userDataPath;
  machineState.viewerEmail = machine.viewerEmail;
  machineState.subagents = machine.subagents;
}

async function seedSkill(
  projectRoot,
  source,
  skillName,
  { description = "fixture skill", createdByEmail = "" } = {},
) {
  const rootDir =
    source === "system"
      ? path.join(projectRoot, "skills")
      : path.join(projectRoot, "skills-user");
  const dir = path.join(rootDir, skillName);
  await fsp.mkdir(dir, { recursive: true });
  const creatorLine = createdByEmail ? `created_by_email: ${createdByEmail}\n` : "";
  await fsp.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\nversion: "1.0"\n${creatorLine}---\n\n# ${skillName}\n`,
  );
  return dir;
}

// ---------------------------------------------------------------------------
// Renderer planner bridge: the real agents.js planners driven against the
// real stack (electronAPI shim mapping IPC surface -> real ops/registries).
// ---------------------------------------------------------------------------

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
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.style = { display: "none" };
    this.classList = new FakeClassList();
    this.innerHTML = "";
    this.textContent = "";
    this.dataset = {};
    this.value = "";
  }
  addEventListener() {}
  removeEventListener() {}
  closest() {
    return null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  appendChild(child) {
    return child;
  }
}

async function scanSkillsCatalog(projectRoot) {
  const rows = [];
  const scan = async (dir, source, nested) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!nested) {
        rows.push({
          name: entry.name,
          display_name: entry.name,
          description: "fixture",
          source,
          skill_path: path.join(dir, entry.name),
          marketplace_id: null,
          marketplace_name: null,
        });
      } else {
        await scanMarketplace(path.join(dir, entry.name), entry.name);
      }
    }
  };
  const hasSkillMd = async (dir) => {
    try {
      return (await fsp.stat(path.join(dir, "SKILL.md"))).isFile();
    } catch {
      return false;
    }
  };
  // Mirrors the real get-skills two-level marketplace scan: a dir with
  // SKILL.md is a flat skill; otherwise it is a plugin holding depth-3
  // skills (never deeper).
  const scanMarketplace = async (mpDir, marketplaceId) => {
    let entries = [];
    try {
      entries = await fsp.readdir(mpDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(mpDir, entry.name);
      if (await hasSkillMd(entryPath)) {
        rows.push({
          name: `${marketplaceId}/${entry.name}`,
          display_name: entry.name,
          description: "fixture",
          source: "marketplace",
          skill_path: entryPath,
          marketplace_id: marketplaceId,
          marketplace_name: marketplaceId,
          plugin_name: null,
        });
        continue;
      }
      let leafEntries = [];
      try {
        leafEntries = await fsp.readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const leaf of leafEntries) {
        if (!leaf.isDirectory()) continue;
        const leafPath = path.join(entryPath, leaf.name);
        if (!(await hasSkillMd(leafPath))) continue;
        rows.push({
          name: `${marketplaceId}/${entry.name}/${leaf.name}`,
          display_name: leaf.name,
          description: "fixture",
          source: "marketplace",
          skill_path: leafPath,
          marketplace_id: marketplaceId,
          marketplace_name: marketplaceId,
          plugin_name: entry.name,
        });
      }
    }
  };
  await scan(path.join(projectRoot, "skills"), "system", false);
  await scan(path.join(projectRoot, "skills-user"), "user", false);
  await scan(path.join(projectRoot, "skills-marketplace"), "marketplace", true);
  return rows;
}

function wrapOps(fn) {
  return async (...args) => {
    try {
      const value = await fn(...args);
      return { success: true, ...value };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        code: error?.code,
        status: error?.status,
        body: error?.body,
      };
    }
  };
}

function loadAgentsRendererBridge(stack) {
  const componentsDir = path.join(SERVICES_DIR, "..", "renderer", "components");
  const agentsPath = path.join(componentsDir, "agents.js");
  const sources = ["agent-reasoning-options.js", "agent-model-picker.js", "agent-reasoning-slider.js", "agents.js"].map(
    (name) => ({
      path: path.join(componentsDir, name),
      source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
    }),
  );

  const documentObject = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  const { ops, marketplaceService, skillLinks, agentLinks, installModule, client } = stack;
  const logToMainEvents = [];

  const electronAPI = {
    invokeMcpTool: async (serverId, toolName, args) =>
      machineState.subagents.invokeMcpTool(serverId, toolName, args),
    getSkills: async () => ({
      success: true,
      skills: await scanSkillsCatalog(machineState.projectRoot),
    }),
    getMarketplaces: async () => ({
      success: true,
      data: await marketplaceService.loadMarketplacesConfig(machineState.projectRoot, {
        logger: console,
      }),
    }),
    getUsername: async () => ({ username: machineState.viewerEmail }),
    loadMcpServers: async () => ({ success: true, data: [] }),
    // The renderer's skills-freshness layer calls this headlessly before
    // reading getSkills; the real service pass is exercised by its own
    // scenario, so the shim only needs to be present and cheap.
    checkSkillUpdates: async () => ({ success: true, updates: [], hasUpdates: false }),
    logToMain: (payload) => logToMainEvents.push(payload),
    aiMarketplace: {
      hasApiKey: async () => ({ hasKey: true }),
      listPublished: wrapOps(async (type) => ({ data: await ops.listPublished(type) })),
      search: wrapOps(async (params) => ({
        data: await client.search(params, { viewerEmail: machineState.viewerEmail }),
      })),
      getSolution: wrapOps(async (id) => ({
        data: await ops.getSolution(id),
      })),
      getBundle: wrapOps(async (id) => ({ data: await ops.getBundle(id) })),
      buildPublishBundle: wrapOps(async (args) => ({
        data: await installModule.buildPublishBundle({
          ...(args || {}),
          projectRoot: machineState.projectRoot,
        }),
      })),
      publish: wrapOps(async (input, options) => {
        const { publishStatus } = await ops.publishSolution(input, options || {});
        return { data: { id: publishStatus.id, status: publishStatus.status } };
      }),
      update: wrapOps(async (id, patch, options) => {
        const { publishStatus } = await ops.updatePublishedSolution(id, patch, options || {});
        return { data: { id: publishStatus.id || id, status: publishStatus.status } };
      }),
      delete: wrapOps(async (id) => ({ data: await ops.deletePublishedSolution(id) })),
      install: wrapOps(async (id, options) => ({
        data: await ops.install(id, {
          interactiveAuth: false,
          existingAgentId: options?.existingAgentId || "",
          refreshInstalledSkillId: options?.refreshInstalledSkillId || "",
        }),
      })),
      reclaimAgent: wrapOps(async (agentId) => ({
        data: await ops.reclaimInstalledAgent(agentId),
      })),
      reclaimSkill: wrapOps(async (skillId) => ({
        data: await ops.reclaimInstalledSkill(skillId),
      })),
      listLinks: wrapOps(async () => ({ links: await agentLinks.listLinks() })),
      getLink: wrapOps(async (agentId) => ({ link: await agentLinks.getLink(agentId) })),
      clearLink: wrapOps(async (agentId) => ({ removed: await agentLinks.clearLink(agentId) })),
      markLinkDirty: wrapOps(async (agentId) => ({
        link: await agentLinks.markLinkDirty(agentId),
      })),
      listSkillLinks: wrapOps(async () => ({ links: await skillLinks.listLinks() })),
      getSkillLink: wrapOps(async (name) => ({ link: await skillLinks.getLink(name) })),
      setSkillLink: wrapOps(async (name, solutionId) => ({
        link: await skillLinks.setLink(name, solutionId),
      })),
      clearSkillLink: wrapOps(async (name) => ({ removed: await skillLinks.clearLink(name) })),
      markSkillLinkDirty: wrapOps(async (name) => ({
        link: await skillLinks.markLinkDirty(name),
      })),
      getInstalledSkillSource: wrapOps(async (name) => ({
        source: await marketplaceService.getInstalledAiMarketplaceSkillSource({
          projectRoot: machineState.projectRoot,
          skillId: name,
        }),
      })),
    },
  };

  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
    electronAPI,
    showNotification() {},
  };

  const context = {
    window: windowObject,
    document: documentObject,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    HTMLElement: FakeElement,
  };
  context.globalThis = context;
  for (const entry of sources) {
    vm.runInNewContext(entry.source, context, { filename: entry.path });
  }
  return { window: windowObject, logToMainEvents };
}

module.exports = {
  startMockMarketplace,
  loadRealMarketplaceStack,
  createMachine,
  setActiveMachine,
  seedSkill,
  installGitFetchRouter,
  loadAgentsRendererBridge,
  FakeSubagents,
};
