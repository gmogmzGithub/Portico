import type { RequestSummary } from '@/types/llm';

export type MonitorSidebarState = 'hidden' | 'visible';

export interface MonitorDeepLinkState {
  sessionId?: string;
  chatId?: string;
  requestId?: string;
  sidebar?: MonitorSidebarState;
}

function normalizeString(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed !== '' ? trimmed : undefined;
}

export function parseMonitorDeepLinkSearch(search: string): MonitorDeepLinkState {
  const params = new URLSearchParams(search);
  const sidebar = normalizeString(params.get('sidebar'));
  return {
    sessionId: normalizeString(params.get('session')),
    chatId: normalizeString(params.get('chat')),
    requestId: normalizeString(params.get('request')),
    sidebar:
      sidebar === 'hidden' || sidebar === 'visible'
        ? sidebar
        : undefined,
  };
}

export function shouldDefaultSidebarHiddenForDeepLink(
  state: MonitorDeepLinkState,
): boolean {
  if (state.sidebar === 'hidden') {
    return true;
  }
  if (state.sidebar === 'visible') {
    return false;
  }
  return Boolean(state.chatId || state.requestId);
}

export function buildMonitorDeepLinkUrl(
  baseUrl: string,
  {
    sessionId,
    chatId,
    requestId,
    sidebar,
  }: MonitorDeepLinkState,
): string {
  const url = new URL(baseUrl);

  if (sessionId) {
    url.searchParams.set('session', sessionId);
  } else {
    url.searchParams.delete('session');
  }

  if (chatId) {
    url.searchParams.set('chat', chatId);
  } else {
    url.searchParams.delete('chat');
  }

  if (requestId) {
    url.searchParams.set('request', requestId);
  } else {
    url.searchParams.delete('request');
  }

  if (sidebar === 'hidden' || sidebar === 'visible') {
    url.searchParams.set('sidebar', sidebar);
  } else {
    url.searchParams.delete('sidebar');
  }

  return url.toString();
}

export function getFirstRequestIdForChat(
  requests: Pick<RequestSummary, 'request_id' | 'timestamp'>[],
): string | undefined {
  if (requests.length === 0) {
    return undefined;
  }

  const sorted = [...requests].sort((left, right) => {
    const leftTime = new Date(left.timestamp).getTime();
    const rightTime = new Date(right.timestamp).getTime();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.request_id.localeCompare(right.request_id);
  });

  return sorted[0]?.request_id;
}
