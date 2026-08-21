// Batch 8 (items 4-6): the AI Marketplace publish/install/search surface is
// exposed agentically through ai-marketplace-operations.js (the shared source of
// truth the HTTP API + IPC both use). These tests inject fakes for every
// dependency (via require.cache) so the operation flows can be exercised without
// Electron, the network, or a live MCP stack.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const Module = require("node:module");

const SERVICES_DIR = __dirname;
const OPS_PATH = path.join(SERVICES_DIR, "ai-marketplace-operations.js");

function resolveDep(rel) {
  return require.resolve(rel, { paths: [SERVICES_DIR] });
}

// Load ai-marketplace-operations.js with all of its dependencies replaced by the
// supplied fakes. Returns { ops, fakes }.
function loadOps(overrides = {}) {
  const events = [];
  const fakes = {
    events,
    client: {
      created: [],
      updated: [],
      deleted: [],
      searches: [],
      solutionGets: [],
      bundleGets: [],
      lastSolution: null,
      async search(params, opts) {
        this.searches.push({ params, opts });
        if (typeof overrides.clientSearch === "function") {
          return await overrides.clientSearch(params, opts);
        }
        if (Array.isArray(overrides.solutions)) {
          return { solutions: overrides.solutions };
        }
        const requestedTypes = Array.isArray(params?.filters?.type)
          ? params.filters.type
          : [params?.filters?.type].filter(Boolean);
        const matchesLast =
          this.lastSolution &&
          (!requestedTypes.length ||
            requestedTypes.includes(this.lastSolution.type));
        return { solutions: matchesLast ? [this.lastSolution] : [] };
      },
      async getSolution(id) {
        this.solutionGets.push(id);
        if (typeof overrides.clientGetSolution === "function") {
          return await overrides.clientGetSolution(id);
        }
        if (overrides.solutionErrorsById?.[id]) throw overrides.solutionErrorsById[id];
        if (overrides.solutionError) throw overrides.solutionError;
        const solution =
          overrides.solutionsById?.[id] ||
          overrides.solution ||
          {
            id,
            type: "portico-agents",
            name: `sol-${id}`,
            submitted_by: overrides.viewerEmail ?? "me@example.invalid",
          };
        this.lastSolution = solution;
        return solution;
      },
      async getSolutionBundle(id) {
        this.bundleGets.push(id);
        if (typeof overrides.clientGetBundle === "function") {
          return await overrides.clientGetBundle(id);
        }
        if (overrides.bundleErrorsById?.[id]) throw overrides.bundleErrorsById[id];
        if (overrides.bundleError) throw overrides.bundleError;
        return (
          overrides.bundlesById?.[id] ||
          overrides.bundle ||
          { type: "portico-agents", payload: { id } }
        );
      },
      async createSolution(solution, opts) {
        this.created.push({ solution, opts });
        if (typeof overrides.clientCreateSolution === "function") {
          return await overrides.clientCreateSolution(solution, opts);
        }
        // New-backend-faithful (MISC-34): create persists the bundle.
        return { id: "sol-new", status: "active", has_bundle: Boolean(solution?.bundle) };
      },
      async updateSolution(id, patch, opts) {
        this.updated.push({ id, patch, opts });
        if (typeof overrides.clientUpdateSolution === "function") {
          return await overrides.clientUpdateSolution(id, patch, opts);
        }
        return { id, status: "active", has_bundle: true };
      },
      async deleteSolution(id, opts) {
        events.push("remote-delete");
        this.deleted.push({ id, opts });
        if (typeof overrides.clientDeleteSolution === "function") {
          return await overrides.clientDeleteSolution(id, opts);
        }
        return { id, status: "deleted" };
      },
    },
    install: {
      calls: [],
      SUBAGENTS_SERVER_ID: "subagents",
      SUBAGENTS_TOOL_LIST: "subagents_list_agents",
      SUBAGENTS_TOOL_RECONCILE_ATTRIBUTION:
        "subagents_reconcile_agent_attribution",
      SUBAGENTS_PORT: 8766,
      sanitizeId(value) {
        return String(value || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "");
      },
      async buildPublishBundle(args) {
        if (typeof overrides.buildPublishBundleImpl === "function") {
          return await overrides.buildPublishBundleImpl(args);
        }
        // Echo the resolved inputs so tests can assert what would be published.
        // Faithful to install.js: skill bundles come back typed "skills".
        const type = args.type === "skill" ? "skills" : args.type;
        return { type, payload: { ...(args.agent || args.skill || {}) } };
      },
      async install(args) {
        this.calls.push(args);
        if (typeof overrides.installImpl === "function") {
          return await overrides.installImpl(args);
        }
        const bundle = args.bundle;
        const id = this.sanitizeId(bundle?.payload?.name || bundle?.id || "installed");
        return {
          installed: true,
          bundle,
          id,
          installedPath: `skills-marketplace/ai-marketplace/${id}`,
        };
      },
    },
    links: {
      published: [],
      clearedPublished: [],
      clearedLocal: [],
      strictReads: 0,
      async setPublishedLink(localAgentId, solutionId, authorIdentity) {
        this.published.push({ localAgentId, solutionId, authorIdentity });
        if (typeof overrides.setPublishedAgentLink === "function") {
          return await overrides.setPublishedAgentLink(
            localAgentId,
            solutionId,
            authorIdentity,
          );
        }
        return { localAgentId, solutionId, authorIdentity };
      },
      async clearPublishedLinksBySolutionId(solutionId) {
        events.push("agent-links-clear");
        this.clearedPublished.push(solutionId);
        if (typeof overrides.clearPublishedAgentLinks === "function") {
          return await overrides.clearPublishedAgentLinks(solutionId);
        }
        return overrides.clearedAgentIds ?? [];
      },
      async clearLink(localAgentId) {
        this.clearedLocal.push(localAgentId);
        if (typeof overrides.clearAgentLink === "function") {
          return await overrides.clearAgentLink(localAgentId);
        }
        return overrides.agentLinkRemoved ?? true;
      },
      async readStateStrict() {
        this.strictReads += 1;
        if (overrides.agentLinksError) throw overrides.agentLinksError;
        if (typeof overrides.readAgentLinks === "function") {
          return await overrides.readAgentLinks();
        }
        return {
          schemaVersion: 2,
          links: overrides.agentLinks || {},
        };
      },
      remoteStamps: [],
      async setLinkRemoteUpdatedAt(localAgentId, remoteUpdatedAt) {
        this.remoteStamps.push([localAgentId, remoteUpdatedAt]);
        return { localAgentId, remoteUpdatedAt };
      },
      markedRemoteUpdates: [],
      async markRemoteUpdate(localAgentId, hasRemoteUpdate) {
        this.markedRemoteUpdates.push([localAgentId, hasRemoteUpdate]);
        return { localAgentId, hasRemoteUpdate };
      },
    },
    skillLinks: {
      skillLinksSet: [],
      skillLinksCleared: [],
      localLinksCleared: [],
      strictReads: 0,
      canonicalSkillName(value) {
        if (typeof value !== "string") return "";
        return value
          .trim()
          .replace(/\\/g, "/")
          .split("/")
          .filter(Boolean)
          .at(-1) || "";
      },
      async readStateStrict() {
        this.strictReads += 1;
        if (overrides.skillLinksError) throw overrides.skillLinksError;
        if (typeof overrides.readSkillLinks === "function") {
          return await overrides.readSkillLinks();
        }
        return { links: overrides.skillLinks || {} };
      },
      async setLink(localSkillName, solutionId) {
        this.skillLinksSet.push({ localSkillName, solutionId });
        if (typeof overrides.setPublishedSkillLink === "function") {
          return await overrides.setPublishedSkillLink(
            localSkillName,
            solutionId,
          );
        }
        return { solutionId };
      },
      async clearLinksBySolutionId(solutionId) {
        events.push("skill-links-clear");
        this.skillLinksCleared.push(solutionId);
        if (typeof overrides.clearPublishedSkillLinks === "function") {
          return await overrides.clearPublishedSkillLinks(solutionId);
        }
        return [];
      },
      async clearLink(localSkillName) {
        this.localLinksCleared.push(localSkillName);
        if (typeof overrides.clearSkillLink === "function") {
          return await overrides.clearSkillLink(localSkillName);
        }
        return overrides.skillLinkRemoved ?? true;
      },
    },
    marketplaceService: {
      uninstallCalls: [],
      detachCalls: [],
      addMarketplaceCalls: [],
      installMarketplaceSkillCalls: [],
      addedEntries: [],
      // Pure helpers pass through to the real module (they are what the
      // durable-identity matching contract is made of).
      normalizeMarketplaceSourceInput(input, opts) {
        return require("./marketplace-service").normalizeMarketplaceSourceInput(
          input,
          opts,
        );
      },
      isSameRepositorySource(left, right) {
        return require("./marketplace-service").isSameRepositorySource(left, right);
      },
      async loadMarketplacesConfig() {
        if (typeof overrides.loadMarketplacesConfigImpl === "function") {
          return await overrides.loadMarketplacesConfigImpl();
        }
        return {
          marketplaces: [
            ...(overrides.gitMarketplaces || []),
            ...this.addedEntries,
          ],
          installedSkills: overrides.gitInstalledSkills || [],
        };
      },
      async addMarketplace(args) {
        this.addMarketplaceCalls.push(args);
        if (overrides.addMarketplaceError) throw overrides.addMarketplaceError;
        if (typeof overrides.addMarketplaceImpl === "function") {
          return await overrides.addMarketplaceImpl(args);
        }
        const source = this.normalizeMarketplaceSourceInput(args.sourceInput);
        const entry = {
          id: overrides.addedMarketplaceId || "added-marketplace",
          name: overrides.addedMarketplaceId || "added-marketplace",
          source,
        };
        this.addedEntries.push(entry);
        return entry;
      },
      removeMarketplaceCalls: [],
      async removeMarketplace(args) {
        this.removeMarketplaceCalls.push(args);
        if (overrides.removeMarketplaceError) throw overrides.removeMarketplaceError;
        this.addedEntries = this.addedEntries.filter(
          (entry) => entry.id !== args?.marketplaceId,
        );
        return true;
      },
      async getMarketplaceSkills(args) {
        if (typeof overrides.getMarketplaceSkillsImpl === "function") {
          return await overrides.getMarketplaceSkillsImpl(args);
        }
        return { skills: overrides.marketplaceSkills || [] };
      },
      async installMarketplaceSkill(args) {
        this.installMarketplaceSkillCalls.push(args);
        if (overrides.installMarketplaceSkillError) {
          throw overrides.installMarketplaceSkillError;
        }
        return {
          localPath: `skills-marketplace/${args.marketplaceId}/${args.skillId}`,
          version: "1.0",
        };
      },
      async detachMarketplaceSkillToUserSkill(args) {
        this.detachCalls.push(args);
        if (overrides.detachError) throw overrides.detachError;
        if (typeof overrides.detachImpl === "function") {
          return await overrides.detachImpl(args);
        }
        const skillName = overrides.detachedSkillName || args.skillId;
        return {
          marketplaceId: args.marketplaceId,
          skillId: args.skillId,
          skillName,
          localPath: `skills-user/${skillName}`,
          previousLocalPath: `skills-marketplace/${args.marketplaceId}/${args.skillId}`,
        };
      },
      async uninstallMarketplaceSkill(args) {
        this.uninstallCalls.push(args);
        if (overrides.uninstallSkillError) throw overrides.uninstallSkillError;
        if (typeof overrides.uninstallSkillImpl === "function") {
          return await overrides.uninstallSkillImpl(args);
        }
        return {
          marketplaceId: args.marketplaceId,
          skillId: args.skillId,
          localPath: `skills-marketplace/${args.marketplaceId}/${args.skillId}`,
        };
      },
    },
    currentUser: {
      async get() {
        return {
          authenticated: overrides.authenticated !== false,
          sessionSummary: {
            user: {
              email: overrides.viewerEmail ?? "me@example.invalid",
              ...(overrides.viewerFullName !== undefined
                ? { name: overrides.viewerFullName }
                : {}),
            },
          },
        };
      },
    },
    dockerMcp: {
      calls: [],
      async invokeMcpTool(server, tool, args) {
        this.calls.push({ server, tool, args });
        if (typeof overrides.invokeMcpTool === "function") {
          return await overrides.invokeMcpTool(server, tool, args);
        }
        // Faithful to mcp-orc: tool-level failures come back as HTTP 200
        // (success:true) with an {is_error, message} envelope, and the agent
        // read tools require `model_id` — `agent_id` is the historical wrong
        // name that produced the round-9 "empty bundle" publish failure.
        const modelIdEnvelope = {
          success: true,
          data: {
            is_error: true,
            message: "model_id is required",
            content: "model_id is required",
          },
        };
        if (tool === "subagents_list_agents") {
          events.push("agent-inventory-read");
          if (overrides.agentInventoryError) {
            return { success: false, error: overrides.agentInventoryError.message };
          }
          return {
            success: true,
            data: { agents: overrides.localAgents || [] },
          };
        }
        if (tool === "subagents_reconcile_agent_attribution") {
          events.push("agent-attribution-reconcile");
          return (
            overrides.reconcileResult || {
              success: true,
              data: {},
            }
          );
        }
        if (tool === "subagents_get_agent") {
          if (typeof args?.model_id !== "string" || !args.model_id) {
            return modelIdEnvelope;
          }
          if (overrides.getAgentResult) return overrides.getAgentResult;
          if (overrides.agent === null) return { success: true, data: null };
          // Faithful: the real handler never includes system_prompt — it only
          // comes from subagents_get_agent_system_prompt.
          const defaultAgent = {
            id: args.model_id,
            name: "Helper",
            description: "A helper",
            base_model_id: "atlas-sonnet-5",
            // Empty by default: the degraded main-side publish fails closed
            // for agents with non-system skills (loadOps' default projectRoot
            // doesn't exist, so nothing resolves as system). Guard tests opt
            // into skills with a real tmpdir projectRoot.
            skill_ids: [],
            tool_server_ids: ["server:time"],
            reasoning_effort: "high",
            creation_source: "local",
            created_by_email: overrides.viewerEmail ?? "me@example.invalid",
            marketplace_relationship: null,
            marketplace_solution_id: null,
            is_read_only: false,
          };
          return {
            success: true,
            data:
              overrides.agent === undefined
                ? defaultAgent
                : { ...defaultAgent, ...overrides.agent },
          };
        }
        if (tool === "subagents_get_agent_system_prompt") {
          if (typeof args?.model_id !== "string" || !args.model_id) {
            return modelIdEnvelope;
          }
          if (overrides.promptResult) return overrides.promptResult;
          return {
            success: true,
            data: {
              model_id: args.model_id,
              system_prompt: overrides.systemPrompt ?? "You are a helper.",
            },
          };
        }
        if (tool === "skills_read_skill") {
          // Faithful to the Rust handler: takes skill_name, nests frontmatter
          // under `metadata` (there is NO skills_get_skill tool).
          if (typeof args?.skill_name !== "string" || !args.skill_name) {
            return {
              success: true,
              data: { is_error: true, message: "skill_name is required" },
            };
          }
          return (
            overrides.skillMetaResult || {
              success: true,
              data: {
                success: true,
                skill_name: args.skill_name,
                metadata: {
                  required_mcp_servers: ["server:time"],
                  created_by_email: overrides.viewerEmail ?? "me@example.invalid",
                },
                content: "---\n---\n",
              },
            }
          );
        }
        return { success: true, data: {} };
      },
    },
    bootstrap: { PROJECT_ROOT: overrides.projectRoot || "/tmp/does-not-exist-project" },
    secrets: {
      DEFAULT_MANAGED_ROOT: "/tmp/managed",
      resolveAiMarketplaceApiKey: () => (overrides.apiKey === undefined ? "key-123" : overrides.apiKey),
    },
  };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => "/tmp" }, BrowserWindow: {}, dialog: {} };
    }
    if (request === "fs" && overrides.fsPromises) {
      const realFs = origLoad.apply(this, arguments);
      return { ...realFs, promises: overrides.fsPromises };
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
  for (const [k, keyPath] of Object.entries(cacheKeys)) {
    saved[keyPath] = require.cache[keyPath];
    require.cache[keyPath] = { id: keyPath, filename: keyPath, loaded: true, exports: fakes[k] };
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
  return { ops, fakes };
}

async function makeMarketplaceProject() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "portico-288-operations-"));
}

