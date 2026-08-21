import type { LLMRequest, RequestSummary } from '@/types/llm';

function getDebugMonitorToken(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('token')?.trim() || '';
}

function getDebugMonitorFetchOptions(): RequestInit | undefined {
  const token = getDebugMonitorToken();
  return token
    ? {
        headers: {
          'X-Debug-Monitor-Token': token,
        },
      }
    : undefined;
}

export async function fetchChatRequests(
  chatId: string,
  limit = 200,
): Promise<{ requests: RequestSummary[]; total: number }> {
  const response = await fetch(
    `/api/chats/${encodeURIComponent(chatId)}/requests?limit=${limit}`,
    getDebugMonitorFetchOptions(),
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch chat requests: ${response.status}`);
  }

  const payload = await response.json();
  return {
    requests: Array.isArray(payload?.requests)
      ? (payload.requests as RequestSummary[])
      : [],
    total:
      typeof payload?.total === 'number' && Number.isFinite(payload.total)
        ? payload.total
        : 0,
  };
}

export async function fetchRequestDetail(requestId: string): Promise<LLMRequest> {
  const response = await fetch(
    `/api/requests/${encodeURIComponent(requestId)}`,
    getDebugMonitorFetchOptions(),
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch request detail: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.request || typeof payload.request !== 'object') {
    throw new Error('Malformed request detail payload');
  }
  return payload.request as LLMRequest;
}
