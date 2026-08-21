// Authoritative, app-owned identity and Marketplace provenance context for the
// Subagents server. The LLM never supplies creator identity through this path.

class AgentAttributionContextError extends Error {
  constructor(message, code, cause = undefined) {
    super(message);
    this.name = "AgentAttributionContextError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const {
  getCurrentCreatorIdentity,
  resolveAuthenticatedCreatorIdentity,
} = require("./creator-identity");

async function resolveAuthenticatedEmail(deps = {}) {
  return (await resolveAuthenticatedCreatorIdentity(deps)).email;
}

async function getCurrentUserAttribution(deps = {}) {
  const identity = await resolveAuthenticatedCreatorIdentity(deps);
  return { email: identity.email };
}

async function getAgentAttributionContext(deps = {}) {
  const email = await resolveAuthenticatedEmail(deps);
  let links;
  try {
    links =
      typeof deps.readLinksStrict === "function"
        ? await deps.readLinksStrict()
        : (await require("./ai-marketplace-agent-links").readStateStrict(deps)).links;
  } catch (error) {
    throw new AgentAttributionContextError(
      "The AI Marketplace agent-link registry could not be read safely.",
      "agent_link_registry_unreadable",
      error,
    );
  }
  return { email, links };
}

module.exports = {
  AgentAttributionContextError,
  getAgentAttributionContext,
  getCurrentCreatorIdentity,
  getCurrentUserAttribution,
  resolveAuthenticatedEmail,
  resolveAuthenticatedCreatorIdentity,
};