async function writeSkillFile(projectRoot, relativeDir, content = "# Skill\n") {
  const filePath = path.join(projectRoot, relativeDir, "SKILL.md");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function writeInstalledSkillConfig(projectRoot, installedSkills) {
  const configPath = path.join(projectRoot, "marketplaces.json");
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ marketplaces: [], installedSkills }, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

function installedSkillRecord({
  skillId = "incident-review",
  solutionId = "skill-solution",
  localPath = `skills-marketplace/ai-marketplace/${skillId}`,
} = {}) {
  return {
    marketplaceId: "ai-marketplace",
    skillId,
    localPath,
    skillSource: {
      type: "ai-marketplace-solution",
      solutionId,
    },
  };
}

function skillBundle(name = "incident-review") {
  return {
    type: "skills",
    payload: { name, skill_md: `# ${name}\n` },
  };
}

async function createStatefulLifecycleHarness() {
  const projectRoot = await makeMarketplaceProject();
  const state = {
    viewerEmail: "me@example.invalid",
    nextSolution: 1,
    remote: new Map(),
    localAgents: new Map(),
    agentLinks: {},
    localSkills: new Map(),
    skillLinks: {},
    installedSkills: [],
  };

  const clone = (value) => structuredClone(value);
  const sanitizeId = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const notFound = (id) =>
    Object.assign(new Error(`Marketplace solution "${id}" was not found.`), {
      code: "not_found",
      status: 404,
      remediation: "Search the Marketplace again and choose an existing solution.",
    });

  async function persistInstalledSkills() {
    await fs.writeFile(
      path.join(projectRoot, "marketplaces.json"),
      `${JSON.stringify(
        { marketplaces: [], installedSkills: state.installedSkills },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function addUserSkill(name, content = `# ${name}\n`) {
    await writeSkillFile(projectRoot, `skills-user/${name}`, content);
    state.localSkills.set(name, {
      name,
      source: "user",
      created_by_email: state.viewerEmail,
      marketplace_relationship: null,
      marketplace_solution_id: null,
      is_read_only: false,
      description: `${name} lifecycle skill`,
    });
    return name;
  }

  function addUserAgent(id, overrides = {}) {
    state.localAgents.set(id, {
      id,
      name: overrides.name || id,
      description: overrides.description || `${id} lifecycle agent`,
      base_model_id: overrides.base_model_id || "atlas-sonnet-5",
      system_prompt: overrides.system_prompt || `Prompt for ${id}.`,
      reasoning_effort: overrides.reasoning_effort || "medium",
      skill_ids: overrides.skill_ids || [],
      tool_server_ids: overrides.tool_server_ids || [],
      creation_source: "local",
      created_by_email: state.viewerEmail,
      marketplace_relationship: null,
      marketplace_solution_id: null,
      is_read_only: false,
    });
    return id;
  }

  function addRemote({
    id,
    type,
    name,
    owner = "other@example.invalid",
    bundle,
  }) {
    const solution = {
      id,
      type,
      name,
      description: `${name} marketplace fixture`,
      author: owner.split("@")[0],
      submitted_by: owner,
      bundle: clone(bundle),
    };
    state.remote.set(id, solution);
    return solution;
  }

  async function installBundle({ bundle, deps }) {
    const solution = state.remote.get(deps.solutionId);
    if (bundle.type === "portico-agents") {
      const id = deps.existingAgentId || sanitizeId(bundle.payload.name);
      const agent = {
        id,
        name: bundle.payload.name,
        description: bundle.payload.description || "",
        base_model_id: bundle.payload.base_model_id,
        system_prompt: bundle.payload.system_prompt,
        reasoning_effort: bundle.payload.reasoning_effort || null,
        skill_ids: clone(bundle.payload.skill_ids || []),
        tool_server_ids: clone(bundle.payload.tool_server_ids || []),
        creation_source: "marketplace",
        created_by_email: solution.submitted_by,
        marketplace_relationship: "installed",
        marketplace_solution_id: deps.solutionId,
        is_read_only: true,
      };
      state.localAgents.set(id, agent);
      state.agentLinks[id] = {
        solutionId: deps.solutionId,
        relationship: "installed",
        authorIdentity: solution.submitted_by,
      };
      return { success: true, created: clone(agent) };
    }

    const id = sanitizeId(bundle.payload.name);
    const localPath = `skills-marketplace/ai-marketplace/${id}`;
    await writeSkillFile(
      projectRoot,
      localPath,
      bundle.payload.skill_md || `# ${id}\n`,
    );
    state.installedSkills = state.installedSkills.filter(
      (entry) =>
        !(
          entry.marketplaceId === "ai-marketplace" &&
          entry.skillId === id
        ),
    );
    state.installedSkills.push({
      marketplaceId: "ai-marketplace",
      skillId: id,
      localPath,
      skillSource: {
        type: "ai-marketplace-solution",
        solutionId: deps.solutionId,
      },
    });
    state.localSkills.set(`ai-marketplace/${id}`, {
      name: id,
      source: "marketplace",
      created_by_email: solution.submitted_by,
      marketplace_relationship: "installed",
      marketplace_solution_id: deps.solutionId,
      is_read_only: true,
      description: solution.description,
    });
    await persistInstalledSkills();
    return { success: true, id, installedPath: localPath };
  }

  await persistInstalledSkills();

  const { ops, fakes } = loadOps({
    projectRoot,
    viewerEmail: state.viewerEmail,
    clientSearch: async (params) => {
      const requestedTypes = Array.isArray(params?.filters?.type)
        ? params.filters.type
        : [params?.filters?.type].filter(Boolean);
      return {
        solutions: [...state.remote.values()]
          .filter(
            (solution) =>
              !requestedTypes.length || requestedTypes.includes(solution.type),
          )
          .map(clone),
      };
    },
    clientGetSolution: async (id) => {
      const solution = state.remote.get(id);
      if (!solution) throw notFound(id);
      return clone(solution);
    },
    clientGetBundle: async (id) => {
      const solution = state.remote.get(id);
      if (!solution) throw notFound(id);
      return clone(solution.bundle);
    },
    clientCreateSolution: async (input) => {
      const id = `owned-${state.nextSolution++}`;
      state.remote.set(id, {
        ...clone(input),
        id,
        status: "active",
        submitted_by: state.viewerEmail,
      });
      // The stateful harness already persisted the posted bundle above —
      // report it like the post-MISC-34 backend does.
      return { id, status: "active", has_bundle: Boolean(input?.bundle) };
    },
    clientUpdateSolution: async (id, patch) => {
      const current = state.remote.get(id);
      if (!current) throw notFound(id);
      if (current.submitted_by !== state.viewerEmail) {
        throw Object.assign(new Error("The current viewer does not own this solution."), {
          code: "not_owner",
          status: 403,
        });
      }
      state.remote.set(id, {
        ...current,
        ...clone(patch),
        id,
        status: "active",
      });
      return { id, status: "active", has_bundle: Boolean(patch.bundle) };
    },
    clientDeleteSolution: async (id) => {
      const current = state.remote.get(id);
      if (!current) throw notFound(id);
      if (current.submitted_by !== state.viewerEmail) {
        throw Object.assign(new Error("The current viewer does not own this solution."), {
          code: "not_owner",
          status: 403,
        });
      }
      state.remote.delete(id);
      return { id, status: "deleted" };
    },
    buildPublishBundleImpl: async (args) => {
      if (args.type === "portico-agents") {
        return {
          type: "portico-agents",
          payload: clone(args.agent),
        };
      }
      const skillMd = await fs.readFile(
        path.join(projectRoot, args.skill.path, "SKILL.md"),
        "utf8",
      );
      return {
        type: "skills",
        payload: {
          name: args.skill.name,
          skill_md: skillMd,
          required_mcp_servers: clone(
            args.skill.required_mcp_servers || [],
          ),
          references: [],
          scripts: [],
        },
      };
    },
    installImpl: installBundle,
    readAgentLinks: async () => ({
      schemaVersion: 2,
      links: clone(state.agentLinks),
    }),
    setPublishedAgentLink: async (localAgentId, solutionId, authorIdentity) => {
      state.agentLinks[localAgentId] = {
        solutionId,
        relationship: "published",
        authorIdentity,
      };
      const agent = state.localAgents.get(localAgentId);
      if (agent) {
        Object.assign(agent, {
          creation_source: "local",
          created_by_email: state.viewerEmail,
          marketplace_relationship: "published",
          marketplace_solution_id: solutionId,
          is_read_only: false,
        });
      }
      return clone(state.agentLinks[localAgentId]);
    },
    clearPublishedAgentLinks: async (solutionId) => {
      const cleared = [];
      for (const [localAgentId, link] of Object.entries(state.agentLinks)) {
        if (
          link.solutionId === solutionId &&
          link.relationship === "published"
        ) {
          delete state.agentLinks[localAgentId];
          cleared.push(localAgentId);
          const agent = state.localAgents.get(localAgentId);
          if (agent) {
            Object.assign(agent, {
              marketplace_relationship: null,
              marketplace_solution_id: null,
              is_read_only: false,
            });
          }
        }
      }
      return cleared;
    },
    clearAgentLink: async (localAgentId) => {
      const existed = Object.hasOwn(state.agentLinks, localAgentId);
      delete state.agentLinks[localAgentId];
      return existed;
    },
    readSkillLinks: async () => ({ links: clone(state.skillLinks) }),
    setPublishedSkillLink: async (localSkillName, solutionId) => {
      state.skillLinks[localSkillName] = { solutionId };
      const skill = state.localSkills.get(localSkillName);
      if (skill) {
        Object.assign(skill, {
          marketplace_relationship: "published",
          marketplace_solution_id: solutionId,
          is_read_only: false,
        });
      }
      return { solutionId };
    },
    clearPublishedSkillLinks: async (solutionId) => {
      const cleared = [];
      for (const [localSkillName, link] of Object.entries(state.skillLinks)) {
        if (link.solutionId === solutionId) {
          delete state.skillLinks[localSkillName];
          cleared.push(localSkillName);
          const skill = state.localSkills.get(localSkillName);
          if (skill) {
            Object.assign(skill, {
              marketplace_relationship: null,
              marketplace_solution_id: null,
              is_read_only: false,
            });
          }
        }
      }
      return cleared;
    },
    clearSkillLink: async (localSkillName) => {
      const existed = Object.hasOwn(state.skillLinks, localSkillName);
      delete state.skillLinks[localSkillName];
      return existed;
    },
    uninstallSkillImpl: async ({ marketplaceId, skillId }) => {
      const localPath = path.join(
        projectRoot,
        "skills-marketplace",
        marketplaceId,
        skillId,
      );
      await fs.rm(localPath, { recursive: true, force: true });
      state.installedSkills = state.installedSkills.filter(
        (entry) =>
          !(
            entry.marketplaceId === marketplaceId &&
            entry.skillId === skillId
          ),
      );
      state.localSkills.delete(`${marketplaceId}/${skillId}`);
      await persistInstalledSkills();
      return { marketplaceId, skillId, localPath };
    },
    invokeMcpTool: async (_server, tool, args) => {
      if (tool === "subagents_list_agents") {
        return {
          success: true,
          data: { agents: [...state.localAgents.values()].map(clone) },
        };
      }
      if (tool === "subagents_get_agent") {
        const agent = state.localAgents.get(args.model_id);
        return { success: true, data: agent ? clone(agent) : null };
      }
      if (tool === "subagents_get_agent_system_prompt") {
        const agent = state.localAgents.get(args.model_id);
        return {
          success: true,
          data: agent
            ? {
                model_id: args.model_id,
                system_prompt: agent.system_prompt,
              }
            : null,
        };
      }
      if (tool === "subagents_reconcile_agent_attribution") {
        const ids = [...state.localAgents.keys()];
        return {
          success: true,
          data: {
            repaired_ids: ids,
            unchanged_ids: ids,
            failures: [],
            skipped_base_ids: [],
            skipped_system_ids: [],
            skipped_linked_ids: [],
            missing_creator_linked_ids: [],
          },
        };
      }
      if (tool === "skills_read_skill") {
        const direct = state.localSkills.get(args.skill_name);
        const installed = state.localSkills.get(
          `ai-marketplace/${args.skill_name}`,
        );
        const skill = direct || installed;
        if (!skill) {
          return {
            success: true,
            data: {
              is_error: true,
              message: `Skill "${args.skill_name}" was not found.`,
            },
          };
        }
        return {
          success: true,
          data: {
            success: true,
            skill_name: args.skill_name,
            metadata: clone(skill),
            content: `---\nname: ${args.skill_name}\n---\n`,
          },
        };
      }
      return { success: true, data: {} };
    },
  });

  return {
    projectRoot,
    state,
    ops,
    fakes,
    addUserAgent,
    addUserSkill,
    addRemote,
    cleanup: () => fs.rm(projectRoot, { recursive: true, force: true }),
  };
}

test("buildAndPublishAgent fetches the agent, builds a bundle, and publishes with a single create", async () => {
  const { ops, fakes } = loadOps();
  const result = await ops.buildAndPublishAgent({ agentId: "helper-1", allowedEmails: ["a@x.com"] });
  assert.equal(result.publishStatus.status, "active");
  assert.equal(fakes.client.created.length, 1);
  // The backend persists the bundle on POST (MISC-34) — no follow-up PUT.
  assert.equal(fakes.client.updated.length, 0);
  const created = fakes.client.created[0].solution;
  assert.equal(created.type, "portico-agents");
  assert.equal(created.submitted_by, "me@example.invalid");
  // Visibility override is threaded into the published payload.
  assert.deepEqual(created.allowed_emails, ["a@x.com"]);
  assert.equal(created.system_prompt, "You are a helper.");
  assert.deepEqual(fakes.links.published, [
    {
      localAgentId: "helper-1",
      solutionId: "sol-new",
      authorIdentity: "me@example.invalid",
    },
  ]);
});

test("buildAndPublishAgent refuses to publish an agent with an empty system prompt", async () => {
  const { ops } = loadOps({ systemPrompt: "   " });
  await assert.rejects(() => ops.buildAndPublishAgent({ agentId: "helper-1" }), /empty/i);
});

test("buildAndPublishAgent rejects a missing agent id", async () => {
  const { ops } = loadOps();
  await assert.rejects(() => ops.buildAndPublishAgent({}), /agent_id is required/);
});

test("agent read tools are called with model_id, never agent_id", async () => {
  const { ops, fakes } = loadOps();
  const { agent, systemPrompt } = await ops.getAgentForPublish("helper-1");
  assert.equal(agent.id, "helper-1");
  assert.equal(systemPrompt, "You are a helper.");
  const reads = fakes.dockerMcp.calls.filter((c) =>
    c.tool === "subagents_get_agent" || c.tool === "subagents_get_agent_system_prompt",
  );
  assert.equal(reads.length, 2);
  for (const call of reads) {
    assert.equal(call.args.model_id, "helper-1");
    assert.ok(!("agent_id" in call.args), `${call.tool} must not send agent_id`);
  }
});

test("tool error envelopes surface the server's message instead of masquerading as data", async () => {
  // Historical bug: mcp-orc returns tool failures as HTTP 200 with an
  // {is_error, message} envelope; the envelope used to flow through as a
  // truthy "agent" with no prompt and fail as "empty bundle".
  const { ops } = loadOps({
    getAgentResult: {
      success: true,
      data: {
        is_error: true,
        message: "model_id is required",
        content: "model_id is required",
      },
    },
  });
  await assert.rejects(
    () => ops.buildAndPublishAgent({ agentId: "helper-1" }),
    (error) => {
      assert.match(error.message, /model_id is required/);
      assert.doesNotMatch(error.message, /empty/i);
      return true;
    },
  );
});

test("a failed system-prompt fetch is a real error, not an empty bundle", async () => {
  const { ops } = loadOps({
    promptResult: {
      success: true,
      data: { is_error: true, message: "prompt store unavailable" },
    },
  });
  await assert.rejects(
    () => ops.buildAndPublishAgent({ agentId: "helper-1" }),
    /prompt store unavailable/,
  );
});

test("buildAndPublishAgent reuses prefetched agent data without re-fetching", async () => {
  const { ops, fakes } = loadOps();
  const prefetched = await ops.getAgentForPublish("helper-1");
  fakes.dockerMcp.calls.length = 0;
  const result = await ops.buildAndPublishAgent({ agentId: "helper-1", prefetched });
  assert.equal(result.publishStatus.status, "active");
  const reads = fakes.dockerMcp.calls.filter((c) =>
    c.tool === "subagents_get_agent" || c.tool === "subagents_get_agent_system_prompt",
  );
  assert.equal(reads.length, 0, "prefetched publish must not re-fetch the agent");
});

// Round 8 (publish-modal consolidation): the app's modal publishes dependent
// USER skills first and embeds skill_refs; this main-side degraded path
// cannot, so it must fail closed rather than silently publish an agent whose
// dependency wiring is stripped (the Loupe Update Generator bug).
test("buildAndPublishAgent fails closed when the agent depends on non-system skills", async (t) => {
  const fsSync = require("node:fs");
  const projectRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "portico-ops-guard-"));
  t.after(() => fsSync.rmSync(projectRoot, { recursive: true, force: true }));
  fsSync.mkdirSync(path.join(projectRoot, "skills-user", "my-notes"), { recursive: true });
  fsSync.writeFileSync(
    path.join(projectRoot, "skills-user", "my-notes", "SKILL.md"),
    "---\nname: my-notes\n---\n",
  );
  const { ops, fakes } = loadOps({
    projectRoot,
    agent: { skill_ids: ["my-notes"] },
  });
  await assert.rejects(
    () => ops.buildAndPublishAgent({ agentId: "helper-1" }),
    (error) => {
      assert.equal(error.code, "dependent_skills_require_app_publish");
      assert.match(error.message, /my-notes/);
      assert.match(error.message, /Agents tab/);
      assert.match(error.remediation || "", /publishes dependent skills first/);
      return true;
    },
  );
  assert.equal(fakes.client.created.length, 0, "fail-closed means zero marketplace writes");
  assert.equal(fakes.client.updated.length, 0);
});

test("buildAndPublishAgent fails closed on unresolvable skill ids", async () => {
  const { ops, fakes } = loadOps({ agent: { skill_ids: ["ghost-skill"] } });
  await assert.rejects(
    () => ops.buildAndPublishAgent({ agentId: "helper-1" }),
    (error) => {
      assert.equal(error.code, "dependent_skills_require_app_publish");
      assert.match(error.message, /ghost-skill/);
      return true;
    },
  );
  assert.equal(fakes.client.created.length, 0);
});

test("buildAndPublishAgent still publishes agents whose skills are all built-in", async (t) => {
  const fsSync = require("node:fs");
  const projectRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "portico-ops-guard-sys-"));
  t.after(() => fsSync.rmSync(projectRoot, { recursive: true, force: true }));
  fsSync.mkdirSync(path.join(projectRoot, "skills", "web-search"), { recursive: true });
  fsSync.writeFileSync(
    path.join(projectRoot, "skills", "web-search", "SKILL.md"),
    "---\nname: web-search\n---\n",
  );
  const { ops, fakes } = loadOps({
    projectRoot,
    agent: { skill_ids: ["web-search"] },
  });
  const result = await ops.buildAndPublishAgent({ agentId: "helper-1" });
  assert.equal(result.publishStatus.status, "active");
  assert.equal(fakes.client.created.length, 1, "system-only agents publish degraded");
});

// Round 10: the external marketplace validator requires `author` on every
// solution write ("Missing required fields: name, description, author, type,
// and one of (detail_url, bundle)"). The control-plane renderer supplies it;
// the agentic main-process paths must default it from the viewer identity.
test("agentic publish payloads carry author + detail_url on the single create", async () => {
  const { ops, fakes } = loadOps();
  await ops.buildAndPublishAgent({ agentId: "helper-1" });
  const created = fakes.client.created[0].solution;
  // Owner form of the viewer email — the same value the control-plane's
  // whoami-based author produces and ownership matching compares against.
  assert.equal(created.author, "me", "create carries the defaulted author");
  assert.equal(created.submitted_by, "me@example.invalid");
  assert.equal(
    created.detail_url,
    "https://solutions.sandbox.example.invalid/?type=portico-agents",
    "create carries the marketplace listing detail_url",
  );
});

test("an explicit caller-supplied author is preserved (control-plane parity)", async () => {
  const create = loadOps();
  await create.ops.publishSolution(
    {
      name: "n",
      description: "d",
      author: "dsantiago",
      type: "portico-agents",
    },
    { localAgentId: "helper-1" },
  );
  assert.equal(create.fakes.client.created[0].solution.author, "dsantiago");
  assert.equal(create.fakes.client.created[0].solution.submitted_by, "me@example.invalid");

  // Same preservation on the update path. The update path now requires the
  // local artifact to already be linked to the target solution (PORTICO-316), so
  // the agent is published/linked to sol-3.
  const update = loadOps({
    agent: {
      marketplace_relationship: "published",
      marketplace_solution_id: "sol-3",
    },
  });
  await update.ops.updatePublishedSolution(
    "sol-3",
    {
      name: "n",
      author: "dsantiago",
      type: "portico-agents",
    },
    { localAgentId: "helper-1" },
  );
  assert.equal(update.fakes.client.updated.at(-1).patch.author, "dsantiago");
});

