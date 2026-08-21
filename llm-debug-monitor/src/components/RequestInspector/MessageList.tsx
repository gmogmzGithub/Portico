import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LLMMessage, LLMContentBlock } from '@/types/llm';
import {
  cacheBreakpointOriginLabel,
  type CacheBreakpoint,
} from '@/utils/cacheBreakpoints';
import { JsonHighlight } from '@/components/shared/JsonHighlight';
import { XmlHighlight } from '@/components/shared/XmlHighlight';
import { ToolCallIdBadge } from '@/components/shared/ToolCallIdBadge';
import { TokenBadge } from '@/components/shared/TokenBadge';
import { isPorticoContextXml } from '@/utils/xml';

interface MessageListProps {
  messages: LLMMessage[];
  /** If true, only the first message is expanded by default */
  defaultExpandFirstOnly?: boolean;
  /** Currently selected tool call ID for highlighting */
  selectedToolCallId?: string | null;
  /** Callback when a tool call ID is clicked */
  onToolCallSelect?: (id: string) => void;
  /** Model name for instructions-hoist detection */
  modelName?: string;
  /** Exact cache breakpoints keyed by message index in this list */
  cacheBreakpointsByMessage?: Record<number, CacheBreakpoint[]>;
}

function getMessageText(content: string | LLMContentBlock[]): string {
  if (typeof content === 'string') return content;
  return (content || []).map(b => b.text || '').join('');
}

