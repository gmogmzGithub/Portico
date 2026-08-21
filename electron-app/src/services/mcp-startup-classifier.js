// Classifies why an MCP server failed to start from its own container logs.
// Only meaningful for a dedicated (non-grouped) docker container: grouped and
// host runtimes interleave several servers' output in one stream, so a match
// there could belong to a different server. Callers enforce that scoping.

const AUTH_PATTERN =
  /programmatic access token|394400|unauthorized|authentication failed|invalid[^\n]{0,40}(token|credential|password)|access denied/i;
const CONFIG_PATTERN =
  /tomldecodeerror|yaml(?:error| error)|parse error|validationerror|invalid config/i;
const SAVED_SECRET_UNAVAILABLE_PATTERN =
  /static secret broker denied[^\n]*http 404|static runtime file is unavailable|saved secure (?:runtime file|configuration) is unavailable/i;

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The crash-loop marker is serverId-scoped because the mcp-orc supervisor
// names the failing child ("native MCP startup failed for '<id>'"); the other
// markers come from the child process itself.
function crashLoopPattern(serverId) {
  return new RegExp(
    `startup failed for '${escapeRegExp(serverId)}'|connection closed: initialize response|exited with code`,
    "i",
  );
}

function classifyStartupLogText(logs, { serverId } = {}) {
  const text = String(logs || "");
  if (!text) return null;
  if (SAVED_SECRET_UNAVAILABLE_PATTERN.test(text)) {
    return "saved_secret_unavailable";
  }
  if (AUTH_PATTERN.test(text)) return "auth";
  if (CONFIG_PATTERN.test(text)) return "config";
  if (crashLoopPattern(serverId).test(text)) return "crash_loop";
  return null;
}

module.exports = {
  classifyStartupLogText,
};
