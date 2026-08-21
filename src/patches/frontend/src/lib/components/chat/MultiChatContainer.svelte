<script lang="ts">
	// PORTICO_PATCH (multi-chat tiling): tiles the root chat plus up to 3
	// start_chat peer chats in ONE view. Chat instances render persistently in
	// a keyed {#each} and are PORTALED into layout slots, so entering/resizing
	// the tiled layout never remounts a live (possibly streaming) chat. One
	// composer serves the whole view: the primary Chat portals its composer
	// into the bottom bar and dispatches to the focused pane.
	//
	// Event-driven only: pane state loads once per root chat (parallel to the
	// chat's own hydration) and extends live via the backend's
	// chat:multi-chat:pane-added socket event. No timers, no polling.
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { PaneGroup, Pane, PaneResizer } from 'paneforge';

	import Chat from './Chat.svelte';
	import { chatId as chatIdStore, socket, showArtifacts, showSidebar } from '$lib/stores';
	import { getChatById } from '$lib/apis/chats';
	import {
		multiChatActiveRootId,
		multiChatFocusedChatId,
		multiChatPaneRuntime,
		type MultiChatPane
	} from '$lib/stores/multiChatPanes';
	import { badgeStyleVars, ORCHESTRATOR_DISPLAY_NAME } from '$lib/utils/displayNameBadge.mjs';
	import { portalTo } from '$lib/utils/portalAction';
	import { rebindSocketListeners } from '$lib/utils/socket-listener-binding.mjs';
	import { toast } from 'svelte-sonner';

	export let chatIdProp = '';

	const MAIN_SLOT = '__main__';

	let panes: MultiChatPane[] = [];
	let metaLoadedFor = '';
	let lastRootChatId: string | null = null;
	let composerBarEl: HTMLElement | null = null;
	let slotEls: Record<string, HTMLElement | null> = {};
	let artifactsToastShown = false;

	// The root chat id: the route param, or (home route) the id the primary
	// Chat publishes to the global store once the first message creates it.
	// The home-route fallback must ignore whatever id the store held BEFORE
	// this container mounted: clicking New Chat navigates here while the store
	// still points at the previous chat, and adopting that stale id would
	// resurrect its tiles around the fresh chat. Once the store passes through
	// '' (the new chat initialized), later ids are genuine "first message
	// created the chat" transitions and are adopted.
	let staleHomeChatId = chatIdProp ? '' : get(chatIdStore) || '';
	$: if (!$chatIdStore) staleHomeChatId = '';
	$: rootChatId = chatIdProp || ($chatIdStore !== staleHomeChatId ? $chatIdStore : '') || '';
	$: tiled = panes.length > 0 && !tilesCollapsed;
	$: hasPanes = panes.length > 0;

	// ── root-change reset + pane meta load ────────────────────────────────
	// Keyed on the resolved root (not just the route param) so an in-place
	// New Chat — where the Chat re-inits via its page subscription without a
	// container remount — also tears the old tiles down.
	$: if (rootChatId !== lastRootChatId) {
		lastRootChatId = rootChatId;
		panes = [];
		metaLoadedFor = '';
		collapsedLoadedFor = '';
		tilesCollapsed = false;
		multiChatFocusedChatId.set('');
	}
	$: void loadPaneMeta(rootChatId);

	async function loadPaneMeta(id: string) {
		if (!id || id.startsWith('local:') || metaLoadedFor === id) {
			return;
		}
		metaLoadedFor = id;
		try {
			// Runs in parallel with the primary Chat's own hydration fetch —
			// never blocks first paint; ordinary chats just get an empty list.
			const chat = await getChatById(localStorage.token, id);
			if (metaLoadedFor !== id) return;
			const paneList = chat?.meta?.multi_chat_panes;
			if (Array.isArray(paneList)) {
				panes = paneList
					.filter((pane) => typeof pane?.chat_id === 'string' && pane.chat_id)
					.map((pane) => ({
						chat_id: pane.chat_id,
						display_name:
							typeof pane.display_name === 'string' && pane.display_name.trim()
								? pane.display_name.trim()
								: 'Chat',
						created_at: Number(pane.created_at) || 0
					}))
					.sort((a, b) => a.created_at - b.created_at)
					.slice(0, 3);
			}
		} catch {
			// Brand-new/foreign chats 404 here; the view stays untiled.
		}
	}

	// ── tiling stores + focus defaults ────────────────────────────────────
	$: multiChatActiveRootId.set(tiled ? rootChatId : '');
	$: if (tiled && rootChatId) {
		const focused = $multiChatFocusedChatId;
		const valid = focused === rootChatId || panes.some((pane) => pane.chat_id === focused);
		if (!valid) {
			multiChatFocusedChatId.set(rootChatId);
		}
	}

	$: focusedChatId = tiled ? $multiChatFocusedChatId || rootChatId : rootChatId;
	$: crossPaneTarget =
		tiled && focusedChatId && focusedChatId !== rootChatId
			? {
					chatId: focusedChatId,
					displayName:
						panes.find((pane) => pane.chat_id === focusedChatId)?.display_name ?? 'Chat'
				}
			: null;

	// ── live pane-added events ────────────────────────────────────────────
	let boundSocket: any = null;
	const paneAddedHandler = (event: any) => {
		if (!event || event.chat_id !== rootChatId) return;
		if (event?.data?.type !== 'chat:multi-chat:pane-added') return;
		const pane = event.data?.data?.pane;
		if (!pane?.chat_id || panes.some((existing) => existing.chat_id === pane.chat_id)) return;
		if (panes.length >= 3) return;
		panes = [
			...panes,
			{
				chat_id: pane.chat_id,
				display_name:
					typeof pane.display_name === 'string' && pane.display_name.trim()
						? pane.display_name.trim()
						: 'Chat',
				created_at: Number(pane.created_at) || 0
			}
		];
	};
	$: boundSocket = rebindSocketListeners(boundSocket, $socket, [['events', paneAddedHandler]]);

	// ── multi-chat forces windowed-only artifacts ─────────────────────────
	// The upstream inline artifacts pane cannot host per-pane artifacts;
	// flip it back off and let the Electron window path take over.
	$: if (tiled && $showArtifacts) {
		showArtifacts.set(false);
		if (!artifactsToastShown) {
			artifactsToastShown = true;
			toast.info('Artifacts open in a separate window while multiple chats are tiled.');
		}
	}

	// ── divider + collapse persistence (localStorage, per root chat) ──────
	type SavedLayout = {
		outer?: number[];
		left?: number[];
		right?: number[];
		collapsed?: boolean;
	};
	const layoutStorageKey = (id: string) => `porticoMultiChatLayout:${id}`;
	let savedLayout: SavedLayout = {};
	$: savedLayout = readSavedLayout(rootChatId);

	// One-fell-swoop tile toggle: hides every peer tile (the view renders as
	// a plain single chat) without unmounting them, so streams stay live and
	// re-expanding is instant. Persisted per root chat.
	let tilesCollapsed = false;
	let collapsedLoadedFor = '';
	$: if (rootChatId && collapsedLoadedFor !== rootChatId) {
		collapsedLoadedFor = rootChatId;
		tilesCollapsed = readSavedLayout(rootChatId)?.collapsed === true;
	}
	const toggleTiles = () => {
		tilesCollapsed = !tilesCollapsed;
		if (!rootChatId) return;
		try {
			const current = readSavedLayout(rootChatId);
			current.collapsed = tilesCollapsed;
			localStorage.setItem(layoutStorageKey(rootChatId), JSON.stringify(current));
		} catch {
			// Persistence failure only costs the remembered collapse state.
		}
	};

	function readSavedLayout(id: string): SavedLayout {
		if (!id) return {};
		try {
			const raw = localStorage.getItem(layoutStorageKey(id));
			const parsed = raw ? JSON.parse(raw) : {};
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	const saveLayout = (group: keyof SavedLayout) => (sizes: number[]) => {
		if (!rootChatId || !Array.isArray(sizes) || sizes.length === 0) return;
		try {
			const current = readSavedLayout(rootChatId);
			current[group] = sizes;
			localStorage.setItem(layoutStorageKey(rootChatId), JSON.stringify(current));
		} catch {
			// Quota/serialization failures only cost divider persistence.
		}
	};

	const savedSize = (group: keyof SavedLayout, index: number, fallback: number) => {
		const sizes = savedLayout?.[group];
		const value = Array.isArray(sizes) ? Number(sizes[index]) : NaN;
		return Number.isFinite(value) && value > 0 && value < 100 ? value : fallback;
	};

	// ── persistent chat instances (portaled into layout slots) ────────────
	type ChatInstance = {
		slotId: string;
		chatIdProp: string;
		chatId: string;
		displayName: string;
		isMain: boolean;
	};
	$: chatInstances = [
		{
			slotId: MAIN_SLOT,
			chatIdProp,
			chatId: rootChatId,
			displayName: ORCHESTRATOR_DISPLAY_NAME,
			isMain: true
		},
		...panes.map((pane) => ({
			slotId: pane.chat_id,
			chatIdProp: pane.chat_id,
			chatId: pane.chat_id,
			displayName: pane.display_name,
			isMain: false
		}))
	] as ChatInstance[];

	const focusPane = (chatId: string) => {
		if (chatId) multiChatFocusedChatId.set(chatId);
	};

	onDestroy(() => {
		boundSocket = rebindSocketListeners(boundSocket, null, [['events', paneAddedHandler]]);
		multiChatActiveRootId.set('');
		multiChatFocusedChatId.set('');
		multiChatPaneRuntime.set({});
	});
</script>

<!-- Takes over Chat.svelte's old root sizing (viewport height + sidebar
     width compensation); Chat instances fill their pane slots with h-full.
     The explicit surface color keeps pane gaps and the composer bar on the
     same background as the chats themselves. -->
<div
	class="portico-chat-canvas flex h-screen max-h-[100dvh] w-full max-w-full flex-col transition-width duration-200 ease-in-out {$showSidebar
		? 'md:max-w-[calc(100%-var(--sidebar-width))]'
		: ''}"
