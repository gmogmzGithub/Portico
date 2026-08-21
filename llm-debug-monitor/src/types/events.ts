// Event type definitions for LLM Debug Monitor

export type EventType =
  | 'llm_request_start'
  | 'llm_request_payload'
  | 'llm_request_transformed'
  | 'llm_response_start'
  | 'llm_response_complete'
  | 'capabilities_change'
  | 'error';

export interface BaseEvent {
  event_id: string;
  event_type: EventType;
  timestamp: string;
  session_id: string;
  chat_id: string;
  message_id?: string;
  debug_request_id?: string;
  upstream_request_id?: string;
  task_name?: string;
  request_phase?: string;
  followup_index?: number;
  outer_message_id?: string;
  trigger_message_id?: string;
  transcript_anchor_kind?: 'user_message' | 'assistant_tool_block' | 'background';
  transcript_anchor_message_id?: string;
  transcript_anchor_tool_block_index?: number;
  user_id?: string;
}

export interface LLMRequestStartEvent extends BaseEvent {
  event_type: 'llm_request_start';
  data: {
    model: string;
    base_model?: string;  // Underlying model for custom agents
    message_count: number;
    tool_ids: string[];
    skills: string[];
    metadata: Record<string, unknown>;
  };
}

export interface LLMRequestPayloadEvent extends BaseEvent {
  event_type: 'llm_request_payload';
  data: {
    model: string;
    base_model?: string;  // Underlying model for custom agents
    messages: Message[];
    tools?: ToolDefinition[];
    temperature?: number;
    max_tokens?: number;
    reasoning_effort?: string;
    reasoning_config?: {
      ui_effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
      model_family: string;
      api_config: {
        budget_tokens?: number;
        api_effort?: string;
      } | null;
    };
    raw_payload: Record<string, unknown>;
  };
}

export interface LLMResponseStartEvent extends BaseEvent {
  event_type: 'llm_response_start';
  data: {
    model: string;
  };
}

export interface LLMResponseCompleteEvent extends BaseEvent {
  event_type: 'llm_response_complete';
  data: {
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cached_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_write_input_tokens?: number;
    };
    finish_reason: string;
    duration_ms: number;
    has_tool_calls: boolean;
    response_content?: string;
    tool_calls?: ToolCall[];
    thinking_content?: string;
    ultra_audit?: {
      child_agent_count: number;
      tool_call_count: number;
      child_tool_call_count: number;
      tool_result_count: number;
      continuation_count: number;
      arguments_logged: false;
      results_logged: false;
    };
  };
}

export interface LLMRequestTransformedEvent extends BaseEvent {
  event_type: 'llm_request_transformed';
  data: {
    model: string;
    api_path: string;
    provider_headers_redacted?: Record<string, string>;
    payload: Record<string, unknown>;
  };
}

export interface CapabilitiesChangeEvent extends BaseEvent {
  event_type: 'capabilities_change';
  data: {
    tools: ActiveTool[];
    skills: ActiveSkill[];
    change_type: 'added' | 'removed' | 'initial';
  };
}

export interface ErrorEvent extends BaseEvent {
  event_type: 'error';
  data: {
    error: string;
    stack?: string;
  };
}

export type DebugEvent =
  | LLMRequestStartEvent
  | LLMRequestPayloadEvent
  | LLMRequestTransformedEvent
  | LLMResponseStartEvent
  | LLMResponseCompleteEvent
  | CapabilitiesChangeEvent
  | ErrorEvent;

// Supporting types
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentBlock {
  type: 'text' | 'image_url' | 'thinking';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
  thinking?: string;
  signature?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function' | 'namespace' | 'tool_search';
  function?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  name?: string;
  description?: string;
  defer_loading?: boolean;
  tools?: ToolDefinition[];
}

export interface ActiveTool {
  server_id: string;
  display_name: string;
  icon_url: string;
  is_core?: boolean;
  user_installed?: boolean;
}

export interface ActiveSkill {
  name: string;
  display_name: string;
}

// Session and Chat tracking
export interface ChatSession {
  chat_id: string;
  title?: string;
  model?: string;
  base_model?: string;  // Underlying model for custom agents
  created_at: string;
  last_activity: string;
  request_count: number;
  capabilities?: {
    tools: ActiveTool[];
    skills: ActiveSkill[];
  };
}

export interface DebugSession {
  session_id: string;
  started_at: string;
  chats: ChatSession[];
}
