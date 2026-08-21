// Shared display-name badge colors for the multi-chat feature. ONE deterministic
// name→color mapping keeps every surface in sync: tile pane badges, the
// [[xchat:...]] prefix badges rendered inside messages, and the composer's
// send-target chip. Colors are plain hex/rgba data (not tailwind classes) so
// this module stays pure and node:test-able, and consumers are immune to
// tailwind's class scanning.

export const ORCHESTRATOR_DISPLAY_NAME = 'Orchestrator';

// Eight hue triads, each with light + dark values that read well on the app's
// light and dark surfaces. `pane` carries the tile-border pair for the same
// hue: idle = a very light pastel (200-level), focused = the saturated
// mid-tone (500-level) — clearly darker yet unmistakably the SAME color
// family. Dark theme uses a dim translucency when idle and the bright
// 400-level when focused (a darker shade would sink into the canvas).
export const BADGE_PALETTE = [
	{
		name: 'blue',
		light: { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
		dark: { bg: 'rgba(59, 130, 246, 0.22)', text: '#bfdbfe', border: 'rgba(59, 130, 246, 0.45)' },
		pane: {
			light: { idle: '#bfdbfe', focused: '#3b82f6' },
			dark: { idle: 'rgba(59, 130, 246, 0.35)', focused: '#60a5fa' }
		}
	},
	{
		name: 'emerald',
		light: { bg: '#d1fae5', text: '#065f46', border: '#6ee7b7' },
		dark: { bg: 'rgba(16, 185, 129, 0.22)', text: '#a7f3d0', border: 'rgba(16, 185, 129, 0.45)' },
		pane: {
			light: { idle: '#a7f3d0', focused: '#10b981' },
			dark: { idle: 'rgba(16, 185, 129, 0.35)', focused: '#34d399' }
		}
	},
	{
		name: 'amber',
		light: { bg: '#fef3c7', text: '#92400e', border: '#fcd34d' },
		dark: { bg: 'rgba(245, 158, 11, 0.22)', text: '#fde68a', border: 'rgba(245, 158, 11, 0.45)' },
		pane: {
			light: { idle: '#fde68a', focused: '#f59e0b' },
			dark: { idle: 'rgba(245, 158, 11, 0.35)', focused: '#fbbf24' }
		}
	},
	{
		name: 'violet',
		light: { bg: '#ede9fe', text: '#5b21b6', border: '#c4b5fd' },
		dark: { bg: 'rgba(139, 92, 246, 0.22)', text: '#ddd6fe', border: 'rgba(139, 92, 246, 0.45)' },
		pane: {
			light: { idle: '#ddd6fe', focused: '#8b5cf6' },
			dark: { idle: 'rgba(139, 92, 246, 0.35)', focused: '#a78bfa' }
		}
	},
	{
		name: 'rose',
		light: { bg: '#ffe4e6', text: '#9f1239', border: '#fda4af' },
		dark: { bg: 'rgba(244, 63, 94, 0.22)', text: '#fecdd3', border: 'rgba(244, 63, 94, 0.45)' },
		pane: {
			light: { idle: '#fecdd3', focused: '#f43f5e' },
			dark: { idle: 'rgba(244, 63, 94, 0.35)', focused: '#fb7185' }
		}
	},
	{
		name: 'cyan',
		light: { bg: '#cffafe', text: '#155e75', border: '#67e8f9' },
		dark: { bg: 'rgba(6, 182, 212, 0.22)', text: '#a5f3fc', border: 'rgba(6, 182, 212, 0.45)' },
		pane: {
			light: { idle: '#a5f3fc', focused: '#06b6d4' },
			dark: { idle: 'rgba(6, 182, 212, 0.35)', focused: '#22d3ee' }
		}
	},
	{
		name: 'orange',
		light: { bg: '#ffedd5', text: '#9a3412', border: '#fdba74' },
		dark: { bg: 'rgba(249, 115, 22, 0.22)', text: '#fed7aa', border: 'rgba(249, 115, 22, 0.45)' },
		pane: {
			light: { idle: '#fed7aa', focused: '#f97316' },
			dark: { idle: 'rgba(249, 115, 22, 0.35)', focused: '#fb923c' }
		}
	},
	{
		name: 'fuchsia',
		light: { bg: '#fae8ff', text: '#86198f', border: '#f0abfc' },
		dark: { bg: 'rgba(217, 70, 239, 0.22)', text: '#f5d0fe', border: 'rgba(217, 70, 239, 0.45)' },
		pane: {
			light: { idle: '#f5d0fe', focused: '#d946ef' },
			dark: { idle: 'rgba(217, 70, 239, 0.35)', focused: '#e879f9' }
		}
	}
];

// FNV-1a over the normalized name: stable across sessions and surfaces.
export const badgePaletteIndex = (name) => {
	const normalized = String(name ?? '')
		.trim()
		.toLowerCase();
	let hash = 0x811c9dc5;
	for (let i = 0; i < normalized.length; i += 1) {
		hash ^= normalized.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % BADGE_PALETTE.length;
};

export const badgeColors = (name) => BADGE_PALETTE[badgePaletteIndex(name)];

// CSS-variable style string consumed by a `.display-name-badge`-style rule:
// light values as the defaults, dark values swapped in under `.dark`.
export const badgeStyleVars = (name) => {
	const { light, dark, pane } = badgeColors(name);
	return [
		`--badge-bg: ${light.bg}`,
		`--badge-text: ${light.text}`,
		`--badge-border: ${light.border}`,
		`--badge-bg-dark: ${dark.bg}`,
		`--badge-text-dark: ${dark.text}`,
		`--badge-border-dark: ${dark.border}`,
		`--pane-border-idle: ${pane.light.idle}`,
		`--pane-border-focused: ${pane.light.focused}`,
		`--pane-border-idle-dark: ${pane.dark.idle}`,
		`--pane-border-focused-dark: ${pane.dark.focused}`
	].join('; ');
};