test("partial update patches (no author) still get the defaulted author", async () => {
  const { ops, fakes } = loadOps({
    agent: {
      marketplace_relationship: "published",
      marketplace_solution_id: "sol-3",
    },
  });
  await ops.updatePublishedSolution(
    "sol-3",
    {
      type: "portico-agents",
      allowed_emails: ["a@x.com"],
    },
    { localAgentId: "helper-1" },
  );
  const { patch } = fakes.client.updated[0];
  assert.equal(patch.author, "me");
  assert.equal(patch.submitted_by, "me@example.invalid");
  assert.deepEqual(patch.allowed_emails, ["a@x.com"]);
});

test("description is never empty: agents fall back to name, skills synthesize one", async () => {
  // Description-less agent -> falls back to the agent name (validator requires
  // a description, and install.js emits description: "" for agents without one).
  const { ops, fakes } = loadOps({
    agent: {
      id: "helper-1",
      name: "Helper",
      description: "",
      base_model_id: "atlas-sonnet-5",
    },
  });
  await ops.buildAndPublishAgent({ agentId: "helper-1" });
  assert.equal(fakes.client.created[0].solution.description, "Helper");
});

test("the republish PUT (existingSolutionId) also carries author + detail_url", async () => {
  const { ops, fakes } = loadOps({
    agent: {
      marketplace_relationship: "published",
      marketplace_solution_id: "sol-7",
    },
  });
  await ops.buildAndPublishAgent({ agentId: "helper-1", existingSolutionId: "sol-7" });
  assert.equal(fakes.client.created.length, 0, "republish must not create");
  const putBody = fakes.client.updated[0].patch;
  assert.equal(fakes.client.updated[0].id, "sol-7");
  assert.equal(putBody.author, "me");
  assert.equal(
    putBody.detail_url,
    "https://solutions.sandbox.example.invalid/?type=portico-agents",
  );
});

