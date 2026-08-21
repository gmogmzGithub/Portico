<!--
  PORTICO PATCHED FILE

  Changes from original Open WebUI InputMenu.svelte:
  1. Reduced the menu to "Upload Files" only
-->
<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { getContext } from 'svelte';
	import { flyAndScale } from '$lib/utils/transitions';

	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Clip from '$lib/components/icons/Clip.svelte';
	import { user } from '$lib/stores';

	const i18n = getContext('i18n');

	export let files = [];

	export let selectedModels: string[] = [];
	export let fileUploadCapableModels: string[] = [];

	export let screenCaptureHandler: Function;
	export let uploadFilesHandler: Function;
	export let inputFilesHandler: Function;

	export let uploadGoogleDriveHandler: Function;
	export let uploadOneDriveHandler: Function;

	export let onUpload: Function;
	export let onClose: Function;

	let show = false;

	let fileUploadEnabled = true;
	$: fileUploadEnabled =
		fileUploadCapableModels.length === selectedModels.length &&
		($user?.role === 'admin' || $user?.permissions?.chat?.file_upload);

	$: if (!fileUploadEnabled && files.length > 0) {
		files = [];
	}
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
			class="portico-menu-surface w-full max-w-70 max-h-72 scrollbar-thin"
			sideOffset={4}
			alignOffset={-6}
			side="bottom"
			align="start"
			collisionPadding={12}
			transition={flyAndScale}
		>
			<Tooltip
				content={fileUploadCapableModels.length !== selectedModels.length
					? $i18n.t('Model(s) do not support file upload')
					: !fileUploadEnabled
						? $i18n.t('You do not have permission to upload files.')
						: ''}
				className="w-full"
			>
				<DropdownMenu.Item
					class="portico-menu-item {!fileUploadEnabled
						? 'opacity-50'
						: ''}"
					on:click={() => {
						if (fileUploadEnabled) {
							uploadFilesHandler();
						}
					}}
				>
					<Clip />

					<div class="line-clamp-1">{$i18n.t('Upload Files')}</div>
				</DropdownMenu.Item>
			</Tooltip>
		</DropdownMenu.Content>
	</div>
</Dropdown>
