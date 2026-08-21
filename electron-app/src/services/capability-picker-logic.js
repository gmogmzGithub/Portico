// Pure logic shared (by mirroring) between the two capability pickers — the
// Electron agents-side picker (renderer/components/agents.js) and the OWUI
// scheduled-tasks picker (CapabilityPicker.svelte). The renderer has no
// `require`, so this module is not imported there; it exists to unit-test the
// exact predicates both pickers inline, so the two stay in agreement.

// Derive the source category for an MCP tool server's badge/filter. Host wins
// (runs on the user's machine), then core (built-in), then user-installed.
// Mirrors normalizeToolServer() in agents.js and sourceKey() in
// CapabilityPicker.svelte.
function deriveMcpSource(server) {
  if (!server || typeof server !== "object") return "";
  const deployment = String(server.deployment_type || server.deploymentType || "")
    .trim()
    .toLowerCase();
  if (deployment === "host") return "host";
  if (server.is_core || server.isCore) return "core";
  if (server.user_installed || server.userInstalled) return "user";
  return "";
}

// A capability's effective source. Electron pre-normalizes options so `source`
// is already set (normalizeToolServer); the OWUI picker feeds RAW MCP options
// with no `source` and derives it live via sourceKey(). Model both: use an
// explicit `source` when present, else derive it from the MCP fields.
function effectiveSource(opt) {
  const explicit = String((opt && opt.source) || "").trim();
  return explicit || deriveMcpSource(opt);
}

// The set of option ids currently visible given the active source filter and
// search query. "Select all" adds exactly these to the selection. Mirrors
// visibleOptionIds() in agents.js and the filteredOptions predicate in
// CapabilityPicker.svelte (search matches id/display_name/description/source).
function visibleCapabilityIds(options, { activeFilter = "all", query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  return (Array.isArray(options) ? options : [])
    .filter((opt) => {
      if (!opt || typeof opt !== "object") return false;
      if (activeFilter && activeFilter !== "all" && effectiveSource(opt) !== activeFilter) {
        return false;
      }
      if (!q) return true;
      return [opt.id, opt.display_name, opt.description, effectiveSource(opt)]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    })
    .map((opt) => opt.id);
}

module.exports = { deriveMcpSource, visibleCapabilityIds };
