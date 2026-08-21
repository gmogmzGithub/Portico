// Pure state helpers for the chat model picker (Selector.svelte). Extracted so
// the tab-open decision and the agents-tab ordering are unit-testable.

export type PickerTab = 'models' | 'agents';

export type ResolveInitialPickerTabInput = {
	selectedModelId: string;
	selectedHasBaseModelId: boolean;
	agentIds: ReadonlySet<string>;
};

// Open on the Agents tab whenever the selected entity is an agent: either it
// is in the (possibly still-loading) workspace-agents set, or it carries a
// base_model_id — the agent-shaped signal that works before the set loads.
export const resolveInitialPickerTab = ({
	selectedModelId,
	selectedHasBaseModelId,
	agentIds
}: ResolveInitialPickerTabInput): PickerTab => {
	const id = String(selectedModelId ?? '').trim();
	if ((id !== '' && agentIds?.has(id)) || selectedHasBaseModelId) return 'agents';
	return 'models';
};

type AgentPickerItemLike = {
	value?: string;
	label?: string;
};

// Agents-tab ordering: the currently selected agent is pinned to the top
// (users typically have many agents); the rest are alphabetized by label,
// case-insensitively. Stable and non-mutating.
export const orderAgentPickerItems = <T extends AgentPickerItemLike>(
	items: readonly T[],
	selectedValue: string
): T[] => {
	const selected = String(selectedValue ?? '').trim();
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			const aSelected = selected !== '' && String(a.item?.value ?? '').trim() === selected;
			const bSelected = selected !== '' && String(b.item?.value ?? '').trim() === selected;
			if (aSelected !== bSelected) return aSelected ? -1 : 1;
			const byLabel = String(a.item?.label ?? '').localeCompare(
				String(b.item?.label ?? ''),
				undefined,
				{ sensitivity: 'base' }
			);
			if (byLabel !== 0) return byLabel;
			return a.index - b.index;
		})
		.map(({ item }) => item);
};
