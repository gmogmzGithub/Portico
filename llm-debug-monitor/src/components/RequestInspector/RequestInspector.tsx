import { useState, useMemo, useEffect } from "react";
import { clsx } from "clsx";
import type { LLMRequest, LLMTransformedPayloadStage } from "@/types/llm";
import { useSelectedChat, useEventStore } from "@/store/eventStore";
import { PayloadViewer } from "./PayloadViewer";
import { MessageList } from "./MessageList";
import { ToolCallViewer } from "./ToolCallViewer";
import { ResponseViewer } from "./ResponseViewer";
import { CapabilitiesViewer } from "./CapabilitiesViewer";
import {
  buildRequestInspectorBreakpointData,
  cacheBreakpointOriginLabel,
  extractStageCacheBreakpoints,
} from "@/utils/cacheBreakpoints";
import type { CacheBreakpoint } from "@/utils/cacheBreakpoints";
import { formatTokens } from "@/utils/time";

type RawInputViewKind = "pre-bridge" | "bridge" | "provider";

interface PayloadSummary {
  systemCount?: number;
  messageCount?: number;
  inputCount?: number;
}

interface RawInputView {
  id: string;
  label: string;
  kind: RawInputViewKind;
  payload: Record<string, unknown>;
  apiPath?: string;
  providerHeadersRedacted: Record<string, string>;
  summary: PayloadSummary;
  breakpoints: CacheBreakpoint[];
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function summarizePayload(payload: Record<string, unknown>): PayloadSummary {
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    const systemCount = messages.filter(
      (message) => isRecord(message) && message.role === "system",
    ).length;
    return {
      systemCount,
      messageCount: messages.length - systemCount,
    };
  }

  const inputItems = payload.input;
  if (Array.isArray(inputItems)) {
    return { inputCount: inputItems.length };
  }

  return {};
}

function isProviderStage(stage: LLMTransformedPayloadStage): boolean {
  return stage.api_path === "bedrock-converse";
}

function classifyTransformedStage(
  stage: LLMTransformedPayloadStage,
): RawInputViewKind {
  if (isProviderStage(stage)) {
    return "provider";
  }
  return "bridge";
}

function transformedStageLabel(stage: LLMTransformedPayloadStage): string {
  if (isProviderStage(stage)) {
    return "Provider Payload";
  }
  if (stage.api_path === "chat-completions") {
    return "Bifrost Input";
  }
  return "Bridge Payload";
}

function transformedStageSortOrder(
  stage: LLMTransformedPayloadStage,
): number {
  const kind = classifyTransformedStage(stage);
  if (kind === "provider") {
    return 0;
  }
  if (kind === "bridge") {
    return 1;
  }
  return 2;
}

function describeAtlasPayloadView(kind: RawInputViewKind): string {
  switch (kind) {
    case "pre-bridge":
      return "This is the original Open WebUI request before the Rust bridge reorders Atlas system messages for caching.";
    case "bridge":
      return "This is the Atlas payload the Rust bridge sent into external Bifrost, with separate system messages still preserved.";
    case "provider":
      return "This is the actual upstream provider request Bifrost sent to Bedrock Converse after all bridge and provider translation.";
  }
}

function buildRawInputViews(request: LLMRequest): RawInputView[] {
  const transformedStages = request.transformed_payloads ?? [];
  const isAtlas = request.model.toLowerCase().includes("atlas");
  const latestBridgeStage =
    [...transformedStages]
      .reverse()
      .find((candidate) => candidate.api_path === "chat-completions") ?? null;

  const transformedViews = [...transformedStages]
    .sort(
      (left, right) =>
        transformedStageSortOrder(left) - transformedStageSortOrder(right),
    )
    .map((stage) => {
      const kind = classifyTransformedStage(stage);
      return {
        id: `stage:${stage.api_path}:${stage.event_id}`,
        label: transformedStageLabel(stage),
        kind,
        payload: stage.payload,
        apiPath: stage.api_path,
        providerHeadersRedacted: stage.provider_headers_redacted ?? {},
        summary: summarizePayload(stage.payload),
        breakpoints: extractStageCacheBreakpoints(stage, {
          bridgeStage: kind === "provider" ? latestBridgeStage : null,
        }),
        note: isAtlas ? describeAtlasPayloadView(kind) : undefined,
      };
    });

  return [
    ...transformedViews,
    {
      id: "pre-bridge",
      label: "Pre-Bridge",
      kind: "pre-bridge",
      payload: request.raw_payload,
      providerHeadersRedacted: {},
      summary: summarizePayload(request.raw_payload),
      breakpoints: extractStageCacheBreakpoints({
        payload: request.raw_payload,
      }),
      note: isAtlas ? describeAtlasPayloadView("pre-bridge") : undefined,
    },
  ];
}

