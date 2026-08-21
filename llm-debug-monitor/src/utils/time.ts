import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';

/**
 * Format a timestamp for display in the UI (12-hour format with AM/PM)
 * - Shows time only (h:mm:ss a) for today
 * - Shows "Yesterday h:mm a" for yesterday
 * - Shows "MMM d h:mm a" for older dates
 */
export function formatTimestamp(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;

  if (isToday(date)) {
    return format(date, 'h:mm:ss a');
  }

  if (isYesterday(date)) {
    return `Yesterday ${format(date, 'h:mm a')}`;
  }

  return format(date, 'MMM d h:mm a');
}

/**
 * Format a timestamp with seconds (for precise timing, 12-hour format)
 */
export function formatTimestampMs(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return format(date, 'h:mm:ss a');
}

/**
 * Format a relative time (e.g., "2 minutes ago")
 */
export function formatRelativeTime(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms?: number): string {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Format token count with K suffix for large numbers
 */
export function formatTokens(n?: number): string {
  if (!n && n !== 0) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

/**
 * Estimate tokens from character count (roughly 4 chars per token)
 * and format as "~Xk tokens" or "~X tokens"
 */
export function estimateTokens(charCount: number): string {
  const tokens = Math.round(charCount / 4);
  if (tokens >= 1000) {
    return `~${(tokens / 1000).toFixed(1)}k tokens`;
  }
  return `~${tokens} tokens`;
}
