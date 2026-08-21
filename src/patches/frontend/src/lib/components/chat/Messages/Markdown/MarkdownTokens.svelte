<script lang="ts">
	import { onMount, getContext } from 'svelte';
	const i18n = getContext('i18n');

	import fileSaver from 'file-saver';
	const { saveAs } = fileSaver;

	import { marked, type Token } from 'marked';
	import { decode } from 'html-entities';
	import { unescapeHtml } from '$lib/utils';

	import { WEBUI_BASE_URL } from '$lib/constants';
	import { settings } from '$lib/stores';

	import CodeBlock from '$lib/components/chat/Messages/CodeBlock.svelte';
	import MarkdownInlineTokens from '$lib/components/chat/Messages/Markdown/MarkdownInlineTokens.svelte';
	import KatexRenderer from './KatexRenderer.svelte';
	import AlertRenderer, { alertComponent } from './AlertRenderer.svelte';
	import Collapsible from '$lib/components/common/Collapsible.svelte';
	import DisplayFilesInline from './DisplayFilesInline.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Download from '$lib/components/icons/Download.svelte';

	import HtmlToken from './HTMLToken.svelte';
	import DebugRequestMarker from '$lib/components/chat/DebugRequestMarker.svelte';
	import { splitDetailsHtml, type DetailSegment } from '$lib/utils/owuiToolBatchMarkers';
	import { isDisplayFilesToolCall } from '$lib/utils/work-activity-summary.mjs';

	export let id: string;
	export let tokens: Token[];
	export let tokenizeMarkdown: (raw: string) => Token[] = (raw) => marked.lexer(raw);
	export let tokenizeCacheKey = '';
	export let top = true;
	export let attributes = {};
	export let sourceIds = [];

	export let done = true;
	export let messageStopReason = null;

	export let save = false;
	export let preview = false;
	export let renderDisplayFilesInline = true;
	export let debugMarkersAfterToolBlockIndex: Record<number, any[]> = {};
	export let openDebugRequestModal: (requestId: string) => void = () => {};

	export let paragraphTag = 'p';

	export let editCodeBlock = true;
	export let topPadding = false;

	export let onSave: Function = () => {};
	export let onUpdate: Function = () => {};
	export let onPreview: Function = () => {};

	export let onTaskClick: Function = () => {};
	export let onSourceClick: Function = () => {};
	export let onStopResponse: Function = () => {};

	const headerComponent = (depth: number) => {
		return 'h' + depth;
	};

	const getLeadingText = (token: Token): string => {
		const value = (token as unknown as { leadingText?: unknown }).leadingText;
		return typeof value === 'string' ? value : '';
	};

	const getToolBlockIndex = (token: Token): number | undefined => {
		const value = (token as Token & { __owuiToolBlockIndex?: unknown }).__owuiToolBlockIndex;
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	};

	const shouldRenderToolBlockMarker = (
		value: { __owuiToolBlockTerminal?: unknown } | undefined
	): boolean => value?.__owuiToolBlockTerminal === true;

	const getAnnotatedHtmlSegments = (token: Token): DetailSegment[] => {
		const cached = (token as Token & { __owuiDetailsSegments?: unknown }).__owuiDetailsSegments;
		const rawHtml = (token as Token & { text?: string }).text ?? '';
		return Array.isArray(cached) ? (cached as DetailSegment[]) : splitDetailsHtml(rawHtml);
	};

	const LEXER_CACHE_MAX = 64;
	const tokenizedMarkdownCache = new Map<string, Token[]>();

	const getCachedMarkdownTokens = (raw: string): Token[] => {
		const rawKey = raw ?? '';
		const key = `${tokenizeCacheKey}\u001f${rawKey}`;
		const cached = tokenizedMarkdownCache.get(key);
		if (cached) {
			return cached;
		}

		const parsed = tokenizeMarkdown(decode(rawKey));
		if (tokenizedMarkdownCache.size >= LEXER_CACHE_MAX) {
			const oldestKey = tokenizedMarkdownCache.keys().next().value;
			if (oldestKey !== undefined) {
				tokenizedMarkdownCache.delete(oldestKey);
			}
		}
		tokenizedMarkdownCache.set(key, parsed);
		return parsed;
	};

	const exportTableToCSVHandler = (token, tokenIdx = 0) => {
		// Extract header row text and escape for CSV.
		const header = token.header.map((headerCell) => `"${headerCell.text.replace(/"/g, '""')}"`);

		// Create an array for rows that will hold the mapped cell text.
		const rows = token.rows.map((row) =>
			row.map((cell) => {
				// Map tokens into a single text
				const cellContent = cell.tokens.map((token) => token.text).join('');
				// Escape double quotes and wrap the content in double quotes
				return `"${cellContent.replace(/"/g, '""')}"`;
			})
		);

		// Combine header and rows
		const csvData = [header, ...rows];

		// Join the rows using commas (,) as the separator and rows using newline (\n).
		const csvContent = csvData.map((row) => row.join(',')).join('\n');

		// To handle Unicode characters, you need to prefix the data with a BOM:
		const bom = '\uFEFF'; // BOM for UTF-8

		// Create a new Blob prefixed with the BOM to ensure proper Unicode encoding.
		const blob = new Blob([bom + csvContent], {
			type: 'text/csv;charset=UTF-8'
		});

		// Use FileSaver.js's saveAs function to save the generated CSV file.
		saveAs(blob, `table-${id}-${tokenIdx}.csv`);
	};

	const getTokenKey = (token: Token, tokenIdx: number): number => {
		const tokenKey = (token as Token & { __streamKey?: number }).__streamKey;
		return typeof tokenKey === 'number' ? tokenKey : tokenIdx;
	};
