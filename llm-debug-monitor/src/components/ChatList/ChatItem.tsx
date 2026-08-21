import type { ChatSession } from '@/types/events';
import { clsx } from 'clsx';
import { formatRelativeTime } from '@/utils/time';

interface ChatItemProps {
  chat: ChatSession;
  isSelected: boolean;
  onClick: () => void;
}

export function ChatItem({ chat, isSelected, onClick }: ChatItemProps) {
  const timeAgo = formatRelativeTime(chat.last_activity);

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full px-4 py-3 text-left border-b border-monitor-border transition-colors',
        isSelected
          ? 'bg-monitor-accent/10 border-l-2 border-l-monitor-accent'
          : 'hover:bg-monitor-bg/50'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-200 truncate">
              {chat.title || `Chat ${chat.chat_id.slice(0, 8)}`}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-slate-500 truncate">{chat.model || 'Unknown model'}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-xs text-slate-500">{timeAgo}</span>
          <div className="flex items-center gap-1">
            <span className="px-1.5 py-0.5 text-xs bg-monitor-bg rounded text-slate-400">
              {chat.request_count} req
            </span>
          </div>
        </div>
      </div>

    </button>
  );
}