test("buildAndPublishSkill payloads carry author + detail_url too", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-ops-skill-"));
  fs.mkdirSync(path.join(projectRoot, "skills-user", "test-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "test-skill", "SKILL.md"),
    "---\nname: test-skill\n---\n",
  );
  try {
    const { ops, fakes } = loadOps({ projectRoot });
    await ops.buildAndPublishSkill({ skillId: "test-skill" });
    const created = fakes.client.created[0].solution;
    assert.equal(created.author, "me");
    assert.equal(
      created.detail_url,
      "https://solutions.sandbox.example.invalid/?type=skills",
    );
    // The real publishSkillBundle payload carries NO description key, and the
    // validator requires one — it must be synthesized.
    assert.equal(
      created.description,
      'Agent Skill "test-skill" published via Portico.',
    );

    // When the skills MCP metadata has a description, prefer it.
    const withMeta = loadOps({
      projectRoot,
      skillMetaResult: {
        success: true,
        data: {
          success: true,
          skill_name: "test-skill",
          metadata: {
            required_mcp_servers: [],
            description: "Does things.",
            created_by_email: "me@example.invalid",
          },
          content: "---\n---\n",
        },
      },
    });
    await withMeta.ops.buildAndPublishSkill({ skillId: "test-skill" });
    assert.equal(withMeta.fakes.client.created[0].solution.description, "Does things.");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// Round 11: solutions are stored with type "skills" (plural) but callers
// historically searched "skill" (singular) — the marketplace's exact-match
// filter returned nothing and every published skill was invisible to chat.
test("search normalizes the singular 'skill' type filter to the stored 'skills'", async () => {
  const { ops, fakes } = loadOps();
  await ops.search({ query: "architecture", filters: { type: "skill" } });
  assert.deepEqual(fakes.client.searches[0].params.filters.type, "skills");
  await ops.search({ query: "", filters: { type: ["skill", "agents"] } });
  assert.deepEqual(fakes.client.searches[1].params.filters.type, [
    "skills",
    "portico-agents",
  ]);
  // Unknown types pass through untouched.
  await ops.search({ query: "", filters: { type: "glean::agents" } });
  assert.equal(fakes.client.searches[2].params.filters.type, "glean::agents");
});

test("listPublished without a type queries each known type instead of the raw index", async () => {
  // An unfiltered search returns the global index (first pages are all
  // glean agents), so the viewer's solutions never reach the owner filter.
  const { ops, fakes } = loadOps({
    solutions: [
      { id: "s1", type: "skills", submitted_by: "me" },
      { id: "x1", type: "skills", submitted_by: "someone-else" },
    ],
  });
  const data = await ops.listPublished({});
  assert.equal(fakes.client.searches.length, 2);
  assert.deepEqual(
    fakes.client.searches.map((s) => s.params.filters.type),
    [["skills"], ["portico-agents"]],
  );
  // Owner filter still applies across the merged pages.
  assert.deepEqual(data.solutions.map((s) => s.id), ["s1", "s1"]);

  // The singular alias normalizes on the explicit-type path too.
  fakes.client.searches.length = 0;
  await ops.listPublished({ type: "skill" });
  assert.deepEqual(fakes.client.searches[0].params.filters.type, ["skills"]);
});

test("chat-side skill publishes maintain the local skill-links registry", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-ops-slink-"));
  fs.mkdirSync(path.join(projectRoot, "skills-user", "test-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "test-skill", "SKILL.md"),
    "---\nname: test-skill\n---\n",
  );
  try {
    const { ops, fakes } = loadOps({ projectRoot });
    const published = await ops.buildAndPublishSkill({ skillId: "test-skill" });
    assert.deepEqual(fakes.skillLinks.skillLinksSet, [
      { localSkillName: "test-skill", solutionId: "sol-new" },
    ]);
    // Identity keys ride alongside the legacy shape so the chat route can
    // compose a flat envelope without re-deriving the id.
    assert.equal(published.skill_id, "test-skill");
    assert.equal(published.solution_id, "sol-new");
    assert.equal(published.action, "created");
    assert.equal(published.publishStatus.id, "sol-new");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("deleting a published solution clears skill links alongside agent links", async () => {
  const { ops, fakes } = loadOps({
    clearPublishedSkillLinks: async () => ["test-skill"],
  });
  const result = await ops.deletePublishedSolution("sol-9");
  assert.deepEqual(fakes.links.clearedPublished, ["sol-9"]);
  assert.deepEqual(fakes.skillLinks.skillLinksCleared, ["sol-9"]);
  // The cleanup results ride the return so the unpublish envelope can say
  // what was touched locally.
  assert.deepEqual(result.clearedSkillLinks, ["test-skill"]);
  assert.deepEqual(result.clearedAgentIds, []);
  assert.equal(
    fakes.dockerMcp.calls.filter(
      (call) => call.tool === "subagents_reconcile_agent_attribution",
    ).length,
    0,
    "skill-only unpublish must not depend on the Subagents server",
  );
});

test("agent unpublish clears links then reconciles every affected local agent once", async () => {
  const { ops, fakes } = loadOps({
    clearedAgentIds: ["helper-b", "helper-a", "helper-a"],
    reconcileResult: {
      success: true,
      data: {
        repaired_ids: ["helper-a"],
        unchanged_ids: ["helper-b"],
        failures: [],
        skipped_base_ids: [],
        skipped_system_ids: [],
        skipped_linked_ids: [],
        missing_creator_linked_ids: [],
      },
    },
  });

  const result = await ops.deletePublishedSolution("sol-9");

  assert.equal(result.data.status, "deleted");
  assert.deepEqual(result.clearedAgentIds, ["helper-b", "helper-a", "helper-a"]);
  assert.deepEqual(fakes.events, [
    "remote-delete",
    "agent-links-clear",
    "skill-links-clear",
    "agent-attribution-reconcile",
  ]);
  assert.equal(
    fakes.dockerMcp.calls.filter(
      (call) => call.tool === "subagents_reconcile_agent_attribution",
    ).length,
    1,
  );
});

test("agent unpublish reports remote completion when local cleanup is not confirmed", async () => {
  const { ops, fakes } = loadOps({
    clearedAgentIds: ["helper-b", "helper-a"],
    reconcileResult: {
      success: true,
      data: {
        repaired_ids: ["helper-b"],
        unchanged_ids: [],
        failures: [],
        skipped_linked_ids: ["helper-a"],
      },
    },
  });

  await assert.rejects(
    () => ops.deletePublishedSolution("sol-9"),
    (error) => {
      assert.equal(error.code, "agent_attribution_failed");
      assert.match(error.message, /was removed, but local published state cleanup failed/);
      assert.deepEqual(error.body, {
        remote_deleted: true,
        solution_id: "sol-9",
        local_agent_ids: ["helper-a", "helper-b"],
        cause_code: "agent_attribution_failed",
      });
      return true;
    },
  );
  assert.equal(fakes.client.deleted.length, 1);
  assert.deepEqual(fakes.links.clearedPublished, ["sol-9"]);
});

test("getSkillForPublish resolves display metadata for the confirmation card", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-ops-gsfp-"));
  fs.mkdirSync(path.join(projectRoot, "skills-user", "my-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "my-skill", "SKILL.md"),
    "---\nname: my-skill\n---\n",
  );
  try {
    const { ops } = loadOps({
      projectRoot,
      skillMetaResult: {
        success: true,
        data: {
          success: true,
          skill_name: "my-skill",
          metadata: {
            description: "Does things.",
            version: "1.1.0",
            author: "EJS",
            created_by_email: "me@example.invalid",
            required_mcp_servers: [],
          },
          content: "---\n---\n",
        },
      },
    });
    const { skill } = await ops.getSkillForPublish("my-skill");
    assert.equal(skill.name, "my-skill");
    assert.equal(skill.source, "user");
    assert.equal(skill.description, "Does things.");
    assert.equal(skill.version, "1.1.0");
    assert.equal(skill.created_by_email, "me@example.invalid");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
  await assert.rejects(() => loadOps().ops.getSkillForPublish(""), /skill_id is required/);
  await assert.rejects(
    () => loadOps().ops.getSkillForPublish("does-not-exist"),
    /not found on disk/,
  );
});

test("agent publish preflight rejects installed, foreign, and unknown provenance before mutation", async () => {
  const cases = [
    {
      name: "installed",
      agent: {
        creation_source: "marketplace",
        marketplace_relationship: "installed",
        marketplace_solution_id: "foreign-agent",
        is_read_only: true,
        created_by_email: "other@example.invalid",
      },
      code: "installed_copy_read_only",
      // Owner-aware: steers self-authored installed copies to the in-place
      // reclaim before falling back to the duplicate-copy path.
      remediation: /convert the installed copy in place \(reclaim_agent \/ reclaim_skill\); otherwise create an editable user copy/,
    },
    {
      name: "foreign editable attribution",
      agent: { created_by_email: "other@example.invalid" },
      code: "not_owner",
      remediation: /list_published_agents/,
    },
    {
      name: "unknown",
      agent: {
        creation_source: "migrated",
        marketplace_relationship: "unknown",
      },
      code: "marketplace_relationship_unknown",
      remediation: /contradictory local Marketplace provenance/,
    },
  ];

  for (const scenario of cases) {
    const { ops, fakes } = loadOps({ agent: scenario.agent });
    await assert.rejects(
      () => ops.buildAndPublishAgent({ agentId: "helper-1" }),
      (error) => {
        assert.equal(error.code, scenario.code, scenario.name);
        assert.match(error.remediation, scenario.remediation, scenario.name);
        return true;
      },
    );
    assert.equal(fakes.client.created.length, 0, scenario.name);
    assert.equal(fakes.client.updated.length, 0, scenario.name);
  }
});

test("fresh agent publication rejects an exact normalized Marketplace name collision before writes", async () => {
  const { ops, fakes } = loadOps({
    solutions: [
      {
        id: "wrong-type-same-name",
        type: "skills",
        name: "HELPER",
        submitted_by: "other@example.invalid",
      },
      {
        id: "existing-agent-name",
        type: "portico-agents",
        name: "  hElPeR  ",
        submitted_by: "other@example.invalid",
      },
    ],
  });

  await assert.rejects(
    () => ops.buildAndPublishAgent({ agentId: "helper-1" }),
    (error) => {
      assert.equal(error.code, "solution_name_conflict");
      assert.match(error.message, /agent named "Helper" already exists/);
      assert.match(error.remediation, /Choose a unique name/);
      assert.deepEqual(error.body.matching_solution_ids, [
        "existing-agent-name",
      ]);
      return true;
    },
  );
  assert.equal(fakes.client.created.length, 0);
  assert.equal(fakes.client.updated.length, 0);
  assert.equal(fakes.links.published.length, 0);
});

test("fresh skill publication rejects an exact normalized Marketplace name collision before writes", async () => {
  const fs = require("node:fs");
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "portico-ops-skill-name-conflict-"),
  );
  fs.mkdirSync(path.join(projectRoot, "skills-user", "collision-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "collision-skill", "SKILL.md"),
    "---\nname: collision-skill\n---\n",
  );
  try {
    const { ops, fakes } = loadOps({
      projectRoot,
      solutions: [
        {
          id: "existing-skill-name",
          type: "skills",
          name: "  COLLISION-SKILL ",
          submitted_by: "other@example.invalid",
        },
      ],
    });
    await assert.rejects(
      () => ops.buildAndPublishSkill({ skillId: "collision-skill" }),
      (error) => {
        assert.equal(error.code, "solution_name_conflict");
        assert.match(error.message, /skill named "collision-skill" already exists/);
        assert.match(error.remediation, /Choose a unique name/);
        return true;
      },
    );
    assert.equal(fakes.client.created.length, 0);
    assert.equal(fakes.client.updated.length, 0);
    assert.equal(fakes.skillLinks.skillLinksSet.length, 0);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("foreign republish and unpublish fail ownership preflight without remote writes", async () => {
  const foreignSolution = {
    id: "foreign-agent",
    type: "portico-agents",
    name: "Foreign agent",
    submitted_by: "other@example.invalid",
  };
  const republish = loadOps({ solution: foreignSolution });
  await assert.rejects(
    () =>
      republish.ops.buildAndPublishAgent({
        agentId: "helper-1",
        existingSolutionId: foreignSolution.id,
      }),
    (error) => {
      assert.equal(error.code, "not_owner");
      assert.match(error.remediation, /list_published_agents/);
      return true;
    },
  );
  assert.equal(republish.fakes.client.created.length, 0);
  assert.equal(republish.fakes.client.updated.length, 0);

  const unpublish = loadOps({ solution: foreignSolution });
  await assert.rejects(
    () =>
      unpublish.ops.deletePublishedSolution(foreignSolution.id, {
        expectedType: "portico-agents",
      }),
    (error) => error?.code === "not_owner",
  );
  assert.equal(unpublish.fakes.client.deleted.length, 0);
  assert.deepEqual(unpublish.fakes.events, []);
});

test("PORTICO-316: an unlinked agent cannot hijack another owned solution via existing_solution_id", async () => {
  // Skill/Agent B is unlinked (default fixture), solution V is owned by the
  // viewer but belongs to Agent A. Supplying V as existing_solution_id must be
  // rejected as a linkage mismatch even though the viewer owns V — and, above
  // all, no remote bundle/listing write may happen.
  const victim = {
    id: "victim-agent",
    type: "portico-agents",
    name: "Victim agent",
    submitted_by: "me@example.invalid",
  };
  const { ops, fakes } = loadOps({ solution: victim, solutions: [victim] });

  await assert.rejects(
    () =>
      ops.buildAndPublishAgent({
        agentId: "helper-1",
        existingSolutionId: "victim-agent",
      }),
    (error) => {
      assert.equal(error.code, "marketplace_link_mismatch");
      assert.equal(error.body.linked_solution_id, null);
      assert.equal(error.body.requested_solution_id, "victim-agent");
      return true;
    },
  );
  assert.equal(fakes.client.created.length, 0, "no create");
  assert.equal(fakes.client.updated.length, 0, "no overwrite of the victim bundle");
  assert.equal(fakes.links.published.length, 0, "no local link mutation");
});

test("PORTICO-316: an unlinked skill cannot hijack another owned solution via existing_solution_id", async () => {
  const fs = require("node:fs");
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "portico316-skill-hijack-"),
  );
  fs.mkdirSync(path.join(projectRoot, "skills-user", "attacker-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "attacker-skill", "SKILL.md"),
    "---\nname: attacker-skill\n---\n",
  );
  try {
    const victim = {
      id: "victim-skill",
      type: "skills",
      name: "Victim skill",
      submitted_by: "me@example.invalid",
    };
    const { ops, fakes } = loadOps({
      projectRoot,
      solution: victim,
      solutions: [victim],
      // attacker-skill is unlinked: no entry in the skill-links state.
      skillLinks: {},
    });

    await assert.rejects(
      () =>
        ops.buildAndPublishSkill({
          skillId: "attacker-skill",
          existingSolutionId: "victim-skill",
        }),
      (error) => {
        assert.equal(error.code, "marketplace_link_mismatch");
        assert.equal(error.body.linked_solution_id, null);
        assert.equal(error.body.requested_solution_id, "victim-skill");
        return true;
      },
    );
    assert.equal(fakes.client.created.length, 0, "no create");
    assert.equal(fakes.client.updated.length, 0, "no overwrite of the victim bundle");
    assert.equal(fakes.skillLinks.skillLinksSet.length, 0, "no local link mutation");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("PORTICO-316: a correctly-linked agent republish with its own existing_solution_id still succeeds", async () => {
  // Guardrail: the linkage check must not break the legitimate republish path.
  const owned = {
    id: "owned-agent",
    type: "portico-agents",
    name: "Helper",
    submitted_by: "me@example.invalid",
  };
  const { ops, fakes } = loadOps({
    solution: owned,
    solutions: [owned],
    // Agent B is genuinely linked to owned-agent (published relationship).
    agent: {
      marketplace_relationship: "published",
      marketplace_solution_id: "owned-agent",
    },
  });

  const result = await ops.buildAndPublishAgent({
    agentId: "helper-1",
    existingSolutionId: "owned-agent",
  });
  assert.ok(result, "republish returns a result");
  assert.equal(fakes.client.updated.length, 1, "the linked solution is updated");
  assert.equal(fakes.client.created.length, 0, "republish updates, never creates");
});

test("repeated unpublish of a deleted solution reports deterministic absence without writes", async () => {
  const deletedSolution = {
    id: "already-deleted-agent",
    type: "portico-agents",
    name: "Already deleted agent",
    status: "deleted",
    submitted_by: "me@example.invalid",
  };
  const { ops, fakes } = loadOps({ solution: deletedSolution });

  await assert.rejects(
    () =>
      ops.deletePublishedSolution(deletedSolution.id, {
        expectedType: "portico-agents",
      }),
    (error) => {
      assert.equal(error.code, "solution_not_found");
      assert.equal(error.remediation, "Discover or publish a current Marketplace solution before retrying.");
      return true;
    },
  );
  assert.equal(fakes.client.deleted.length, 0);
  assert.deepEqual(fakes.events, []);
});

test("agent and skill operations reject cross-type solution ids before mutation", async () => {
  const agentSolution = {
    id: "agent-solution",
    type: "portico-agents",
    submitted_by: "me@example.invalid",
  };
  const skillSolution = {
    id: "skill-solution",
    type: "skills",
    submitted_by: "me@example.invalid",
  };

  const agentAsSkill = loadOps({
    solution: agentSolution,
    bundle: {
      type: "portico-agents",
      payload: { name: "Agent solution" },
    },
  });
  await assert.rejects(
    () =>
      agentAsSkill.ops.install(agentSolution.id, {
        expectedType: "skills",
      }),
    (error) => error?.code === "solution_type_mismatch",
  );
  assert.equal(agentAsSkill.fakes.install.calls.length, 0);

  const skillAsAgent = loadOps({ solution: skillSolution });
  await assert.rejects(
    () =>
      skillAsAgent.ops.updatePublishedSolution(
        skillSolution.id,
        { type: "portico-agents", name: "Wrong type" },
        { localAgentId: "helper-1" },
      ),
    (error) => error?.code === "solution_type_mismatch",
  );
  await assert.rejects(
    () =>
      skillAsAgent.ops.deletePublishedSolution(skillSolution.id, {
        expectedType: "portico-agents",
      }),
    (error) => error?.code === "solution_type_mismatch",
  );
  assert.equal(skillAsAgent.fakes.client.updated.length, 0);
  assert.equal(skillAsAgent.fakes.client.deleted.length, 0);
});

test("installed and foreign user skills cannot publish or republish", async () => {
  const projectRoot = await makeMarketplaceProject();
  await writeSkillFile(
    projectRoot,
    "skills-marketplace/ai-marketplace/installed-skill",
  );
  await writeSkillFile(projectRoot, "skills-user/foreign-user-skill");
  try {
    const installed = loadOps({ projectRoot });
    await assert.rejects(
      () =>
        installed.ops.buildAndPublishSkill({
          skillId: "ai-marketplace/installed-skill",
        }),
      (error) => error?.code === "installed_copy_read_only",
    );
    assert.equal(installed.fakes.client.created.length, 0);

    const foreignUser = loadOps({
      projectRoot,
      skillMetaResult: {
        success: true,
        data: {
          success: true,
          skill_name: "foreign-user-skill",
          metadata: {
            name: "foreign-user-skill",
            description: "Foreign attribution",
            created_by_email: "other@example.invalid",
          },
          content: "---\n---\n",
        },
      },
    });
    await assert.rejects(
      () =>
        foreignUser.ops.buildAndPublishSkill({
          skillId: "foreign-user-skill",
        }),
      (error) => error?.code === "not_owner",
    );
    assert.equal(foreignUser.fakes.client.created.length, 0);
    assert.equal(foreignUser.fakes.client.updated.length, 0);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("source-aware skill deletion removes only the authoritative local copy", async () => {
  const userRoot = await makeMarketplaceProject();
  const installedRoot = await makeMarketplaceProject();
  const systemRoot = await makeMarketplaceProject();
  try {
    const userFile = await writeSkillFile(
      userRoot,
      "skills-user/user-skill",
      "# User\n",
    );
    const user = loadOps({ projectRoot: userRoot });
    const userResult = await user.ops.deleteLocalSkill("user-skill");
    assert.equal(userResult.source, "user");
    // H1-synthesized title, captured before the directory was removed.
    assert.equal(userResult.display_name, "User");
    assert.equal(userResult.remote_solution_deleted, false);
    await assert.rejects(() => fs.access(userFile));
    assert.deepEqual(user.fakes.skillLinks.localLinksCleared, ["user-skill"]);
    assert.equal(user.fakes.client.deleted.length, 0);

    await writeSkillFile(
      installedRoot,
      "skills-marketplace/ai-marketplace/installed-skill",
      "# Installed\n",
    );
    await writeInstalledSkillConfig(installedRoot, [
      installedSkillRecord({
        skillId: "installed-skill",
        solutionId: "foreign-skill-solution",
        localPath:
          "skills-marketplace/ai-marketplace/installed-skill",
      }),
    ]);
    const installed = loadOps({ projectRoot: installedRoot });
    const installedResult = await installed.ops.deleteLocalSkill(
      "ai-marketplace/installed-skill",
    );
    assert.equal(installedResult.source, "marketplace");
    assert.equal(installedResult.display_name, "Installed");
    assert.equal(installedResult.marketplace_relationship, "installed");
    assert.equal(
      installedResult.marketplace_solution_id,
      "foreign-skill-solution",
    );
    assert.equal(installedResult.remote_solution_deleted, false);
    assert.equal(installed.fakes.marketplaceService.uninstallCalls.length, 1);
    assert.deepEqual(
      installed.fakes.marketplaceService.uninstallCalls[0],
      {
        projectRoot: installedRoot,
        marketplaceId: "ai-marketplace",
        skillId: "installed-skill",
        logger: console,
      },
    );
    assert.deepEqual(installed.fakes.skillLinks.localLinksCleared, [
      "installed-skill",
    ]);
    assert.equal(installed.fakes.client.deleted.length, 0);

    await writeSkillFile(systemRoot, "skills/system-skill", "# System\n");
    const system = loadOps({ projectRoot: systemRoot });
    await assert.rejects(
      () => system.ops.deleteLocalSkill("system-skill"),
      (error) => error?.code === "system_skill_read_only",
    );
    assert.equal(system.fakes.marketplaceService.uninstallCalls.length, 0);
  } finally {
    await Promise.all(
      [userRoot, installedRoot, systemRoot].map((root) =>
        fs.rm(root, { recursive: true, force: true }),
      ),
    );
  }
});

test("deleteLocalSkill reports authored display_name and derives when it restates the kebab id", async () => {
  const authoredRoot = await makeMarketplaceProject();
  const kebabRoot = await makeMarketplaceProject();
  try {
    await writeSkillFile(
      authoredRoot,
      "skills-user/mcp-log-reader",
      "---\nname: mcp-log-reader\ndescription: Reads logs.\ndisplay_name: Log Reader Pro\n---\nBody\n",
    );
    const authored = loadOps({ projectRoot: authoredRoot });
    const authoredResult = await authored.ops.deleteLocalSkill("mcp-log-reader");
    assert.equal(authoredResult.display_name, "Log Reader Pro");

    await writeSkillFile(
      kebabRoot,
      "skills-user/plain-title",
      "---\nname: plain-title\ndescription: Plain.\ndisplay_name: plain-title\n---\nBody\n",
    );
    const kebab = loadOps({ projectRoot: kebabRoot });
    const kebabResult = await kebab.ops.deleteLocalSkill("plain-title");
    assert.equal(kebabResult.display_name, "Plain Title");
  } finally {
    await Promise.all(
      [authoredRoot, kebabRoot].map((root) =>
        fs.rm(root, { recursive: true, force: true }),
      ),
    );
  }
});

test("local agent deletion bookkeeping never deletes the remote solution", async () => {
  const { ops, fakes } = loadOps({ agentLinkRemoved: true });
  const result = await ops.clearDeletedAgentLink("installed-agent");
  assert.deepEqual(result, {
    success: true,
    local_agent_id: "installed-agent",
    link_removed: true,
    remote_solution_deleted: false,
  });
  assert.deepEqual(fakes.links.clearedLocal, ["installed-agent"]);
  assert.equal(fakes.client.deleted.length, 0);
});

test("publish rejects a linked null creator before remote Marketplace mutation", async () => {
  const { ops, fakes } = loadOps({
    agent: {
      created_by_email: null,
    },
    reconcileResult: {
      success: true,
      data: {
        failures: [],
        skipped_linked_ids: ["helper-1"],
        missing_creator_linked_ids: ["helper-1"],
      },
    },
  });
  await assert.rejects(
    () => ops.buildAndPublishAgent({ agentId: "helper-1" }),
    /authoritative creator attribution/,
  );
  assert.equal(fakes.client.created.length, 0);
  assert.equal(fakes.links.published.length, 0);
});

test("publish requires an API key and a resolved viewer identity", async () => {
  const noKey = loadOps({ apiKey: "" });
  await assert.rejects(() => noKey.ops.buildAndPublishAgent({ agentId: "a" }), /API key is not set/);
  const noUser = loadOps({ viewerEmail: "" });
  await assert.rejects(() => noUser.ops.buildAndPublishAgent({ agentId: "a" }), /user identity/);
  const unauthenticated = loadOps({ authenticated: false });
  await assert.rejects(
    () => unauthenticated.ops.buildAndPublishAgent({ agentId: "a" }),
    /user identity/,
  );
  const bareHandle = loadOps({ viewerEmail: "dsantiago" });
  await assert.rejects(
    () => bareHandle.ops.buildAndPublishAgent({ agentId: "a" }),
    /user identity/,
  );
});

test("deletePublishedSolution removes a published solution with the viewer identity", async () => {
  const { ops, fakes } = loadOps();
  const result = await ops.deletePublishedSolution("sol-9");
  assert.equal(result.data.status, "deleted");
  assert.equal(fakes.client.deleted[0].id, "sol-9");
  assert.equal(fakes.client.deleted[0].opts.submittedBy, "me@example.invalid");
  assert.deepEqual(fakes.links.clearedPublished, ["sol-9"]);
});

test("listPublished returns only the viewer's own solutions", async () => {
  const solutions = [
    { id: "1", submitted_by: "me@example.invalid" },
    { id: "2", submitted_by: "someone@else.com" },
    { id: "3", submitted_by: "ME@example.invalid" },
    { id: "4", submitted_by: "Me" },
  ];
  const { ops, fakes } = loadOps({ solutions });
  const data = await ops.listPublished({ type: "portico-agents" });
  assert.deepEqual(fakes.client.searches[0].params.filters, {
    type: ["portico-agents"],
  });
  assert.deepEqual(data.solutions.map((s) => s.id).sort(), ["1", "3", "4"]);
  assert.equal(data.viewer_email, "me@example.invalid");
});

test("search and getSolution pass through the client with the viewer email", async () => {
  const { ops, fakes } = loadOps();
  await ops.search({ query: "planner" });
  assert.equal(fakes.client.searches[0].params.query, "planner");
  assert.equal(fakes.client.searches[0].opts.viewerEmail, "me@example.invalid");
  const sol = await ops.getSolution("sol-5");
  assert.equal(sol.id, "sol-5");
});

// The marketplace's version_history embeds previous_values — full SUPERSEDED
// listing payloads that read exactly like current data (chat c6f2570f: two
// models reported a superseded skill_ref as a live dependency). Every
// semantic read strips it; the empty array is the backend's own trimmed form.
test("marketplace reads strip version_history from listing envelopes", async () => {
  const staleHistory = () => [
    {
      version_id: "old-version",
      timestamp: 1785000000,
      previous_values: {
        skill_ids: ["kept-skill", "removed-skill"],
        skill_refs: [
          { kind: "solution", skill_id: "removed-skill", solution_id: "deleted-sol-id" },
        ],
      },
    },
  ];

  const { ops } = loadOps({
    clientSearch: async () => ({
      results: [
        { id: "sol-1", type: "skills", submitted_by: "me@example.invalid", version_history: staleHistory() },
      ],
    }),
    clientGetSolution: async (id) => ({
      id,
      type: "skills",
      submitted_by: "me@example.invalid",
      version_history: staleHistory(),
    }),
  });

  const payload = await ops.search({ query: "" });
  assert.deepEqual(payload.results[0].version_history, []);

  const solution = await ops.getSolution("sol-1");
  assert.deepEqual(solution.version_history, []);
  assert.equal(solution.id, "sol-1", "the rest of the envelope is untouched");
});

// Skill solutions carry only kebab names (legacy listings no title at all);
// the read layer injects display_name for skill-type solutions at the same
// seam that strips version_history. Agents are untouched — their name IS the
// display name.
test("marketplace reads inject display_name for skill solutions only", async () => {
  const { ops } = loadOps({
    clientSearch: async () => ({
      solutions: [
        {
          id: "sol-legacy",
          type: "skills",
          name: "epic-voice-booster",
          submitted_by: "me@example.invalid",
        },
        {
          id: "sol-titled",
          type: "skills",
          name: "log-reader",
          bundle: { payload: { display_name: "Log Reader Pro" } },
          submitted_by: "me@example.invalid",
        },
        {
          id: "sol-agent",
          type: "portico-agents",
          name: "Funhouse Creative",
          submitted_by: "me@example.invalid",
        },
      ],
    }),
    clientGetSolution: async (id) => ({
      id,
      type: "skills",
      name: "epic-voice-booster",
      // A stored title that restates the kebab id must derive instead.
      bundle: { payload: { display_name: "epic-voice-booster" } },
      submitted_by: "me@example.invalid",
    }),
    clientGetBundle: async () => ({
      type: "skills",
      payload: { name: "weekly-team-update-generator" },
    }),
  });

  const payload = await ops.search({ query: "" });
  const byId = Object.fromEntries(payload.solutions.map((s) => [s.id, s]));
  assert.equal(byId["sol-legacy"].display_name, "Epic Voice Booster");
  assert.equal(byId["sol-titled"].display_name, "Log Reader Pro");
  assert.equal(byId["sol-agent"].display_name, undefined);

  const solution = await ops.getSolution("sol-x");
  assert.equal(solution.display_name, "Epic Voice Booster");

  const bundle = await ops.getBundle("sol-b");
  assert.equal(bundle.display_name, "Weekly Team Update Generator");
});

test("listPublished injects display_name for the viewer's skill listings", async () => {
  const { ops } = loadOps({
    solutions: [
      {
        id: "mine-skill",
        type: "skills",
        name: "icebreaker-carousel",
        submitted_by: "me@example.invalid",
      },
      {
        id: "mine-agent",
        type: "portico-agents",
        name: "Funhouse Creative",
        submitted_by: "me@example.invalid",
      },
    ],
  });
  const data = await ops.listPublished();
  const byId = Object.fromEntries(data.solutions.map((s) => [s.id, s]));
  assert.equal(byId["mine-skill"].display_name, "Icebreaker Carousel");
  assert.equal(byId["mine-agent"].display_name, undefined);
});

// The bundle payload's display_name (derived in install.js's real
// buildPublishBundle — covered by ai-marketplace-install.test.js) must ride
// the solutionInput spread to the backend, top-level and inside bundle.
test("publish forwards the bundle payload's display_name to the marketplace", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-ops-skill-title-"));
  fs.mkdirSync(path.join(projectRoot, "skills-user", "mcp-log-reader"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "mcp-log-reader", "SKILL.md"),
    "---\nname: mcp-log-reader\ndescription: Reads logs.\ndisplay_name: Log Reader Pro\n---\nBody\n",
  );
  try {
    const { ops, fakes } = loadOps({
      projectRoot,
      buildPublishBundleImpl: async (args) => ({
        type: "skills",
        payload: {
          name: args.skill.name,
          display_name: "Log Reader Pro",
          skill_md: "---\nname: mcp-log-reader\n---\n",
        },
      }),
    });
    await ops.buildAndPublishSkill({ skillId: "mcp-log-reader" });
    const created = fakes.client.created[0].solution;
    assert.equal(created.display_name, "Log Reader Pro");
    assert.equal(created.bundle.payload.display_name, "Log Reader Pro");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("listPublished strips version_history from the viewer's listings", async () => {
  const { ops } = loadOps({
    solutions: [
      {
        id: "mine-1",
        type: "skills",
        submitted_by: "me@example.invalid",
        version_history: [
          { version_id: "v0", previous_values: { skill_ids: ["ghost-skill"] } },
        ],
      },
      { id: "theirs", type: "skills", submitted_by: "someone@else.com" },
    ],
  });
  const data = await ops.listPublished({ type: "skills" });
  assert.deepEqual(data.solutions.map((s) => s.id), ["mine-1"]);
  assert.deepEqual(data.solutions[0].version_history, []);
});

test("solution reads normalize remote 404s to solution_not_found", async () => {
  const unavailable = Object.assign(new Error("Solution not found"), {
    code: "http_error",
    status: 404,
    body: { error: "Solution not found" },
  });
  const { ops } = loadOps({
    solutionError: unavailable,
    bundleError: unavailable,
  });

  for (const read of [
    () => ops.getSolution("deleted-solution"),
    () => ops.getBundle("deleted-solution"),
  ]) {
    await assert.rejects(read, (error) => {
      assert.equal(error.code, "solution_not_found");
      assert.equal(error.status, 404);
      assert.equal(
        error.remediation,
        "Discover or publish a current Marketplace solution before retrying.",
      );
      assert.deepEqual(error.body, { solution_id: "deleted-solution" });
      return true;
    });
  }
});

test("install rejects unavailable bundles before inventory or local mutation", async () => {
  const unavailable = Object.assign(new Error("Solution not found"), {
    code: "not_found",
    status: 404,
  });
  const { ops, fakes } = loadOps({ bundleError: unavailable });

  await assert.rejects(
    () => ops.install("deleted-solution"),
    (error) => error?.code === "solution_not_found",
  );

  assert.deepEqual(fakes.client.bundleGets, ["deleted-solution"]);
  assert.deepEqual(fakes.client.solutionGets, []);
  assert.deepEqual(fakes.install.calls, []);
  assert.deepEqual(fakes.dockerMcp.calls, []);
  assert.equal(fakes.links.strictReads, 0);
  assert.equal(fakes.skillLinks.strictReads, 0);
  assert.deepEqual(fakes.events, []);
});

test("bare agent install rejects the publisher's extant linked original", async () => {
  const solutionId = "agent-solution";
  const { ops, fakes } = loadOps({
    localAgents: [{ id: "publisher-agent" }],
    agentLinks: {
      "publisher-agent": {
        solutionId,
        relationship: "published",
      },
    },
  });

  await assert.rejects(
    () => ops.install(solutionId),
    (error) => {
      assert.equal(error.code, "solution_already_installed");
      assert.equal(error.body.existing[0].id, "publisher-agent");
      return true;
    },
  );
  assert.equal(fakes.install.calls.length, 0);
});

test("bare agent reinstall rejects an extant installed link but ignores a stale link", async () => {
  const solutionId = "agent-solution";
  const extant = loadOps({
    localAgents: [{ id: "installed-agent" }],
    agentLinks: {
      "installed-agent": { solutionId, relationship: "installed" },
    },
  });
  await assert.rejects(
    () => extant.ops.install(solutionId),
    (error) => error?.code === "solution_already_installed",
  );
  assert.equal(extant.fakes.install.calls.length, 0);

  const stale = loadOps({
    localAgents: [],
    agentLinks: {
      "deleted-agent": { solutionId, relationship: "installed" },
    },
  });
  await stale.ops.install(solutionId);
  assert.equal(stale.fakes.install.calls.length, 1);
});

test("explicit agent refresh requires the exact unique solution link", async () => {
  const solutionId = "agent-solution";
  const matching = loadOps({
    localAgents: [{ id: "installed-agent" }],
    agentLinks: {
      "installed-agent": { solutionId, relationship: "installed" },
    },
  });
  await matching.ops.install(solutionId, { existingAgentId: "installed-agent" });
  assert.equal(
    matching.fakes.install.calls[0].deps.existingAgentId,
    "installed-agent",
  );

  const wrong = loadOps({
    localAgents: [{ id: "other-agent" }],
    agentLinks: {
      "other-agent": { solutionId: "other-solution", relationship: "installed" },
    },
  });
  await assert.rejects(
    () => wrong.ops.install(solutionId, { existingAgentId: "other-agent" }),
    (error) => error?.code === "marketplace_link_mismatch",
  );
  assert.equal(wrong.fakes.install.calls.length, 0);

  const ambiguous = loadOps({
    localAgents: [{ id: "agent-a" }, { id: "agent-b" }],
    agentLinks: {
      "agent-a": { solutionId, relationship: "installed" },
      "agent-b": { solutionId, relationship: "published" },
    },
  });
  await assert.rejects(
    () => ambiguous.ops.install(solutionId, { existingAgentId: "agent-a" }),
    (error) => error?.code === "solution_already_installed",
  );
  assert.equal(ambiguous.fakes.install.calls.length, 0);

  const staleRequested = loadOps({
    localAgents: [{ id: "agent-b" }],
    agentLinks: {
      "agent-a": { solutionId, relationship: "installed" },
      "agent-b": { solutionId, relationship: "installed" },
    },
  });
  await assert.rejects(
    () =>
      staleRequested.ops.install(solutionId, {
        existingAgentId: "agent-a",
      }),
    (error) => error?.code === "marketplace_relationship_mismatch",
  );
  assert.equal(staleRequested.fakes.install.calls.length, 0);
});

test("concurrent same-solution agent installs serialize and only one mutates", async () => {
  const solutionId = "concurrent-agent-solution";
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let mutations = 0;
  const overrides = {
    localAgents: [],
    agentLinks: {},
    installImpl: async () => {
      mutations += 1;
      markFirstStarted();
      await release;
      overrides.localAgents.push({ id: "serialized-agent" });
      overrides.agentLinks["serialized-agent"] = {
        solutionId,
        relationship: "installed",
      };
      return { installed: true };
    },
  };
  const { ops } = loadOps(overrides);

  const first = ops.install(solutionId);
  await firstStarted;
  const second = ops.install(solutionId);
  releaseFirst();
  await first;
  await assert.rejects(
    () => second,
    (error) => error?.code === "solution_already_installed",
  );
  assert.equal(mutations, 1);
});

test("different solution ids targeting one skill destination serialize before mutation", async () => {
  const projectRoot = await makeMarketplaceProject();
  const firstId = "skill-solution-a";
  const secondId = "skill-solution-b";
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let mutations = 0;
  const { ops } = loadOps({
    projectRoot,
    bundlesById: {
      [firstId]: skillBundle("shared-destination"),
      [secondId]: skillBundle("shared-destination"),
    },
    solutionsById: {
      [firstId]: { id: firstId, type: "skills", submitted_by: "owner" },
      [secondId]: { id: secondId, type: "skills", submitted_by: "owner" },
    },
    installImpl: async ({ deps }) => {
      mutations += 1;
      markFirstStarted();
      await release;
      const relativeDir = "skills-marketplace/ai-marketplace/shared-destination";
      await writeSkillFile(projectRoot, relativeDir, "# First install\n");
      await writeInstalledSkillConfig(projectRoot, [
        installedSkillRecord({
          skillId: "shared-destination",
          solutionId: deps.solutionId,
          localPath: relativeDir,
        }),
      ]);
      return { id: "shared-destination", installedPath: relativeDir };
    },
  });

  const first = ops.install(firstId);
  await firstStarted;
  const second = ops.install(secondId);
  releaseFirst();
  await first;
  await assert.rejects(
    () => second,
    (error) => error?.code === "skill_install_target_conflict",
  );
  assert.equal(mutations, 1);
});

test("cross-referencing concurrent agent installs settle without lock inversion", async () => {
  const firstId = "agent-a";
  const secondId = "agent-b";
  const { ops } = loadOps({
    bundlesById: {
      [firstId]: { type: "portico-agents", payload: { name: "Agent A" } },
      [secondId]: { type: "portico-agents", payload: { name: "Agent B" } },
    },
    installImpl: async ({ bundle, deps }) => {
      const childId = bundle.payload.name === "Agent A" ? secondId : firstId;
      return await deps.installSkillDependency({
        expectedSkillId: "peer-agent",
        solutionId: childId,
      });
    },
  });

  const installs = Promise.allSettled([ops.install(firstId), ops.install(secondId)]);
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("install queue deadlocked")), 250);
    timer.unref?.();
  });
  const results = await Promise.race([installs, timeout]);

  assert.deepEqual(
    results.map((result) => result.reason?.code),
    ["skill_dependency_type_mismatch", "skill_dependency_type_mismatch"],
  );
});

test("legacy marketplace config without installedSkills is treated as empty", async () => {
  const projectRoot = await makeMarketplaceProject();
  await fs.writeFile(
    path.join(projectRoot, "marketplaces.json"),
    JSON.stringify({ marketplaces: [] }),
    "utf8",
  );
  const solutionId = "legacy-config-skill";
  const { ops, fakes } = loadOps({
    projectRoot,
    bundle: skillBundle("legacy-config-skill"),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
  });

  await ops.install(solutionId);
  assert.equal(fakes.install.calls.length, 1);
});

test("skill install blocks an extant published original without mutation", async () => {
  const projectRoot = await makeMarketplaceProject();
  const skillFile = await writeSkillFile(
    projectRoot,
    "skills-user/incident-review",
    "# Publisher original\n",
  );
  const solutionId = "skill-solution";
  const { ops, fakes } = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
    skillLinks: {
      "incident-review": { solutionId },
    },
  });

  await assert.rejects(
    () => ops.install(solutionId),
    (error) => error?.code === "solution_already_installed",
  );
  assert.equal(fakes.install.calls.length, 0);
  assert.equal(await fs.readFile(skillFile, "utf8"), "# Publisher original\n");
  await assert.rejects(() => fs.access(path.join(projectRoot, "marketplaces.json")));
});

test("ordinary skill reinstall blocks exact installed provenance byte-for-byte", async () => {
  const projectRoot = await makeMarketplaceProject();
  const solutionId = "skill-solution";
  const relativeDir = "skills-marketplace/ai-marketplace/incident-review";
  const skillFile = await writeSkillFile(projectRoot, relativeDir, "# Installed\n");
  const configPath = await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({ solutionId, localPath: relativeDir }),
  ]);
  const beforeConfig = await fs.readFile(configPath);
  const beforeSkill = await fs.readFile(skillFile);
  const { ops, fakes } = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
  });

  await assert.rejects(
    () => ops.install(solutionId),
    (error) => error?.code === "solution_already_installed",
  );
  assert.equal(fakes.install.calls.length, 0);
  assert.deepEqual(await fs.readFile(configPath), beforeConfig);
  assert.deepEqual(await fs.readFile(skillFile), beforeSkill);
});

test("skill refresh is allowed only for one exact provenance-bound destination", async () => {
  const projectRoot = await makeMarketplaceProject();
  const solutionId = "skill-solution";
  const relativeDir = "skills-marketplace/ai-marketplace/incident-review";
  await writeSkillFile(projectRoot, relativeDir);
  await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({ solutionId, localPath: relativeDir }),
  ]);
  const exact = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
  });
  await exact.ops.install(solutionId, {
    refreshInstalledSkillId: "incident-review",
  });
  assert.equal(exact.fakes.install.calls.length, 1);

  await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({ solutionId, localPath: relativeDir }),
    installedSkillRecord({
      skillId: "deleted-copy",
      solutionId,
      localPath: "skills-marketplace/ai-marketplace/deleted-copy",
    }),
  ]);
  const staleDuplicate = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
  });
  await staleDuplicate.ops.install(solutionId, {
    refreshInstalledSkillId: "incident-review",
  });
  assert.equal(staleDuplicate.fakes.install.calls.length, 1);

  const renamed = loadOps({
    projectRoot,
    bundle: skillBundle("renamed-skill"),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
  });
  await assert.rejects(
    () =>
      renamed.ops.install(solutionId, {
        refreshInstalledSkillId: "incident-review",
      }),
    (error) => error?.code === "marketplace_relationship_mismatch",
  );
  assert.equal(renamed.fakes.install.calls.length, 0);
});

