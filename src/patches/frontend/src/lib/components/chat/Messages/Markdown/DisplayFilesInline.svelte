<script lang="ts">
	import { decode } from 'html-entities';
	import { getContext } from 'svelte';
	import { toast } from 'svelte-sonner';

	import Image from '$lib/components/common/Image.svelte';
	import { copyToClipboard } from '$lib/utils';
	import { getChatLinkAction } from '$lib/utils/chat-link-interaction.mjs';
	import { selectDisplayFileUrl } from '$lib/utils/displayFileUrl';

	const i18n = getContext('i18n');

	export let id = '';
	export let attributes: Record<string, unknown> | null | undefined = null;

	type NormalizedDisplayFile = {
		key: string;
		url: string;
		name: string;
		contentType: string;
		isImage: boolean;
	};

	let displayFiles: NormalizedDisplayFile[] = [];

	const handleChatLinkClick = async (event: MouseEvent, href: string) => {
		const decision = getChatLinkAction(event, href);
		if (decision.action !== 'copy' || !decision.url) {
			return;
		}

		event.preventDefault();
		await copyToClipboard(decision.url);
		toast.success($i18n.t('Copied to clipboard'));
	};

	const parseDeepJson = (value: unknown, depth = 0): unknown => {
		if (depth > 4 || typeof value !== 'string') {
			return value;
		}

		const decoded = decode(value).trim();
		if (!decoded) {
			return null;
		}

		try {
			return parseDeepJson(JSON.parse(decoded), depth + 1);
		} catch {
			return decoded;
		}
	};

	const stringValue = (value: unknown): string =>
		typeof value === 'string' && value.trim() ? value.trim() : '';

	const getRecordString = (record: Record<string, unknown>, keys: string[]): string => {
		for (const key of keys) {
			const value = stringValue(record[key]);
			if (value) {
				return value;
			}
		}
		return '';
	};

	const fileNameFromUrl = (url: string): string => {
		const lastSegment = url.split(/[?#]/, 1)[0].split('/').pop() || '';
		try {
			return decodeURIComponent(lastSegment);
		} catch {
			return lastSegment;
		}
	};

	const extractFilesAttribute = (value: unknown): unknown[] => {
		const parsed = parseDeepJson(value);
		return Array.isArray(parsed) ? parsed : [];
	};

	const extractDisplayPayloadFiles = (value: unknown): unknown[] => {
		const parsed = parseDeepJson(value);
		if (Array.isArray(parsed)) {
			return parsed.flatMap((item) => extractDisplayPayloadFiles(item));
		}
		if (!parsed || typeof parsed !== 'object') {
			return [];
		}

		const record = parsed as Record<string, unknown>;
		if (record.display_files === true && Array.isArray(record.files)) {
			return record.files;
		}
		if (Array.isArray(record.results)) {
			return record.results.flatMap((item) => extractDisplayPayloadFiles(item));
		}
		return [];
	};

	const normalizeDisplayFile = (file: unknown): NormalizedDisplayFile | null => {
		if (typeof file === 'string') {
			const url = file.trim();
			if (!url) {
				return null;
			}
			return {
				key: `url:${url}`,
				url,
				name: url.split('/').pop() || 'File',
				contentType: '',
				isImage: url.startsWith('data:image/')
			};
		}
		if (!file || typeof file !== 'object') {
			return null;
		}

		const record = file as Record<string, unknown>;
		const contentType = getRecordString(record, ['content_type', 'mime_type']);
		const isImage =
			getRecordString(record, ['browser_url', 'url', 'download_url', 'content']).startsWith(
				'data:image/'
			) ||
			record.type === 'image' ||
			record.is_image === true ||
			contentType.startsWith('image/');
		const url = selectDisplayFileUrl(record, isImage);
		if (!url) {
			return null;
		}

		const name = getRecordString(record, ['name', 'file_name']) || fileNameFromUrl(url) || 'File';

		return {
			key: `url:${url}`,
			url,
			name,
			contentType,
			isImage
		};
	};

	const mergeDisplayFiles = (files: unknown[]): NormalizedDisplayFile[] => {
		const merged: NormalizedDisplayFile[] = [];
		const seen = new Set<string>();
		for (const file of files) {
			const normalized = normalizeDisplayFile(file);
			if (!normalized || seen.has(normalized.key)) {
				continue;
			}
			seen.add(normalized.key);
			merged.push(normalized);
		}
		return merged;
	};

	$: resultDisplayFiles = extractDisplayPayloadFiles(attributes?.result);
	$: displayFiles = mergeDisplayFiles(
		resultDisplayFiles.length > 0 ? resultDisplayFiles : extractFilesAttribute(attributes?.files)
	);
</script>

{#if displayFiles.length > 0}
	<div class="my-2 flex w-full flex-col gap-2" data-display-files-inline="true">
		{#each displayFiles as file, idx (file.key)}
			{#if file.isImage}
				<div class="w-full max-w-full">
					<Image id={`${id}-display-file-${idx}`} src={file.url} alt={file.name} />
				</div>
			{:else}
				<a
					id={`${id}-display-file-${idx}`}
					class="inline-flex max-w-full items-center self-start rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
					href={file.url}
					target="_blank"
					rel="noreferrer"
					on:click={(event) => handleChatLinkClick(event, file.url)}
				>
					<span class="truncate">{file.name}</span>
				</a>
			{/if}
		{/each}
	</div>
{/if}
