<!--
  PORTICO PATCHED FILE

  Changes from original Open WebUI ModelMenu.svelte:
  1. Removed the "Copy Link" menu item
  2. Removed the "Share" menu item
-->
<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { flyAndScale } from '$lib/utils/transitions';
	import { getContext } from 'svelte';

	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import GarbageBin from '$lib/components/icons/GarbageBin.svelte';
	import Pencil from '$lib/components/icons/Pencil.svelte';
	import DocumentDuplicate from '$lib/components/icons/DocumentDuplicate.svelte';
	import Download from '$lib/components/icons/Download.svelte';

	import { user as currentUser } from '$lib/stores';

	const i18n = getContext('i18n');

	export let user;
	export let model;

	export let editHandler: Function;
	export let shareHandler: Function;
	export let cloneHandler: Function;
	export let exportHandler: Function;
	export let copyLinkHandler: Function;

	export let hideHandler: Function;
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
	<button
		on:click={(e) => {
			e.stopPropagation();
			show = !show;
		}}
	>
		<slot />
	</button>

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
					editHandler();
				}}
			>
				<Pencil />
				<div class="flex items-center">{$i18n.t('Edit')}</div>
			</DropdownMenu.Item>

			<DropdownMenu.Item
				class="portico-menu-item"
				on:click={() => {
					hideHandler();
				}}
			>
				{#if model?.meta?.hidden ?? false}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						stroke-width="1.5"
						stroke="currentColor"
						class="size-4"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"
						/>
					</svg>
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						stroke-width="1.5"
						stroke="currentColor"
						class="size-4"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"
						/>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
						/>
					</svg>
				{/if}

				<div class="flex items-center">
					{#if model?.meta?.hidden ?? false}
						{$i18n.t('Show Model')}
					{:else}
						{$i18n.t('Hide Model')}
					{/if}
				</div>
			</DropdownMenu.Item>

			<DropdownMenu.Item
				class="portico-menu-item"
				on:click={() => {
					cloneHandler();
				}}
			>
				<DocumentDuplicate />

				<div class="flex items-center">{$i18n.t('Clone')}</div>
			</DropdownMenu.Item>

			<hr class="portico-menu-divider" />

			{#if $currentUser?.role === 'admin' || $currentUser?.permissions?.workspace?.models_export}
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
