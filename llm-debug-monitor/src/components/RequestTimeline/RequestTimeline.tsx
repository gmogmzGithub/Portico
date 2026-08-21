import { useEffect } from 'react';
import { useEventStore } from '@/store/eventStore';
import { RequestCard } from './RequestCard';
import type { LLMRequest } from '@/types/llm';
import type { ActiveTool } from '@/types/events';

interface RequestTimelineProps {
  requests: LLMRequest[];
  activeServers: ActiveTool[];
}

export function RequestTimeline({ requests, activeServers }: RequestTimelineProps) {
  const { selectedRequestId, selectRequest } = useEventStore();

  useEffect(() => {
    if (!selectedRequestId) {
      return;
    }

    const target = document.querySelector<HTMLElement>(
      `[data-request-card-id="${CSS.escape(selectedRequestId)}"]`
    );
    target?.scrollIntoView({ block: 'nearest' });
  }, [selectedRequestId]);

  if (requests.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto text-slate-600 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <p className="text-sm text-slate-500">No requests yet</p>
          <p className="text-xs text-slate-600 mt-1">Send a message to see LLM requests</p>
        </div>
      </div>
    );
  }

  // Reverse to show most recent first
  const reversedRequests = [...requests].reverse();

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {reversedRequests.map((request, index) => (
        <RequestCard
          key={request.request_id}
          request={request}
          index={requests.length - index}
          isSelected={request.request_id === selectedRequestId}
          onClick={() => selectRequest(request.request_id)}
          activeServers={activeServers}
        />
      ))}
    </div>
  );
}
