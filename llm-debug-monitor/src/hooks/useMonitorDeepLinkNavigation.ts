import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchChatRequests, fetchRequestDetail } from '@/api/monitor';
import { useEventStore } from '@/store/eventStore';
import {
  buildMonitorDeepLinkUrl,
  getFirstRequestIdForChat,
  parseMonitorDeepLinkSearch,
  shouldDefaultSidebarHiddenForDeepLink,
} from '@/utils/monitorDeepLinks';

type LocationApplyReason = 'load' | 'popstate';

export function useMonitorDeepLinkNavigation(sessionId: string) {
  const selectedChatId = useEventStore((state) => state.selectedChatId);
  const selectedRequestId = useEventStore((state) => state.selectedRequestId);
  const selectionOrigin = useEventStore((state) => state.selectionOrigin);
  const requests = useEventStore((state) => state.requests);
  const setSelection = useEventStore((state) => state.setSelection);
  const hydrateChatRequests = useEventStore((state) => state.hydrateChatRequests);
  const hydrateRequestDetail = useEventStore((state) => state.hydrateRequestDetail);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [urlScopedSocketEnabled, setUrlScopedSocketEnabled] = useState(false);
  const [urlScopedChatId, setUrlScopedChatId] = useState<string | null>(null);
  const initialRouteAppliedRef = useRef(false);
  const suppressUrlSyncRef = useRef(false);
  const inflightDetailRequestIdsRef = useRef<Set<string>>(new Set());

  const applyLocationSearch = useCallback(
    async (search: string, reason: LocationApplyReason) => {
      const nextState = parseMonitorDeepLinkSearch(search);
      const hasExplicitTarget = Boolean(nextState.chatId || nextState.requestId);

      setSidebarCollapsed(shouldDefaultSidebarHiddenForDeepLink(nextState));
      setUrlScopedSocketEnabled(hasExplicitTarget);

      if (!hasExplicitTarget) {
        setUrlScopedChatId(null);
        if (reason === 'popstate') {
          setSelection(null, null, 'deep_link');
        }
        initialRouteAppliedRef.current = true;
        return;
      }

      suppressUrlSyncRef.current = true;
      try {
        if (nextState.requestId) {
          const detail = await fetchRequestDetail(nextState.requestId);
          const resolvedChatId = nextState.chatId || detail.chat_id;

          if (resolvedChatId) {
            const { requests, total } = await fetchChatRequests(resolvedChatId);
            hydrateChatRequests(resolvedChatId, requests, total);
            setUrlScopedChatId(resolvedChatId);
          }

          hydrateRequestDetail(detail);
          setSelection(resolvedChatId || detail.chat_id || null, detail.request_id, 'deep_link');

          const normalizedUrl = buildMonitorDeepLinkUrl(window.location.href, {
            sessionId: nextState.sessionId || sessionId,
            chatId: resolvedChatId || detail.chat_id,
            requestId: detail.request_id,
            sidebar: nextState.sidebar,
          });
          window.history.replaceState({}, '', normalizedUrl);
        } else if (nextState.chatId) {
          const { requests, total } = await fetchChatRequests(nextState.chatId);
          hydrateChatRequests(nextState.chatId, requests, total);
          setUrlScopedChatId(nextState.chatId);
          setSelection(
            nextState.chatId,
            getFirstRequestIdForChat(requests) || null,
            'deep_link',
          );
        }
      } catch (error) {
        console.error('[Monitor] Failed to apply deep link:', error);
        setUrlScopedChatId(nextState.chatId || null);
        if (!nextState.chatId) {
          setUrlScopedSocketEnabled(false);
        }
      } finally {
        suppressUrlSyncRef.current = false;
        initialRouteAppliedRef.current = true;
      }
    },
    [hydrateChatRequests, hydrateRequestDetail, sessionId, setSelection],
  );

  useEffect(() => {
    void applyLocationSearch(window.location.search, 'load');

    const handlePopState = () => {
      void applyLocationSearch(window.location.search, 'popstate');
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyLocationSearch]);

  useEffect(() => {
    if (!initialRouteAppliedRef.current || suppressUrlSyncRef.current) {
      return;
    }
    if (selectionOrigin !== 'user') {
      return;
    }

    const nextUrl = buildMonitorDeepLinkUrl(window.location.href, {
      sessionId,
      chatId: selectedChatId || undefined,
      requestId: selectedRequestId || undefined,
    });
    window.history.replaceState({}, '', nextUrl);
  }, [selectedChatId, selectedRequestId, selectionOrigin, sessionId]);

  useEffect(() => {
    if (!selectedRequestId) {
      return;
    }

    const selectedRequest = requests.get(selectedRequestId);
    if (selectedRequest && selectedRequest.messages.length > 0) {
      return;
    }
    if (inflightDetailRequestIdsRef.current.has(selectedRequestId)) {
      return;
    }

    inflightDetailRequestIdsRef.current.add(selectedRequestId);
    void (async () => {
      try {
        const detail = await fetchRequestDetail(selectedRequestId);
        hydrateRequestDetail(detail);
      } catch (error) {
        console.error('[Monitor] Failed to hydrate selected request detail:', error);
      } finally {
        inflightDetailRequestIdsRef.current.delete(selectedRequestId);
      }
    })();
  }, [hydrateRequestDetail, requests, selectedRequestId]);

  const effectiveSocketChatId = useMemo(() => {
    if (!urlScopedSocketEnabled) {
      return undefined;
    }
    return selectedChatId || urlScopedChatId || undefined;
  }, [selectedChatId, urlScopedChatId, urlScopedSocketEnabled]);

  return {
    sidebarCollapsed,
    setSidebarCollapsed,
    useUrlScopedSocket: urlScopedSocketEnabled,
    socketChatId: effectiveSocketChatId,
  };
}
