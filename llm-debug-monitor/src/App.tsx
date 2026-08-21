import { useEffect, useRef } from 'react';
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';
import { useSession } from '@/hooks/useSession';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useMonitorDeepLinkNavigation } from '@/hooks/useMonitorDeepLinkNavigation';
import { useEventStore } from '@/store/eventStore';
import { Header } from '@/components/Layout/Header';
import { Sidebar } from '@/components/Layout/Sidebar';
import { MainContent } from '@/components/Layout/MainContent';

function App() {
  const { sessionId } = useSession();
  const { processEvent, setConnected } = useEventStore();
  const sidebarPanelRef = useRef<ImperativePanelHandle | null>(null);
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    useUrlScopedSocket,
    socketChatId,
  } = useMonitorDeepLinkNavigation(sessionId);

  const { isConnected, reconnect } = useWebSocket({
    enabled: !useUrlScopedSocket || Boolean(socketChatId),
    sessionId: useUrlScopedSocket ? undefined : sessionId,
    chatId: socketChatId,
    onEvent: processEvent,
    onConnect: () => setConnected(true),
    onDisconnect: () => setConnected(false),
  });

  // Sync connection status to store
  useEffect(() => {
    setConnected(isConnected);
  }, [isConnected, setConnected]);

  useEffect(() => {
    if (sidebarCollapsed) {
      sidebarPanelRef.current?.collapse();
    } else {
      sidebarPanelRef.current?.expand(20);
    }
  }, [sidebarCollapsed]);

  return (
    <div className="h-screen flex flex-col bg-monitor-bg">
      <Header isConnected={isConnected} onReconnect={reconnect} />
      <div className="flex-1 relative">
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            className="absolute left-0 top-4 z-20 flex items-center gap-2 rounded-r-lg border border-monitor-border bg-monitor-card px-2 py-2 text-xs font-medium text-slate-300 shadow-lg hover:text-white"
            aria-label="Show active chats pane"
            title="Show active chats"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <span className="hidden md:inline">Chats</span>
          </button>
        )}
        <PanelGroup
          direction="horizontal"
          autoSaveId="llm-debug-monitor-layout"
          className="flex-1"
        >
          <Panel
            ref={sidebarPanelRef}
            defaultSize={20}
            minSize={15}
            maxSize={35}
            collapsible
            collapsedSize={0}
            onCollapse={() => setSidebarCollapsed(true)}
            onExpand={() => setSidebarCollapsed(false)}
            className="bg-monitor-card"
          >
            <Sidebar onCollapse={() => setSidebarCollapsed(true)} />
          </Panel>
          <PanelResizeHandle
            className={`w-1.5 bg-monitor-border hover:bg-monitor-accent/50 transition-colors cursor-col-resize ${
              sidebarCollapsed ? 'hidden' : ''
            }`}
          />
          <Panel minSize={50}>
            <MainContent />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}

export default App;
