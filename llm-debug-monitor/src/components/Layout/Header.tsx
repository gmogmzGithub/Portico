import { useEventStore } from '@/store/eventStore';

interface HeaderProps {
  isConnected: boolean;
  onReconnect: () => void;
}

export function Header({ isConnected, onReconnect }: HeaderProps) {
  const { chats, requests, clearEvents } = useEventStore();

  // Filter out "unknown" chats from count
  const chatCount = Array.from(chats.values()).filter(c => c.chat_id && c.chat_id !== 'unknown').length;

  return (
    <header className="h-14 bg-monitor-card border-b border-monitor-border flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-white flex items-center gap-2">
          <svg className="w-6 h-6 text-monitor-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Portico Monitor
        </h1>

        {/* Connection Status */}
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-monitor-success animate-pulse-slow' : 'bg-monitor-error'}`} />
          <span className="text-sm text-slate-400">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
          {!isConnected && (
            <button
              onClick={onReconnect}
              className="text-sm text-monitor-accent hover:text-blue-400 underline"
            >
              Reconnect
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-6">
        {/* Stats */}
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <span className="text-slate-400">{chatCount} chats</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="text-slate-400">{requests.size} requests</span>
          </div>
        </div>

        {/* Clear Button */}
        <button
          onClick={clearEvents}
          className="px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-monitor-bg hover:bg-slate-700 rounded border border-monitor-border transition-colors"
        >
          Clear
        </button>
      </div>
    </header>
  );
}