test("skill refresh rejects multiple extant records for one solution", async () => {
  const projectRoot = await makeMarketplaceProject();
  const solutionId = "skill-solution";
  await writeSkillFile(
    projectRoot,
    "skills-marketplace/ai-marketplace/incident-review",
  );
  await writeSkillFile(
    projectRoot,
    "skills-marketplace/ai-marketplace/incident-review-copy",
  );
  await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({ solutionId }),
    installedSkillRecord({
      skillId: "incident-review-copy",
      solutionId,
      localPath: "skills-marketplace/ai-marketplace/incident-review-copy",
    }),
  ]);
  const { ops, fakes } = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
  });

  await assert.rejects(
    () =>
      ops.install(solutionId, {
        refreshInstalledSkillId: "incident-review",
      }),
    (error) => error?.code === "solution_already_installed",
  );
  assert.equal(fakes.install.calls.length, 0);
});

test("stale skill provenance does not block but an untracked destination does", async () => {
  const projectRoot = await makeMarketplaceProject();
  const solutionId = "skill-solution";
  await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({ solutionId }),
  ]);
  const stale = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
    skillLinks: { "incident-review": { solutionId } },
  });
  await stale.ops.install(solutionId);
  assert.equal(stale.fakes.install.calls.length, 1);

  await writeSkillFile(
    projectRoot,
    "skills-marketplace/ai-marketplace/incident-review",
    "# Untracked\n",
  );
  await writeInstalledSkillConfig(projectRoot, []);
  const conflict = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
  });
  await assert.rejects(
    () => conflict.ops.install(solutionId),
    (error) => error?.code === "skill_install_target_conflict",
  );
  assert.equal(conflict.fakes.install.calls.length, 0);
});

test("skill install fails closed when strict provenance is malformed or unreadable", async () => {
  const projectRoot = await makeMarketplaceProject();
  const solutionId = "skill-solution";
  await writeSkillFile(projectRoot, "skills-user/incident-review");

  const malformed = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
    skillLinksError: new SyntaxError("ambiguous skill links"),
  });
  await assert.rejects(
    () => malformed.ops.install(solutionId),
    (error) => error?.code === "local_provenance_unavailable",
  );
  assert.equal(malformed.fakes.install.calls.length, 0);

  const realFs = fs;
  const unreadable = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
    skillLinks: { "incident-review": { solutionId } },
    fsPromises: {
      ...realFs,
      async lstat(target) {
        if (path.resolve(target) === path.join(projectRoot, "skills-user")) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return await realFs.lstat(target);
      },
    },
  });
  await assert.rejects(
    () => unreadable.ops.install(solutionId),
    (error) => error?.code === "local_provenance_unavailable",
  );
  assert.equal(unreadable.fakes.install.calls.length, 0);

  const skillFile = path.join(
    projectRoot,
    "skills-user",
    "incident-review",
    "SKILL.md",
  );
  const unreadableFile = loadOps({
    projectRoot,
    bundle: skillBundle(),
    solution: { id: solutionId, type: "skills", submitted_by: "owner" },
    skillLinks: { "incident-review": { solutionId } },
    fsPromises: {
      ...realFs,
      async lstat(target) {
        if (path.resolve(target) === skillFile) {
          throw Object.assign(new Error("I/O failure"), { code: "EIO" });
        }
        return await realFs.lstat(target);
      },
    },
  });
  await assert.rejects(
    () => unreadableFile.ops.install(solutionId),
    (error) => error?.code === "local_provenance_unavailable",
  );
  assert.equal(unreadableFile.fakes.install.calls.length, 0);
});

test("guarded agent dependency rejects a ref whose id differs from its bundle", async () => {
  const projectRoot = await makeMarketplaceProject();
  const parentId = "parent-agent";
  const childId = "child-skill";
  let childMutations = 0;
  const { ops } = loadOps({
    projectRoot,
    bundlesById: {
      [parentId]: { type: "portico-agents", payload: { name: "Parent" } },
      [childId]: skillBundle("different-skill"),
    },
    installImpl: async ({ bundle, deps }) => {
      if (bundle.type === "portico-agents") {
        return await deps.installSkillDependency({
          expectedSkillId: "expected-skill",
          solutionId: childId,
        });
      }
      childMutations += 1;
      return { id: "different-skill" };
    },
  });

  await assert.rejects(
    () => ops.install(parentId),
    (error) => error?.code === "skill_dependency_id_mismatch",
  );
  assert.equal(childMutations, 0);
  await assert.rejects(() => fs.access(path.join(projectRoot, "marketplaces.json")));
});

test("concurrent parent installs share one serialized dependency install", async () => {
  const projectRoot = await makeMarketplaceProject();
  const parentA = "parent-a";
  const parentB = "parent-b";
  const childId = "shared-skill";
  let childMutations = 0;
  let releaseChild;
  let markChildStarted;
  const childStarted = new Promise((resolve) => {
    markChildStarted = resolve;
  });
  const childRelease = new Promise((resolve) => {
    releaseChild = resolve;
  });
  const overrides = {
    projectRoot,
    bundlesById: {
      [parentA]: { type: "portico-agents", payload: { name: "Parent A" } },
      [parentB]: { type: "portico-agents", payload: { name: "Parent B" } },
      [childId]: skillBundle("shared-skill"),
    },
    installImpl: async ({ bundle, deps }) => {
      if (bundle.type === "portico-agents") {
        return await deps.installSkillDependency({
          expectedSkillId: "shared-skill",
          solutionId: childId,
        });
      }
      childMutations += 1;
      markChildStarted();
      await childRelease;
      const relativeDir = "skills-marketplace/ai-marketplace/shared-skill";
      await writeSkillFile(projectRoot, relativeDir, "# Shared\n");
      await writeInstalledSkillConfig(projectRoot, [
        installedSkillRecord({
          skillId: "shared-skill",
          solutionId: childId,
          localPath: relativeDir,
        }),
      ]);
      return {
        id: "shared-skill",
        installedPath: relativeDir,
      };
    },
  };
  const { ops } = loadOps(overrides);

  const first = ops.install(parentA);
  const second = ops.install(parentB);
  await childStarted;
  releaseChild();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.localSkillId, "ai-marketplace/shared-skill");
  assert.equal(secondResult.localSkillId, "ai-marketplace/shared-skill");
  assert.equal(childMutations, 1);
});

test("dependency provenance errors fail closed after tolerant inventory errors", async () => {
  const projectRoot = await makeMarketplaceProject();
  const parentId = "parent-agent";
  const childId = "published-child";
  const marketplaceRoot = path.join(projectRoot, "skills-marketplace");
  await writeSkillFile(
    projectRoot,
    "skills-marketplace/custom-source/published-child",
  );
  let childMutations = 0;
  const realFs = fs;
  const { ops } = loadOps({
    projectRoot,
    bundlesById: {
      [parentId]: { type: "portico-agents", payload: { name: "Parent" } },
      [childId]: skillBundle("published-child"),
    },
    skillLinks: {
      "published-child": { solutionId: childId },
    },
    fsPromises: {
      ...realFs,
      async readdir(target, options) {
        if (path.resolve(target) === marketplaceRoot) {
          throw Object.assign(new Error("I/O failure"), { code: "EIO" });
        }
        return await realFs.readdir(target, options);
      },
    },
    installImpl: async ({ bundle, deps }) => {
      if (bundle.type === "portico-agents") {
        return await deps.installSkillDependency({
          expectedSkillId: "published-child",
          solutionId: childId,
        });
      }
      childMutations += 1;
      return { id: "published-child" };
    },
  });

  await assert.rejects(
    () => ops.install(parentId),
    (error) => error?.code === "local_provenance_unavailable",
  );
  assert.equal(childMutations, 0);
});

test("a reused guarded dependency survives a later parent failure", async () => {
  const projectRoot = await makeMarketplaceProject();
  const parentId = "failing-parent";
  const childId = "existing-child";
  const relativeDir = "skills-marketplace/ai-marketplace/existing-child";
  const skillFile = await writeSkillFile(projectRoot, relativeDir, "# Existing\n");
  await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({
      skillId: "existing-child",
      solutionId: childId,
      localPath: relativeDir,
    }),
  ]);
  let childMutations = 0;
  const { ops } = loadOps({
    projectRoot,
    bundlesById: {
      [parentId]: { type: "portico-agents", payload: { name: "Parent" } },
      [childId]: skillBundle("existing-child"),
    },
    installImpl: async ({ bundle, deps }) => {
      if (bundle.type === "portico-agents") {
        const reused = await deps.installSkillDependency({
          expectedSkillId: "existing-child",
          solutionId: childId,
        });
        assert.equal(reused.newlyInstalled, false);
        throw new Error("parent failed after dependency resolution");
      }
      childMutations += 1;
      return { id: "existing-child" };
    },
  });

  await assert.rejects(() => ops.install(parentId), /parent failed/);
  assert.equal(childMutations, 0);
  assert.equal(await fs.readFile(skillFile, "utf8"), "# Existing\n");
});

