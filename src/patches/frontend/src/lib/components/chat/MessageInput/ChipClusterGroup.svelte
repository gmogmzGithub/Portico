<!--
	PORTICO PATCH (Round 4 / Issue 4): cluster pending tool-confirmation
	chips by ``(tool_name, mcp)``. Clusters with at least
	``CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT`` chips render as a
	collapsible header with bulk Approve / Cancel actions; smaller
	clusters render inline as before.

	Bulk-approve / bulk-cancel ONLY operate on chips that are still in
	the ``pending`` state — already-resolved chips inside the cluster
	keep their prior decision. Each bulk click emits one
	``decision`` event per chip (the parent's
	``onToolConfirmationDecision`` handler is identical to a manual
	per-chip click), so no security guarantees change: every chip
	still resolves through ``POST /api/v1/utils/chip/resolve`` with
	the user's auth token.

	Cross-references:
	- ``./chipClusters.js`` (pure-JS clustering helper, unit-tested)
	- ``./ToolConfirmationChip.svelte`` (per-chip renderer)
	- ``../MessageInput.svelte`` (parent that supplies the chip list)
	- tests/test_tool_confirmation_chip.node.test.js (Round 4 tests)
-->
<script lang="ts">
	import { createEventDispatcher, getContext } from 'svelte';
	import ToolConfirmationChip from './ToolConfirmationChip.svelte';
	import {
		CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT,
		clusterPendingChips,
		pendingChipsInCluster,
	} from './chipClusters.js';

	const i18n = getContext('i18n');

	type ChipCard = {
		hash: string;
		tool_name?: string;
		mcp?: string;
		summary?: string;
		args_preview?: Record<string, unknown>;
		state?: 'pending' | 'approved' | 'cancelled' | 'modify-submitted' | 'resolved';
		modify_payload?: string;
		kind?: 'tool_confirmation' | 'clarification';
		options?: Array<{ id: string; label: string; style?: string }>;
		prompt?: string;
		allow_freeform?: boolean;
		context?: Record<string, unknown>;
	};

	export let chips: ChipCard[] = [];
	export let chatId: string = '';
	export let collapseThreshold: number = CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT;

	$: clusters = clusterPendingChips(chips, collapseThreshold);

	// Per-cluster expansion state. Default: collapsed when collapsible.
	let expandedClusters: Record<string, boolean> = {};

	function toggleExpanded(clusterKey: string) {
		expandedClusters = {
			...expandedClusters,
			[clusterKey]: !expandedClusters[clusterKey],
		};
	}

	function clusterIsExpanded(clusterKey: string, isCollapsible: boolean): boolean {
		if (!isCollapsible) {
			return true;
		}
		return Boolean(expandedClusters[clusterKey]);
	}

	const dispatch = createEventDispatcher<{ decision: any }>();

	function bulkResolve(cluster: { chips: ChipCard[] }, optionId: 'approve' | 'cancel') {
		const pending = pendingChipsInCluster(cluster);
		for (const chip of pending) {
			// Mirror the shape ToolConfirmationChip emits: a CustomEvent-like
			// object with ``detail`` is built by the parent dispatcher, so
			// here we just hand off { detail } to the listener.
			const detail = {
				decision: optionId === 'approve' ? 'approve' : 'cancel',
				option_id: optionId,
				hash: chip.hash,
				payload: undefined,
			};
			// Svelte's dispatch wraps detail into a CustomEvent — listeners
			// see ``event.detail.decision`` exactly like a per-chip click.
			dispatch('decision', detail);
		}
	}

	function clusterTitle(cluster: {
		tool_name: string;
		mcp: string;
		chips: ChipCard[];
	}): string {
		const total = cluster.chips.length;
		const tool = cluster.tool_name || '(unknown tool)';
		const mcp = cluster.mcp ? ` (${cluster.mcp})` : '';
		return `${total} pending confirmation${total === 1 ? '' : 's'} for ${tool}${mcp}`;
	}
</script>

{#each clusters as cluster (cluster.cluster_key)}
	{#if cluster.is_collapsible}
		<div
			class="chip-cluster rounded-2xl border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-left text-slate-900 transition dark:border-amber-500/20 dark:bg-amber-900/20 dark:text-slate-100"
			data-test-id="chip-cluster"
			data-cluster-key={cluster.cluster_key}
		>
			<div class="flex items-center justify-between gap-3">
				<div class="min-w-0 flex-1">
					<div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-200">
						Action group
					</div>
					<div class="truncate text-sm font-medium">
						{clusterTitle(cluster)}
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<button
						type="button"
						class="rounded-md border border-amber-300/80 bg-white/80 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-800/40"
						data-test-id="chip-cluster-toggle"
						on:click={() => toggleExpanded(cluster.cluster_key)}
					>
						{clusterIsExpanded(cluster.cluster_key, cluster.is_collapsible)
							? 'Hide'
							: `Show all ${cluster.chips.length}`}
					</button>
				</div>
			</div>

			{#if clusterIsExpanded(cluster.cluster_key, cluster.is_collapsible)}
				<div class="mt-2 flex flex-col gap-2">
					{#each cluster.chips as chipCard, chipIndex (chipCard.hash)}
						<ToolConfirmationChip
							card={chipCard}
							{chatId}
							index={chipIndex + 1}
							total={cluster.chips.length}
							on:decision
						/>
					{/each}
				</div>
				<!-- Bulk-action row is ONLY surfaced once the cluster is
					 expanded so the user has seen the individual chips
					 before clicking "approve all". Click semantics:
					 every still-pending chip in the cluster is resolved
					 with the chosen option. Already-resolved chips are
					 untouched. -->
				<div class="mt-2 flex shrink-0 items-center gap-2 border-t border-amber-200/60 pt-2 dark:border-amber-500/20">
					<button
						type="button"
						class="rounded-md border border-emerald-300/80 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 dark:border-emerald-400/30 dark:bg-emerald-900/30 dark:text-emerald-100 dark:hover:bg-emerald-800/40"
						data-test-id="chip-cluster-approve-all"
						on:click={() => bulkResolve(cluster, 'approve')}
					>
						Approve all
					</button>
					<button
						type="button"
						class="rounded-md border border-rose-300/80 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-800 hover:bg-rose-100 dark:border-rose-400/30 dark:bg-rose-900/30 dark:text-rose-100 dark:hover:bg-rose-800/40"
						data-test-id="chip-cluster-cancel-all"
						on:click={() => bulkResolve(cluster, 'cancel')}
					>
						Cancel all
					</button>
				</div>
			{/if}
		</div>
	{:else}
		{#each cluster.chips as chipCard, chipIndex (chipCard.hash)}
			<ToolConfirmationChip
				card={chipCard}
				{chatId}
				index={chipIndex + 1}
				total={cluster.chips.length}
				on:decision
			/>
		{/each}
	{/if}
{/each}