export function MessageList({ messages, defaultExpandFirstOnly = false, selectedToolCallId, onToolCallSelect, modelName, cacheBreakpointsByMessage = {} }: MessageListProps) {
  const isGpt5 = (modelName || '').toLowerCase().startsWith('gpt-5');
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');

  // Track expanded state for each message by index
  const [expandedStates, setExpandedStates] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    messages.forEach((_, idx) => {
      initial[idx] = defaultExpandFirstOnly ? idx === 0 : true;
    });
    return initial;
  });

  // Reset expanded states when messages change
  useEffect(() => {
    const newStates: Record<number, boolean> = {};
    messages.forEach((_, idx) => {
      newStates[idx] = defaultExpandFirstOnly ? idx === 0 : true;
    });
    setExpandedStates(newStates);
  }, [messages, defaultExpandFirstOnly]);

  const expandAll = useCallback(() => {
    const newStates: Record<number, boolean> = {};
    messages.forEach((_, idx) => {
      newStates[idx] = true;
    });
    setExpandedStates(newStates);
  }, [messages]);

  const collapseAll = useCallback(() => {
    const newStates: Record<number, boolean> = {};
    messages.forEach((_, idx) => {
      newStates[idx] = false;
    });
    setExpandedStates(newStates);
  }, [messages]);

  const toggleExpanded = useCallback((index: number) => {
    setExpandedStates(prev => ({ ...prev, [index]: !prev[index] }));
  }, []);

  // Check if all are expanded or collapsed
  const allExpanded = messages.every((_, idx) => expandedStates[idx]);
  const allCollapsed = messages.every((_, idx) => !expandedStates[idx]);

  return (
    <div className="p-4">
      {/* Controls Row */}
      <div className="flex items-center justify-between mb-4">
        {/* View Mode Toggle */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">View:</span>
          <div className="flex rounded-lg overflow-hidden border border-monitor-border">
            <button
              onClick={() => setViewMode('formatted')}
              className={clsx(
                'px-3 py-1 text-xs font-medium transition-colors',
                viewMode === 'formatted'
                  ? 'bg-monitor-accent text-white'
                  : 'bg-monitor-card text-slate-400 hover:text-white'
              )}
            >
              Formatted
            </button>
            <button
              onClick={() => setViewMode('raw')}
              className={clsx(
                'px-3 py-1 text-xs font-medium transition-colors',
                viewMode === 'raw'
                  ? 'bg-monitor-accent text-white'
                  : 'bg-monitor-card text-slate-400 hover:text-white'
              )}
            >
              Raw
            </button>
          </div>
        </div>

        {/* Expand/Collapse All Buttons */}
        {messages.length > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={expandAll}
              disabled={allExpanded}
              className={clsx(
                'px-2 py-1 text-xs font-medium rounded border transition-colors',
                allExpanded
                  ? 'bg-monitor-bg text-slate-600 border-monitor-border cursor-not-allowed'
                  : 'bg-monitor-card text-slate-300 border-monitor-border hover:text-white hover:border-slate-500'
              )}
            >
              Expand All
            </button>
            <button
              onClick={collapseAll}
              disabled={allCollapsed}
              className={clsx(
                'px-2 py-1 text-xs font-medium rounded border transition-colors',
                allCollapsed
                  ? 'bg-monitor-bg text-slate-600 border-monitor-border cursor-not-allowed'
                  : 'bg-monitor-card text-slate-300 border-monitor-border hover:text-white hover:border-slate-500'
              )}
            >
              Collapse All
            </button>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="space-y-3">
        {messages.map((message, index) => (
          <div
            key={index}
            className={clsx(
              'p-3 rounded-lg',
              index % 2 === 0 ? 'bg-slate-700/40' : 'bg-slate-800/70'
            )}
          >
            <MessageItem
              message={message}
              displayIndex={index + 1}
              viewMode={viewMode}
              isExpanded={expandedStates[index] ?? true}
              onToggleExpanded={() => toggleExpanded(index)}
              selectedToolCallId={selectedToolCallId}
              onToolCallSelect={onToolCallSelect}
              cacheBreakpoints={cacheBreakpointsByMessage[index] || []}
              isGpt5InstructionsHoist={isGpt5 && message.role === 'system' && !getMessageText(message.content).includes('<dynamic_context>')}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

interface MessageItemProps {
  message: LLMMessage;
  displayIndex: number;
  viewMode: 'formatted' | 'raw';
  isExpanded: boolean;
  onToggleExpanded: () => void;
  selectedToolCallId?: string | null;
  onToolCallSelect?: (id: string) => void;
  cacheBreakpoints?: CacheBreakpoint[];
  isGpt5InstructionsHoist?: boolean;
}

function MessageItem({ message, displayIndex, viewMode, isExpanded, onToggleExpanded, selectedToolCallId, onToolCallSelect, cacheBreakpoints = [], isGpt5InstructionsHoist }: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const originBadgeClass = (origin: CacheBreakpoint['origin']): string => {
    switch (origin) {
      case 'explicit':
        return 'bg-cyan-950/40 text-cyan-300 border-cyan-700/40';
      case 'request-level':
        return 'bg-amber-950/40 text-amber-300 border-amber-700/40';
      case 'automatic':
        return 'bg-emerald-950/40 text-emerald-300 border-emerald-700/40';
    }
  };

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, []);

  // Role-specific styling - matching ResponseViewer style
  const roleStyles = {
    system: {
      badge: 'bg-slate-900/50 text-slate-300 border-slate-700/50',
      bg: 'bg-slate-900/30 border-slate-700/50',
      text: 'text-slate-300',
    },
    user: {
      badge: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
      bg: 'bg-blue-950/30 border-blue-900/50',
      text: 'text-blue-200/90',
    },
    assistant: {
      badge: 'bg-green-900/50 text-green-300 border-green-700/50',
      bg: 'bg-green-950/30 border-green-900/50',
      text: 'text-green-200/90',
    },
    tool: {
      badge: 'bg-purple-900/50 text-purple-300 border-purple-700/50',
      bg: 'bg-purple-950/30 border-purple-900/50',
      text: 'text-purple-200/90',
    },
  };

  const style = roleStyles[message.role] || roleStyles.system;

  const getContentString = (content: string | LLMContentBlock[]): string => {
    if (typeof content === 'string') return content;
    return content
      .map((block) => {
        if (block.type === 'text') return block.text || '';
        if (block.type === 'thinking') return `[Thinking: ${block.thinking?.slice(0, 100)}...]`;
        if (block.type === 'image_url') return '[Image]';
        return '';
      })
      .join('\n');
  };

  const contentString = getContentString(message.content);
  const isLongContent = contentString.length > 500;

  // Check if content is JSON for tool results
  const isToolResult = message.role === 'tool';
  const isContentJson = isToolResult && (() => {
    try {
      JSON.parse(contentString);
      return true;
    } catch {
      return false;
    }
  })();

  // Check if system message contains Portico context XML
  const isSystemXml = message.role === 'system' && isPorticoContextXml(contentString);

  return (
    <div className="space-y-2">
      {/* Header - entire row is clickable for expand/collapse */}
      <div
        onClick={onToggleExpanded}
        className="flex items-center gap-2 w-full flex-wrap cursor-pointer hover:bg-slate-600/20 rounded-lg py-1 px-1 -mx-1 transition-colors"
      >
        {/* Role badge */}
        <div className={clsx('flex items-center gap-2 px-2 py-1 text-xs font-medium rounded border', style.badge)}>
          <svg
            className={clsx('w-3 h-3 transition-transform', isExpanded && 'rotate-90')}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="capitalize">
            {message.role === 'tool' ? 'Tool Result' : message.role}
          </span>
          {message.name && <span className="opacity-70">({message.name})</span>}
        </div>
        <span className="text-xs text-slate-500">#{displayIndex}</span>
        {cacheBreakpoints.length > 0 && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-cyan-900/50 text-cyan-300 border border-cyan-700/50" title="Exact cache breakpoint metadata derived from the transformed request payload">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
            Cache {cacheBreakpoints.length}
          </span>
        )}
        {isGpt5InstructionsHoist && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-900/50 text-amber-300 border border-amber-700/50" title="Hoisted to Responses API 'instructions' field (cached prefix) by the Rust bridge">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
            Instructions Hoist
          </span>
        )}
        <TokenBadge charCount={contentString.length} />
        {message.tool_call_id && (
          <ToolCallIdBadge
            id={message.tool_call_id}
            isSelected={selectedToolCallId === message.tool_call_id}
            onClick={(id) => {
              // Stop propagation to prevent toggle when clicking badge
              onToolCallSelect?.(id);
            }}
          />
        )}
        {/* Copy button - stop propagation to prevent toggle */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleCopy(contentString);
          }}
          className={clsx(
            'ml-auto px-2 py-1 text-xs font-medium rounded border transition-colors',
            copied
              ? 'bg-green-900/50 text-green-300 border-green-700/50'
              : 'bg-monitor-card text-slate-400 border-monitor-border hover:text-white hover:border-slate-500'
          )}
          title="Copy message content"
        >
          {copied ? (
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Copied
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy
            </span>
          )}
        </button>
      </div>

      {/* Content */}
      {isExpanded && (
        <div className={clsx(
          'p-4 rounded-lg border transition-all',
          style.bg,
          // Highlight Tool Result when its tool_call_id is selected
          isToolResult && selectedToolCallId && message.tool_call_id === selectedToolCallId && 'ring-2 ring-cyan-400/50 border-cyan-500/50'
        )}>
          {cacheBreakpoints.length > 0 && (
            <div className="mb-4 p-3 rounded bg-cyan-950/20 border border-cyan-800/40">
              <div className="flex items-center gap-2 mb-2 text-xs text-cyan-300 font-medium">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                Cache Breakpoints
              </div>
              <div className="space-y-2">
                {cacheBreakpoints.map((breakpoint) => (
                  <div key={breakpoint.id} className="rounded border border-cyan-800/30 bg-cyan-950/20 px-2.5 py-2">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span
                        className={clsx(
                          'px-1.5 py-0.5 text-[10px] font-medium rounded border',
                          originBadgeClass(breakpoint.origin)
                        )}
                      >
                        {cacheBreakpointOriginLabel(breakpoint.origin)}
                      </span>
                      <span className="text-[11px] text-cyan-200">{breakpoint.displayPath}</span>
                    </div>
                    <div className="text-[11px] text-slate-300">{breakpoint.summary}</div>
                    <div className="mt-1 font-mono text-[11px] text-slate-400 break-all">
                      {breakpoint.jsonPath}
                    </div>
                    {breakpoint.preview && (
                      <div className="mt-1 text-[11px] text-slate-400 whitespace-pre-wrap break-words">
                        {breakpoint.preview}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Thinking blocks */}
          {message.thinking_blocks && message.thinking_blocks.length > 0 && (
            <div className="mb-4 p-3 rounded bg-amber-950/30 border border-amber-900/50">
              <div className="flex items-center gap-2 mb-2 text-xs text-amber-300 font-medium">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Thinking Block
              </div>
              <pre className="text-sm text-amber-200/80 whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto font-mono">
                {message.thinking_blocks[0].thinking}
              </pre>
            </div>
          )}

          {/* Main content */}
          {isSystemXml && contentString.length <= 20000 ? (
            // XML syntax highlighting for Portico context system messages (skip for very large content)
            <div className="overflow-x-auto">
              <XmlHighlight
                xml={contentString}
                showLineNumbers
                maxHeight="32rem"
                collapsed={isLongContent}
              />
            </div>
          ) : isToolResult && isContentJson ? (
            // JSON syntax highlighting for tool results
            <div className="overflow-x-auto">
              <JsonHighlight data={contentString} expandLevel={3} />
            </div>
          ) : viewMode === 'raw' || contentString.length > 20000 ? (
            // Raw mode or very large content — skip ReactMarkdown to avoid browser hang
            <pre
              className={clsx(
                'text-sm whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed',
                style.text,
                isLongContent && 'max-h-96 overflow-y-auto'
              )}
            >
              {contentString}
            </pre>
          ) : (
            <div
              className={clsx(
                'prose prose-sm prose-invert max-w-none',
                style.text,
                isLongContent && 'max-h-96 overflow-y-auto'
              )}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {contentString}
              </ReactMarkdown>
            </div>
          )}

          {/* Tool Use Requests */}
          {message.tool_calls && message.tool_calls.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="px-2 py-1 text-xs font-medium bg-amber-900/50 text-amber-300 rounded">
                  Tool Use Requests
                </span>
                <span className="text-xs text-slate-500">
                  {message.tool_calls.length} request(s)
                </span>
              </div>
              {message.tool_calls.map((toolCall) => {
                const isSelected = selectedToolCallId === toolCall.id;
                return (
                  <div
                    key={toolCall.id}
                    className={clsx(
                      'p-3 rounded border transition-all',
                      isSelected
                        ? 'bg-cyan-950/40 border-cyan-500/50 ring-2 ring-cyan-400/50'
                        : 'bg-amber-950/30 border-amber-900/50'
                    )}
                  >
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className={clsx('text-sm font-medium', isSelected ? 'text-cyan-300' : 'text-amber-300')}>
                        {toolCall.function.name}
                      </span>
                      <ToolCallIdBadge
                        id={toolCall.id}
                        isSelected={isSelected}
                        onClick={onToolCallSelect}
                      />
                    </div>
                    <div className="overflow-x-auto max-h-32 overflow-y-auto">
                      <JsonHighlight data={toolCall.function.arguments} expandLevel={2} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