test("stateful fake Marketplace mirrors the four canonical agent lifecycle scenarios", async () => {
  const harness = await createStatefulLifecycleHarness();
  const { state, ops, addUserAgent, addRemote, projectRoot } = harness;
  // agent-one depends on a SYSTEM skill: create it on disk so the main-side
  // dependent-skill guard classifies it as built-in (publishable degraded).
  await writeSkillFile(projectRoot, "skills/planner");
  addRemote({
    id: "foreign-agent-solution",
    type: "portico-agents",
    name: "foreign-agent",
    bundle: {
      type: "portico-agents",
      payload: {
        name: "foreign-agent",
        description: "Foreign fixture",
        base_model_id: "atlas-sonnet-5",
        system_prompt: "Foreign prompt.",
        reasoning_effort: "medium",
        skill_ids: [],
        tool_server_ids: [],
      },
    },
  });
  addRemote({
    id: "foreign-skill-solution",
    type: "skills",
    name: "foreign-skill",
    bundle: skillBundle("foreign-skill"),
  });

  try {
    // Scenario 1: local editable source -> publish -> same-id republish ->
    // unpublish, leaving the exact local configuration intact.
    addUserAgent("agent-one", {
      system_prompt: "Agent one exact prompt.",
      skill_ids: ["planner"],
      tool_server_ids: ["server:time"],
    });
    const firstPublish = await ops.buildAndPublishAgent({
      agentId: "agent-one",
    });
    const firstSolutionId = firstPublish.publishStatus.id;
    assert.ok(firstSolutionId);
    assert.equal(
      state.localAgents.get("agent-one").marketplace_relationship,
      "published",
    );
    assert.equal(
      state.remote.get(firstSolutionId).bundle.payload.system_prompt,
      "Agent one exact prompt.",
    );
    const remoteCountBeforeRepublish = state.remote.size;
    const republished = await ops.buildAndPublishAgent({
      agentId: "agent-one",
      existingSolutionId: firstSolutionId,
    });
    assert.equal(republished.publishStatus.id, firstSolutionId);
    assert.equal(state.remote.size, remoteCountBeforeRepublish);
    await ops.deletePublishedSolution(firstSolutionId, {
      expectedType: "portico-agents",
    });
    assert.equal(state.remote.has(firstSolutionId), false);
    assert.equal(state.localAgents.has("agent-one"), true);
    assert.equal(
      state.localAgents.get("agent-one").system_prompt,
      "Agent one exact prompt.",
    );
    assert.equal(
      state.localAgents.get("agent-one").marketplace_relationship,
      null,
    );

    // Scenario 2: foreign installation is read-only, rejects all remote
    // ownership actions and duplicate/invalid refreshes, and local deletion
    // leaves the listing intact.
    await ops.install("foreign-agent-solution", {
      expectedType: "portico-agents",
    });
    const installed = state.localAgents.get("foreign-agent");
    assert.equal(installed.creation_source, "marketplace");
    assert.equal(installed.marketplace_relationship, "installed");
    assert.equal(installed.marketplace_solution_id, "foreign-agent-solution");
    assert.equal(installed.is_read_only, true);
    await assert.rejects(
      () => ops.buildAndPublishAgent({ agentId: "foreign-agent" }),
      (error) => error?.code === "installed_copy_read_only",
    );
    await assert.rejects(
      () =>
        ops.buildAndPublishAgent({
          agentId: "foreign-agent",
          existingSolutionId: "foreign-agent-solution",
        }),
      (error) => error?.code === "installed_copy_read_only",
    );
    await assert.rejects(
      () =>
        ops.deletePublishedSolution("foreign-agent-solution", {
          expectedType: "portico-agents",
        }),
      (error) => error?.code === "not_owner",
    );
    await assert.rejects(
      () =>
        ops.install("foreign-agent-solution", {
          expectedType: "portico-agents",
        }),
      (error) => error?.code === "solution_already_installed",
    );
    addUserAgent("unrelated-refresh-target");
    await assert.rejects(
      () =>
        ops.install("foreign-agent-solution", {
          expectedType: "portico-agents",
          existingAgentId: "unrelated-refresh-target",
        }),
      (error) => error?.code === "marketplace_link_mismatch",
    );
    state.localAgents.delete("foreign-agent");
    const deletedInstalled = await ops.clearDeletedAgentLink("foreign-agent");
    assert.equal(deletedInstalled.remote_solution_deleted, false);
    assert.equal(state.remote.has("foreign-agent-solution"), true);

    // Scenario 3: a locally published source is already represented, including
    // when someone misuses its id as an installed refresh target.
    addUserAgent("agent-three");
    const thirdPublish = await ops.buildAndPublishAgent({
      agentId: "agent-three",
    });
    const thirdSolutionId = thirdPublish.publishStatus.id;
    await assert.rejects(
      () =>
        ops.install(thirdSolutionId, {
          expectedType: "portico-agents",
        }),
      (error) => error?.code === "solution_already_installed",
    );
    await assert.rejects(
      () =>
        ops.install(thirdSolutionId, {
          expectedType: "portico-agents",
          existingAgentId: "agent-three",
        }),
      (error) => error?.code === "marketplace_relationship_mismatch",
    );
    assert.equal(
      [...state.localAgents.values()].filter(
        (agent) => agent.marketplace_solution_id === thirdSolutionId,
      ).length,
      1,
    );
    await ops.deletePublishedSolution(thirdSolutionId, {
      expectedType: "portico-agents",
    });
    state.localAgents.delete("agent-three");

    // Scenario 4: a bridge-style user copy cannot overwrite the foreign
    // listing, publishes as a distinct solution, cannot be reinstalled, and
    // can be unpublished without disturbing the fixture.
    await ops.install("foreign-agent-solution", {
      expectedType: "portico-agents",
    });
    const foreign = state.localAgents.get("foreign-agent");
    addUserAgent("agent-copy", {
      name: "agent-copy",
      description: foreign.description,
      base_model_id: foreign.base_model_id,
      system_prompt: foreign.system_prompt,
      reasoning_effort: foreign.reasoning_effort,
      skill_ids: foreign.skill_ids,
      tool_server_ids: foreign.tool_server_ids,
    });
    await assert.rejects(
      () =>
        ops.buildAndPublishAgent({
          agentId: "agent-copy",
          existingSolutionId: "foreign-agent-solution",
        }),
      (error) => error?.code === "not_owner",
    );
    const copyPublish = await ops.buildAndPublishAgent({
      agentId: "agent-copy",
    });
    const copySolutionId = copyPublish.publishStatus.id;
    assert.notEqual(copySolutionId, "foreign-agent-solution");
    assert.equal(state.remote.has("foreign-agent-solution"), true);
    await assert.rejects(
      () =>
        ops.install(copySolutionId, {
          expectedType: "portico-agents",
        }),
      (error) => error?.code === "solution_already_installed",
    );
    await ops.deletePublishedSolution(copySolutionId, {
      expectedType: "portico-agents",
    });
    assert.equal(state.remote.has(copySolutionId), false);
    assert.equal(state.remote.has("foreign-agent-solution"), true);

    // Weird combinations are deterministic and do not reclassify the
    // still-installed foreign artifact.
    await assert.rejects(
      () =>
        ops.install("foreign-skill-solution", {
          expectedType: "portico-agents",
        }),
      (error) => error?.code === "solution_type_mismatch",
    );
    await assert.rejects(
      () =>
        ops.install("missing-agent-solution", {
          expectedType: "portico-agents",
        }),
      (error) => error?.code === "solution_not_found",
    );
    await assert.rejects(
      () =>
        ops.deletePublishedSolution(copySolutionId, {
          expectedType: "portico-agents",
        }),
      (error) => error?.code === "solution_not_found",
    );
    assert.equal(
      state.localAgents.get("foreign-agent").marketplace_relationship,
      "installed",
    );

    // Exact-name collisions are rejected as a fresh publication before any
    // remote create. The linked-owner republish path above remains valid.
    addRemote({
      id: "foreign-agent-name-collision",
      type: "portico-agents",
      name: "  AGENT-COLLISION ",
      bundle: {
        type: "portico-agents",
        payload: {
          name: "agent-collision",
          base_model_id: "atlas-sonnet-5",
          system_prompt: "Existing collision.",
        },
      },
    });
    addUserAgent("agent-collision");
    const remoteCountBeforeCollision = state.remote.size;
    await assert.rejects(
      () => ops.buildAndPublishAgent({ agentId: "agent-collision" }),
      (error) => error?.code === "solution_name_conflict",
    );
    assert.equal(state.remote.size, remoteCountBeforeCollision);
    assert.equal(
      state.localAgents.get("agent-collision").marketplace_relationship,
      null,
    );
  } finally {
    await harness.cleanup();
  }
});

test("stateful fake Marketplace mirrors the four canonical skill lifecycle scenarios", async () => {
  const harness = await createStatefulLifecycleHarness();
  const { projectRoot, state, ops, addUserSkill, addRemote } = harness;
  addRemote({
    id: "foreign-agent-solution",
    type: "portico-agents",
    name: "foreign-agent",
    bundle: {
      type: "portico-agents",
      payload: {
        name: "foreign-agent",
        base_model_id: "atlas-sonnet-5",
        system_prompt: "Foreign agent prompt.",
      },
    },
  });
  addRemote({
    id: "foreign-skill-solution",
    type: "skills",
    name: "foreign-skill",
    bundle: {
      type: "skills",
      payload: {
        name: "foreign-skill",
        skill_md: "# Foreign Skill\nExact foreign content.\n",
        references: [],
        scripts: [],
      },
    },
  });

  try {
    // Scenario 1: create, publish, same-id republish, and unpublish while
    // retaining the exact editable user skill.
    await addUserSkill("skill-one", "# Skill One\nExact local content.\n");
    const firstPublish = await ops.buildAndPublishSkill({
      skillId: "skill-one",
    });
    const firstSolutionId = firstPublish.publishStatus.id;
    assert.equal(
      state.remote.get(firstSolutionId).bundle.payload.skill_md,
      "# Skill One\nExact local content.\n",
    );
    const remoteCountBeforeRepublish = state.remote.size;
    const republished = await ops.buildAndPublishSkill({
      skillId: "skill-one",
      existingSolutionId: firstSolutionId,
    });
    assert.equal(republished.publishStatus.id, firstSolutionId);
    assert.equal(state.remote.size, remoteCountBeforeRepublish);
    await ops.deletePublishedSolution(firstSolutionId, {
      expectedType: "skills",
    });
    assert.equal(state.remote.has(firstSolutionId), false);
    assert.equal(
      await fs.readFile(
        path.join(projectRoot, "skills-user", "skill-one", "SKILL.md"),
        "utf8",
      ),
      "# Skill One\nExact local content.\n",
    );
    assert.equal(state.skillLinks["skill-one"], undefined);

    // Scenario 2: foreign installed skill is explicit/read-only, every
    // publish path is blocked, repeated install is rejected, and source-aware
    // local deletion never unpublishes the fixture.
    await ops.install("foreign-skill-solution", { expectedType: "skills" });
    const installed = state.localSkills.get("ai-marketplace/foreign-skill");
    assert.equal(installed.source, "marketplace");
    assert.equal(installed.marketplace_relationship, "installed");
    assert.equal(installed.marketplace_solution_id, "foreign-skill-solution");
    assert.equal(installed.is_read_only, true);
    await assert.rejects(
      () =>
        ops.buildAndPublishSkill({
          skillId: "ai-marketplace/foreign-skill",
        }),
      (error) => error?.code === "installed_copy_read_only",
    );
    await assert.rejects(
      () =>
        ops.buildAndPublishSkill({
          skillId: "ai-marketplace/foreign-skill",
          existingSolutionId: "foreign-skill-solution",
        }),
      (error) => error?.code === "installed_copy_read_only",
    );
    await assert.rejects(
      () =>
        ops.deletePublishedSolution("foreign-skill-solution", {
          expectedType: "skills",
        }),
      (error) => error?.code === "not_owner",
    );
    await assert.rejects(
      () => ops.install("foreign-skill-solution", { expectedType: "skills" }),
      (error) => error?.code === "solution_already_installed",
    );
    const deletedInstalled = await ops.deleteLocalSkill(
      "ai-marketplace/foreign-skill",
    );
    assert.equal(deletedInstalled.remote_solution_deleted, false);
    assert.equal(state.remote.has("foreign-skill-solution"), true);
    await assert.rejects(
      () => ops.deleteLocalSkill("ai-marketplace/foreign-skill"),
      (error) => error?.code === "skill_not_found",
    );

    // Scenario 3: the viewer-owned published source cannot be installed or
    // misused as an installed refresh target.
    await addUserSkill("skill-three");
    const thirdPublish = await ops.buildAndPublishSkill({
      skillId: "skill-three",
    });
    const thirdSolutionId = thirdPublish.publishStatus.id;
    await assert.rejects(
      () => ops.install(thirdSolutionId, { expectedType: "skills" }),
      (error) => error?.code === "solution_already_installed",
    );
    await assert.rejects(
      () =>
        ops.install(thirdSolutionId, {
          expectedType: "skills",
          refreshInstalledSkillId: "skill-three",
        }),
      (error) => error?.code === "marketplace_relationship_mismatch",
    );
    assert.equal(
      [...state.localSkills.values()].filter(
        (skill) => skill.marketplace_solution_id === thirdSolutionId,
      ).length,
      1,
    );
    await ops.deletePublishedSolution(thirdSolutionId, {
      expectedType: "skills",
    });
    await ops.deleteLocalSkill("skill-three");

    // Scenario 4: the bridge-style copy resets provenance, cannot overwrite
    // the foreign listing, publishes independently, cannot be reinstalled,
    // and can be unpublished without touching the fixture.
    await ops.install("foreign-skill-solution", { expectedType: "skills" });
    const foreignBundle = state.remote.get("foreign-skill-solution").bundle;
    await addUserSkill("skill-copy", foreignBundle.payload.skill_md);
    await assert.rejects(
      () =>
        ops.buildAndPublishSkill({
          skillId: "skill-copy",
          existingSolutionId: "foreign-skill-solution",
        }),
      (error) => error?.code === "not_owner",
    );
    const copyPublish = await ops.buildAndPublishSkill({
      skillId: "skill-copy",
    });
    const copySolutionId = copyPublish.publishStatus.id;
    assert.notEqual(copySolutionId, "foreign-skill-solution");
    assert.equal(
      state.remote.get(copySolutionId).bundle.payload.skill_md,
      foreignBundle.payload.skill_md,
    );
    await assert.rejects(
      () => ops.install(copySolutionId, { expectedType: "skills" }),
      (error) => error?.code === "solution_already_installed",
    );
    await ops.deletePublishedSolution(copySolutionId, {
      expectedType: "skills",
    });
    assert.equal(state.remote.has(copySolutionId), false);
    assert.equal(state.remote.has("foreign-skill-solution"), true);

    // Cross-type and unavailable/repeated operations are deterministic.
    await assert.rejects(
      () => ops.install("foreign-agent-solution", { expectedType: "skills" }),
      (error) => error?.code === "solution_type_mismatch",
    );
    await assert.rejects(
      () => ops.install("missing-skill-solution", { expectedType: "skills" }),
      (error) => error?.code === "solution_not_found",
    );
    await assert.rejects(
      () =>
        ops.deletePublishedSolution(copySolutionId, {
          expectedType: "skills",
        }),
      (error) => error?.code === "solution_not_found",
    );
    assert.equal(
      state.localSkills.get("ai-marketplace/foreign-skill")
        .marketplace_relationship,
      "installed",
    );

    addRemote({
      id: "foreign-skill-name-collision",
      type: "skills",
      name: "  SKILL-COLLISION ",
      bundle: skillBundle("skill-collision"),
    });
    await addUserSkill("skill-collision");
    const remoteCountBeforeCollision = state.remote.size;
    await assert.rejects(
      () => ops.buildAndPublishSkill({ skillId: "skill-collision" }),
      (error) => error?.code === "solution_name_conflict",
    );
    assert.equal(state.remote.size, remoteCountBeforeCollision);
    assert.equal(state.skillLinks["skill-collision"], undefined);
  } finally {
    await harness.cleanup();
  }
});

test("assertMarketplaceWriteAccepted throws on a non-active status", () => {
  const { ops } = loadOps();
  assert.throws(
    () => ops.assertMarketplaceWriteAccepted({ id: "x", status: "pending" }, "x"),
    /marketplace_write_not_active|status/i,
  );
  assert.equal(ops.assertMarketplaceWriteAccepted({ id: "x", status: "active" }).status, "active");
});

// The api.js marketplace route surface (all nine /api/ai-marketplace/* routes,
// publish/unpublish gated on user confirmation with the native-dialog
// fallback, and the always-200 { success:false } error envelope) is covered
// BEHAVIORALLY — real HTTP against createApiServer() — in
// ai-marketplace-publish-modal-regressions.test.js.

// ---- reclaimInstalledAgent (convert a self-authored installed copy) ---------

const reclaimableOverrides = (extra = {}) => ({
  agentLinks: {
    helper: {
      solutionId: "sol-1",
      relationship: "installed",
      authorIdentity: "me",
      attributionPending: false,
    },
  },
  agent: {
    creation_source: "marketplace",
    marketplace_relationship: "installed",
    marketplace_solution_id: "sol-1",
    is_read_only: true,
  },
  solution: {
    id: "sol-1",
    type: "portico-agents",
    name: "helper",
    submitted_by: "me@example.invalid",
  },
  reconcileResult: {
    success: true,
    data: { repaired_ids: ["helper"], unchanged_ids: [], failures: [] },
  },
  ...extra,
});

test("reclaimInstalledAgent flips the link then reconciles for a self-authored installed copy", async () => {
  const { ops, fakes } = loadOps(reclaimableOverrides());

  const result = await ops.reclaimInstalledAgent("helper");

  assert.deepEqual(fakes.links.published, [
    { localAgentId: "helper", solutionId: "sol-1", authorIdentity: "me@example.invalid" },
  ]);
  assert.ok(fakes.events.includes("agent-attribution-reconcile"));
  assert.equal(result.local_agent_id, "helper");
  assert.equal(result.solution_id, "sol-1");
});

test("reclaimInstalledAgent rejects non-installed or missing links without mutating", async () => {
  for (const agentLinks of [
    {
      helper: {
        solutionId: "sol-1",
        relationship: "published",
        authorIdentity: "me",
        attributionPending: false,
      },
    },
    {},
  ]) {
    const { ops, fakes } = loadOps(reclaimableOverrides({ agentLinks }));
    await assert.rejects(
      ops.reclaimInstalledAgent("helper"),
      (error) => error?.code === "marketplace_relationship_mismatch",
    );
    assert.equal(fakes.links.published.length, 0);
    assert.ok(!fakes.events.includes("agent-attribution-reconcile"));
  }
});

test("reclaimInstalledAgent rejects attribution-pending installs without mutating", async () => {
  const { ops, fakes } = loadOps(
    reclaimableOverrides({
      agentLinks: {
        helper: {
          solutionId: "sol-1",
          relationship: "installed",
          authorIdentity: "me",
          attributionPending: true,
        },
      },
    }),
  );
  await assert.rejects(
    ops.reclaimInstalledAgent("helper"),
    (error) => error?.code === "marketplace_relationship_unknown",
  );
  assert.equal(fakes.links.published.length, 0);
});

test("reclaimInstalledAgent rejects when the local copy's creator is not the viewer", async () => {
  const { ops, fakes } = loadOps(
    reclaimableOverrides({
      agent: {
        creation_source: "marketplace",
        marketplace_relationship: "installed",
        marketplace_solution_id: "sol-1",
        is_read_only: true,
        created_by_email: "other@example.invalid",
      },
    }),
  );
  await assert.rejects(
    ops.reclaimInstalledAgent("helper"),
    (error) => error?.code === "not_owner",
  );
  assert.equal(fakes.links.published.length, 0);
});