</script>

<!-- {JSON.stringify(tokens)} -->
{#each tokens as token, tokenIdx (getTokenKey(token, tokenIdx))}
	{@const tokenId = getTokenKey(token, tokenIdx)}
	{#if token.type === 'hr'}
		<hr class=" border-gray-100/30 dark:border-gray-850/30" />
	{:else if token.type === 'heading'}
		<svelte:element this={headerComponent(token.depth)} dir="auto">
			<MarkdownInlineTokens
				id={`${id}-${tokenId}-h`}
				tokens={token.tokens}
				{done}
				{sourceIds}
				{onSourceClick}
			/>
		</svelte:element>
	{:else if token.type === 'code'}
		{#if token.raw.includes('```')}
			<CodeBlock
				id={`${id}-${tokenId}`}
				collapsed={$settings?.collapseCodeBlocks ?? false}
				{token}
				lang={token?.lang ?? ''}
				code={token?.text ?? ''}
				{attributes}
				{save}
				{preview}
				edit={editCodeBlock}
				stickyButtonsClassName={topPadding ? 'top-10' : 'top-0'}
				onSave={(value) => {
					onSave({
						raw: token.raw,
						oldContent: token.text,
						newContent: value
					});
				}}
				{onUpdate}
				{onPreview}
			/>
		{:else}
			{token.text}
		{/if}
	{:else if token.type === 'table'}
		<div class="markdown-table-shell relative w-full group my-3.5">
			<div
				class="markdown-table-frame scrollbar-hidden relative max-w-full overflow-x-auto border border-gray-200/80 bg-white shadow-[0_1px_2px_-1px_rgba(15,23,42,0.08)] dark:border-gray-800/70 dark:bg-gray-850/40 dark:shadow-none"
			>
				<table
					class="markdown-chat-table w-full max-w-full min-w-full border-collapse text-left text-[0.84rem] tabular-nums text-gray-600 dark:text-gray-200"
				>
					<thead
						class="bg-gray-50/80 text-xs tracking-[0.01em] text-gray-800 dark:bg-gray-800/30 dark:text-gray-400"
					>
						<tr class="">
							{#each token.header as header, headerIdx}
								<th
									scope="col"
									class="px-4! py-2! text-left border-b border-gray-200/90! dark:border-gray-700/45!"
									style={token.align[headerIdx] ? `text-align: ${token.align[headerIdx]}` : ''}
								>
									<div class="break-normal">
										<MarkdownInlineTokens
											id={`${id}-${tokenId}-header-${headerIdx}`}
											tokens={header.tokens}
											{done}
											{sourceIds}
											{onSourceClick}
										/>
									</div>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each token.rows as row, rowIdx}
							<tr class="bg-transparent hover:bg-gray-50 dark:hover:bg-gray-800/25">
								{#each row ?? [] as cell, cellIdx}
									<td
										class="px-4! py-2.5! text-gray-900 dark:text-gray-100 {token.rows.length -
											1 ===
										rowIdx
											? ''
											: 'border-b border-gray-100! dark:border-gray-800/70!'}"
										style={token.align[cellIdx] ? `text-align: ${token.align[cellIdx]}` : ''}
									>
										<div class="break-normal">
											<MarkdownInlineTokens
												id={`${id}-${tokenId}-row-${rowIdx}-${cellIdx}`}
												tokens={cell.tokens}
												{done}
												{sourceIds}
												{onSourceClick}
											/>
										</div>
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<div class=" absolute top-1.5 right-1.5 z-20 invisible group-hover:visible">
				<Tooltip content={$i18n.t('Export to CSV')}>
					<button
						class="p-1 rounded-md text-gray-400 transition hover:bg-gray-200/70 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-700/60 dark:hover:text-gray-200"
						on:click={(e) => {
							e.stopPropagation();
							exportTableToCSVHandler(token, tokenIdx);
						}}
					>
						<Download className=" size-3.5" strokeWidth="1.5" />
					</button>
				</Tooltip>
			</div>
		</div>
	{:else if token.type === 'blockquote'}
		{@const alert = alertComponent(token, tokenizeMarkdown)}
		{#if alert}
			<AlertRenderer {token} {alert} {tokenizeMarkdown} {tokenizeCacheKey} />
		{:else}
			<blockquote dir="auto">
				<svelte:self
					id={`${id}-${tokenId}`}
					tokens={token.tokens}
					{tokenizeMarkdown}
					{tokenizeCacheKey}
					{renderDisplayFilesInline}
					{done}
					{debugMarkersAfterToolBlockIndex}
					{openDebugRequestModal}
					{editCodeBlock}
					{onTaskClick}
					{sourceIds}
					{onSourceClick}
				/>
			</blockquote>
		{/if}
	{:else if token.type === 'list'}
		{#if token.ordered}
			<ol start={token.start || 1} dir="auto">
				{#each token.items as item, itemIdx}
					<li class="text-start">
						{#if item?.task}
							<input
								class=" translate-y-[1px] -translate-x-1"
								type="checkbox"
								checked={item.checked}
								on:change={(e) => {
									onTaskClick({
										id: id,
										token: token,
										tokenIdx: tokenIdx,
										item: item,
										itemIdx: itemIdx,
										checked: e.target.checked
									});
								}}
							/>
						{/if}

						<svelte:self
							id={`${id}-${tokenId}-${itemIdx}`}
							tokens={item.tokens}
							{tokenizeMarkdown}
							{tokenizeCacheKey}
							{renderDisplayFilesInline}
							top={token.loose}
							{done}
							{debugMarkersAfterToolBlockIndex}
							{openDebugRequestModal}
							{editCodeBlock}
							{onTaskClick}
							{sourceIds}
							{onSourceClick}
							{onStopResponse}
						/>
					</li>
				{/each}
			</ol>
		{:else}
			<ul dir="auto" class="">
				{#each token.items as item, itemIdx}
					<li class="text-start {item?.task ? 'flex -translate-x-6.5 gap-3 ' : ''}">
						{#if item?.task}
							<input
								class=""
								type="checkbox"
								checked={item.checked}
								on:change={(e) => {
									onTaskClick({
										id: id,
										token: token,
										tokenIdx: tokenIdx,
										item: item,
										itemIdx: itemIdx,
										checked: e.target.checked
									});
								}}
							/>

							<div>
								<svelte:self
									id={`${id}-${tokenId}-${itemIdx}`}
									tokens={item.tokens}
									{tokenizeMarkdown}
									{tokenizeCacheKey}
									{renderDisplayFilesInline}
									top={token.loose}
									{done}
									{debugMarkersAfterToolBlockIndex}
									{openDebugRequestModal}
									{editCodeBlock}
									{onTaskClick}
									{sourceIds}
									{onSourceClick}
									{onStopResponse}
								/>
							</div>
						{:else}
							<svelte:self
								id={`${id}-${tokenId}-${itemIdx}`}
								tokens={item.tokens}
								{tokenizeMarkdown}
								{tokenizeCacheKey}
								{renderDisplayFilesInline}
								top={token.loose}
								{done}
								{debugMarkersAfterToolBlockIndex}
								{openDebugRequestModal}
								{editCodeBlock}
								{onTaskClick}
								{sourceIds}
								{onSourceClick}
								{onStopResponse}
							/>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{:else if token.type === 'details'}
		{@const leadingText = getLeadingText(token)}
		{@const toolBlockIndex = getToolBlockIndex(token)}
		{@const renderToolBlockMarker =
			toolBlockIndex !== undefined && shouldRenderToolBlockMarker(token)}
		{#if leadingText && leadingText.trim()}
			<svelte:self
				id={`${id}-${tokenId}-leading`}
				tokens={getCachedMarkdownTokens(leadingText)}
				{tokenizeMarkdown}
				{tokenizeCacheKey}
				{renderDisplayFilesInline}
				{done}
				{messageStopReason}
				{debugMarkersAfterToolBlockIndex}
				{openDebugRequestModal}
				{editCodeBlock}
				{onTaskClick}
				{sourceIds}
				{onSourceClick}
				{onStopResponse}
			/>
		{/if}
		<Collapsible
			title={token.summary}
			open={$settings?.expandDetails ?? false}
			attributes={token?.attributes}
			messageDone={done}
			{messageStopReason}
			copyText={decode(token.text)}
			className="w-full space-y-1"
			dir="auto"
			{onStopResponse}
		>
			<div class=" mb-1.5" slot="content">
				<svelte:self
					id={`${id}-${tokenId}-d`}
					tokens={getCachedMarkdownTokens(token.text)}
					{tokenizeMarkdown}
					{tokenizeCacheKey}
					{renderDisplayFilesInline}
					attributes={token?.attributes}
					{done}
					{messageStopReason}
					{debugMarkersAfterToolBlockIndex}
					{openDebugRequestModal}
					{editCodeBlock}
					{onTaskClick}
					{sourceIds}
					{onSourceClick}
					{onStopResponse}
				/>
			</div>
		</Collapsible>
		{#if renderDisplayFilesInline && isDisplayFilesToolCall(token?.attributes)}
			<DisplayFilesInline
				id={`${id}-${tokenId}-display-files`}
				attributes={token?.attributes}
			/>
		{/if}
		{#if renderToolBlockMarker && debugMarkersAfterToolBlockIndex?.[toolBlockIndex]?.length}
			<div class="w-full" role="presentation">
				{#each debugMarkersAfterToolBlockIndex[toolBlockIndex] as request (request.request_id)}
					<DebugRequestMarker request={request} onInspect={openDebugRequestModal} />
				{/each}
			</div>
		{/if}
	{:else if token.type === 'html'}
		{@const htmlSegments = getAnnotatedHtmlSegments(token)}
		{#if token.text && htmlSegments.some((segment) => segment.type === 'details')}
			{#each htmlSegments as segment, segmentIdx}
				{#if segment.type === 'details'}
					{@const segmentToolBlockIndex =
						typeof segment.__owuiToolBlockIndex === 'number'
							? segment.__owuiToolBlockIndex
							: undefined}
					{@const renderSegmentToolBlockMarker =
						segmentToolBlockIndex !== undefined && shouldRenderToolBlockMarker(segment)}
					<Collapsible
						title={segment.summary}
						open={$settings?.expandDetails ?? false}
						attributes={segment.attributes}
						messageDone={done}
						{messageStopReason}
						copyText={decode(segment.body)}
						className="w-full space-y-1"
						dir="auto"
						{onStopResponse}
					>
						<div class=" mb-1.5" slot="content">
							<svelte:self
								id={`${id}-${tokenId}-html-${segmentIdx}-d`}
								tokens={getCachedMarkdownTokens(segment.body)}
								{tokenizeMarkdown}
								{tokenizeCacheKey}
								{renderDisplayFilesInline}
								attributes={segment.attributes}
								{done}
								{messageStopReason}
								{debugMarkersAfterToolBlockIndex}
								{openDebugRequestModal}
								{editCodeBlock}
								{onTaskClick}
								{sourceIds}
								{onSourceClick}
								{onStopResponse}
							/>
						</div>
					</Collapsible>
					{#if renderDisplayFilesInline && isDisplayFilesToolCall(segment.attributes)}
						<DisplayFilesInline
							id={`${id}-${tokenId}-html-${segmentIdx}-display-files`}
							attributes={segment.attributes}
						/>
					{/if}
					{#if renderSegmentToolBlockMarker &&
						debugMarkersAfterToolBlockIndex?.[segmentToolBlockIndex]?.length}
						<div class="w-full" role="presentation">
							{#each debugMarkersAfterToolBlockIndex[segmentToolBlockIndex] as request (request.request_id)}
								<DebugRequestMarker request={request} onInspect={openDebugRequestModal} />
							{/each}
						</div>
					{/if}
				{:else}
					<svelte:self
						id={`${id}-${tokenId}-html-${segmentIdx}-t`}
						tokens={getCachedMarkdownTokens(segment.content)}
						{tokenizeMarkdown}
						{tokenizeCacheKey}
						{renderDisplayFilesInline}
						{done}
						{messageStopReason}
						{debugMarkersAfterToolBlockIndex}
						{openDebugRequestModal}
						{editCodeBlock}
						{onTaskClick}
						{sourceIds}
						{onSourceClick}
						{onStopResponse}
					/>
				{/if}
			{/each}
		{:else}
			<HtmlToken {id} {token} {onSourceClick} />
		{/if}
	{:else if token.type === 'iframe'}
		<iframe
			src="{WEBUI_BASE_URL}/api/v1/files/{token.fileId}/content"
			title={token.fileId}
			width="100%"
			frameborder="0"
			on:load={(e) => {
				try {
					e.currentTarget.style.height =
						e.currentTarget.contentWindow.document.body.scrollHeight + 20 + 'px';
				} catch {}
			}}
		></iframe>
	{:else if token.type === 'paragraph'}
		{#if paragraphTag == 'span'}
			<span dir="auto">
				<MarkdownInlineTokens
					id={`${id}-${tokenId}-p`}
					tokens={token.tokens ?? []}
					{done}
					{sourceIds}
					{onSourceClick}
				/>
			</span>
		{:else}
			<p dir="auto">
				<MarkdownInlineTokens
					id={`${id}-${tokenId}-p`}
					tokens={token.tokens ?? []}
					{done}
					{sourceIds}
					{onSourceClick}
				/>
			</p>
		{/if}
	{:else if token.type === 'text'}
		{#if top}
			<p>
				{#if token.tokens}
					<MarkdownInlineTokens
						id={`${id}-${tokenId}-t`}
						tokens={token.tokens}
						{done}
						{sourceIds}
						{onSourceClick}
					/>
				{:else}
					{unescapeHtml(token.text)}
				{/if}
			</p>
		{:else if token.tokens}
			<MarkdownInlineTokens
				id={`${id}-${tokenId}-p`}
				tokens={token.tokens ?? []}
				{done}
				{sourceIds}
				{onSourceClick}
			/>
		{:else}
			{unescapeHtml(token.text)}
		{/if}
	{:else if token.type === 'inlineKatex'}
		{#if token.text}
			<KatexRenderer content={token.text} displayMode={token?.displayMode ?? false} />
		{/if}
	{:else if token.type === 'blockKatex'}
		{#if token.text}
			<KatexRenderer content={token.text} displayMode={token?.displayMode ?? false} />
		{/if}
	{:else if token.type === 'space'}
		<div class="my-2"></div>
	{/if}
{/each}
