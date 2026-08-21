// One-way additive merge of an agent's capabilities into the task's current
// selection: adds any agent ids missing from `current`, preserves the user's
// existing selections and ordering, and never introduces duplicates. Used by
// the scheduled-tasks form's "Reload from Agent" button.
export function mergeAgentCapabilities(
	current: readonly string[] = [],
	agent: readonly string[] = []
): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	const push = (value: unknown) => {
		const id = `${value ?? ''}`.trim();
		if (id && !seen.has(id)) {
			seen.add(id);
			result.push(id);
		}
	};
	for (const id of current) push(id);
	for (const id of agent) push(id);
	return result;
}