test("reclaimInstalledAgent fails closed when the listing is foreign or missing", async () => {
  const foreign = loadOps(
    reclaimableOverrides({
      solution: {
        id: "sol-1",
        type: "portico-agents",
        name: "helper",
        submitted_by: "other@example.invalid",
      },
    }),
  );
  await assert.rejects(
    foreign.ops.reclaimInstalledAgent("helper"),
    (error) => error?.code === "not_owner",
  );
  assert.equal(foreign.fakes.links.published.length, 0);

  const missing = loadOps(
    reclaimableOverrides({
      solutionError: Object.assign(new Error("gone"), { status: 404 }),
    }),
  );
  await assert.rejects(
    missing.ops.reclaimInstalledAgent("helper"),
    (error) => error?.code === "solution_not_found",
  );
  assert.equal(missing.fakes.links.published.length, 0);
});

test("reclaimInstalledAgent surfaces reconcile failures after the flip (crash-safe ordering)", async () => {
  const failed = loadOps(
    reclaimableOverrides({
      reconcileResult: {
        success: true,
        data: { repaired_ids: [], unchanged_ids: [], failures: [{ id: "helper" }] },
      },
    }),
  );
  await assert.rejects(
    failed.ops.reclaimInstalledAgent("helper"),
    (error) => error?.code === "agent_attribution_failed",
  );
  // The link flip is durable before reconcile; the next startup reconcile
  // self-heals the metas, so the flip is expected to have happened.
  assert.equal(failed.fakes.links.published.length, 1);

  const unconfirmed = loadOps(
    reclaimableOverrides({
      reconcileResult: {
        success: true,
        data: { repaired_ids: [], unchanged_ids: [], failures: [] },
      },
    }),
  );
  await assert.rejects(
    unconfirmed.ops.reclaimInstalledAgent("helper"),
    (error) => error?.code === "agent_attribution_failed",
  );
});

test("reclaimInstalledAgent fails closed on registry corruption, blank ids, and missing agents", async () => {
  const corrupt = loadOps(
    reclaimableOverrides({ agentLinksError: new SyntaxError("bad json") }),
  );
  await assert.rejects(
    corrupt.ops.reclaimInstalledAgent("helper"),
    (error) => error?.code === "local_provenance_unavailable",
  );
  assert.equal(corrupt.fakes.links.published.length, 0);

  const blank = loadOps(reclaimableOverrides());
  await assert.rejects(
    blank.ops.reclaimInstalledAgent("   "),
    (error) => error?.code === "invalid_argument",
  );

  const absent = loadOps(reclaimableOverrides({ agent: null }));
  await assert.rejects(
    absent.ops.reclaimInstalledAgent("helper"),
    (error) => error?.code === "agent_not_found",
  );
  assert.equal(absent.fakes.links.published.length, 0);
});

// ---- reclaimInstalledSkill (convert a self-authored installed skill copy) ----

test("reclaimInstalledSkill detaches an owned solutions copy and relinks it to its listing", async () => {
  const projectRoot = await makeMarketplaceProject();
  await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({ skillId: "code-execution", solutionId: "sol-skill" }),
  ]);
  const { ops, fakes } = loadOps({
    projectRoot,
    solution: {
      id: "sol-skill",
      type: "skills",
      name: "code-execution",
      submitted_by: "me@example.invalid",
    },
  });

  const result = await ops.reclaimInstalledSkill("ai-marketplace/code-execution");

  assert.equal(fakes.marketplaceService.detachCalls.length, 1);
  assert.equal(fakes.marketplaceService.detachCalls[0].skillId, "code-execution");
  assert.deepEqual(fakes.skillLinks.skillLinksSet, [
    { localSkillName: "code-execution", solutionId: "sol-skill" },
  ]);
  assert.equal(result.local_skill_id, "code-execution");
  assert.equal(result.display_name, "Code Execution");
  assert.equal(result.solution_id, "sol-skill");
});

test("reclaimInstalledSkill uses the collision-suffixed detached name for the link", async () => {
  const projectRoot = await makeMarketplaceProject();
  await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({ skillId: "code-execution", solutionId: "sol-skill" }),
  ]);
  const { ops, fakes } = loadOps({
    projectRoot,
    detachedSkillName: "code-execution-detached",
    solution: {
      id: "sol-skill",
      type: "skills",
      name: "code-execution",
      submitted_by: "me@example.invalid",
    },
  });

  const result = await ops.reclaimInstalledSkill("ai-marketplace/code-execution");
  assert.deepEqual(fakes.skillLinks.skillLinksSet, [
    { localSkillName: "code-execution-detached", solutionId: "sol-skill" },
  ]);
  assert.equal(result.local_skill_id, "code-execution-detached");
  assert.equal(result.display_name, "Code Execution Detached");
});

test("reclaimInstalledSkill rejects non-installed skills and foreign listings without mutating", async () => {
  const missingRoot = await makeMarketplaceProject();
  await writeInstalledSkillConfig(missingRoot, []);
  const missing = loadOps({ projectRoot: missingRoot });
  await assert.rejects(
    missing.ops.reclaimInstalledSkill("code-execution"),
    (error) => error?.code === "marketplace_relationship_mismatch",
  );
  assert.equal(missing.fakes.marketplaceService.detachCalls.length, 0);
  assert.equal(missing.fakes.skillLinks.skillLinksSet.length, 0);

  const foreignRoot = await makeMarketplaceProject();
  await writeInstalledSkillConfig(foreignRoot, [
    installedSkillRecord({ skillId: "code-execution", solutionId: "sol-skill" }),
  ]);
  const foreign = loadOps({
    projectRoot: foreignRoot,
    solution: {
      id: "sol-skill",
      type: "skills",
      name: "code-execution",
      submitted_by: "other@example.invalid",
    },
  });
  await assert.rejects(
    foreign.ops.reclaimInstalledSkill("code-execution"),
    (error) => error?.code === "not_owner",
  );
  assert.equal(foreign.fakes.marketplaceService.detachCalls.length, 0);
  assert.equal(foreign.fakes.skillLinks.skillLinksSet.length, 0);
});

test("reclaimInstalledSkill surfaces detach failures without linking", async () => {
  const projectRoot = await makeMarketplaceProject();
  await writeInstalledSkillConfig(projectRoot, [
    installedSkillRecord({ skillId: "code-execution", solutionId: "sol-skill" }),
  ]);
  const { ops, fakes } = loadOps({
    projectRoot,
    detachError: Object.assign(new Error("copy failed"), { code: "detach_failed" }),
    solution: {
      id: "sol-skill",
      type: "skills",
      name: "code-execution",
      submitted_by: "me@example.invalid",
    },
  });

  await assert.rejects(
    ops.reclaimInstalledSkill("code-execution"),
    /copy failed/,
  );
  assert.equal(fakes.skillLinks.skillLinksSet.length, 0);
});

// ---- installGitMarketplaceSkillDependency (reference-only dependency policy) --

const GIT_DEP_REF = (overrides = {}) => ({
  skill_id: "algorithmic-art",
  kind: "git-marketplace",
  solution_id: null,
  marketplace: {
    name: "anthropic-agent-skills",
    source: {
      type: "github",
      repo: "anthropics/skills",
      repoUrl: "https://github.com/anthropics/skills",
      ref: "main",
    },
  },
  skill_path: "./skills/algorithmic-art",
  skill_source: null,
  ...overrides,
});

const ANTHROPIC_MARKETPLACE = {
  id: "anthropic-agent-skills",
  name: "anthropic-agent-skills",
  source: {
    type: "github",
    repo: "anthropics/skills",
    repoUrl: "https://github.com/anthropics/skills",
    ref: "main",
  },
};

test("git deps reuse an existing marketplace matched by repo identity (case-insensitive, ref-agnostic)", async () => {
  const { ops, fakes } = loadOps({ gitMarketplaces: [ANTHROPIC_MARKETPLACE] });

  const ref = GIT_DEP_REF();
  ref.marketplace.source = {
    type: "github",
    repo: "Anthropics/Skills",
    ref: "dev-branch",
  };
  const result = await ops.installGitMarketplaceSkillDependency({
    ref,
    interactiveAuth: true,
  });

  assert.equal(fakes.marketplaceService.addMarketplaceCalls.length, 0);
  assert.equal(fakes.marketplaceService.installMarketplaceSkillCalls.length, 1);
  const installCall = fakes.marketplaceService.installMarketplaceSkillCalls[0];
  assert.equal(installCall.marketplaceId, "anthropic-agent-skills");
  assert.equal(installCall.skillId, "algorithmic-art");
  assert.equal(installCall.skillPath, "./skills/algorithmic-art");
  assert.equal(installCall.interactiveAuth, true);
  assert.equal(result.localSkillId, "anthropic-agent-skills/algorithmic-art");
  assert.equal(result.newlyInstalled, true);
});

test("git deps auto-add a missing marketplace and report it", async () => {
  const addedMarketplaces = [];
  const { ops, fakes } = loadOps({ addedMarketplaceId: "anthropic-agent-skills" });

  const result = await ops.installGitMarketplaceSkillDependency({
    ref: GIT_DEP_REF(),
    interactiveAuth: false,
    addedMarketplaces,
  });

  assert.equal(fakes.marketplaceService.addMarketplaceCalls.length, 1);
  assert.equal(
    fakes.marketplaceService.addMarketplaceCalls[0].interactiveAuth,
    false,
  );
  assert.deepEqual(addedMarketplaces, [
    { id: "anthropic-agent-skills", name: "anthropic-agent-skills" },
  ]);
  assert.equal(result.localSkillId, "anthropic-agent-skills/algorithmic-art");
});

test("a duplicate-marketplace id conflict fails the dependency without installing anything", async () => {
  const { ops, fakes } = loadOps({
    addMarketplaceError: Object.assign(new Error("already configured"), {
      code: "duplicate_marketplace",
    }),
  });

  await assert.rejects(
    ops.installGitMarketplaceSkillDependency({ ref: GIT_DEP_REF() }),
    (error) => error?.code === "marketplace_identity_conflict",
  );
  assert.equal(fakes.marketplaceService.installMarketplaceSkillCalls.length, 0);
});

test("an already-installed git skill is reused without re-download or rollback registration", async () => {
  const { ops, fakes } = loadOps({
    gitMarketplaces: [ANTHROPIC_MARKETPLACE],
    gitInstalledSkills: [
      {
        marketplaceId: "anthropic-agent-skills",
        skillId: "algorithmic-art",
        localPath: "skills-marketplace/anthropic-agent-skills/algorithmic-art",
      },
    ],
  });

  const result = await ops.installGitMarketplaceSkillDependency({
    ref: GIT_DEP_REF(),
  });

  assert.equal(fakes.marketplaceService.installMarketplaceSkillCalls.length, 0);
  assert.equal(result.newlyInstalled, false);
  assert.equal(result.rollbackOnParentFailure, false);
  assert.equal(result.localSkillId, "anthropic-agent-skills/algorithmic-art");
});

test("a git ref without skill_path falls back to the marketplace manifest lookup", async () => {
  const { ops, fakes } = loadOps({
    gitMarketplaces: [ANTHROPIC_MARKETPLACE],
    marketplaceSkills: [
      { id: "algorithmic-art", skillPath: "./skills/algorithmic-art" },
    ],
  });

  await ops.installGitMarketplaceSkillDependency({
    ref: GIT_DEP_REF({ skill_path: "" }),
  });

  assert.equal(
    fakes.marketplaceService.installMarketplaceSkillCalls[0].skillPath,
    "./skills/algorithmic-art",
  );
});

test("headless git deps surface auth failures from the marketplace add", async () => {
  const { ops, fakes } = loadOps({
    addMarketplaceError: Object.assign(new Error("GitLab session required"), {
      code: "gitlab_auth_required",
    }),
  });

  await assert.rejects(
    ops.installGitMarketplaceSkillDependency({
      ref: GIT_DEP_REF(),
      interactiveAuth: false,
    }),
    (error) => error?.code === "gitlab_auth_required",
  );
  assert.equal(fakes.marketplaceService.installMarketplaceSkillCalls.length, 0);
});

test("install threads options.onProgress into the installer deps", async () => {
  const { ops, fakes } = loadOps({});
  const seen = [];
  const onProgress = (event) => seen.push(event);

  await ops.install("agent-solution", { onProgress });

  assert.equal(fakes.install.calls.length, 1);
  const deps = fakes.install.calls[0].deps;
  assert.equal(typeof deps.onProgress, "function");
  deps.onProgress({ phase: "skill:start", skillId: "alpha" });
  assert.deepEqual(seen, [{ phase: "skill:start", skillId: "alpha" }]);

  // Callers without a callback (the headless HTTP route) get a null slot,
  // which the installer treats as a no-op.
  const silent = loadOps({});
  await silent.ops.install("agent-solution");
  assert.equal(silent.fakes.install.calls[0].deps.onProgress, null);
});

// ---------------------------------------------------------------------------
// Round 19: the marketplace-wide published-agent sweep guards skill
// unpublishes at the deletePublishedSolution chokepoint (renderer IPC, HTTP
// route, and the agentic tools all pass through here).
// ---------------------------------------------------------------------------

test("skill unpublish blocks when a published agent listing references it; nothing mutates", async () => {
  const { ops, fakes } = loadOps({
    clientSearch: (params) => ({
      results:
        params.page === 1
          ? [
              {
                id: "agent-1",
                name: "Research Buddy",
                bundle: {
                  payload: {
                    base_model_id: "gpt",
                    skill_refs: [{ skill_id: "notes", solution_id: "sol-skill" }],
                  },
                },
              },
            ]
          : [],
    }),
  });
  await assert.rejects(
    ops.deletePublishedSolution("sol-skill", {
      ownershipChecked: true,
      ownedSolutionType: "skills",
    }),
    (error) => {
      assert.equal(error.code, "skill_dependency_of_published_agents");
      assert.match(error.message, /Research Buddy/);
      assert.match(error.message, /Unpublish that agent first/);
      return true;
    },
  );
  assert.ok(!fakes.events.includes("remote-delete"), "remote delete never ran");
  assert.deepEqual(fakes.links.clearedPublished, []);
  assert.deepEqual(fakes.skillLinks.skillLinksCleared, []);
});

test("skill unpublish proceeds when the marketplace sweep finds no referencing agents", async () => {
  const { ops, fakes } = loadOps({
    clientSearch: () => ({ results: [] }),
  });
  await ops.deletePublishedSolution("sol-clean", {
    ownershipChecked: true,
    ownedSolutionType: "skills",
  });
  assert.ok(fakes.events.includes("remote-delete"), "delete ran after a clean sweep");
});

test("skill unpublish fails CLOSED when the marketplace sweep cannot run", async () => {
  const { ops, fakes } = loadOps({
    clientSearch: () => {
      throw new Error("marketplace offline");
    },
  });
  await assert.rejects(
    ops.deletePublishedSolution("sol-skill", {
      ownershipChecked: true,
      ownedSolutionType: "skills",
    }),
    (error) => error.code === "published_agent_check_unavailable",
  );
  assert.ok(!fakes.events.includes("remote-delete"));
});

// ---------------------------------------------------------------------------
// listPublished dependency annotation — the agentic list_published_skills
// surface must reflect the same published-agent constraint the unpublish
// action enforces (chat 23f20288 declared every skill unpublishable because
// the listing carried no dependency signal).
// ---------------------------------------------------------------------------

test("listPublished annotates skills with the published agents that reference them", async () => {
  const { ops, fakes } = loadOps({
    clientSearch: (params) => {
      const types = params?.filters?.type || [];
      if (types.includes("skills")) {
        return {
          results: [
            { id: "sol-used", type: "skills", submitted_by: "me" },
            { id: "sol-free", type: "skills", submitted_by: "me" },
          ],
        };
      }
      return {
        results: [
          {
            id: "agent-1",
            name: "Research Buddy",
            submitted_by: "someone-else",
            bundle: {
              type: "portico-agents",
              payload: {
                base_model_id: "gpt",
                skill_refs: [{ skill_id: "notes", solution_id: "sol-used" }],
              },
            },
          },
        ],
      };
    },
  });

  const data = await ops.listPublished({
    type: "skills",
    includeAgentDependencies: true,
  });
  const byId = Object.fromEntries(data.solutions.map((s) => [s.id, s]));
  assert.deepEqual(
    byId["sol-used"].used_by_published_agents.map((a) => a.name),
    ["Research Buddy"],
  );
  assert.deepEqual(byId["sol-free"].used_by_published_agents, []);
  // One skills listing + one agents sweep page.
  assert.deepEqual(
    fakes.client.searches.map((s) => s.params.filters.type),
    [["skills"], ["portico-agents"]],
  );
});

test("listPublished without the flag never pays for the agent sweep", async () => {
  const { ops, fakes } = loadOps({
    solutions: [{ id: "s1", type: "skills", submitted_by: "me" }],
  });
  const data = await ops.listPublished({ type: "skills" });
  // Hot renderer path: exactly the one listing search, no annotation.
  assert.equal(fakes.client.searches.length, 1);
  assert.equal(data.solutions[0].used_by_published_agents, undefined);
});

test("listPublished with the flag skips the sweep for agent-only listings", async () => {
  const { ops, fakes } = loadOps({
    solutions: [{ id: "a1", type: "portico-agents", submitted_by: "me" }],
  });
  await ops.listPublished({
    type: "portico-agents",
    includeAgentDependencies: true,
  });
  assert.equal(fakes.client.searches.length, 1);
});

test("listPublished flags skills when the dependency sweep cannot run", async () => {
  const { ops } = loadOps({
    clientSearch: (params) => {
      const types = params?.filters?.type || [];
      if (types.includes("skills")) {
        return { results: [{ id: "s1", type: "skills", submitted_by: "me" }] };
      }
      throw new Error("marketplace offline");
    },
  });
  const data = await ops.listPublished({
    type: "skills",
    includeAgentDependencies: true,
  });
  assert.equal(data.solutions[0].agent_dependency_check_unavailable, true);
  assert.equal(data.solutions[0].used_by_published_agents, undefined);
});

test("exported assertSolutionUnpublishableOnMarketplace binds module client access", async () => {
  const { ops } = loadOps({
    clientSearch: (params) => {
      const types = params?.filters?.type || [];
      assert.deepEqual(types, ["portico-agents"]);
      return {
        results: [
          {
            id: "agent-1",
            name: "Blocker",
            submitted_by: "other",
            bundle: {
              type: "portico-agents",
              payload: {
                base_model_id: "gpt",
                skill_refs: [{ skill_id: "x", solution_id: "sol-skill" }],
              },
            },
          },
        ],
      };
    },
  });
  await assert.rejects(
    ops.assertSolutionUnpublishableOnMarketplace("sol-skill", "skills"),
    (error) => error.code === "skill_dependency_of_published_agents",
  );
  // Non-skill types no-op without touching the marketplace.
  await ops.assertSolutionUnpublishableOnMarketplace("sol-agent", "portico-agents");
});

