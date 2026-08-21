import { ChatList } from '@/components/ChatList/ChatList';

interface SidebarProps {
  onCollapse: () => void;
}

export function Sidebar({ onCollapse }: SidebarProps) {
  return (
    <aside className="h-full bg-monitor-card flex flex-col overflow-hidden">
      {/* Chat List */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-monitor-border flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-slate-300">Active Chats</h2>
          <button
            type="button"
            onClick={onCollapse}
            className="inline-flex items-center justify-center rounded border border-monitor-border bg-monitor-bg p-1.5 text-slate-400 hover:text-white"
            aria-label="Hide active chats pane"
            title="Hide active chats"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        </div>
        <ChatList />
      </div>
    </aside>
  );
}
