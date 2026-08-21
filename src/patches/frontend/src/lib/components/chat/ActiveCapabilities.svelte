<!--
  ActiveCapabilities.svelte
  Displays active MCP server tools, skills, and artifacts as consolidated badges
  PORTICO PATCH: Real-time capabilities display with artifact management popover
-->
<script lang="ts">
	import { createEventDispatcher, onMount, onDestroy } from 'svelte';
	import { resolveActiveSkillDisplayName } from '$lib/utils/activeSkillDisplayName';
	import { multiChatActive } from '$lib/stores/multiChatPanes';

	export let tools: { server_id: string; display_name: string; icon_url: string; tool_count?: number; is_core?: boolean }[] = [];
	type Skill = { name: string; display_name?: string };
	export let skills: Skill[] = [];
	export let artifacts: {
		artifact_id: string;
		name: string;
		current_version: number;
		display_version?: number;
		isInPanel?: boolean;
		isDetached?: boolean;
		isRunning?: boolean;
	}[] = [];

	const dispatch = createEventDispatcher();

	const MAX_ICON_RETRIES = 3;
	const ICON_RETRY_BASE_MS = 1000;
	const ICON_RETRY_MAX_MS = 8000;

	// Artifact menu state
	let showArtifactMenu = false;
	let menuRef: HTMLDivElement;

	let iconRetryTokens: Record<string, number> = {};
	let iconRetryAttempts: Record<string, number> = {};
	let iconErrorFlags: Record<string, boolean> = {};
	let iconRetryTimers: Record<string, number> = {};
	let lastIconUrls: Record<string, string> = {};

	// Sort tools: core first, then non-core, alphabetically within each group
	$: sortedTools = [...tools].sort((a, b) => {
		// Core servers first
		if (a.is_core !== b.is_core) return a.is_core ? -1 : 1;
		// Then alphabetically by display name
		return a.display_name.localeCompare(b.display_name);
	});

	// Sort skills alphabetically by display label
	$: normalizedSkills = skills.map((skill) => ({
		...skill,
		display_label: resolveActiveSkillDisplayName(skill)
	}));
	$: sortedSkills = [...normalizedSkills].sort((a, b) =>
		a.display_label.localeCompare(b.display_label)
	);
	$: activeCount = sortedTools.length + sortedSkills.length;

	// Debug: Log received tools
	$: if (tools.length > 0) {
		console.log('[ActiveCapabilities] Received tools:', tools.length, tools.map(t => t.server_id));
	}

	// Debug: Log received artifacts (only when there are artifacts)
	$: if (artifacts.length > 0) {
		console.log('[ActiveCapabilities] Artifacts prop:', artifacts.length, artifacts);
	}

	function buildIconSrc(url: string, token?: number) {
		if (!url) return '';
		if (!token) return url;
		const separator = url.includes('?') ? '&' : '?';
		return `${url}${separator}v=${token}`;
	}

	function removeKey<T>(record: Record<string, T>, key: string) {
		const { [key]: _unused, ...rest } = record;
		return rest;
	}

	function resetIconState(serverId: string) {
		if (iconRetryTimers[serverId]) {
			clearTimeout(iconRetryTimers[serverId]);
			iconRetryTimers = removeKey(iconRetryTimers, serverId);
		}
		iconRetryAttempts = removeKey(iconRetryAttempts, serverId);
		iconRetryTokens = removeKey(iconRetryTokens, serverId);
		iconErrorFlags = removeKey(iconErrorFlags, serverId);
	}

	// Reset icon state if icon URLs change or tools disappear.
	$: {
		const currentUrls: Record<string, string> = {};
		for (const tool of tools) {
			if (!tool?.server_id) continue;
			const iconUrl = tool.icon_url || '';
			currentUrls[tool.server_id] = iconUrl;
			if (lastIconUrls[tool.server_id] && lastIconUrls[tool.server_id] !== iconUrl) {
				resetIconState(tool.server_id);
			}
		}
		for (const serverId of Object.keys(lastIconUrls)) {
			if (!(serverId in currentUrls)) {
				resetIconState(serverId);
			}
		}
		lastIconUrls = currentUrls;
	}

	// Handle image load error - show fallback and retry a few times.
	function handleImageError(serverId: string) {
		if (!serverId) return;
		iconErrorFlags = { ...iconErrorFlags, [serverId]: true };

		const attempts = iconRetryAttempts[serverId] || 0;
		if (attempts >= MAX_ICON_RETRIES) return;

		const nextAttempt = attempts + 1;
		iconRetryAttempts = { ...iconRetryAttempts, [serverId]: nextAttempt };

		if (iconRetryTimers[serverId]) {
			clearTimeout(iconRetryTimers[serverId]);
		}

		const delay = Math.min(ICON_RETRY_BASE_MS * 2 ** (nextAttempt - 1), ICON_RETRY_MAX_MS);
		const timerId = window.setTimeout(() => {
			const currentToken = iconRetryTokens[serverId] || 0;
			iconRetryTokens = { ...iconRetryTokens, [serverId]: currentToken + 1 };
		}, delay);
		iconRetryTimers = { ...iconRetryTimers, [serverId]: timerId };
	}

	function handleImageLoad(serverId: string) {
		if (!serverId) return;
		iconErrorFlags = removeKey(iconErrorFlags, serverId);
		iconRetryAttempts = removeKey(iconRetryAttempts, serverId);
		if (iconRetryTimers[serverId]) {
			clearTimeout(iconRetryTimers[serverId]);
			iconRetryTimers = removeKey(iconRetryTimers, serverId);
		}
	}

	// Toggle artifact menu
	function toggleArtifactMenu(e: MouseEvent) {
		e.stopPropagation();
		showArtifactMenu = !showArtifactMenu;
	}

	// Close artifact menu
	function closeArtifactMenu() {
		showArtifactMenu = false;
	}

	// Handle click outside to close menu
	function handleClickOutside(event: MouseEvent) {
		if (menuRef && !menuRef.contains(event.target as Node)) {
			closeArtifactMenu();
		}
	}

	// Send action to Electron via webview host IPC bridge
	function sendAction(action: string, artifactId: string) {
		const hostApi = (window as any).webviewHost;
		if (hostApi?.sendArtifactAction) {
			hostApi.sendArtifactAction(action, artifactId);
		} else {
			console.warn('[ActiveCapabilities] webviewHost not available for artifact action', action, artifactId);
		}
		closeArtifactMenu();
	}

	// Get status icon for artifact
	function getStatusIcon(artifact: typeof artifacts[0]): string {
		// Green = running + displayed in panel/window, Gray = otherwise
		return artifact.isRunning ? '●' : '○';
	}

	// Handle item click - default action based on status
	// Context-aware: opens in window if panel is occupied, attaches if panel is empty
	function handleItemClick(artifact: typeof artifacts[0]) {
		// Multi-chat tiling: artifacts are windowed-only — the attached panel
		// cannot represent per-pane artifacts, so every open goes to a window.
		if ($multiChatActive) {
			if (!artifact.isDetached) {
				sendAction('open-window', artifact.artifact_id);
			}
			return;
		}
		if (artifact.isInPanel) {
			// Already showing this artifact, do nothing (use the detach button)
			return;
		}
		if (artifact.isDetached) {
			// In a detached window - attach it to panel
			sendAction('attach', artifact.artifact_id);
			return;
		}
		// Check if panel is currently occupied by another artifact
		const panelOccupied = artifacts.some(a => a.isInPanel);
		if (panelOccupied) {
			// Panel has a different artifact - open this one in a separate window
			sendAction('open-window', artifact.artifact_id);
		} else {
			// Panel is empty - attach to panel
			sendAction('attach', artifact.artifact_id);
		}
	}

	onMount(() => {
		document.addEventListener('click', handleClickOutside);
	});

	onDestroy(() => {
		document.removeEventListener('click', handleClickOutside);
		Object.values(iconRetryTimers).forEach((timerId) => clearTimeout(timerId));
	});
