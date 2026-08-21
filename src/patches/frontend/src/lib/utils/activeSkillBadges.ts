import type { ActiveSkill } from '$lib/apis/chatCapabilities';
import {
	formatActiveSkillDisplayName,
	resolveActiveSkillDisplayName
} from '$lib/utils/activeSkillDisplayName';

export type ActiveSkillBadge = {
	kind: 'core' | 'user' | 'published' | 'installed' | 'git' | 'marketplace-name';
	label: string;
};

const SOLUTIONS_MARKETPLACE_ID = 'ai-marketplace';

// Chip set and ordering mirror the control plane's provenance table
// (electron-app agents.js agentViewSkillRowChipsHtml): marketplace installs
// show their where-from chips (GIT for git-backed repos, then the marketplace
// name) — every active skill is installed by definition, so the INSTALLED
// chip is dropped here to save row width. User skills lead with USER
// (+PUBLISHED when linked to a listing), system skills are CORE. Unenriched
// skills render as a name-only row.
export const activeSkillBadges = (skill: ActiveSkill): ActiveSkillBadge[] => {
	if (skill.source === 'marketplace') {
		const badges: ActiveSkillBadge[] = [];
		if (skill.marketplace_id && skill.marketplace_id !== SOLUTIONS_MARKETPLACE_ID) {
			badges.push({ kind: 'git', label: 'Git' });
		}
		if (skill.marketplace_id) {
			badges.push({
				kind: 'marketplace-name',
				label:
					skill.marketplace_id === SOLUTIONS_MARKETPLACE_ID
						? 'Solutions Marketplace'
						: skill.marketplace_id
			});
		}
		return badges;
	}
	if (skill.source === 'user') {
		const badges: ActiveSkillBadge[] = [{ kind: 'user', label: 'User' }];
		if (skill.marketplace_relationship === 'published') {
			badges.push({ kind: 'published', label: 'Published' });
		}
		return badges;
	}
	if (skill.source === 'system') {
		return [{ kind: 'core', label: 'Core' }];
	}
	return [];
};

// Mirrors the control plane's skillTableSourceRank (agents.js): Core/system
// first, then the viewer's user skills, then Solutions Marketplace installs,
// then git-marketplace installs; unenriched rows last. Skill tables sort by
// this rank, alphabetically within each group.
export const activeSkillSourceRank = (skill: ActiveSkill): number => {
	if (skill.source === 'system') return 0;
	if (skill.source === 'user') return 1;
	if (skill.source === 'marketplace') {
		return skill.marketplace_id && skill.marketplace_id !== SOLUTIONS_MARKETPLACE_ID ? 3 : 2;
	}
	return 4;
};

// Row label: the friendly leaf name, prefixed by its plugin when the skill
// ships inside one ("A11y → Fixing Jira A11y In Bulk" — same reading as the
// control plane's provenance tables). Badges convey the marketplace, so a
// namespaced fallback label ("Repo/Plugin/Skill") drops its path prefix.
export const activeSkillRowLabel = (skill: ActiveSkill): string => {
	const label = resolveActiveSkillDisplayName(skill);
	const splitAt = label.lastIndexOf('/');
	const leaf = splitAt === -1 ? label : label.slice(splitAt + 1).trim() || label;
	const plugin = String(skill.plugin_name || '').trim();
	if (!plugin) return leaf;
	return `${formatActiveSkillDisplayName(plugin)} → ${leaf}`;
};
