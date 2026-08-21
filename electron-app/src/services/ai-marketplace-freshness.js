// Freshness stamp for a Solutions Marketplace listing: the single field
// derivation every update-detection comparison uses. The live backend names
// these fields `updated_timestamp` / `created_timestamp` (ISO strings on both
// GET-by-id and search entries; updated_timestamp advances on every
// republish). The legacy `updated_at` / `created_at` names are kept as
// fallbacks for older fixtures — reading only the legacy names is the bug
// that silently disabled agent AND solutions-skill update detection for
// everyone until 2026-08-04 (Zach's-colleague incident).
//
// LOCKSTEP: the renderer's installed-agent sweep (agents.js
// maybeCheckInstalledAgentFreshness) inlines this same expression — it is a
// plain renderer script and cannot require() this module.
function solutionFreshnessStamp(solution) {
  return (
    solution?.updated_timestamp ??
    solution?.updated_at ??
    solution?.created_timestamp ??
    solution?.created_at ??
    null
  );
}

module.exports = { solutionFreshnessStamp };
