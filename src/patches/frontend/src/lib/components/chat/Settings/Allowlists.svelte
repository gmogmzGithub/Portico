<!--
	PORTICO PATCH (Round 4 / Issue 2d): Settings tab for the per-user
	tool-allowlist.

	Renders:
	  * Master toggle ("Allowlists enabled") — a panic button that
	    suspends every entry without nuking the rules.
	  * One row per (tool_name, mcp) entry: per-row enable/disable
	    switch + delete button with a 5-second undo toast.

	Wiring:
	  * Mounted as a tab inside the OWUI Settings dialog by the
	    upstream patch in Settings.svelte (see follow-up). Until
	    that patch lands, the component is reachable via direct
	    import in app routes for QA.
	  * Talks to the backend via ``$lib/apis/toolAllowlist`` —
	    every helper there carries the auth token from the user
	    store and verifies chat ownership server-side.

	The chip's "Always allow" button (Round 4 / Issue 2b) populates
	the same backend file via the gate's resolve endpoint, so a
	user who never opens this page still ends up with a working
	allowlist.

	Cross-references:
	  * src/patches/backend/open_webui/utils/tool_allowlist.py (data)
	  * src/patches/backend/open_webui/routers/utils.py (REST)
	  * docs/architecture/chip-system.md "Per-user allowlist"
-->
<script lang="ts">
	import { onMount, getContext } from 'svelte';
	import { toast } from 'svelte-sonner';
	import {
		emptyAllowlistFile,
		getAllowlist,
		setAllowlistMasterToggle,
		setAllowlistEntryEnabled,
		deleteAllowlistEntry,
		type ToolAllowlistEntry,
		type ToolAllowlistFile
	} from '$lib/apis/toolAllowlist';

	const i18n = getContext<any>('i18n');

	export let token: string = '';

	let file: ToolAllowlistFile = emptyAllowlistFile();
	let loading = true;
	let saving = false;

	$: groupedEntries = groupEntriesByMcp(file.entries);

	function groupEntriesByMcp(
		entries: ToolAllowlistEntry[]
	): Array<{ mcp: string; entries: ToolAllowlistEntry[] }> {
		// Group by mcp so the user's mental model ("Slack rules /
		// Asana rules / Jira rules") matches the page layout. Empty
		// mcp falls under "Other".
		const map = new Map<string, ToolAllowlistEntry[]>();
		for (const entry of entries) {
			const key = entry.mcp || 'other';
			const bucket = map.get(key) ?? [];
			bucket.push(entry);
			map.set(key, bucket);
		}
		// Sort MCPs alphabetically, "other" last.
		const keys = Array.from(map.keys()).sort((a, b) => {
			if (a === 'other') return 1;
			if (b === 'other') return -1;
			return a.localeCompare(b);
		});
		return keys.map((mcp) => ({
			mcp,
			entries: (map.get(mcp) ?? []).slice().sort((a, b) =>
				a.tool_name.localeCompare(b.tool_name)
			)
		}));
	}

	async function reload() {
		loading = true;
		try {
			file = await getAllowlist(token);
		} finally {
			loading = false;
		}
	}

	async function toggleMaster(event: Event) {
		const checked = (event.target as HTMLInputElement)?.checked ?? false;
		// User-perceived change: ``master_disabled`` is the inverse
		// of "enabled" so the toggle reads as "Allowlists enabled".
		saving = true;
		try {
			file = await setAllowlistMasterToggle(token, !checked);
			toast.success(
				checked ? 'Allowlists enabled' : 'Allowlists temporarily disabled'
			);
		} catch (error) {
			console.error('[allowlists] master toggle failed', error);
			toast.error('Failed to update allowlist toggle');
			// Reload to re-sync local state with the server.
			await reload();
		} finally {
			saving = false;
		}
	}

	async function toggleEntry(entry: ToolAllowlistEntry, enabled: boolean) {
		saving = true;
		try {
			const updated = await setAllowlistEntryEnabled(token, entry.id, enabled);
			file = {
				...file,
				entries: file.entries.map((e) => (e.id === updated.id ? updated : e))
			};
		} catch (error) {
			console.error('[allowlists] toggle failed', error);
			toast.error('Failed to toggle allowlist entry');
			await reload();
		} finally {
			saving = false;
		}
	}

	async function removeEntry(entry: ToolAllowlistEntry) {
		// Optimistic removal so the UI feels responsive; if the
		// 5-second undo window expires WITHOUT being clicked, we
		// commit by sending the DELETE call. If it IS clicked, we
		// re-insert locally and skip the DELETE.
		const previous = file;
		file = {
			...file,
			entries: file.entries.filter((e) => e.id !== entry.id)
		};
		let undone = false;
		toast.info(`Removed ${entry.tool_name}`, {
			duration: 5000,
			action: {
				label: 'Undo',
				onClick: () => {
					undone = true;
					file = previous;
				}
			}
		});
		setTimeout(async () => {
			if (undone) {
				return;
			}
			try {
				await deleteAllowlistEntry(token, entry.id);
			} catch (error) {
				console.error('[allowlists] delete failed', error);
				toast.error('Failed to remove allowlist entry');
				file = previous;
			}
		}, 5100);
	}

	onMount(() => {
		if (token) {
			reload();
		}
	});