>
	<!-- Tiled layouts get a whisper of horizontal padding so pane borders never
	     butt flush against the window/sidebar edge. -->
	<div class="min-h-0 flex-1 {tiled ? 'px-1.5' : ''}">
		{#if !tiled}
			<div class="h-full w-full" bind:this={slotEls[MAIN_SLOT]}></div>
		{:else if panes.length === 1}
			<PaneGroup direction="horizontal" class="h-full w-full" onLayoutChange={saveLayout('outer')}>
				<Pane defaultSize={savedSize('outer', 0, 50)} minSize={20}>
					<div class="h-full w-full" bind:this={slotEls[MAIN_SLOT]}></div>
				</Pane>
				<PaneResizer class="multi-chat-resizer" />
				<Pane defaultSize={savedSize('outer', 1, 50)} minSize={20}>
					<div class="h-full w-full" bind:this={slotEls[panes[0].chat_id]}></div>
				</Pane>
			</PaneGroup>
		{:else if panes.length === 2}
			<PaneGroup direction="horizontal" class="h-full w-full" onLayoutChange={saveLayout('outer')}>
				<Pane defaultSize={savedSize('outer', 0, 50)} minSize={20}>
					<div class="h-full w-full" bind:this={slotEls[MAIN_SLOT]}></div>
				</Pane>
				<PaneResizer class="multi-chat-resizer" />
				<Pane defaultSize={savedSize('outer', 1, 50)} minSize={20}>
					<PaneGroup direction="vertical" class="h-full w-full" onLayoutChange={saveLayout('right')}>
						<Pane defaultSize={savedSize('right', 0, 50)} minSize={15}>
							<div class="h-full w-full" bind:this={slotEls[panes[0].chat_id]}></div>
						</Pane>
						<PaneResizer class="multi-chat-resizer multi-chat-resizer-horizontal" />
						<Pane defaultSize={savedSize('right', 1, 50)} minSize={15}>
							<div class="h-full w-full" bind:this={slotEls[panes[1].chat_id]}></div>
						</Pane>
					</PaneGroup>
				</Pane>
			</PaneGroup>
		{:else}
			<PaneGroup direction="horizontal" class="h-full w-full" onLayoutChange={saveLayout('outer')}>
				<Pane defaultSize={savedSize('outer', 0, 50)} minSize={20}>
					<PaneGroup direction="vertical" class="h-full w-full" onLayoutChange={saveLayout('left')}>
						<Pane defaultSize={savedSize('left', 0, 50)} minSize={15}>
							<div class="h-full w-full" bind:this={slotEls[MAIN_SLOT]}></div>
						</Pane>
						<PaneResizer class="multi-chat-resizer multi-chat-resizer-horizontal" />
						<Pane defaultSize={savedSize('left', 1, 50)} minSize={15}>
							<div class="h-full w-full" bind:this={slotEls[panes[1].chat_id]}></div>
						</Pane>
					</PaneGroup>
				</Pane>
				<PaneResizer class="multi-chat-resizer" />
				<Pane defaultSize={savedSize('outer', 1, 50)} minSize={20}>
					<PaneGroup direction="vertical" class="h-full w-full" onLayoutChange={saveLayout('right')}>
						<Pane defaultSize={savedSize('right', 0, 50)} minSize={15}>
							<div class="h-full w-full" bind:this={slotEls[panes[0].chat_id]}></div>
						</Pane>
						<PaneResizer class="multi-chat-resizer multi-chat-resizer-horizontal" />
						<Pane defaultSize={savedSize('right', 1, 50)} minSize={15}>
							<div class="h-full w-full" bind:this={slotEls[panes[2].chat_id]}></div>
						</Pane>
					</PaneGroup>
				</Pane>
			</PaneGroup>
		{/if}
	</div>

	{#if tiled}
		<!-- Shared composer bar: the primary Chat portals its MessageInput
		     here. Seamless with the chat surface (no divider, tight gap). -->
		<div
			class="w-full shrink-0 px-3 pb-0.5"
			data-multi-chat-composer-bar
			bind:this={composerBarEl}
		></div>
	{/if}
</div>

<!-- Persistent Chat instances; portaled into whichever slot the current
     layout assigns them. Keyed by slot (NOT by chat id for the main pane) so
     neither tiling activation nor home-route chat creation remounts a chat. -->
<div class="hidden">
	{#each chatInstances as instance (instance.slotId)}
		<div
			class="h-full min-h-0 w-full"
			use:portalTo={slotEls[instance.slotId]}
		>
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div
				class="relative h-full min-h-0 w-full overflow-hidden {tiled
					? `rounded-md border-[5px] transition-colors multi-chat-pane-border-badge ${
							focusedChatId === instance.chatId && instance.chatId
								? 'multi-chat-pane-focused'
								: ''
						}`
					: ''}"
				style={tiled ? badgeStyleVars(instance.displayName) : undefined}
				data-multi-chat-pane={tiled ? 'true' : undefined}
				data-multi-chat-chrome={hasPanes ? 'true' : undefined}
				data-pane-chat-id={instance.chatId || undefined}
				on:pointerdown|capture={() => {
					// Click-anywhere-to-focus: capture phase, no preventDefault —
					// the press still reaches links/buttons/text selection inside.
					if (tiled && instance.chatId) focusPane(instance.chatId);
				}}
			>
				{#if hasPanes && (tiled || instance.isMain)}
					<!-- Badge + button cluster: top-LEFT on every pane (consistent
					     anchoring), z-50 above the Navbar's translucent blur layer,
					     over a canvas-colored backdrop that fades at the edges so
					     scrolling content never visually collides with the chrome.
					     Clickability: the pane-scoped .drag-region override below
					     removes the navbar's window-drag behavior while tiled, so
					     real mouse clicks reach these buttons. -->
					<div class="pointer-events-none absolute left-3 top-2 z-50">
						<div class="pane-chrome-backdrop absolute -inset-x-6 -inset-y-3" aria-hidden="true"></div>
						<div class="relative flex items-center gap-1.5">
						<span
							class="display-name-badge no-drag-region pointer-events-auto inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold leading-4 shadow-sm"
							style={badgeStyleVars(instance.displayName)}
						>
							{instance.displayName}
						</span>
						{#if instance.isMain}
							<button
								type="button"
								class="focus-pane-button no-drag-region pointer-events-auto inline-flex size-6 items-center justify-center rounded-full border border-slate-300/80 bg-white/90 text-slate-600 shadow-sm transition hover:border-blue-400 hover:text-blue-600 dark:border-white/10 dark:bg-gray-850/90 dark:text-slate-300 dark:hover:border-blue-400/60 dark:hover:text-blue-300"
								title={tilesCollapsed
									? 'Show the tiled chats'
									: 'Hide the tiled chats (they keep working in the background)'}
								aria-label={tilesCollapsed ? 'Show tiled chats' : 'Hide tiled chats'}
								aria-pressed={!tilesCollapsed}
								data-multi-chat-toggle
								on:click={toggleTiles}
							>
								{#if tilesCollapsed}
									<!-- expand tiles: outward arrows -->
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-3.5" aria-hidden="true">
										<path d="M15 3h6v6" />
										<path d="M9 21H3v-6" />
										<path d="M21 3l-7 7" />
										<path d="M3 21l7-7" />
									</svg>
								{:else}
									<!-- collapse tiles: inward arrows -->
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-3.5" aria-hidden="true">
										<path d="M4 14h6v6" />
										<path d="M20 10h-6V4" />
										<path d="M14 10l7-7" />
										<path d="M3 21l7-7" />
									</svg>
								{/if}
							</button>
						{/if}
						</div>
					</div>
				{/if}
				<Chat
					chatIdProp={instance.chatIdProp}
					paneRole={instance.isMain ? (tiled ? 'primary' : 'single') : 'tile'}
					composerPortalTarget={instance.isMain && tiled ? composerBarEl : null}
					crossPaneTarget={instance.isMain ? crossPaneTarget : null}
				/>
			</div>
		</div>
	{/each}
</div>

<style>
	:global(.multi-chat-resizer) {
		position: relative;
		width: 6px;
		flex-shrink: 0;
		background: transparent;
		cursor: col-resize;
	}
	:global(.multi-chat-resizer-horizontal) {
		width: 100%;
		height: 6px;
		cursor: row-resize;
	}
	/* Always-visible blue dividers (no hover-only gap); hover/drag deepens. */
	:global(.multi-chat-resizer)::after {
		content: '';
		position: absolute;
		inset: 2px;
		border-radius: 9999px;
		background: rgba(59, 130, 246, 0.45);
		transition: background-color 120ms ease;
	}
	:global(.multi-chat-resizer:hover)::after,
	:global(.multi-chat-resizer[data-active])::after {
		background: rgba(37, 99, 235, 0.85);
	}

	/* Soft canvas-colored halo behind each pane's badge/button cluster so
	   content scrolling underneath fades out instead of colliding with the
	   chrome. Color mirrors the .portico-chat-canvas rules. */
	.pane-chrome-backdrop {
		background: radial-gradient(
			ellipse 100% 100% at 50% 50%,
			var(--portico-light-canvas, #f7f7f7) 45%,
			transparent 100%
		);
	}
	:global(.dark) .pane-chrome-backdrop {
		background: radial-gradient(
			ellipse 100% 100% at 50% 50%,
			#171717 45%,
			transparent 100%
		);
	}

	/* Portaled composer: MessageInput's first section is empty here (its
	   scroll buttons dock inside the input container instead), but app.css
	   forces 1.5rem padding-bottom on every such section — that padding is
	   the dead band between the tiles and the target chip. */
	:global([data-multi-chat-composer-bar] .font-primary > .bg-transparent:first-child) {
		padding-bottom: 0.65rem !important;
	}

	/* Pane top alignment: the primary's collapsed navbar (-mb-12) nets a few
	   pixels less lead-in than navbar-less tiles — compensate so first
	   messages align across panes when scrolled to the top. */
	:global([data-multi-chat-pane] nav ~ div #messages-container) {
		padding-top: calc(24px * var(--app-text-scale, 1) + 4px) !important;
	}

	/* Multi-chat panes: the OWUI navbar's window-drag strip
	   (-webkit-app-region: drag, extended over content via -mb-12) swallows
	   real mouse clicks on our overlay buttons — no-drag holes on the buttons
	   were not honored for this embedded view. Whenever the pane chrome
	   (badge/focus/toggle cluster) is rendered — tiled OR collapsed — the
	   pane navbar stops being a drag surface (the shell header/tab bar
	   remains the drag handle); chats without panes are untouched. */
	:global([data-multi-chat-chrome] .drag-region) {
		-webkit-app-region: no-drag !important;
	}

	/* Every pane wears its badge's hue (the pane div carries the same
	   badgeStyleVars the badge chip uses); FOCUS is signaled by SHADE within
	   that hue: idle = a very light pastel (200-level), focused = the
	   saturated 500-level mid-tone — clearly darker, same color family. Dark
	   theme uses the bright 400-level when focused (darker shades sink into
	   the canvas). Uniform width → no layout shift on focus change. */
	:global(.multi-chat-pane-border-badge) {
		border-color: var(--pane-border-idle);
	}
	:global(.dark .multi-chat-pane-border-badge) {
		border-color: var(--pane-border-idle-dark);
	}
	:global(.multi-chat-pane-focused) {
		border-color: var(--pane-border-focused);
	}
	:global(.dark .multi-chat-pane-focused) {
		border-color: var(--pane-border-focused-dark);
	}

	.display-name-badge {
		background: var(--badge-bg);
		color: var(--badge-text);
		border-color: var(--badge-border);
	}
	:global(.dark) .display-name-badge {
		background: var(--badge-bg-dark);
		color: var(--badge-text-dark);
		border-color: var(--badge-border-dark);
	}
</style>