// ---- allowed_emails pinning + the union policy (ai-marketplace-acl.js) -------

const OWNED_RESTRICTED_SKILL = {
  id: "sol-acl",
  type: "skills",
  name: "test-skill",
  status: "active",
  submitted_by: "me",
  allowed_emails: ["existing@example.invalid"],
};

test("standalone skill republish PUTs pin the listing's current allowed_emails", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-ops-aclpin-"));
  fs.mkdirSync(path.join(projectRoot, "skills-user", "test-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "test-skill", "SKILL.md"),
    "---\nname: test-skill\n---\n",
  );
  try {
    const { ops, fakes } = loadOps({
      projectRoot,
      solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
      solutions: [OWNED_RESTRICTED_SKILL],
      skillLinks: { "test-skill": { solutionId: "sol-acl" } },
    });
    await ops.buildAndPublishSkill({
      skillId: "test-skill",
      existingSolutionId: "sol-acl",
    });
    assert.equal(fakes.client.updated.length, 1);
    // The chat path has no agent audience (aclAudience null): the PUT must
    // carry the accumulated ACL explicitly instead of omitting the field.
    assert.deepEqual(fakes.client.updated[0].patch.allowed_emails, [
      "existing@example.invalid",
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("skill republish proves ownership ONCE and opts the PUT into retry + long timeout", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-ops-dedupe-"));
  fs.mkdirSync(path.join(projectRoot, "skills-user", "test-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "test-skill", "SKILL.md"),
    "---\nname: test-skill\n---\n",
  );
  try {
    const { ops, fakes } = loadOps({
      projectRoot,
      solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
      solutions: [OWNED_RESTRICTED_SKILL],
      skillLinks: { "test-skill": { solutionId: "sol-acl" } },
    });
    // The renderer cascade's per-skill leg: the ai-marketplace-update IPC
    // calls updatePublishedSolution with provenanceChecked unset, which used
    // to run getOwnedSolutionForWrite TWICE (once itself, once inside the
    // assert pipeline) — 3 concurrent skill updates hammered a degraded
    // backend with 15 near-simultaneous calls in the smart-slides incident.
    await ops.updatePublishedSolution(
      "sol-acl",
      { name: "test-skill", type: "skills" },
      { localSkillId: "test-skill" },
    );
    // Dedupe: one GET + one ownership search for the whole update.
    assert.deepEqual(fakes.client.solutionGets, ["sol-acl"]);
    assert.equal(fakes.client.searches.length, 1);
    assert.equal(fakes.client.updated.length, 1);
    // The bundle-carrying PUT is idempotent: retryable, with a longer
    // per-attempt budget than the 30s read default.
    assert.equal(fakes.client.updated[0].opts.retryable, true);
    assert.equal(fakes.client.updated[0].opts.timeoutMs, 60_000);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a mismatched prefetched solution is ignored: the assert pipeline fetches its own", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-ops-dedupe-miss-"));
  fs.mkdirSync(path.join(projectRoot, "skills-user", "test-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "test-skill", "SKILL.md"),
    "---\nname: test-skill\n---\n",
  );
  try {
    const { ops, fakes } = loadOps({
      projectRoot,
      solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
      solutions: [OWNED_RESTRICTED_SKILL],
      skillLinks: { "test-skill": { solutionId: "sol-acl" } },
    });
    // A prefetch for a DIFFERENT id must not satisfy the PORTICO-316 ownership
    // guard for the actual target.
    await ops.getSkillForPublish("test-skill", {
      existingSolutionId: "sol-acl",
      ownedSolution: { id: "sol-other", type: "skills" },
    });
    assert.deepEqual(fakes.client.solutionGets, ["sol-acl"]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("updatePublishedSolution unions an agent audience into the listing ACL", async () => {
  const { ops, fakes } = loadOps({
    solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
    solutions: [OWNED_RESTRICTED_SKILL],
  });
  await ops.updatePublishedSolution(
    "sol-acl",
    { name: "test-skill", type: "skills" },
    { provenanceChecked: true, aclAudience: ["new@example.invalid"] },
  );
  assert.deepEqual(fakes.client.updated[0].patch.allowed_emails, [
    "existing@example.invalid",
    "new@example.invalid",
  ]);
});

test("updatePublishedSolution: a public audience widens the listing to public", async () => {
  const { ops, fakes } = loadOps({
    solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
    solutions: [OWNED_RESTRICTED_SKILL],
  });
  await ops.updatePublishedSolution(
    "sol-acl",
    { name: "test-skill", type: "skills" },
    { provenanceChecked: true, aclAudience: [] },
  );
  assert.deepEqual(fakes.client.updated[0].patch.allowed_emails, []);
});

test("updatePublishedSolution: an explicit allowed_emails patch passes through verbatim", async () => {
  const { ops, fakes } = loadOps({
    solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
    solutions: [OWNED_RESTRICTED_SKILL],
  });
  await ops.updatePublishedSolution(
    "sol-acl",
    {
      name: "test-skill",
      type: "skills",
      allowed_emails: ["only-this@example.invalid"],
    },
    { provenanceChecked: true, aclAudience: ["ignored@example.invalid"] },
  );
  assert.deepEqual(fakes.client.updated[0].patch.allowed_emails, [
    "only-this@example.invalid",
  ]);
});

test("publishSolution pins creates: audience inherited, none means public", async () => {
  const { ops, fakes } = loadOps();
  await ops.publishSolution(
    { name: "brand-new", type: "skills", description: "d" },
    { provenanceChecked: true, aclAudience: ["a@example.invalid"] },
  );
  assert.deepEqual(fakes.client.created[0].solution.allowed_emails, [
    "a@example.invalid",
  ]);
  await ops.publishSolution(
    { name: "brand-new-2", type: "skills", description: "d" },
    { provenanceChecked: true },
  );
  assert.deepEqual(fakes.client.created[1].solution.allowed_emails, []);
});

test("solution writes carry the viewer's Okta full name as author_display_name", async () => {
  const { ops, fakes } = loadOps({
    viewerFullName: "Dionny Santiago",
    solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
    solutions: [OWNED_RESTRICTED_SKILL],
  });
  await ops.publishSolution(
    { name: "named-create", type: "skills", description: "d" },
    { provenanceChecked: true },
  );
  assert.equal(fakes.client.created[0].solution.author_display_name, "Dionny Santiago");
  assert.equal(fakes.client.created[0].solution.submitted_by, "me@example.invalid");

  await ops.updatePublishedSolution(
    "sol-acl",
    { name: "test-skill", type: "skills" },
    { provenanceChecked: true },
  );
  assert.equal(fakes.client.updated[0].patch.author_display_name, "Dionny Santiago");

  // A caller-provided display name wins over the session's.
  await ops.publishSolution(
    { name: "named-create-2", type: "skills", description: "d", author_display_name: "Team X" },
    { provenanceChecked: true },
  );
  assert.equal(fakes.client.created[1].solution.author_display_name, "Team X");
});

test("a session without a full name omits author_display_name entirely", async () => {
  const { ops, fakes } = loadOps();
  await ops.publishSolution(
    { name: "anon-create", type: "skills", description: "d" },
    { provenanceChecked: true },
  );
  assert.equal(
    "author_display_name" in fakes.client.created[0].solution,
    false,
    "no fabricated field when the claims carry no name",
  );
});

test("syncSolutionAclForAudience: no-op when the union changes nothing", async () => {
  const { ops, fakes } = loadOps({
    solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
    solutions: [OWNED_RESTRICTED_SKILL],
  });
  const result = await ops.syncSolutionAclForAudience("sol-acl", {
    aclAudience: ["existing@example.invalid"],
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.allowed_emails, ["existing@example.invalid"]);
  assert.equal(fakes.client.updated.length, 0, "unchanged ACL performs no PUT");
});

test("syncSolutionAclForAudience: drift produces one minimal visibility-only PUT", async () => {
  const { ops, fakes } = loadOps({
    solutionsById: { "sol-acl": OWNED_RESTRICTED_SKILL },
    solutions: [OWNED_RESTRICTED_SKILL],
  });
  const result = await ops.syncSolutionAclForAudience("sol-acl", {
    aclAudience: ["new@example.invalid"],
    localSkillId: "test-skill",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.allowed_emails, [
    "existing@example.invalid",
    "new@example.invalid",
  ]);
  assert.equal(fakes.client.updated.length, 1);
  const { patch } = fakes.client.updated[0];
  assert.deepEqual(patch.allowed_emails, [
    "existing@example.invalid",
    "new@example.invalid",
  ]);
  assert.equal(patch.bundle, undefined, "visibility-only PUT carries no bundle");
  assert.equal(patch.name, undefined, "minimal patch: no field echoes needed");
  assert.ok(patch.submitted_by, "write identity rides the patch");
});

test("syncSolutionAclForAudience fails closed on listings the viewer does not own", async () => {
  const foreign = {
    ...OWNED_RESTRICTED_SKILL,
    id: "sol-foreign",
    submitted_by: "someone-else",
  };
  const { ops, fakes } = loadOps({
    solutionsById: { "sol-foreign": foreign },
    solutions: [foreign],
  });
  await assert.rejects(
    ops.syncSolutionAclForAudience("sol-foreign", { aclAudience: [] }),
    (error) => error.code === "not_owner",
  );
  assert.equal(fakes.client.updated.length, 0);
});

test("preflightDependentSkillListings classifies alive/deleted/unknown with ACL drift", async () => {
  const notFound = Object.assign(new Error("Solution not found"), {
    status: 404,
    code: "http_error",
  });
  const flaky = new Error("socket hang up");
  const { ops } = loadOps({
    solutionsById: {
      "sol-alive": {
        id: "sol-alive",
        type: "skills",
        status: "active",
        submitted_by: "me",
        allowed_emails: ["a@example.invalid"],
      },
      "sol-dead": { id: "sol-dead", type: "skills", status: "deleted" },
    },
    solutionErrorsById: { "sol-404": notFound, "sol-flaky": flaky },
  });
  const { listings } = await ops.preflightDependentSkillListings({
    solutionIds: ["sol-alive", "sol-dead", "sol-404", "sol-flaky", "sol-alive"],
    aclAudience: ["b@example.invalid"],
  });
  assert.equal(listings.length, 4, "duplicate ids collapse");
  const byId = new Map(listings.map((entry) => [entry.solution_id, entry]));
  const alive = byId.get("sol-alive");
  assert.equal(alive.state, "alive");
  assert.deepEqual(alive.allowed_emails, ["a@example.invalid"]);
  assert.deepEqual(alive.acl_sync, {
    allowed_emails: ["a@example.invalid", "b@example.invalid"],
    changed: true,
  });
  assert.equal(byId.get("sol-dead").state, "deleted");
  assert.equal(byId.get("sol-404").state, "deleted");
  assert.equal(byId.get("sol-flaky").state, "unknown");
});

test("preflightDependentSkillListings: null audience reports no drift", async () => {
  const { ops } = loadOps({
    solutionsById: {
      "sol-alive": {
        id: "sol-alive",
        type: "skills",
        status: "active",
        submitted_by: "me",
        allowed_emails: ["a@example.invalid"],
      },
    },
  });
  const { listings } = await ops.preflightDependentSkillListings({
    solutionIds: ["sol-alive"],
    aclAudience: null,
  });
  assert.equal(listings[0].acl_sync.changed, false);
  assert.deepEqual(listings[0].acl_sync.allowed_emails, ["a@example.invalid"]);
});

// ---- full install rollback: auto-added marketplaces ---------------------------

test("a failed install removes the marketplaces it auto-added, preserving the error", async () => {
  const { ops, fakes } = loadOps({
    addedMarketplaceId: "zstevens-portico-skills",
    installImpl: async (args) => {
      // Simulate the reconcile: a git dependency auto-adds its marketplace,
      // then a later dependency fails the whole install.
      await args.deps.installGitSkillDependency({ ref: GIT_DEP_REF() });
      const error = new Error(
        "Agent install failed because one or more required dependent skills could not be installed.",
      );
      error.code = "agent_dependency_install_failed";
      error.body = {
        failedSkills: [{ skill_id: "x", error: "Solution not found" }],
      };
      throw error;
    },
  });

  await assert.rejects(
    () => ops.install("agent-solution"),
    (error) => {
      assert.equal(error.code, "agent_dependency_install_failed");
      assert.deepEqual(error.body.addedMarketplaces, [
        {
          id: "zstevens-portico-skills",
          name: "zstevens-portico-skills",
          outcome: "removed",
        },
      ]);
      assert.equal(
        error.body.failedSkills[0].skill_id,
        "x",
        "the original envelope body survives the rollback annotation",
      );
      return true;
    },
  );
  assert.equal(fakes.marketplaceService.removeMarketplaceCalls.length, 1);
  assert.equal(
    fakes.marketplaceService.removeMarketplaceCalls[0].marketplaceId,
    "zstevens-portico-skills",
  );
});

test("a failed install never removes a pre-existing marketplace", async () => {
  const { ops, fakes } = loadOps({
    gitMarketplaces: [ANTHROPIC_MARKETPLACE],
    installImpl: async (args) => {
      // The dependency reuses the marketplace that already existed — it must
      // never enter the rollback set.
      await args.deps.installGitSkillDependency({ ref: GIT_DEP_REF() });
      throw Object.assign(new Error("boom"), {
        code: "agent_dependency_install_failed",
      });
    },
  });

  await assert.rejects(
    () => ops.install("agent-solution"),
    (error) => {
      assert.equal(
        error.body?.addedMarketplaces,
        undefined,
        "nothing was added, so nothing is reported removed",
      );
      return true;
    },
  );
  assert.equal(fakes.marketplaceService.addMarketplaceCalls.length, 0);
  assert.equal(fakes.marketplaceService.removeMarketplaceCalls.length, 0);
});

test("a marketplace-removal failure reports the marketplace kept, not a new error", async () => {
  const { ops, fakes } = loadOps({
    addedMarketplaceId: "zstevens-portico-skills",
    removeMarketplaceError: new Error("registry locked"),
    installImpl: async (args) => {
      await args.deps.installGitSkillDependency({ ref: GIT_DEP_REF() });
      throw Object.assign(new Error("boom"), {
        code: "agent_dependency_install_failed",
      });
    },
  });

  await assert.rejects(
    () => ops.install("agent-solution"),
    (error) => {
      assert.equal(error.message, "boom", "the install error is never masked");
      assert.equal(error.code, "agent_dependency_install_failed");
      assert.deepEqual(error.body.addedMarketplaces, [
        {
          id: "zstevens-portico-skills",
          name: "zstevens-portico-skills",
          outcome: "kept",
        },
      ]);
      return true;
    },
  );
  assert.equal(fakes.marketplaceService.removeMarketplaceCalls.length, 1);
});

test("getSkillForPublish carries the authored display name to the approvals card", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico-ops-dname-"));
  fs.mkdirSync(path.join(projectRoot, "skills-user", "gtm-brief-qa"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "skills-user", "gtm-brief-qa", "SKILL.md"),
    "---\nname: gtm-brief-qa\n---\n",
  );
  try {
    const named = loadOps({
      projectRoot,
      skillMetaResult: {
        success: true,
        data: {
          success: true,
          skill_name: "gtm-brief-qa",
          metadata: {
            display_name: "GTM Brief QA",
            required_mcp_servers: [],
            created_by_email: "me@example.invalid",
          },
          content: "---\n---\n",
        },
      },
    });
    const { skill } = await named.ops.getSkillForPublish("gtm-brief-qa");
    assert.equal(skill.display_name, "GTM Brief QA");

    // A display_name restating the kebab id is treated as absent.
    const restating = loadOps({
      projectRoot,
      skillMetaResult: {
        success: true,
        data: {
          success: true,
          skill_name: "gtm-brief-qa",
          metadata: {
            display_name: "gtm-brief-qa",
            required_mcp_servers: [],
            created_by_email: "me@example.invalid",
          },
          content: "---\n---\n",
        },
      },
    });
    const restated = await restating.ops.getSkillForPublish("gtm-brief-qa");
    assert.equal(restated.skill.display_name, undefined);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- installed-agent update detection (2026-08-04: the sweep + baseline
// stamp read updated_at/created_at while the live backend emits
// updated_timestamp/created_timestamp — detection failed closed for everyone
// and had zero coverage). --------------------------------------------------

test("checkInstalledAgentUpdates flags on updated_timestamp movement and persists verdicts", async () => {
  const { ops, fakes } = loadOps({
    agentLinks: {
      "agent-stale": {
        relationship: "installed",
        solutionId: "sol-stale",
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
      },
      "agent-current": {
        relationship: "installed",
        solutionId: "sol-current",
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
      },
      "agent-legacy": { relationship: "installed", solutionId: "sol-legacy" },
      "agent-published": { relationship: "published", solutionId: "sol-pub" },
    },
    solutionsById: {
      "sol-stale": { id: "sol-stale", updated_timestamp: "2026-08-04T12:00:00Z" },
      "sol-current": { id: "sol-current", updated_timestamp: "2026-07-30T00:00:00Z" },
      "sol-legacy": { id: "sol-legacy", updated_timestamp: "2026-08-04T12:00:00Z" },
    },
  });

  const result = await ops.checkInstalledAgentUpdates();
  assert.equal(result.hasUpdates, true);
  assert.deepEqual(
    result.updates.map((entry) => entry.agentId),
    ["agent-stale"],
  );
  // Verdicts persist for every baselined install (true AND false); the
  // legacy link backfills its baseline silently instead of flagging.
  assert.deepEqual(fakes.links.markedRemoteUpdates, [
    ["agent-stale", true],
    ["agent-current", false],
  ]);
  assert.deepEqual(fakes.links.remoteStamps, [
    ["agent-legacy", "2026-08-04T12:00:00Z"],
  ]);
});

test("agent install stamps the freshness baseline from the listing's updated_timestamp", async () => {
  const { ops, fakes } = loadOps({
    bundle: { type: "portico-agents", payload: { name: "Fresh Agent" } },
    solution: {
      id: "sol-fresh",
      type: "portico-agents",
      submitted_by: "owner",
      updated_timestamp: "2026-08-04T12:00:00Z",
    },
    installImpl: async () => ({
      installed: true,
      created: { id: "fresh-agent" },
    }),
  });

  await ops.install("sol-fresh");
  assert.deepEqual(fakes.links.remoteStamps, [
    ["fresh-agent", "2026-08-04T12:00:00Z"],
  ]);
});

test("search forwards caller options to the client (sweep passes a tight timeoutMs)", async () => {
  const { ops, fakes } = loadOps({ solutions: [] });
  await ops.search({ query: "x" }, { timeoutMs: 12_000 });
  const recorded = fakes.client.searches.at(-1);
  assert.equal(recorded.opts.timeoutMs, 12_000);
  assert.ok(recorded.opts.viewerEmail !== undefined, "identity still resolved");
});
