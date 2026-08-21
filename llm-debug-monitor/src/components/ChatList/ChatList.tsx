import { useEventStore } from '@/store/eventStore';
import { ChatItem } from './ChatItem';

export function ChatList() {
  const { chats, selectedChatId, selectChat } = useEventStore();

  // Filter out "unknown" chats (from title/suggestion API calls without proper chat_id)
  const sortedChats = Array.from(chats.values())
    .filter(chat => chat.chat_id && chat.chat_id !== 'unknown')
    .sort((a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime());

  if (sortedChats.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <svg className="w-10 h-10 mx-auto text-slate-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <p className="text-sm text-slate-500">No active chats</p>
          <p className="text-xs text-slate-600 mt-1">Waiting for events...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {sortedChats.map((chat) => (
        <ChatItem
          key={chat.chat_id}
          chat={chat}
          isSelected={chat.chat_id === selectedChatId}
          onClick={() => selectChat(chat.chat_id)}
        />
      ))}
    </div>
  );
}
