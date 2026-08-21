import { useState } from 'react';
import { clsx } from 'clsx';
import type { LLMResponse } from '@/types/llm';
import { JsonHighlight } from '@/components/shared/JsonHighlight';
import { ToolCallIdBadge } from '@/components/shared/ToolCallIdBadge';
import { TokenBadge } from '@/components/shared/TokenBadge';

interface ResponseViewerProps {
  response?: LLMResponse;
  selectedToolCallId?: string | null;
  onToolCallSelect?: (id: string) => void;
}

function CopyButton({ text, id, copiedId, onCopy }: { text: string; id: string; copiedId: string | null; onCopy: (text: string, id: string) => void }) {
  const isCopied = copiedId === id;
  return (
    <button
      onClick={() => onCopy(text, id)}
      className="flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-white bg-monitor-bg rounded transition-colors"
      title="Copy to clipboard"
    >
      {isCopied ? (
        <>
          <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-green-400">Copied</span>
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <span>Copy</span>
        </>
      )}
    </button>
  );
}

export function ResponseViewer({ response, selectedToolCallId, onToolCallSelect }: ResponseViewerProps) {
  const [showThinking, setShowThinking] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (!response) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="text-center text-slate-500">
          <svg className="w-12 h-12 mx-auto mb-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>Response pending...</p>
        </div>
      </div>
    );
  }

  if (!response.content && !response.thinking && (!response.tool_calls || response.tool_calls.length === 0)) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="text-center text-slate-500">
          <svg className="w-12 h-12 mx-auto mb-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
          <p>No response content captured</p>
          <p className="text-xs mt-1 text-slate-600">Finish reason: {response.finish_reason || 'unknown'}</p>
        </div>
      </div>
    );
  }

  // Build array of response sections for alternating backgrounds
  const sections: { type: 'thinking' | 'content' | 'tools'; key: string }[] = [];
  if (response.thinking) sections.push({ type: 'thinking', key: 'thinking' });
  if (response.content) sections.push({ type: 'content', key: 'content' });
  if (response.tool_calls && response.tool_calls.length > 0) sections.push({ type: 'tools', key: 'tools' });

  const getSectionBg = (index: number) => index % 2 === 0 ? 'bg-slate-700/40' : 'bg-slate-800/70';

  return (
    <div className="p-4 space-y-3">
      {sections.map((section, sectionIndex) => {
        if (section.type === 'thinking') {
          return (
            <div key={section.key} className={clsx('p-3 rounded-lg', getSectionBg(sectionIndex))}>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowThinking(!showThinking)}
                      className="flex items-center gap-2 px-2 py-1 text-xs font-medium bg-amber-900/50 text-amber-300 rounded hover:bg-amber-900/70 transition-colors"
                    >
                      <svg
                        className={`w-3 h-3 transition-transform ${showThinking ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      Thinking / Reasoning
                    </button>
                    <TokenBadge charCount={response.thinking!.length} />
                  </div>
                  <CopyButton text={response.thinking!} id="thinking" copiedId={copiedId} onCopy={handleCopy} />
                </div>
                {showThinking && (
                  <div className="p-4 bg-amber-950/30 rounded-lg border border-amber-900/50">
                    <pre className="text-sm text-amber-200/80 whitespace-pre-wrap font-mono leading-relaxed">
                      {response.thinking}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          );
        }

        if (section.type === 'content') {
          return (
            <div key={section.key} className={clsx('p-3 rounded-lg', getSectionBg(sectionIndex))}>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-1 text-xs font-medium bg-green-900/50 text-green-300 rounded">
                      Assistant Response
                    </span>
                    <TokenBadge charCount={response.content!.length} />
                  </div>
                  <CopyButton text={response.content!} id="content" copiedId={copiedId} onCopy={handleCopy} />
                </div>
                <div className="p-4 bg-monitor-card rounded-lg border border-monitor-border">
                  <pre className="text-sm text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                    {response.content}
                  </pre>
                </div>
              </div>
            </div>
          );
        }

        if (section.type === 'tools') {
          return (
            <div key={section.key} className={clsx('p-3 rounded-lg', getSectionBg(sectionIndex))}>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-1 text-xs font-medium bg-amber-900/50 text-amber-300 rounded">
                    Tool Use Requests
                  </span>
                  <span className="text-xs text-slate-500">
                    {response.tool_calls!.length} request(s) from LLM
                  </span>
                </div>
                <div className="space-y-2">
                  {response.tool_calls!.map((tc, idx) => {
                    const toolCopyText = JSON.stringify({
                      function: tc.function.name,
                      arguments: (() => {
                        try {
                          return JSON.parse(tc.function.arguments);
                        } catch {
                          return tc.function.arguments;
                        }
                      })()
                    }, null, 2);
                    const isSelected = selectedToolCallId === tc.id;

                    return (
                      <div
                        key={tc.id || idx}
                        className={clsx(
                          'p-3 rounded-lg border transition-all',
                          isSelected
                            ? 'bg-cyan-950/40 border-cyan-500/50 ring-2 ring-cyan-400/50'
                            : 'bg-amber-950/30 border-amber-900/50'
                        )}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={clsx('text-sm font-medium', isSelected ? 'text-cyan-300' : 'text-amber-300')}>
                              {tc.function.name}
                            </span>
                            {tc.id && (
                              <ToolCallIdBadge
                                id={tc.id}
                                isSelected={isSelected}
                                onClick={onToolCallSelect}
                              />
                            )}
                          </div>
                          <CopyButton text={toolCopyText} id={`tool-${tc.id || idx}`} copiedId={copiedId} onCopy={handleCopy} />
                        </div>
                        <div className="bg-monitor-bg p-2 rounded overflow-x-auto">
                          <JsonHighlight data={tc.function.arguments} expandLevel={3} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
