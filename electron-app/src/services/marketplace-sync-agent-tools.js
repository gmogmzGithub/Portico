// Agent transport for the destructive marketplace sync.
// MCP Orchestration seam: the sync classifier and the consented-removal
// executor in marketplace-service.js are Electron-free and take these as
// injected collaborators; the IPC and HTTP surfaces both build them here so
// their behavior is identical. Same load-light discipline as
// agent-skill-usage-guard: no top-level requires of Electron-bound modules —
// defaults lazy-require at call time, unit fixtures inject their own.

const SUBAGENTS_SERVER_ID = "subagents";
const SUBAGENTS_PORT = 8766;
const SUBAGENTS_TOOL_LIST = "subagents_list_agents";
const SUBAGENTS_TOOL_UPDATE = "subagents_update_agent";

function defaultInvokeMcpTool(...args) {
  return require("./docker-mcp").invokeMcpTool(...args);
}

function defaultAgentFlags() {
  return require("./agent-local-flags");
}

function transportError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// invokeMcpTool success is transport-level only; tool-domain failures arrive
// as HTTP 200 with {success:false}/{is_error} envelopes inside data (see the
// 2026-08-01 ISSUE-9 note in ai-marketplace-install.js).
function domainFailure(result) {
  const data = result?.data;
  if (data && typeof data === "object" && (data.success === false || data.is_error === true)) {
    return data.error || data.detail || "tool reported a failure";
  }
  return null;
}

// Full agent inventory with raw skill_ids — the removal executor needs the
// exact reference strings to rewrite arrays without disturbing anything else.
async function listAgentsWithSkillIds({ invokeMcpTool = defaultInvokeMcpTool } = {}) {
  let result;
  try {
    result = await invokeMcpTool(SUBAGENTS_SERVER_ID, SUBAGENTS_TOOL_LIST, {}, SUBAGENTS_PORT);
  } catch (error) {
    throw transportError(
      error?.message || "agent services unavailable",
      "agent_inventory_unavailable",
    );
  }
  if (result?.success === false) {
    throw transportError(
      result?.error || "agent services unavailable",
      "agent_inventory_unavailable",
    );
  }
  const failure = domainFailure(result);
  if (failure) {
    throw transportError(failure, "agent_inventory_unavailable");
  }
  const agents = Array.isArray(result?.data?.agents)
    ? result.data.agents
    : Array.isArray(result?.data)
      ? result.data
      : null;
  if (!agents) {
    throw transportError("invalid agent inventory response", "agent_inventory_unavailable");
  }
  return agents
    .filter((agent) => typeof agent?.id === "string" && agent.id.trim())
    .map((agent) => ({
      id: agent.id.trim(),
      name:
        typeof agent?.name === "string" && agent.name.trim()
          ? agent.name.trim()
          : agent.id.trim(),
      relationship:
        typeof agent?.marketplace_relationship === "string"
          ? agent.marketplace_relationship
          : null,
      readOnly: agent?.is_read_only === true,
      createdByEmail:
        typeof agent?.created_by_email === "string"
          ? agent.created_by_email.trim()
          : "",
      marketplaceSolutionId:
        typeof agent?.marketplace_solution_id === "string"
          ? agent.marketplace_solution_id.trim()
          : "",
      skillIds: Array.isArray(agent?.skill_ids)
        ? agent.skill_ids.filter((id) => typeof id === "string")
        : [],
    }));
}

async function updateAgentSkillIds(
  agentId,
  skillIds,
  { invokeMcpTool = defaultInvokeMcpTool } = {},
) {
  const result = await invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_UPDATE,
    { model_id: agentId, skill_ids: skillIds },
    SUBAGENTS_PORT,
  );
  if (result?.success === false) {
    throw transportError(result?.error || "agent update failed", null);
  }
  const failure = domainFailure(result);
  if (failure) {
    const error = transportError(failure, null);
    if (/read.?only/i.test(failure)) error.code = "installed_copy_read_only";
    throw error;
  }
}

// The bundle for marketplace-service: sync classification + removal executor.
function buildSyncAgentTools({ invokeMcpTool = defaultInvokeMcpTool, agentFlags } = {}) {
  return {
    // Classification reader (agent-skill-usage-guard shape: leaves Sets).
    listReferences: () =>
      require("./agent-skill-usage-guard").listAgentSkillReferences({ invokeMcpTool }),
    listAgents: () => listAgentsWithSkillIds({ invokeMcpTool }),
    updateAgentSkillIds: (agentId, skillIds) =>
      updateAgentSkillIds(agentId, skillIds, { invokeMcpTool }),
    flagAgentsSkillsNotFound: (entries) =>
      (agentFlags || defaultAgentFlags()).setSkillsNotFoundFlags(entries),
  };
}

module.exports = {
  buildSyncAgentTools,
  listAgentsWithSkillIds,
  updateAgentSkillIds,
};
