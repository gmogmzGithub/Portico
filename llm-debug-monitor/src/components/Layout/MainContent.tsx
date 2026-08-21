import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useEventStore, useSelectedRequest, useSelectedChat, useChatRequests } from '@/store/eventStore';
import { RequestTimeline } from '@/components/RequestTimeline/RequestTimeline';
import { RequestInspector } from '@/components/RequestInspector/RequestInspector';

export function MainContent() {
  const { selectedChatId, selectedRequestId, selectedToolCallId } = useEventStore();
  const clearToolCallSelection = useEventStore((state) => state.selectToolCall);
  const selectedRequest = useSelectedRequest();
  const selectedChat = useSelectedChat();
  const chatRequests = useChatRequests(selectedChatId);
  const selectedRequestDetailLoaded = Boolean(
    selectedRequest &&
      (
        selectedRequest.messages.length > 0 ||
        Object.keys(selectedRequest.raw_payload || {}).length > 0 ||
        (selectedRequest.transformed_payloads?.length || 0) > 0
      )
  );

  if (!selectedChatId) {
    return (
      <main className="h-full flex items-center justify-center bg-monitor-bg">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto text-slate-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <h2 className="text-lg font-medium text-slate-400 mb-2">No Chat Selected</h2>
          <p className="text-sm text-slate-500">
            Start a chat to see LLM requests here.
          </p>
        </div>
      </main>
    );
  }

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId="llm-debug-monitor-main"
      className="h-full"
    >
      {/* Request Timeline */}
      <Panel defaultSize={selectedRequestId ? 40 : 100} minSize={18}>
        <div className="h-full flex flex-col bg-monitor-bg">
          <div className="px-4 py-3 border-b border-monitor-border bg-monitor-card">
            <h2 className="text-sm font-medium text-slate-300">
              Request Timeline
              <span className="ml-2 text-slate-500">({chatRequests.length} requests)</span>
            </h2>
          </div>
          <RequestTimeline requests={chatRequests} activeServers={selectedChat?.capabilities?.tools || []} />
        </div>
      </Panel>

      {/* Request Inspector (conditional) */}
      {selectedRequestId && selectedRequest && (
        <>
          <PanelResizeHandle className="w-1.5 bg-monitor-border hover:bg-monitor-accent/50 transition-colors cursor-col-resize" />
          <Panel defaultSize={60} minSize={18}>
            <div className="h-full flex flex-col bg-monitor-bg">
              <div className="px-4 py-3 border-b border-monitor-border bg-monitor-card flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-medium text-slate-300">Request Inspector</h2>
                  <span
                    className="rounded border border-monitor-border bg-monitor-bg px-2 py-1 text-xs font-mono text-slate-300"
                    title={selectedRequest.request_id}
                  >
                    {selectedRequest.request_id}
                  </span>
                  {selectedToolCallId && (
                    <button
                      onClick={() => clearToolCallSelection(null)}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs font-mono bg-cyan-900 text-cyan-300 border border-cyan-600 rounded hover:bg-cyan-800 hover:text-cyan-200 transition-colors group"
                      title="Click to clear selection (or press Escape)"
                    >
                      <span>{selectedToolCallId}</span>
                      <svg className="w-3.5 h-3.5 opacity-70 group-hover:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                <button
                  onClick={() => useEventStore.getState().selectRequest(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {selectedRequestDetailLoaded ? (
                <RequestInspector request={selectedRequest} />
              ) : (
                <div className="flex h-full items-center justify-center bg-monitor-bg">
                  <div className="text-center">
                    <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-monitor-border border-t-monitor-accent" />
                    <p className="text-sm text-slate-400">Loading request detail...</p>
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
