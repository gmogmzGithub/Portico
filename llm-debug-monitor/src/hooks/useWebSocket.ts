import { useEffect, useRef, useCallback, useState } from 'react';
import type { DebugEvent } from '@/types/events';

interface UseWebSocketOptions {
  enabled?: boolean;
  sessionId?: string;
  chatId?: string;
  onEvent?: (event: DebugEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

interface UseWebSocketReturn {
  isConnected: boolean;
  reconnect: () => void;
  disconnect: () => void;
}

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const { enabled = true, sessionId, chatId } = options;

  // Use refs for callbacks to avoid re-triggering effects
  const onEventRef = useRef(options.onEvent);
  const onConnectRef = useRef(options.onConnect);
  const onDisconnectRef = useRef(options.onDisconnect);
  const onErrorRef = useRef(options.onError);

  // Update refs when callbacks change
  useEffect(() => {
    onEventRef.current = options.onEvent;
    onConnectRef.current = options.onConnect;
    onDisconnectRef.current = options.onDisconnect;
    onErrorRef.current = options.onError;
  }, [options.onEvent, options.onConnect, options.onDisconnect, options.onError]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const isConnectingRef = useRef(false);
  const mountedRef = useRef(true);
  const [isConnected, setIsConnected] = useState(false);

  const connect = useCallback(() => {
    if (!enabled) {
      return;
    }

    // Prevent multiple simultaneous connection attempts
    if (isConnectingRef.current || wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Clean up any existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    isConnectingRef.current = true;

    // Build WebSocket URL with query params
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const params = new URLSearchParams();
    if (sessionId) params.set('session_id', sessionId);
    if (chatId) params.set('chat_id', chatId);
    const debugMonitorToken = new URLSearchParams(window.location.search).get('token');
    if (debugMonitorToken) params.set('token', debugMonitorToken);

    const wsUrl = `${protocol}//${host}/ws/events?${params.toString()}`;
    console.log('[WebSocket] Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      console.log('[WebSocket] Connected');
      isConnectingRef.current = false;
      setIsConnected(true);
      onConnectRef.current?.();

      // Clear any pending reconnect
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Handle ping messages
        if (data.type === 'ping') {
          return;
        }
        onEventRef.current?.(data as DebugEvent);
      } catch (e) {
        console.error('[WebSocket] Failed to parse message:', e);
      }
    };

    ws.onclose = (event) => {
      console.log('[WebSocket] Closed:', event.code, event.reason);
      isConnectingRef.current = false;
      wsRef.current = null;

      if (!mountedRef.current) return;

      setIsConnected(false);
      onDisconnectRef.current?.();

      // Auto-reconnect after 3 seconds (only if still mounted)
      if (mountedRef.current) {
        reconnectTimeoutRef.current = window.setTimeout(() => {
          if (mountedRef.current) {
            console.log('[WebSocket] Auto-reconnecting...');
            connect();
          }
        }, 3000);
      }
    };

    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
      isConnectingRef.current = false;
      onErrorRef.current?.(error);
    };
  }, [enabled, sessionId, chatId]);

  const disconnect = useCallback(() => {
    console.log('[WebSocket] Disconnecting...');
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    isConnectingRef.current = false;
    setIsConnected(false);
  }, []);

  const reconnect = useCallback(() => {
    console.log('[WebSocket] Manual reconnect requested');
    disconnect();
    // Small delay to ensure clean disconnection
    setTimeout(() => {
      if (mountedRef.current) {
        connect();
      }
    }, 100);
  }, [disconnect, connect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    mountedRef.current = true;

    // Delay initial connection slightly to avoid React strict mode issues
    const timeoutId = setTimeout(() => {
      if (mountedRef.current && enabled) {
        connect();
      }
    }, 100);

    return () => {
      mountedRef.current = false;
      clearTimeout(timeoutId);
      disconnect();
    };
  }, [connect, disconnect, enabled]);

  return {
    isConnected,
    reconnect,
    disconnect,
  };
}
