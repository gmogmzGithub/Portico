import { useState, useEffect, useCallback, useMemo } from "react";
import { clsx } from "clsx";
import type { LLMTool } from "@/types/llm";
import {
  cacheBreakpointOriginLabel,
  type CacheBreakpoint,
} from "@/utils/cacheBreakpoints";
import type { ActiveTool } from "@/types/events";
import { buildToolServerGroups } from "./toolGrouping";

interface ToolCallViewerProps {
  tools: LLMTool[];
  activeServers: ActiveTool[];
  requestToolIds?: string[];
  cacheBreakpointsByTool?: Record<number, CacheBreakpoint[]>;
}

// Get a deterministic color for a server based on its ID
function getServerColor(serverId: string): string {
  const colors = [
    "bg-blue-600",
    "bg-green-600",
    "bg-purple-600",
    "bg-amber-600",
    "bg-pink-600",
    "bg-cyan-600",
    "bg-indigo-600",
    "bg-rose-600",
    "bg-teal-600",
    "bg-orange-600",
  ];
  let hash = 0;
  for (let i = 0; i < serverId.length; i++) {
    hash = serverId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// Get first letter for fallback icon
function getServerInitial(displayName: string): string {
  return displayName.charAt(0).toUpperCase();
}

// Acronyms that should be fully capitalized
const ACRONYMS = new Set([
  "vm",
  "mcp",
  "ai",
  "api",
  "url",
  "id",
  "ui",
  "llm",
  "http",
  "ssh",
  "sql",
]);

// Format display name to capitalize acronyms
function formatDisplayName(name: string): string {
  return name
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) {
        return word.toUpperCase();
      }
      return word;
    })
    .join(" ");
}

