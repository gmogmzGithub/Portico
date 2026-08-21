export const normalizeStreamStartedAt = (value, fallback = Date.now()) => {
	const parsed = typeof value === 'number' ? value : Number(value ?? 0);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
};

// The middleware serializer's ONLY open-reasoning shape (attribute order is
// fixed: type, done, [started_at], elapsed; inner text is html-escaped so the
// lazy body always ends at the block's own closer). The leading \n? consumes
// the separator newline the serializer inserts before the block.
const OPEN_REASONING_DETAILS_LITERAL = '<details type="reasoning" done="false"';
const OPEN_REASONING_DETAILS_BLOCK_RE =
	/\n?<details type="reasoning" done="false"[^>]*>[\s\S]*?<\/details>\s*/g;

// Durable streaming content: transient OPEN reasoning blocks removed. An open
// block either closes into done="true" (counted then) or is pruned server-side
// when it never received summary text, so it must not inflate monotonic
// streaming baselines. Closed reasoning and tool_calls blocks are durable.
export const stripOpenReasoningBlocks = (content) => {
	if (typeof content !== 'string' || !content.includes(OPEN_REASONING_DETAILS_LITERAL)) {
		return content;
	}
	return content.replace(OPEN_REASONING_DETAILS_BLOCK_RE, '');
};

// True while the assistant message has a live (unclosed) reasoning block —
// i.e. the thinking indicator is showing. During silent reasoning the stream
// is quiet by design, so stall heartbeats ("Still working...") should defer
// to the more specific indicator instead of overlaying it.
export const hasOpenReasoningActivity = (message) => {
	const blocks = message?.contentBlocks;
	if (Array.isArray(blocks)) {
		for (const block of blocks) {
			if (
				block &&
				typeof block === 'object' &&
				block.type === 'reasoning' &&
				(block.ended_at === null || block.ended_at === undefined)
			) {
				return true;
			}
		}
	}
	const content = typeof message?.content === 'string' ? message.content : '';
	return content.includes(OPEN_REASONING_DETAILS_LITERAL);
};

export const formatElapsedDuration = (elapsedSeconds) => {
	const parsed = typeof elapsedSeconds === 'number' ? elapsedSeconds : Number(elapsedSeconds ?? 0);
	const totalSeconds = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	const parts = [];

	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

	return parts.join(' ');
};