interface ProviderHeadersPanelProps {
  headers: Record<string, string>;
}

function ProviderHeadersPanel({ headers }: ProviderHeadersPanelProps) {
  const entries = useMemo(
    () =>
      Object.entries(headers).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    [headers],
  );

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-monitor-border bg-monitor-bg">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-monitor-border bg-monitor-card">
        <span className="text-xs font-medium text-slate-300">
          Provider Headers
        </span>
        <span className="px-1.5 py-0.5 rounded bg-monitor-bg text-[10px] text-slate-400 border border-monitor-border">
          {entries.length}
        </span>
        <span className="px-1.5 py-0.5 rounded text-[10px] border bg-emerald-950/30 text-emerald-300 border-emerald-700/40">
          Redacted
        </span>
      </div>
      <div className="bg-monitor-bg font-mono text-xs">
        {entries.map(([name, value], index) => (
          <div
            key={name}
            className={clsx(
              "grid grid-cols-[minmax(0,220px)_1fr] gap-3 px-3 py-2",
              index < entries.length - 1 && "border-b border-monitor-border",
            )}
          >
            <div className="text-cyan-300 break-all">{name}</div>
            <div className="text-slate-300 break-all whitespace-pre-wrap">
              {value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CacheBreakpointPanel({
  breakpoints,
}: {
  breakpoints: CacheBreakpoint[];
}) {
  const originBadgeClass = (origin: CacheBreakpoint["origin"]): string => {
    switch (origin) {
      case "explicit":
        return "bg-cyan-950/30 text-cyan-300 border-cyan-700/40";
      case "request-level":
        return "bg-amber-950/30 text-amber-300 border-amber-700/40";
      case "automatic":
        return "bg-emerald-950/30 text-emerald-300 border-emerald-700/40";
    }
  };

  const groupedBreakpoints = useMemo(() => {
    const orderedScopes: Array<CacheBreakpoint["scope"]> = [
      "tool",
      "system",
      "message",
      "request",
    ];
    return orderedScopes
      .map((scope) => ({
        scope,
        items: breakpoints.filter((breakpoint) => breakpoint.scope === scope),
      }))
      .filter((group) => group.items.length > 0);
  }, [breakpoints]);

  if (groupedBreakpoints.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-monitor-border bg-monitor-bg">
      <div className="px-3 py-2 border-b border-monitor-border bg-monitor-card">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-slate-300">
            Cache Breakpoints
          </span>
          <span className="px-1.5 py-0.5 rounded bg-monitor-bg text-[10px] text-slate-400 border border-monitor-border">
            {breakpoints.length}
          </span>
        </div>
      </div>
      <div className="p-3 space-y-3">
        {groupedBreakpoints.map((group) => (
          <div key={group.scope} className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {group.scope === "tool"
                ? "Tools"
                : group.scope === "system"
                  ? "System"
                  : group.scope === "message"
                    ? "Conversation"
                    : "Request"}
            </div>
            <div className="space-y-2">
              {group.items.map((breakpoint) => (
                <div
                  key={breakpoint.id}
                  className="rounded border border-monitor-border bg-monitor-card px-3 py-2"
                >
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span
                      className={clsx(
                        "px-1.5 py-0.5 rounded text-[10px] font-medium border",
                        originBadgeClass(breakpoint.origin),
                      )}
                    >
                      {cacheBreakpointOriginLabel(breakpoint.origin)}
                    </span>
                    <span className="text-xs text-slate-200">
                      {breakpoint.displayPath}
                    </span>
                  </div>
                  <div className="text-xs text-slate-300">
                    {breakpoint.summary}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-slate-400 break-all">
                    {breakpoint.jsonPath}
                  </div>
                  {breakpoint.targetPath && (
                    <div className="mt-1 font-mono text-[11px] text-slate-500 break-all">
                      target: {breakpoint.targetPath}
                    </div>
                  )}
                  {breakpoint.preview && (
                    <div className="mt-1 text-[11px] text-slate-400 whitespace-pre-wrap break-words">
                      {breakpoint.preview}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RawInputPanel({ request }: { request: LLMRequest }) {
  const rawInputViews = useMemo(
    () => buildRawInputViews(request),
    [request.model, request.raw_payload, request.transformed_payloads],
  );
  const defaultViewId = rawInputViews[0]?.id ?? "pre-bridge";
  const [viewId, setViewId] = useState(defaultViewId);
  const activeView =
    rawInputViews.find((candidate) => candidate.id === viewId) ??
    rawInputViews[0];
  const providerHeaders = activeView?.providerHeadersRedacted ?? {};
  const hasProviderHeaders = Object.keys(providerHeaders).length > 0;

  useEffect(() => {
    setViewId(defaultViewId);
  }, [request.request_id, defaultViewId]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 flex-wrap p-2 border-b border-monitor-border bg-monitor-bg">
        <span className="text-xs text-slate-500">View:</span>
        <div className="flex rounded-lg overflow-hidden border border-monitor-border">
          {rawInputViews.map((view) => (
            <button
              key={view.id}
              onClick={() => setViewId(view.id)}
              className={clsx(
                "px-3 py-1 text-xs font-medium transition-colors",
                viewId === view.id
                  ? "bg-monitor-accent text-white"
                  : "bg-monitor-card text-slate-400 hover:text-white",
              )}
            >
              {view.label}
            </button>
          ))}
        </div>
        {activeView?.apiPath && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-900/50 text-violet-300 border border-violet-700/50">
            {activeView.apiPath}
          </span>
        )}
        {activeView?.summary.systemCount !== undefined && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-monitor-card text-slate-300 border border-monitor-border">
            System {activeView.summary.systemCount}
          </span>
        )}
        {activeView?.summary.messageCount !== undefined && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-monitor-card text-slate-300 border border-monitor-border">
            Messages {activeView.summary.messageCount}
          </span>
        )}
        {activeView?.summary.inputCount !== undefined && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-monitor-card text-slate-300 border border-monitor-border">
            Input {activeView.summary.inputCount}
          </span>
        )}
        {activeView?.breakpoints.length ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950/40 text-cyan-300 border border-cyan-700/40">
            Cache {activeView.breakpoints.length}
          </span>
        ) : null}
      </div>
      {activeView?.kind !== "pre-bridge" && hasProviderHeaders && (
        <ProviderHeadersPanel headers={providerHeaders} />
      )}
      <CacheBreakpointPanel breakpoints={activeView?.breakpoints ?? []} />
      <div className="flex-1">
        <PayloadViewer
          payload={activeView?.payload ?? {}}
          modelName={request.model}
          note={activeView?.note}
        />
      </div>
    </div>
  );
}

interface RequestInspectorProps {
  request: LLMRequest;
}

type Tab =
  | "capabilities"
  | "system"
  | "messages"
  | "tools"
  | "response"
  | "raw-input"
  | "raw-output";

export function RequestInspector({ request }: RequestInspectorProps) {
  const [activeTab, setActiveTab] = useState<Tab>("messages");
  const selectedChat = useSelectedChat();

  // Use global store for tool call selection
  const selectedToolCallId = useEventStore((state) => state.selectedToolCallId);
  const toggleToolCallSelection = useEventStore(
    (state) => state.toggleToolCallSelection,
  );
  const clearToolCallSelection = useEventStore((state) => state.selectToolCall);

  // Clear selection on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearToolCallSelection(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clearToolCallSelection]);

  const breakpointData = useMemo(
    () => buildRequestInspectorBreakpointData(request),
    [request.messages, request.tools, request.transformed_payloads],
  );

  const displayMessages = breakpointData.displayMessages;
  const displayTools = breakpointData.displayTools;

  const systemMessages = useMemo(
    () => displayMessages.filter((message) => message.role === "system"),
    [displayMessages],
  );
  const nonSystemMessages = useMemo(
    () => displayMessages.filter((message) => message.role !== "system"),
    [displayMessages],
  );

  // Build raw output payload from response
  const rawOutputPayload = useMemo(() => {
    if (!request.response) return null;
    return {
      content: request.response.content,
      thinking: request.response.thinking,
      tool_calls: request.response.tool_calls,
      finish_reason: request.response.finish_reason,
      usage: request.response.usage,
    };
  }, [request.response]);

  // Count capabilities for the tab badge
  const capabilitiesCount =
    (request.tool_ids?.length || 0) + (request.skills?.length || 0);

  const leftTabs: {
    id: Tab;
    label: string;
    count?: number;
    highlight?: boolean;
  }[] = [
    { id: "capabilities", label: "Capabilities", count: capabilitiesCount },
    { id: "system", label: "Request System", count: systemMessages.length },
    {
      id: "messages",
      label: "Request Messages",
      count: nonSystemMessages.length,
    },
    { id: "tools", label: "Tools", count: displayTools.length || 0 },
    {
      id: "response",
      label: "Response",
      highlight: !!request.response?.content,
    },
  ];

  const rightTabs: { id: Tab; label: string }[] = [
    { id: "raw-input", label: "Raw Input" },
    { id: "raw-output", label: "Raw Output" },
  ];

  const renderTab = (tab: {
    id: Tab;
    label: string;
    count?: number;
    highlight?: boolean;
  }) => (
    <button
      key={tab.id}
      onClick={() => setActiveTab(tab.id)}
      className={clsx(
        "px-4 py-2 text-sm font-medium transition-colors border-b-2",
        activeTab === tab.id
          ? "text-monitor-accent border-monitor-accent"
          : tab.highlight
            ? "text-green-400 border-transparent hover:text-green-300"
            : "text-slate-400 border-transparent hover:text-slate-300",
      )}
    >
      {tab.label}
      {tab.count !== undefined && (
        <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-monitor-bg rounded">
          {tab.count}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tabs */}
      <div className="flex justify-between border-b border-monitor-border bg-monitor-card">
        <div className="flex">{leftTabs.map(renderTab)}</div>
        <div className="flex">{rightTabs.map(renderTab)}</div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "capabilities" && (
          <CapabilitiesViewer
            toolIds={request.tool_ids || []}
            skills={request.skills || []}
            activeServers={selectedChat?.capabilities?.tools || []}
          />
        )}
        {activeTab === "system" && (
          <MessageList
            messages={systemMessages}
            defaultExpandFirstOnly
            selectedToolCallId={selectedToolCallId}
            onToolCallSelect={toggleToolCallSelection}
            modelName={request.model}
            cacheBreakpointsByMessage={breakpointData.systemByMessageIndex}
          />
        )}
        {activeTab === "messages" && (
          <MessageList
            messages={nonSystemMessages}
            selectedToolCallId={selectedToolCallId}
            onToolCallSelect={toggleToolCallSelection}
            modelName={request.model}
            cacheBreakpointsByMessage={breakpointData.conversationByMessageIndex}
          />
        )}
        {activeTab === "tools" && (
          <ToolCallViewer
            tools={displayTools || []}
            activeServers={selectedChat?.capabilities?.tools || []}
            requestToolIds={request.tool_ids || []}
            rawPayload={request.raw_payload}
            cacheBreakpointsByTool={breakpointData.toolsByIndex}
          />
        )}
        {activeTab === "response" && (
          <ResponseViewer
            response={request.response}
            selectedToolCallId={selectedToolCallId}
            onToolCallSelect={toggleToolCallSelection}
          />
        )}
        {activeTab === "raw-input" && <RawInputPanel request={request} />}
        {activeTab === "raw-output" && (
          <PayloadViewer payload={rawOutputPayload || {}} />
        )}
      </div>

      {/* Request Summary Footer */}
      <div className="p-3 border-t border-monitor-border bg-monitor-card text-xs text-slate-400">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span>
              Model: <span className="text-slate-300">{request.model}</span>
              {request.base_model && request.base_model !== request.model && (
                <span className="text-slate-500">
                  {" "}
                  (base: {request.base_model})
                </span>
              )}
            </span>
          </div>
          {request.response?.usage &&
            (() => {
              const u = request.response.usage;
              const cacheRead =
                u.cached_tokens || u.cache_read_input_tokens || 0;
              const cacheWrite =
                u.cache_creation_input_tokens ||
                u.cache_write_input_tokens ||
                0;
              const pct =
                u.prompt_tokens > 0
                  ? Math.round((cacheRead / u.prompt_tokens) * 100)
                  : 0;
              return (
                <div className="flex items-center gap-3 flex-wrap">
                  <span>
                    Prompt:{" "}
                    <span className="text-slate-300">
                      {formatTokens(u.prompt_tokens)}
                    </span>
                  </span>
                  <span>
                    Completion:{" "}
                    <span className="text-slate-300">
                      {formatTokens(u.completion_tokens)}
                    </span>
                  </span>
                  <span>
                    Total:{" "}
                    <span className="text-slate-300">
                      {formatTokens(u.total_tokens)}
                    </span>
                  </span>
                  {(cacheRead > 0 || cacheWrite > 0) && (
                    <span>
                      Cache:{" "}
                      {cacheRead > 0 && (
                        <span className="text-green-400">
                          {formatTokens(cacheRead)} read ({pct}%)
                        </span>
                      )}
                      {cacheRead > 0 && cacheWrite > 0 && " / "}
                      {cacheWrite > 0 && (
                        <span className="text-blue-400">
                          {formatTokens(cacheWrite)} write
                        </span>
                      )}
                    </span>
                  )}
                  {u.cost != null && u.cost > 0 && (
                    <span>
                      Cost:{" "}
                      <span className="text-emerald-400">
                        ${u.cost.toFixed(4)}
                      </span>
                    </span>
                  )}
                </div>
              );
            })()}
        </div>
      </div>
    </div>
  );
}
