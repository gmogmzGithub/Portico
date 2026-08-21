// LLM request/response types

// Model family for reasoning configuration
export type ModelFamily =
  | 'atlas-sonnet'
  | 'atlas-opus'
  | 'atlas-opus-4.6'
  | 'atlas-opus-4.7'
  | 'atlas-opus-4.8'
  | 'atlas-opus-5'
  | 'atlas-haiku'
  | 'gpt5.2'
  | 'gpt5.1'
  | 'gpt5.4-pro'
  | 'gpt5.6-sol'
  | 'gpt5.6-sol-pro'
  | 'gpt5.6-terra'
  | 'gpt5.6-luna'
  | 'gpt5-mini'
  | 'gpt5-pro'
  | 'no-reasoning';

// Rich reasoning configuration from backend
export interface ReasoningConfig {
  // User-selected value from UI
  ui_effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  // Model family classification
  model_family: ModelFamily;
  // What was actually sent to the API (model-specific)
  api_config: {
    // For Atlas models - budget tokens
    budget_tokens?: number;
    // For GPT-5 models - actual API effort value
    api_effort?: string;
  } | null;
}

export interface LLMTransformedPayloadStage {
  event_id: string;
  api_path: string;
  payload: Record<string, unknown>;
  provider_headers_redacted?: Record<string, string>;
  timestamp?: string;
}

export interface LLMRequest {
  request_id: string;
  chat_id: string;
  session_id: string;
  timestamp: string;
  model: string;
  base_model?: string;  // Underlying model for custom agents
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
  is_auxiliary?: boolean;
  messages: LLMMessage[];
  tools?: LLMTool[];
  parameters: LLMParameters;
  raw_payload: Record<string, unknown>;
  transformed_payloads?: LLMTransformedPayloadStage[];
  response?: LLMResponse;
  duration_ms?: number;
  status: 'pending' | 'streaming' | 'complete' | 'error';
  // Per-request capabilities
  tool_ids?: string[];
  skills?: string[];
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentBlock[];
  name?: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  thinking_blocks?: LLMThinkingBlock[];
}

export interface LLMContentBlock {
  type: 'text' | 'image_url' | 'thinking';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
  thinking?: string;
}

export interface LLMThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMTool {
  type: 'function' | 'namespace' | 'tool_search';
  function?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  name?: string;
  description?: string;
  defer_loading?: boolean;
  tools?: LLMTool[];
}

export interface LLMParameters {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';  // For backwards compat
  reasoning_config?: ReasoningConfig;  // Rich config with model-specific details
  stream?: boolean;
}

export interface LLMResponse {
  content: string;
  tool_calls?: LLMToolCall[];
  finish_reason: string;
  usage: LLMUsage;
  thinking?: string;
  ultra_audit?: {
    child_agent_count: number;
    tool_call_count: number;
    child_tool_call_count: number;
    tool_result_count: number;
    continuation_count: number;
    arguments_logged: false;
    results_logged: false;
  };
}

export interface LLMUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_write_input_tokens?: number;
  cost?: number;
}

// Formatted view types
export interface FormattedMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  contentBlocks?: LLMContentBlock[];
  toolCalls?: LLMToolCall[];
  thinking?: string;
  timestamp?: string;
  isCollapsed?: boolean;
}

export interface RequestSummary {
  request_id: string;
  timestamp: string;
  chat_id?: string;
  message_id?: string;
  debug_request_id?: string;
  upstream_request_id?: string;
  model: string;
  base_model?: string;
  task_name?: string;
  is_auxiliary?: boolean;
  request_phase?: string;
  followup_index?: number;
  outer_message_id?: string;
  trigger_message_id?: string;
  transcript_anchor_kind?: 'user_message' | 'assistant_tool_block' | 'background';
  transcript_anchor_message_id?: string;
  transcript_anchor_tool_block_index?: number;
  message_count: number;
  tool_count: number;
  status: 'pending' | 'streaming' | 'complete' | 'error';
  duration_ms?: number;
  usage?: LLMUsage;
  tool_ids?: string[];
  skills?: string[];
}