</script>

<div class="flex flex-col gap-4" data-test-id="settings-allowlists">
	<header class="flex items-start justify-between gap-3">
		<div>
			<h2 class="text-base font-semibold">
				{$i18n?.t?.('Tool allowlist') ?? 'Tool allowlist'}
			</h2>
			<p class="text-sm text-gray-600 dark:text-gray-300">
				{$i18n?.t?.(
					'Actions you have approved with "Always allow" run silently. Toggle entries off to bring back the confirmation chip.'
				) ??
					'Actions you have approved with "Always allow" run silently. Toggle entries off to bring back the confirmation chip.'}
			</p>
		</div>
	</header>

	<label class="flex items-center gap-3 rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700">
		<input
			type="checkbox"
			class="h-4 w-4"
			checked={!file.master_disabled}
			disabled={loading || saving}
			on:change={toggleMaster}
			data-test-id="allowlist-master-toggle"
		/>
		<span class="text-sm">
			{$i18n?.t?.('Allowlists enabled') ?? 'Allowlists enabled'}
		</span>
		<span class="ml-auto text-xs text-gray-500">
			{file.master_disabled
				? ($i18n?.t?.('Allowlists are paused — every action will surface a chip.') ??
					'Allowlists are paused — every action will surface a chip.')
				: ($i18n?.t?.('Approved actions will run silently.') ??
					'Approved actions will run silently.')}
		</span>
	</label>

	{#if loading}
		<div class="text-sm text-gray-500" data-test-id="allowlist-loading">Loading…</div>
	{:else if file.entries.length === 0}
		<div class="text-sm text-gray-500" data-test-id="allowlist-empty">
			{$i18n?.t?.(
				'No allowlist entries yet. Click "Always allow" on a confirmation chip to add one.'
			) ?? 'No allowlist entries yet. Click "Always allow" on a confirmation chip to add one.'}
		</div>
	{:else}
		<div class="flex flex-col gap-4" data-test-id="allowlist-groups">
			{#each groupedEntries as group (group.mcp)}
				<section class="flex flex-col gap-1">
					<h3
						class="text-xs font-semibold uppercase tracking-wide text-gray-500"
						data-test-id="allowlist-group-header"
						data-mcp={group.mcp}
					>
						{group.mcp}
					</h3>
					<ul class="flex flex-col gap-1">
						{#each group.entries as entry (entry.id)}
							<li
								class="flex items-center gap-3 rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700"
								data-test-id="allowlist-entry"
								data-entry-id={entry.id}
							>
								<input
									type="checkbox"
									class="h-4 w-4"
									checked={entry.enabled}
									disabled={saving}
									on:change={(event) =>
										toggleEntry(entry, (event.target as HTMLInputElement).checked)}
									data-test-id="allowlist-entry-toggle"
								/>
								<span class="font-mono">{entry.tool_name}</span>
								<button
									type="button"
									class="ml-auto rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
									aria-label="Remove allowlist entry"
									on:click={() => removeEntry(entry)}
									data-test-id="allowlist-entry-remove"
								>
									X
								</button>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	{/if}
</div>
