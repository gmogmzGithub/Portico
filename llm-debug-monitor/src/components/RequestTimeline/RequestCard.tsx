import { useMemo } from 'react';
import { clsx } from 'clsx';
import type { LLMRequest, ReasoningConfig } from '@/types/llm';
import type { ActiveTool } from '@/types/events';
import { formatTimestampMs, formatDuration, formatTokens } from '@/utils/time';

interface RequestCardProps {
  request: LLMRequest;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  activeServers: ActiveTool[];
}

// Sparkle icon component for reuse
function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}

// Get color class for reasoning effort level
function getEffortColor(effort: string): string {
  switch (effort) {
    case 'max': return 'text-rose-500';
    case 'xhigh': return 'text-fuchsia-500';
    case 'high': return 'text-purple-500';
    case 'medium': return 'text-blue-500';
    case 'low':
    default: return 'text-gray-400';
  }
}

// Format budget tokens for display (e.g., 32000 -> "32k")
function formatBudgetTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${tokens}`;
}

// Get display text for reasoning config based on model family
function getReasoningDisplayText(config: ReasoningConfig): { primary: string; secondary?: string } {
  const uiEffort = config.ui_effort === 'xhigh'
    ? 'XHigh'
    : config.ui_effort.charAt(0).toUpperCase() + config.ui_effort.slice(1);

  switch (config.model_family) {
    case 'atlas-sonnet':
    case 'atlas-opus':
    case 'atlas-opus-4.6':
    case 'atlas-opus-4.7':
    case 'atlas-opus-4.8':
    case 'atlas-opus-5':
    case 'atlas-haiku': {
      const tokens = config.api_config?.budget_tokens;
      return {
        primary: uiEffort,
        secondary: tokens ? `${formatBudgetTokens(tokens)} tokens` : undefined
      };
    }
    case 'gpt5.2': {
      const apiEffort = config.api_config?.api_effort;
      // Show mapping if different (max -> xhigh)
      if (config.ui_effort === 'max' && apiEffort === 'xhigh') {
        return { primary: uiEffort, secondary: 'xhigh' };
      }
      return { primary: uiEffort };
    }
    case 'gpt5.4-pro': {
      const apiEffort = config.api_config?.api_effort;
      if (config.ui_effort === 'max' && apiEffort === 'xhigh') {
        return { primary: uiEffort, secondary: 'xhigh' };
      }
      if (config.ui_effort === 'low' && apiEffort === 'medium') {
        return { primary: uiEffort, secondary: 'min medium' };
      }
      return { primary: uiEffort };
    }
    case 'gpt5.6-sol':
      return config.ui_effort === 'ultra'
        ? { primary: 'Ultra', secondary: 'multi-agent' }
        : { primary: uiEffort };
    case 'gpt5.6-sol-pro':
      return { primary: uiEffort, secondary: 'pro mode' };
    case 'gpt5.6-terra':
    case 'gpt5.6-luna':
      return { primary: uiEffort };
    case 'gpt5.1':
    case 'gpt5-mini': {
      const apiEffort = config.api_config?.api_effort;
      // Show mapping if different (max -> high)
      if (config.ui_effort === 'max' && apiEffort === 'high') {
        return { primary: uiEffort, secondary: 'capped' };
      }
      return { primary: uiEffort };
    }
    case 'gpt5-pro':
      return { primary: 'High', secondary: 'auto' };
    default:
      return { primary: uiEffort };
  }
}

// Get model family display name
function getModelFamilyDisplayName(family: string): string {
  switch (family) {
    case 'atlas-sonnet': return 'Atlas Sonnet';
    case 'atlas-opus': return 'Atlas Opus';
    case 'atlas-opus-4.6': return 'Atlas Opus 4.6';
    case 'atlas-opus-4.7': return 'Atlas Opus 4.7';
    case 'atlas-opus-4.8': return 'Atlas Opus 4.8';
    case 'atlas-opus-5': return 'Atlas Opus 5';
    case 'atlas-haiku': return 'Atlas Haiku';
    case 'gpt5.2': return 'GPT-5.4 (legacy)';
    case 'gpt5.1': return 'GPT-5.1';
    case 'gpt5.4-pro': return 'GPT-5.4 Pro (legacy)';
    case 'gpt5.6-sol': return 'GPT-5.6 Sol';
    case 'gpt5.6-sol-pro': return 'GPT-5.6 Sol Pro';
    case 'gpt5.6-terra': return 'GPT-5.6 Terra';
    case 'gpt5.6-luna': return 'GPT-5.6 Luna';
    case 'gpt5-mini': return 'GPT-5 Mini/Nano';
    case 'gpt5-pro': return 'GPT-5 Pro';
    default: return family;
  }
}

function formatTaskName(taskName: string): string {
  return taskName
    .replace(/^tasks?\./i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function RequestCard({ request, index, isSelected, onClick, activeServers }: RequestCardProps) {
  const statusColors = {
    pending: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    streaming: 'bg-blue-500/20 text-blue-300 border-blue-500/30 animate-pulse',
    complete: 'bg-green-500/20 text-green-300 border-green-500/30',
    error: 'bg-red-500/20 text-red-300 border-red-500/30',
  };

  const statusIcons = {
    pending: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    streaming: (
      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
    complete: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
    error: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  };

  // Build server info with metadata from activeServers
  const servers = useMemo(() => {
    if (!request.tool_ids || request.tool_ids.length === 0) return [];

    // Construct icon URL base
    const port = window.location.port;
    const useDevOwui = port === '5176' || port === '5173' || port === '8879';
    const owuiBase = useDevOwui ? 'http://localhost:3789' : 'http://localhost:8080';

    return request.tool_ids.map((toolId) => {
      const serverId = toolId.replace('server:', '');
      const serverMeta = activeServers.find((s) => s.server_id === serverId);

      const iconPath = serverMeta?.icon_url || `/api/v1/chats/mcp/servers/${serverId}/icon`;
      const iconUrl = iconPath.startsWith('/') ? `${owuiBase}${iconPath}` : iconPath;

      return {
        serverId,
        displayName: serverMeta?.display_name || serverId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        iconUrl,
        isCore: serverMeta?.is_core ?? false,
      };
    }).sort((a, b) => {
      // Sort: Core first, then alphabetically
      if (a.isCore !== b.isCore) return a.isCore ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [request.tool_ids, activeServers]);

  // Format skills for display
  const formattedSkills = useMemo(() => {
    if (!request.skills || request.skills.length === 0) return [];
    return request.skills.map(skill => ({
      name: skill,
      displayName: skill.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    }));
  }, [request.skills]);

  const hasCapabilities = request.parameters.reasoning_config || request.parameters.reasoning_effort || servers.length > 0 || formattedSkills.length > 0;

  return (
    <button
      onClick={onClick}
      data-request-card-id={request.request_id}
      className={clsx(
        'w-full text-left p-4 rounded-lg border transition-all',
        isSelected
          ? 'bg-monitor-accent/10 border-monitor-accent shadow-lg shadow-monitor-accent/10'
          : 'bg-monitor-card border-monitor-border hover:border-slate-500'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-500">#{index}</span>
          <span className={clsx('px-2 py-0.5 text-xs rounded border flex items-center gap-1', statusColors[request.status])}>
            {statusIcons[request.status]}
            {request.status}
          </span>
        </div>
        <span className="text-xs text-slate-500">
          {formatTimestampMs(request.timestamp)}
        </span>
      </div>

      {/* Model */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium text-slate-200">{request.model}</span>
        {request.base_model && request.base_model !== request.model && (
          <span className="text-xs text-slate-400">(using {request.base_model})</span>
        )}
        {request.task_name && (
          <span className="px-2 py-0.5 text-[10px] uppercase tracking-wide rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-200">
            {formatTaskName(request.task_name)}
          </span>
        )}
      </div>

      <div className="mb-3 rounded border border-monitor-border bg-monitor-bg/60 px-2.5 py-2">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Request ID</div>
        <div
          className="mt-1 text-xs font-mono text-slate-300 break-all"
          title={request.request_id}
        >
          {request.request_id}
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 text-xs text-slate-400">
        <div className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          {request.messages.length} msgs
        </div>

        {request.tools && request.tools.length > 0 && (
          <div className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {request.tools.length} tools
          </div>
        )}

        <div className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {formatDuration(request.duration_ms)}
        </div>

        {request.response?.usage && (
          <div className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            {formatTokens(request.response.usage.total_tokens)} tokens
          </div>
        )}

        {request.response?.usage?.cost != null && request.response.usage.cost > 0 && (
          <div className="flex items-center gap-1 text-emerald-400">
            <span>${request.response.usage.cost.toFixed(4)}</span>
          </div>
        )}
      </div>

      {/* Cache Metrics Row */}
      {request.response?.usage && (() => {
        const u = request.response.usage;
        const cacheRead = u.cached_tokens || u.cache_read_input_tokens || 0;
        const cacheWrite = u.cache_creation_input_tokens || u.cache_write_input_tokens || 0;
        if (cacheRead === 0 && cacheWrite === 0) return null;
        const pct = u.prompt_tokens > 0 ? Math.round((cacheRead / u.prompt_tokens) * 100) : 0;
        return (
          <div className="flex items-center gap-3 mt-1.5 text-xs">
            {cacheRead > 0 && (
              <span className="flex items-center gap-1 text-green-400">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {formatTokens(cacheRead)} cached ({pct}%)
              </span>
            )}
            {cacheWrite > 0 && (
              <span className="flex items-center gap-1 text-blue-400">
                {formatTokens(cacheWrite)} written
              </span>
            )}
          </div>
        );
      })()}

      {/* Capabilities Row */}
      {hasCapabilities && (
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {/* Reasoning Effort Badge - Enhanced with model context */}
          {(request.parameters.reasoning_config || request.parameters.reasoning_effort) && (
            <div className="relative group">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/50 border border-slate-700 text-xs font-medium cursor-pointer">
                <SparkleIcon className={clsx('size-3.5', getEffortColor(
                  request.parameters.reasoning_config?.ui_effort || request.parameters.reasoning_effort || 'medium'
                ))} />

                {request.parameters.reasoning_config ? (
                  <>
                    <span className="text-slate-300">
                      {getReasoningDisplayText(request.parameters.reasoning_config).primary}
                    </span>
                    {getReasoningDisplayText(request.parameters.reasoning_config).secondary && (
                      <span className="text-slate-500 text-[10px]">
                        ({getReasoningDisplayText(request.parameters.reasoning_config).secondary})
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-slate-300 capitalize">{request.parameters.reasoning_effort}</span>
                )}
              </div>

              {/* Tooltip - positioned below */}
              {request.parameters.reasoning_config && (
                <div className="absolute top-full left-0 mt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 pointer-events-none">
                  <div className="bg-gray-900 rounded-lg shadow-xl p-3 min-w-[180px] max-w-[280px]">
                    {/* Tooltip arrow */}
                    <div className="absolute bottom-full left-4 border-4 border-transparent border-b-gray-900"></div>
                    <div className="text-[10px] text-gray-500 mb-2 font-medium uppercase tracking-wide">Reasoning Config</div>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between gap-4">
                        <span className="text-slate-400">Family:</span>
                        <span className="text-white">{getModelFamilyDisplayName(request.parameters.reasoning_config.model_family)}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-slate-400">UI Selection:</span>
                        <span className="text-white capitalize">{request.parameters.reasoning_config.ui_effort}</span>
                      </div>
                      {request.parameters.reasoning_config.api_config?.budget_tokens && (
                        <div className="flex justify-between gap-4">
                          <span className="text-slate-400">Budget:</span>
                          <span className="text-white">{request.parameters.reasoning_config.api_config.budget_tokens.toLocaleString()} tokens</span>
                        </div>
                      )}
                      {request.parameters.reasoning_config.api_config?.api_effort && (
                        <div className="flex justify-between gap-4">
                          <span className="text-slate-400">API Effort:</span>
                          <span className="text-white">{request.parameters.reasoning_config.api_config.api_effort}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* MCP Servers Badge with Tooltip */}
          {servers.length > 0 && (
            <div className="relative group">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/50 border border-slate-700 text-xs font-medium cursor-pointer select-none">
                <span className="size-2 rounded-full bg-green-500 flex-shrink-0"></span>
                <span className="text-slate-300">
                  {servers.length} {servers.length === 1 ? 'server' : 'servers'}
                </span>
              </div>

              {/* Tooltip - positioned below */}
              <div className="absolute top-full left-0 mt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 pointer-events-none">
                <div className="bg-gray-900 rounded-lg shadow-xl p-3 min-w-[200px] max-w-[300px]">
                  {/* Tooltip arrow */}
                  <div className="absolute bottom-full left-4 border-4 border-transparent border-b-gray-900"></div>
                  <div className="text-[10px] text-gray-500 mb-2 font-medium uppercase tracking-wide">Active Servers</div>
                  <div className="flex flex-col gap-2">
                    {servers.map((server) => (
                      <div key={server.serverId} className="flex items-center gap-2">
                        <div className="size-4 rounded overflow-hidden bg-gray-700 flex-shrink-0 flex items-center justify-center">
                          <img
                            src={server.iconUrl}
                            alt=""
                            className="size-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                              const parent = (e.target as HTMLImageElement).parentElement;
                              if (parent) {
                                const fallback = parent.querySelector('.fallback');
                                if (fallback) (fallback as HTMLElement).style.display = 'flex';
                              }
                            }}
                          />
                          <span className="fallback hidden size-full items-center justify-center text-[8px] font-medium text-gray-400 uppercase">
                            {server.displayName.charAt(0)}
                          </span>
                        </div>
                        <span className="text-white text-xs truncate flex-1">{server.displayName}</span>
                        {server.isCore && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-gray-600 text-white flex-shrink-0 uppercase font-medium">
                            Core
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Skills Badge with Tooltip */}
          {formattedSkills.length > 0 && (
            <div className="relative group">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/50 border border-slate-700 text-xs font-medium cursor-pointer select-none">
                <SparkleIcon className="size-3.5 text-purple-500" />
                <span className="text-slate-300">
                  {formattedSkills.length} {formattedSkills.length === 1 ? 'skill' : 'skills'}
                </span>
              </div>

              {/* Tooltip - positioned below */}
              <div className="absolute top-full left-0 mt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50 pointer-events-none">
                <div className="bg-gray-900 rounded-lg shadow-xl p-3 min-w-[160px] max-w-[280px]">
                  {/* Tooltip arrow */}
                  <div className="absolute bottom-full left-4 border-4 border-transparent border-b-gray-900"></div>
                  <div className="text-[10px] text-gray-500 mb-2 font-medium uppercase tracking-wide">Active Skills</div>
                  <div className="flex flex-col gap-1.5">
                    {formattedSkills.map((skill) => (
                      <div key={skill.name} className="flex items-center gap-2">
                        <SparkleIcon className="size-4 text-purple-400 flex-shrink-0" />
                        <span className="text-white text-xs truncate">{skill.displayName}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Click hint */}
      {!isSelected && (
        <div className="mt-3 text-xs text-slate-600 text-center">
          Click to inspect payload
        </div>
      )}
    </button>
  );
}
