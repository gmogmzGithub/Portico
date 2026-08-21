type ActiveSkillLike = {
	name?: string;
	display_name?: string;
};

const ACRONYM_OVERRIDES: Record<string, string> = {
	ai: 'AI',
	api: 'API',
	iql: 'IQL',
	lm: 'LM',
	mcp: 'MCP',
	ml: 'ML',
	pdf: 'PDF',
	prd: 'PRD',
	ui: 'UI',
	ux: 'UX'
};

const titleCaseWord = (word: string): string => {
	const lower = word.toLowerCase();
	const override = ACRONYM_OVERRIDES[lower];
	if (override) return override;
	return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const applyAcronymOverrides = (value: string): string =>
	value.replace(/\b([A-Za-z0-9]+)\b/g, (match) => {
		const override = ACRONYM_OVERRIDES[match.toLowerCase()];
		return override || match;
	});

const isLikelySkillIdSegment = (value: string): boolean => {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (/[-_]/.test(trimmed)) {
		return /^[a-z0-9]+([_-][a-z0-9]+)+$/.test(trimmed);
	}
	return /^[a-z0-9]+$/.test(trimmed) && trimmed === trimmed.toLowerCase();
};

const isLikelySkillId = (value: string): boolean =>
	value
		.split('/')
		.map((segment) => segment.trim())
		.filter(Boolean)
		.every(isLikelySkillIdSegment);

const normalizeSkillIdSegment = (segment: string): string =>
	segment
		.trim()
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(titleCaseWord)
		.join(' ');

const normalizeSlashDelimitedSkillName = (value: string): string =>
	value
		.split('/')
		.map(normalizeSkillIdSegment)
		.filter(Boolean)
		.join('/');

export const formatActiveSkillDisplayName = (value: string): string => {
	const raw = String(value || '').trim();
	if (!raw) return '';

	if (raw.includes('/')) {
		return normalizeSlashDelimitedSkillName(raw);
	}

	if (isLikelySkillId(raw)) {
		return normalizeSkillIdSegment(raw);
	}

	return applyAcronymOverrides(raw);
};

export const resolveActiveSkillDisplayName = (skill: ActiveSkillLike): string => {
	const rawDisplay = (skill.display_name || '').trim();
	const rawName = (skill.name || '').trim();
	const baseValue = rawDisplay || rawName;
	if (!baseValue) return '';

	const shouldFormatAsFallbackId =
		(rawDisplay && rawName && rawDisplay === rawName) || isLikelySkillId(baseValue);

	return shouldFormatAsFallbackId
		? formatActiveSkillDisplayName(baseValue)
		: applyAcronymOverrides(formatActiveSkillDisplayName(baseValue));
};

export type SplitActiveSkillDisplayName = {
	marketplace: string | null;
	skillName: string;
};

// Splits a formatted "Marketplace/Skill" label on its LAST slash so the skill
// name can render with priority while the marketplace prefix ellipsizes.
// Degenerate labels (no slash, empty halves) collapse to skillName-only.
export const splitActiveSkillDisplayName = (skill: ActiveSkillLike): SplitActiveSkillDisplayName => {
	const label = resolveActiveSkillDisplayName(skill);
	const splitAt = label.lastIndexOf('/');
	if (splitAt === -1) return { marketplace: null, skillName: label };
	const marketplace = label.slice(0, splitAt).trim();
	const skillName = label.slice(splitAt + 1).trim();
	if (!marketplace || !skillName) return { marketplace: null, skillName: label };
	return { marketplace, skillName };
};
