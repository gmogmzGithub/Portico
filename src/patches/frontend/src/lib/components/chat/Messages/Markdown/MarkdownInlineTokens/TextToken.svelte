<script lang="ts">
	// PORTICO_PATCH: Stream only the appended suffix with fade-in.
	//
	// The previous implementation split token.raw into words and used an
	// unkeyed {#each}, which caused DOM reuse by index and visual jitter when
	// token boundaries shifted during incremental markdown updates.
	//
	// This version renders a stable prefix as plain text and only animates the
	// newly appended suffix chunk. Existing content stays mounted and does not
	// re-fade.

	import { fade } from 'svelte/transition';
	import { unescapeHtml } from '$lib/utils';

	export let token;
	export let done = true;

	let committedText = '';
	let streamingSuffix = '';
	let renderedText = '';
	let lastText = '';

	// marked's HTML renderer normally lets the browser decode entities. This
	// custom escaped-text renderer must do that once before diffing/displaying.
	const decodeTextToken = (raw: string): string =>
		raw.includes('&') ? (unescapeHtml(raw) ?? raw) : raw;

	const longestCommonPrefixLength = (a: string, b: string): number => {
		const maxLength = Math.min(a.length, b.length);
		let index = 0;
		while (index < maxLength && a[index] === b[index]) {
			index += 1;
		}
		return index;
	};

	$: {
		const raw = (token?.raw ?? '') as string;
		const text = decodeTextToken(raw);
		renderedText = text;

		if (done) {
			committedText = text;
			streamingSuffix = '';
			lastText = text;
		} else if (!lastText) {
			committedText = '';
			streamingSuffix = text;
			lastText = text;
		} else if (text.startsWith(lastText)) {
			committedText = lastText;
			streamingSuffix = text.slice(lastText.length);
			lastText = text;
		} else {
			const commonPrefixLength = longestCommonPrefixLength(lastText, text);
			committedText = text.slice(0, commonPrefixLength);
			streamingSuffix = text.slice(commonPrefixLength);
			lastText = text;
		}
	}
</script>

{#if done}
	{renderedText}
{:else}
	<span>{committedText}</span>
	{#if streamingSuffix}
		{#key `${committedText.length}:${streamingSuffix}`}
			<span in:fade={{ duration: 1500 }}>{streamingSuffix}</span>
		{/key}
	{/if}
{/if}