</script>

{#if sortedTools.length > 0 || sortedSkills.length > 0 || artifacts.length > 0}
	<div class="capability-row flex flex-wrap items-center shrink-0">
		<!-- Active MCPs and skills badge with tooltip -->
		{#if activeCount > 0}
			<div class="group relative">
				<div class="capability-pill capability-pill--readonly shrink-0 whitespace-nowrap select-none">
					<svg
						class="size-3.5 text-purple-500"
						fill="none"
						viewBox="0 0 24 24"
						stroke-width="2"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
						/>
					</svg>
					<span>{activeCount} Active</span>
				</div>

				<div
					class="absolute bottom-full left-1/2 mb-2 -translate-x-1/2
						opacity-0 invisible group-hover:opacity-100 group-hover:visible
						transition-all duration-150 z-50 pointer-events-none"
				>
					<div class="w-max max-w-[calc(100vw-2rem)] rounded-lg bg-gray-900 p-4 shadow-xl dark:bg-black">
						<div class="{sortedTools.length > 0 && sortedSkills.length > 0 ? 'grid grid-cols-[minmax(0,max-content)_1px_minmax(0,max-content)] gap-x-4' : 'flex flex-col gap-4'}">
							{#if sortedTools.length > 0}
								<div class="min-w-0 w-max max-w-[240px]">
									<div class="text-[10px] text-gray-500 mb-2.5 font-medium tracking-wide">ACTIVE MCPs</div>
									<div class="flex flex-col gap-2.5">
										{#each sortedTools as tool (tool.server_id)}
											<div class="flex w-full items-center gap-2.5 min-w-0">
												<div class="size-4 rounded overflow-hidden bg-gray-700 flex-shrink-0 flex items-center justify-center">
													<img
														src={buildIconSrc(tool.icon_url, iconRetryTokens[tool.server_id])}
														alt=""
														class="size-full object-cover"
														class:hidden={iconErrorFlags[tool.server_id]}
														on:error={() => handleImageError(tool.server_id)}
														on:load={() => handleImageLoad(tool.server_id)}
													/>
													<span
														class="fallback-initial text-[8px] font-medium text-gray-400 uppercase flex items-center justify-center size-full"
														class:hidden={!iconErrorFlags[tool.server_id]}
													>
														{tool.display_name.charAt(0)}
													</span>
												</div>
												<span class="text-white text-xs truncate flex-1 min-w-0">{tool.display_name}</span>
												{#if tool.is_core}
													<span class="text-[9px] px-1 py-0.5 rounded bg-gray-600 text-white flex-shrink-0 uppercase font-medium">
														Core
													</span>
												{:else if tool.tool_count}
													<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 flex-shrink-0">
														{tool.tool_count} tools
													</span>
												{/if}
											</div>
										{/each}
									</div>
								</div>
							{/if}

							{#if sortedTools.length > 0 && sortedSkills.length > 0}
								<div class="w-px self-stretch bg-gray-500/20 dark:bg-gray-600/30"></div>
							{/if}

							{#if sortedSkills.length > 0}
								<div class="min-w-0 w-max max-w-[260px]">
									<div class="text-[10px] text-gray-500 mb-2.5 font-medium uppercase tracking-wide">Active Skills</div>
									<div class="flex flex-col gap-2">
										{#each sortedSkills as skill (skill.name)}
											<div class="flex w-full items-center gap-2.5 min-w-0">
												<svg
													class="size-4 text-purple-400 flex-shrink-0"
													fill="none"
													viewBox="0 0 24 24"
													stroke-width="2"
													stroke="currentColor"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
													/>
												</svg>
												<span class="text-white text-xs truncate min-w-0">{skill.display_label}</span>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						</div>

						<!-- Tooltip arrow -->
						<div class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900 dark:border-t-black"></div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Artifacts badge with popover menu -->
		{#if artifacts.length > 0}
			<div class="relative" bind:this={menuRef}>
					<!-- Clickable artifact badge -->
					<button
						type="button"
						on:click={toggleArtifactMenu}
						class="capability-pill capability-pill--interactive capability-pill--artifact shrink-0 whitespace-nowrap select-none"
					>
					<!-- Package/Box icon for artifacts -->
					<svg
						class="size-3.5"
						fill="none"
						viewBox="0 0 24 24"
						stroke-width="2"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
						/>
					</svg>
					<span class="font-semibold">
						{artifacts.length} {artifacts.length === 1 ? 'artifact' : 'artifacts'}
					</span>
				</button>

				<!-- Popover Menu (click-activated, not hover) -->
				{#if showArtifactMenu}
					<div class="artifact-composer-popover-shell">
						<div class="artifact-composer-popover">
							<!-- Header -->
							<div class="artifact-composer-popover-header">
								<div>
									<div class="artifact-composer-popover-kicker">Chat output</div>
									<div class="artifact-composer-popover-title">Artifacts</div>
								</div>
								<span class="artifact-composer-popover-count">{artifacts.length}</span>
							</div>

							<!-- Artifact List -->
							<div class="artifact-composer-popover-list">
								{#each artifacts as artifact (artifact.artifact_id)}
									<div
										class="artifact-composer-popover-item"
										role="button"
										tabindex="0"
										on:click={() => handleItemClick(artifact)}
										on:keydown={(event) => {
											if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
												event.preventDefault();
												handleItemClick(artifact);
											}
										}}
									>
										<!-- Status indicator -->
										<span
											class="artifact-composer-status"
											class:artifact-composer-status--running={artifact.isRunning}
											title={artifact.isRunning ? 'Running' : 'Stopped'}
										>
											{getStatusIcon(artifact)}
										</span>

										<!-- Artifact info -->
										<div class="artifact-composer-info">
											<div class="artifact-composer-name">{artifact.name || 'Unnamed Artifact'}</div>
											<div class="artifact-composer-version">Version {artifact.display_version ?? artifact.current_version ?? 1}</div>
										</div>

										<!-- Action button(s) -->
										<div class="artifact-composer-actions">
											{#if artifact.isInPanel}
												<!-- In panel: show Detach button -->
												<button
												class="artifact-composer-action"
													on:click|stopPropagation={() => sendAction('detach', artifact.artifact_id)}
												>
													Detach
												</button>
											{:else if artifact.isDetached}
												<!-- Detached window: show Attach button only -->
												<button
												class="artifact-composer-action artifact-composer-action--primary"
													on:click|stopPropagation={() => sendAction('attach', artifact.artifact_id)}
												>
													Attach
												</button>
											{:else}
												<!-- Not running: show Window and Attach buttons -->
												<button
												class="artifact-composer-action"
													on:click|stopPropagation={() => sendAction('open-window', artifact.artifact_id)}
													title="Open in new window"
												>
													Window
												</button>
												<button
												class="artifact-composer-action artifact-composer-action--primary"
													on:click|stopPropagation={() => sendAction('attach', artifact.artifact_id)}
													title="Open in panel"
												>
													Attach
												</button>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
