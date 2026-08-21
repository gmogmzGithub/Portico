<script lang="ts">
	import { getContext, tick } from 'svelte';
	import { config, settings } from '$lib/stores';
	import { updateUserSettings } from '$lib/apis/users';

	import Modal from '../common/Modal.svelte';
	import Interface from './Settings/Interface.svelte';
	import DataControls from './Settings/DataControls.svelte';
	// PORTICO PATCH (Round 4 / Issue 2d): per-user tool allowlist
	// settings tab. Backed by the file-based store at
	// ``<DATA_DIR>/tool-allowlists/<user_id>.json``; populated either
	// via the chip's "Always allow" button or by hand from this UI.
	// Visibility is gated by the ``tool_allowlist`` feature flag exposed
	// at ``/api/config`` (see ``optimization_flags.json``).
	import Allowlists from './Settings/Allowlists.svelte';
	import XMark from '../icons/XMark.svelte';
	import DatabaseSettings from '../icons/DatabaseSettings.svelte';
	import AppNotification from '../icons/AppNotification.svelte';

	const i18n = getContext('i18n');

	export let show = false;

	interface SettingsTab {
		id: 'interface' | 'data_controls' | 'allowlists';
		title: 'Interface' | 'Data Controls' | 'Allowlists';
		keywords: string[];
	}

	const allSettings: SettingsTab[] = [
		{
			id: 'interface',
			title: 'Interface',
			keywords: [
				'interface',
				'ui',
				'ui scale',
				'text scale',
				'display',
				'layout'
			]
		},
		{
			id: 'data_controls',
			title: 'Data Controls',
			keywords: [
				'data controls',
				'archived chats',
				'archive chats',
				'import chats',
				'export chats',
				'delete chats',
				'chat history'
			]
		},
		{
			// PORTICO PATCH (Round 4 / Issue 2d): tool-allowlist tab. The
			// keywords list mirrors the round-4 user vocabulary so the
			// future Settings search box (upstream OWUI feature) can
			// surface this tab with terms like "always allow", "tool",
			// "approval", "bypass", etc.
			id: 'allowlists',
			title: 'Allowlists',
			keywords: [
				'allowlists',
				'allowlist',
				'always allow',
				'tool approval',
				'tool confirmation',
				'auto approve',
				'bypass',
				'silent dispatch',
				'mcp'
			]
		}
	];

	// PORTICO PATCH: hide the Allowlists tab when the backend feature
	// flag is off. Default-true semantics (omitted flag => visible) keep
	// existing deployments unchanged.
	$: allowlistEnabled = $config?.features?.tool_allowlist !== false;
	$: visibleSettings = allSettings.filter(
		(tab) => tab.id !== 'allowlists' || allowlistEnabled
	);

	let selectedTab: SettingsTab['id'] = 'interface';

	// If the allowlists tab gets hidden while it's selected (e.g. flag
	// flipped server-side mid-session), fall back to the default tab so
	// the panel area doesn't render an unmounted child.
	$: if (selectedTab === 'allowlists' && !allowlistEnabled) {
		selectedTab = 'interface';
	}

	$: if (show) {
		addScrollListener();
	} else {
		removeScrollListener();
	}

	const saveSettings = async (updated) => {
		await settings.set({ ...$settings, ...updated });
		await updateUserSettings(localStorage.token, { ui: $settings });
	};

	const scrollHandler = (event) => {
		const settingsTabsContainer = document.getElementById('settings-tabs-container');
		if (settingsTabsContainer) {
			event.preventDefault();
			settingsTabsContainer.scrollLeft += event.deltaY;
		}
	};

	const addScrollListener = async () => {
		await tick();
		const settingsTabsContainer = document.getElementById('settings-tabs-container');
		if (settingsTabsContainer) {
			settingsTabsContainer.addEventListener('wheel', scrollHandler);
		}
	};

	const removeScrollListener = async () => {
		await tick();
		const settingsTabsContainer = document.getElementById('settings-tabs-container');
		if (settingsTabsContainer) {
			settingsTabsContainer.removeEventListener('wheel', scrollHandler);
		}
	};
</script>

<Modal size="2xl" bind:show>
	<div class="mx-1 text-gray-900 dark:text-gray-100">
		<div class="flex justify-between px-4 md:px-4.5 pt-4.5 pb-0.5 md:pb-2.5 text-gray-800 dark:text-gray-300">
			<div class="self-center text-lg font-medium">{$i18n.t('Settings')}</div>
			<button
				aria-label={$i18n.t('Close settings modal')}
				class="self-center text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
				on:click={() => {
					show = false;
				}}
			>
				<XMark className="w-5 h-5" />
			</button>
		</div>

		<div class="flex w-full flex-col pt-1 pb-4 md:flex-row">
			<div
				role="tablist"
				id="settings-tabs-container"
				class="tabs mx-3 mb-1 flex flex-1 flex-row gap-2.5 overflow-x-auto text-left text-sm text-gray-700 dark:text-gray-200 md:mb-0 md:w-50 md:min-h-[42rem] md:max-h-[42rem] md:flex-none md:flex-col md:gap-1 md:pr-4"
			>
				{#each visibleSettings as tab (tab.id)}
					<button
						role="tab"
						aria-controls={`tab-${tab.id}`}
						aria-selected={selectedTab === tab.id}
						class={`px-0.5 md:px-2.5 py-1 min-w-fit rounded-xl flex flex-1 md:flex-none text-left transition ${
							selectedTab === tab.id
								? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-white'
								: ($settings?.highContrastMode ?? false)
									? 'text-gray-800 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800'
									: 'text-gray-600 dark:text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white'
						}`}
						on:click={() => {
							selectedTab = tab.id;
						}}
					>
						<div class="self-center mr-2">
							{#if tab.id === 'interface'}
								<AppNotification strokeWidth="2" />
							{:else if tab.id === 'allowlists'}
								<!-- PORTICO PATCH (Round 4 / Issue 2d): reuse the
									data-controls icon to avoid pulling a new icon
									dependency. The tab label is unambiguous and
									the icon is decorative; a future round can swap
									in a dedicated lock / shield glyph. -->
								<DatabaseSettings strokeWidth="2" />
							{:else}
								<DatabaseSettings strokeWidth="2" />
							{/if}
						</div>
						<div class="self-center">{$i18n.t(tab.title)}</div>
					</button>
				{/each}
			</div>

			<div class="max-h-[42rem] flex-1 px-3.5 md:min-h-[42rem] md:pl-0 md:pr-4.5">
				{#if selectedTab === 'interface'}
					<Interface {saveSettings} />
				{:else if selectedTab === 'data_controls'}
					<DataControls />
				{:else if selectedTab === 'allowlists'}
					<!-- PORTICO PATCH (Round 4 / Issue 2d): tool allowlist
						manager. The component fetches the user's allowlist
						file lazily on mount; the bearer token is taken from
						``localStorage.token`` (same convention as the rest
						of OWUI's API client wiring). -->
					<Allowlists token={localStorage.token} />
				{/if}
			</div>
		</div>
	</div>
</Modal>

<style>
	input::-webkit-outer-spin-button,
	input::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.tabs::-webkit-scrollbar {
		display: none;
	}

	.tabs {
		-ms-overflow-style: none;
		scrollbar-width: none;
	}

	input[type='number'] {
		appearance: textfield;
		-moz-appearance: textfield;
	}
</style>
