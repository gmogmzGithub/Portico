<!--
  PORTICO PATCHED FILE

  Changes from original Open WebUI PromptMenu.svelte:
  1. Removed the "Share" menu item
-->
<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { flyAndScale } from '$lib/utils/transitions';
	import { getContext } from 'svelte';
	import { user } from '$lib/stores';

	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import GarbageBin from '$lib/components/icons/GarbageBin.svelte';
	import DocumentDuplicate from '$lib/components/icons/DocumentDuplicate.svelte';
	import Download from '$lib/components/icons/Download.svelte';

	const i18n = getContext('i18n');

	export let shareHandler: Function;
	export let cloneHandler: Function;
	export let exportHandler: Function;
	export let deleteHandler: Function;
	export let onClose: Function;

	let show = false;
</script>

<Dropdown
	bind:show
	on:change={(e) => {
		if (e.detail === false) {
			onClose();
		}
	}}
>
	<slot />

	<div slot="content">
		<DropdownMenu.Content
			class="portico-menu-surface w-full max-w-[170px]"
			sideOffset={-2}
			side="bottom"
			align="start"
			collisionPadding={12}
			transition={flyAndScale}
		>
			<DropdownMenu.Item
				class="portico-menu-item"
				on:click={() => {
					cloneHandler();
				}}
			>
				<DocumentDuplicate />

				<div class="flex items-center">{$i18n.t('Clone')}</div>
			</DropdownMenu.Item>

			{#if $user?.role === 'admin' || $user?.permissions?.workspace?.prompts_export}
				<DropdownMenu.Item
					class="portico-menu-item"
					on:click={() => {
						exportHandler();
					}}
				>
					<Download />

					<div class="flex items-center">{$i18n.t('Export')}</div>
				</DropdownMenu.Item>
			{/if}

			<hr class="portico-menu-divider" />

			<DropdownMenu.Item
				class="portico-menu-item"
				on:click={() => {
					deleteHandler();
				}}
			>
				<GarbageBin />
				<div class="flex items-center">{$i18n.t('Delete')}</div>
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</div>
</Dropdown>
