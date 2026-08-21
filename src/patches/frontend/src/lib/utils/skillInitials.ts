// Two-letter fallback logo for a skill from its display name: first letter of
// the first word + first letter of the last word (e.g. "MCP Bridge Setup" ->
// "MS", "Algorithmic Art" -> "AA"). Single-word names use the first two letters
// ("Artifacts" -> "AR"). Mirrors the Electron implementation
// (electron-app/src/services/skill-initials.js) so both pickers agree.
export function skillInitials(displayName: string): string {
	const cleaned = String(displayName || '')
		// Drop any marketplace path prefix so both sides derive the same initials.
		.split('/')
		.filter(Boolean)
		.pop();
	const words = String(cleaned || '')
		.replace(/[-_]+/g, ' ')
		.split(/\s+/)
		.map((w) => w.trim())
		.filter(Boolean);
	if (words.length === 0) return 'S';
	if (words.length === 1) {
		const w = words[0];
		return (w.length >= 2 ? w.slice(0, 2) : w).toUpperCase();
	}
	return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

// Uppercase common acronyms so names match the agents side, which runs the same
// mapping (electron-app/src/services/skill-frontmatter.js applySkillDisplayAcronyms).
// e.g. "Mcp Bridge Setup" -> "MCP Bridge Setup".
function applySkillDisplayAcronyms(name: string): string {
	return String(name || '').replace(/\b(Lm|Mcp|Api|Url|Ui|Ai|Id)\b/g, (m) => m.toUpperCase());
}

// Human-friendly skill name: strip any marketplace path prefix and prettify the
// last segment, so OWUI matches the clean names shown on the agents side.
export function cleanSkillName(displayName: string): string {
	const last = String(displayName || '')
		.split('/')
		.filter(Boolean)
		.pop();
	const pretty = String(last || '')
		.replace(/[-_]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
	return applySkillDisplayAcronyms(pretty) || String(displayName || '');
}