export function ToolCallViewer({
  tools,
  activeServers,
  requestToolIds = [],
  cacheBreakpointsByTool = {},
  rawPayload,
}: ToolCallViewerProps & { rawPayload?: Record<string, unknown> }) {
  const originBadgeClass = (origin: CacheBreakpoint["origin"]): string => {
    switch (origin) {
      case "explicit":
        return "bg-cyan-950/40 text-cyan-300 border-cyan-700/40";
      case "request-level":
        return "bg-amber-950/40 text-amber-300 border-amber-700/40";
      case "automatic":
        return "bg-emerald-950/40 text-emerald-300 border-emerald-700/40";
    }
  };

  // Detect namespace metadata from the raw request payload
  const namespaceMetadata = useMemo(() => {
    const ns = rawPayload?._tool_namespaces;
    if (ns && typeof ns === "object" && !Array.isArray(ns)) {
      return ns as Record<string, string>;
    }
    return null;
  }, [rawPayload]);

  // Group tools by server (only function-type tools with a function object)
  const serverGroups = useMemo(() => {
    // For LLM debug monitor, prepend OWUI base URL to relative icon URLs
    // In Docker dev mode, OWUI is on 3789; in prod, it's on 8080
    const port = window.location.port;
    const useDevOwui = port === "5176" || port === "5173" || port === "8879";
    const owuiBase = useDevOwui
      ? "http://localhost:3789" // Dev mode: OWUI Vite dev server
      : "http://localhost:8080"; // Prod mode: Direct OWUI

    return buildToolServerGroups({
      tools,
      activeServers,
      requestToolIds,
      rawPayload,
    }).map((group) => ({
      ...group,
      displayName: formatDisplayName(group.displayName),
      iconUrl: group.iconPath.startsWith("/")
        ? `${owuiBase}${group.iconPath}`
        : group.iconPath,
    }));
  }, [tools, activeServers, requestToolIds, rawPayload]);

  // Track expanded state for servers and tools (collapsed by default)
  const [expandedServers, setExpandedServers] = useState<
    Record<string, boolean>
  >(() => {
    const initial: Record<string, boolean> = {};
    serverGroups.forEach((group) => {
      initial[group.serverId] = false;
    });
    return initial;
  });

  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>(
    {},
  );
  const [failedIcons, setFailedIcons] = useState<Set<string>>(new Set());

  const toolIndexByReference = useMemo(() => {
    const indexMap = new Map<LLMTool, number>();
    tools.forEach((tool, index) => {
      indexMap.set(tool, index);
    });
    return indexMap;
  }, [tools]);

  // Reset expanded states when tools change (keep collapsed by default)
  useEffect(() => {
    setExpandedServers((previousStates) => {
      const newServerStates: Record<string, boolean> = {};
      serverGroups.forEach((group) => {
        newServerStates[group.serverId] =
          previousStates[group.serverId] ?? false;
      });
      return newServerStates;
    });
    setExpandedTools({});
  }, [serverGroups]);

  const expandAllServers = useCallback(() => {
    const newStates: Record<string, boolean> = {};
    serverGroups.forEach((group) => {
      newStates[group.serverId] = true;
    });
    setExpandedServers(newStates);
  }, [serverGroups]);

  const collapseAllServers = useCallback(() => {
    const newStates: Record<string, boolean> = {};
    serverGroups.forEach((group) => {
      newStates[group.serverId] = false;
    });
    setExpandedServers(newStates);
    setExpandedTools({});
  }, [serverGroups]);

  const toggleServer = useCallback((serverId: string) => {
    setExpandedServers((prev) => ({ ...prev, [serverId]: !prev[serverId] }));
  }, []);

  const toggleTool = useCallback((toolKey: string) => {
    setExpandedTools((prev) => ({ ...prev, [toolKey]: !prev[toolKey] }));
  }, []);

  const handleIconError = useCallback((serverId: string) => {
    setFailedIcons((prev) => new Set(prev).add(serverId));
  }, []);

  const allServersExpanded = serverGroups.every(
    (g) => expandedServers[g.serverId],
  );
  const allServersCollapsed = serverGroups.every(
    (g) => !expandedServers[g.serverId],
  );

  // Extract short tool name (remove server prefix)
  const getShortToolName = useCallback((toolName: string, serverId: string) => {
    const normalizedPrefix = serverId.replace(/-/g, "_") + "_";
    if (toolName.startsWith(normalizedPrefix)) {
      return toolName.slice(normalizedPrefix.length);
    }
    return toolName;
  }, []);

  if (tools.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <svg
            className="w-12 h-12 mx-auto text-slate-600 mb-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          <p className="text-sm text-slate-500">No tools in this request</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Namespace callout */}
      {namespaceMetadata && Object.keys(namespaceMetadata).length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-900/20 border border-violet-800/30 text-xs text-violet-300">
          <svg
            className="w-4 h-4 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
          <span>
            {tools.length} tools grouped into{" "}
            <span className="text-violet-200 font-medium">
              {Object.keys(namespaceMetadata).length}
            </span>{" "}
            {Object.keys(namespaceMetadata).length === 1
              ? "namespace"
              : "namespaces"}{" "}
            ({Object.keys(namespaceMetadata).join(", ")}) &mdash; tool schemas
            organized by MCP server for the OpenAI Responses API
          </span>
        </div>
      )}

      {/* Header with summary and controls */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-400">
          <span className="text-slate-300 font-medium">{tools.length}</span>{" "}
          tools from{" "}
          <span className="text-slate-300 font-medium">
            {serverGroups.length}
          </span>{" "}
          servers
        </div>

        {/* Expand/Collapse All Buttons */}
        {serverGroups.length > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={expandAllServers}
              disabled={allServersExpanded}
              className={clsx(
                "px-2 py-1 text-xs font-medium rounded border transition-colors",
                allServersExpanded
                  ? "bg-monitor-bg text-slate-600 border-monitor-border cursor-not-allowed"
                  : "bg-monitor-card text-slate-300 border-monitor-border hover:text-white hover:border-slate-500",
              )}
            >
              Expand All
            </button>
            <button
              onClick={collapseAllServers}
              disabled={allServersCollapsed}
              className={clsx(
                "px-2 py-1 text-xs font-medium rounded border transition-colors",
                allServersCollapsed
                  ? "bg-monitor-bg text-slate-600 border-monitor-border cursor-not-allowed"
                  : "bg-monitor-card text-slate-300 border-monitor-border hover:text-white hover:border-slate-500",
              )}
            >
              Collapse All
            </button>
          </div>
        )}
      </div>

      {/* Server Groups */}
      {serverGroups.map((group) => {
        const isServerExpanded = expandedServers[group.serverId] ?? false;
        const serverColor = getServerColor(group.serverId);
        const showFallbackIcon =
          !group.iconUrl || failedIcons.has(group.serverId);

        return (
          <div
            key={group.serverId}
            className="rounded-lg border border-monitor-border bg-monitor-card overflow-hidden"
          >
            {/* Server Header */}
            <button
              onClick={() => toggleServer(group.serverId)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-monitor-bg transition-colors"
            >
              <div className="flex items-center gap-3">
                {/* Server Icon */}
                {showFallbackIcon ? (
                  <div
                    className={clsx(
                      "w-8 h-8 rounded flex items-center justify-center text-white text-sm font-bold flex-shrink-0",
                      serverColor,
                    )}
                  >
                    {getServerInitial(group.displayName)}
                  </div>
                ) : (
                  <img
                    src={group.iconUrl}
                    alt={group.displayName}
                    className="w-8 h-8 rounded object-contain flex-shrink-0"
                    onError={() => handleIconError(group.serverId)}
                  />
                )}
                <div className="flex flex-col items-start">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-200">
                      {group.displayName}
                    </span>
                    <span
                      className={clsx(
                        "px-1.5 py-0.5 text-[10px] font-medium rounded",
                        group.isCore
                          ? "bg-blue-900/50 text-blue-300 border border-blue-700/50"
                          : group.isUserInstalled
                            ? "bg-emerald-900/50 text-emerald-300 border border-emerald-700/50"
                            : "bg-purple-900/50 text-purple-300 border border-purple-700/50",
                      )}
                    >
                      {group.isCore
                        ? "Core"
                        : group.isUserInstalled
                          ? "User"
                          : "System"}
                    </span>
                    {namespaceMetadata &&
                      group.namespaceKey &&
                      namespaceMetadata[group.namespaceKey] !== undefined && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-violet-900/50 text-violet-300 border border-violet-700/50">
                          Namespace
                        </span>
                      )}
                  </div>
                  <span className="text-xs text-slate-500">
                    {group.tools.length} tools
                  </span>
                </div>
              </div>
              <svg
                className={clsx(
                  "w-4 h-4 text-slate-400 transition-transform",
                  isServerExpanded && "rotate-180",
                )}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {/* Tools List */}
            {isServerExpanded && (
              <div className="border-t border-monitor-border">
                {group.tools.map((tool, toolIndex) => {
                  const fn = tool.function!;
                  const shortName = getShortToolName(fn.name, group.serverId);
                  const toolKey = `${group.serverId}:${fn.name}`;
                  const isToolExpanded = expandedTools[toolKey] ?? false;
                  const originalToolIndex = toolIndexByReference.get(tool);
                  const cacheBreakpoints =
                    originalToolIndex != null
                      ? cacheBreakpointsByTool[originalToolIndex] || []
                      : [];

                  return (
                    <div
                      key={toolIndex}
                      className={clsx(
                        "border-monitor-border",
                        toolIndex < group.tools.length - 1 && "border-b",
                      )}
                    >
                      {/* Tool Header */}
                      <button
                        onClick={() => toggleTool(toolKey)}
                        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-monitor-bg/50 transition-colors"
                      >
                        <div className="flex items-center gap-3 pl-11">
                          <svg
                            className="w-4 h-4 text-amber-400 flex-shrink-0"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                            />
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                            />
                          </svg>
                          <span className="text-sm text-slate-300 font-mono">
                            {shortName}
                          </span>
                          {cacheBreakpoints.length > 0 && (
                            <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-cyan-900/50 text-cyan-300 border border-cyan-700/50">
                              <svg
                                className="w-3 h-3"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
                                />
                              </svg>
                              Cache {cacheBreakpoints.length}
                            </span>
                          )}
                        </div>
                        <svg
                          className={clsx(
                            "w-3 h-3 text-slate-500 transition-transform flex-shrink-0",
                            isToolExpanded && "rotate-90",
                          )}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </button>

                      {/* Tool Details */}
                      {isToolExpanded && (
                        <div className="px-4 pb-3 pl-[4.5rem] border-t border-monitor-border/50 pt-3 bg-monitor-bg/30">
                          {cacheBreakpoints.length > 0 && (
                            <div className="mb-3 rounded border border-cyan-800/40 bg-cyan-950/20 p-3">
                              <div className="flex items-center gap-2 mb-2 text-xs text-cyan-300 font-medium">
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
                                  />
                                </svg>
                                Cache Breakpoints
                              </div>
                              <div className="space-y-2">
                                {cacheBreakpoints.map((breakpoint) => (
                                  <div
                                    key={breakpoint.id}
                                    className="rounded border border-cyan-800/30 bg-cyan-950/20 px-2.5 py-2"
                                  >
                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                      <span
                                        className={clsx(
                                          "px-1.5 py-0.5 text-[10px] font-medium rounded border",
                                          originBadgeClass(breakpoint.origin),
                                        )}
                                      >
                                        {cacheBreakpointOriginLabel(
                                          breakpoint.origin,
                                        )}
                                      </span>
                                      <span className="text-[11px] text-cyan-200">
                                        {breakpoint.displayPath}
                                      </span>
                                    </div>
                                    <div className="text-[11px] text-slate-300">
                                      {breakpoint.summary}
                                    </div>
                                    <div className="mt-1 font-mono text-[11px] text-slate-400 break-all">
                                      {breakpoint.jsonPath}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Full Name */}
                          <div className="mb-3">
                            <div className="text-xs font-medium text-slate-500 mb-1">
                              Full Name
                            </div>
                            <code className="text-xs text-slate-400 font-mono">
                              {fn.name}
                            </code>
                          </div>

                          {/* Description */}
                          <div className="mb-3">
                            <div className="text-xs font-medium text-slate-500 mb-1">
                              Description
                            </div>
                            <p className="text-sm text-slate-300">
                              {fn.description}
                            </p>
                          </div>

                          {/* Parameters */}
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-2">
                              Parameters Schema
                            </div>
                            <pre className="p-3 rounded bg-monitor-bg text-xs text-slate-300 overflow-x-auto max-h-48 overflow-y-auto font-mono">
                              {JSON.stringify(fn.parameters, null, 2)}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
