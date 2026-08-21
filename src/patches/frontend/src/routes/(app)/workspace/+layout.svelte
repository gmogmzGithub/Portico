<script lang="ts">
	import { onMount, getContext } from 'svelte';
	import { WEBUI_NAME, showSidebar, user, mobile } from '$lib/stores';
	import { workspaceCounts, refreshWorkspaceCounts } from '$lib/stores/workspaceCounts';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		isPromptsManagementPath,
		resolvePromptsManagementRedirect
	} from '$lib/utils/promptsManagementRoute.mjs';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Sidebar from '$lib/components/icons/Sidebar.svelte';

	const i18n = getContext('i18n');

	let loaded = false;
	let redirecting = false;
	let lastCountsRefreshPath = '';

	$: canManagePrompts =
		$user?.role === 'admin' || Boolean($user?.permissions?.workspace?.prompts);
	$: promptsManagementPathActive = isPromptsManagementPath($page.url.pathname);
	$: promptsIndexActive = $page.url.pathname === '/workspace/prompts';

	const enforcePromptsManagementRoute = async () => {
		const redirectTarget = resolvePromptsManagementRedirect({
			pathname: $page.url.pathname,
			canManagePrompts
		});

		if (!redirectTarget) {
			return true;
		}

		redirecting = true;
		try {
			await goto(redirectTarget, { replaceState: true });
			return redirectTarget !== '/';
		} finally {
			redirecting = false;
		}
	};

	onMount(async () => {
		loaded = await enforcePromptsManagementRoute();
	});

	$: if (loaded && !redirecting) {
		const redirectTarget = resolvePromptsManagementRedirect({
			pathname: $page.url.pathname,
			canManagePrompts
		});

		if (redirectTarget) {
			loaded = false;
			void enforcePromptsManagementRoute().then((canRender) => {
				loaded = canRender;
			});
		}
	}

	$: if (loaded && canManagePrompts && promptsManagementPathActive) {
		if ($page.url.pathname !== lastCountsRefreshPath) {
			lastCountsRefreshPath = $page.url.pathname;
			void refreshWorkspaceCounts();
		}
	}
</script>

<svelte:head>
	<title>
		{$i18n.t('Prompts')} • {$WEBUI_NAME}
	</title>
</svelte:head>

{#if loaded && canManagePrompts && promptsManagementPathActive && !redirecting}
	<div
		class="workspace-shell prompts-workspace-shell relative flex h-screen max-h-[100dvh] w-full max-w-full flex-col transition-width duration-200 ease-in-out {$showSidebar
			? 'md:max-w-[calc(100%-var(--sidebar-width))]'
			: ''}"
	>
		{#if $mobile || !promptsIndexActive}
			<nav class="prompts-workspace-nav drag-region">
				<div
					class="prompts-workspace-nav-inner transition-transform duration-200 ease-in-out {$showSidebar
						? ''
						: 'md:-translate-x-[1.625rem]'}"
					data-portico-rail-compensated={$showSidebar ? 'false' : 'true'}
				>
					{#if $mobile}
						<div class="{$showSidebar ? 'md:hidden' : ''} self-center flex flex-none items-center">
							<Tooltip
								content={$showSidebar ? $i18n.t('Close Sidebar') : $i18n.t('Open Sidebar')}
								interactive={true}
							>
								<button
									id="sidebar-toggle-button"
									class="prompts-workspace-sidebar-toggle"
									type="button"
									aria-label={$showSidebar ? $i18n.t('Close Sidebar') : $i18n.t('Open Sidebar')}
									on:click={() => {
										showSidebar.set(!$showSidebar);
									}}
								>
									<Sidebar />
								</button>
							</Tooltip>
						</div>
					{/if}

					{#if !promptsIndexActive}
						<a class="prompts-workspace-back-link" href="/workspace/prompts">
							<svg viewBox="0 0 20 20" fill="currentColor" class="size-4" aria-hidden="true">
								<path
									fill-rule="evenodd"
									d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158-3.96a.75.75 0 1 0-1.04-1.08l-5.5 5.25a.75.75 0 0 0 0 1.08l5.5 5.25a.75.75 0 1 0 1.04-1.08l-4.158-3.96H16.25A.75.75 0 0 0 17 10Z"
									clip-rule="evenodd"
								/>
							</svg>
							<span>{$i18n.t('Prompts')}</span>
							{#if $workspaceCounts.prompts !== null}
								<span class="prompts-workspace-count">{$workspaceCounts.prompts}</span>
							{/if}
						</a>
					{/if}
				</div>
			</nav>
		{/if}

		<div
			class="workspace-shell-content prompts-workspace-content flex-1 overflow-y-auto"
			id="workspace-container"
		>
			<slot />
		</div>
	</div>
{/if}
