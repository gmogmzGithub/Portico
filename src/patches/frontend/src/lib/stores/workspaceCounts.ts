import { writable } from 'svelte/store';
import { getPromptList } from '$lib/apis/prompts';

type WorkspaceCounts = {
	prompts: number | null;
};

const initialCounts: WorkspaceCounts = {
	prompts: null
};

export const workspaceCounts = writable<WorkspaceCounts>(initialCounts);

let refreshSequence = 0;

export const refreshWorkspaceCounts = async () => {
	if (typeof localStorage === 'undefined') {
		return;
	}

	const token = localStorage.token;
	if (!token) {
		workspaceCounts.set(initialCounts);
		return;
	}

	const requestId = ++refreshSequence;

	const promptsResult = await getPromptList(token)
		.then((prompts) => ({ status: 'fulfilled' as const, value: prompts }))
		.catch((reason) => ({ status: 'rejected' as const, reason }));

	if (requestId !== refreshSequence) {
		return;
	}

	workspaceCounts.update((counts) => ({
		prompts:
			promptsResult.status === 'fulfilled' && Array.isArray(promptsResult.value)
				? promptsResult.value.length
				: counts.prompts
	}));
};
