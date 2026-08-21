// Compute a two-letter fallback logo for a skill from its display name:
// first letter of the first word + first letter of the last word (e.g.
// "MCP Bridge Setup" -> "MS", "Algorithmic Art" -> "AA"). Single-word names use
// the first two letters ("Artifacts" -> "AR"). Used by the capability pickers'
// icon fallback so skills no longer all show a generic "S".
function skillInitials(displayName) {
  const cleaned = String(displayName || "")
    // Drop any marketplace path prefix ("Anthropic Agent Skills/algorithmic Art"
    // -> "algorithmic Art") so both pickers derive the same initials.
    .split("/")
    .filter(Boolean)
    .pop();
  const words = String(cleaned || "")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return "S";
  if (words.length === 1) {
    const w = words[0];
    return (w.length >= 2 ? w.slice(0, 2) : w).toUpperCase();
  }
  const first = words[0][0];
  const last = words[words.length - 1][0];
  return `${first}${last}`.toUpperCase();
}

module.exports = { skillInitials };
