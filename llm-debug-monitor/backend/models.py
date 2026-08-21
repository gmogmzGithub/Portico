"""Pydantic models for LLM Debug Monitor API"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime


class ActiveTool(BaseModel):
    server_id: str
    display_name: str
    icon_url: str = ""


class ActiveSkill(BaseModel):
    name: str
    display_name: str


class Capabilities(BaseModel):
    tools: List[ActiveTool] = []
    skills: List[ActiveSkill] = []


class ChatSession(BaseModel):
    chat_id: str
    title: Optional[str] = None
    model: Optional[str] = None
    created_at: datetime
    last_activity: datetime
    request_count: int = 0
    capabilities: Optional[Capabilities] = None


class DebugSession(BaseModel):
    session_id: str
    started_at: datetime
    chats: List[ChatSession] = []


class LLMUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class LLMParameters(BaseModel):
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    top_p: Optional[float] = None
    reasoning_effort: Optional[str] = None


class LLMResponse(BaseModel):
    content: str = ""
    tool_calls: List[Dict[str, Any]] = []
    finish_reason: str = ""
    usage: Optional[LLMUsage] = None
    thinking: str = ""


class ToolFunction(BaseModel):
    name: str
    description: str = ""
    parameters: Dict[str, Any] = {}


class LLMTool(BaseModel):
    type: str = "function"
    function: ToolFunction


class Message(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: Any  # Can be string or list of content blocks
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class TransformedPayloadStage(BaseModel):
    event_id: str
    api_path: str
    payload: Dict[str, Any]
    provider_headers_redacted: Optional[Dict[str, str]] = None
    timestamp: Optional[datetime] = None


class LLMRequest(BaseModel):
    request_id: str
    chat_id: str
    session_id: str
    timestamp: datetime
    model: str
    base_model: Optional[str] = None
    message_id: Optional[str] = None
    debug_request_id: Optional[str] = None
    upstream_request_id: Optional[str] = None
    task_name: Optional[str] = None
    request_phase: Optional[str] = None
    followup_index: Optional[int] = None
    outer_message_id: Optional[str] = None
    trigger_message_id: Optional[str] = None
    transcript_anchor_kind: Optional[str] = None
    transcript_anchor_message_id: Optional[str] = None
    transcript_anchor_tool_block_index: Optional[int] = None
    is_auxiliary: bool = False
    messages: List[Message] = []
    tools: List[LLMTool] = []
    parameters: LLMParameters = Field(default_factory=LLMParameters)
    raw_payload: Dict[str, Any] = {}
    transformed_payloads: List[TransformedPayloadStage] = []
    response: Optional[LLMResponse] = None
    status: Literal["pending", "streaming", "complete", "error"] = "pending"
    duration_ms: Optional[int] = None
    usage: Optional[LLMUsage] = None
    tool_ids: List[str] = []
    skills: List[str] = []


class RequestSummary(BaseModel):
    request_id: str
    timestamp: datetime
    chat_id: Optional[str] = None
    message_id: Optional[str] = None
    debug_request_id: Optional[str] = None
    upstream_request_id: Optional[str] = None
    model: str
    base_model: Optional[str] = None
    task_name: Optional[str] = None
    is_auxiliary: bool = False
    request_phase: Optional[str] = None
    followup_index: Optional[int] = None
    outer_message_id: Optional[str] = None
    trigger_message_id: Optional[str] = None
    transcript_anchor_kind: Optional[str] = None
    transcript_anchor_message_id: Optional[str] = None
    transcript_anchor_tool_block_index: Optional[int] = None
    message_count: int
    tool_count: int
    status: str
    duration_ms: Optional[int] = None
    usage: Optional[LLMUsage] = None
    tool_ids: List[str] = []
    skills: List[str] = []


# Event types
class BaseEvent(BaseModel):
    event_id: str
    event_type: str
    timestamp: datetime
    session_id: str
    chat_id: str
    message_id: Optional[str] = None
    debug_request_id: Optional[str] = None
    upstream_request_id: Optional[str] = None
    task_name: Optional[str] = None
    request_phase: Optional[str] = None
    followup_index: Optional[int] = None
    outer_message_id: Optional[str] = None
    trigger_message_id: Optional[str] = None
    transcript_anchor_kind: Optional[str] = None
    transcript_anchor_message_id: Optional[str] = None
    transcript_anchor_tool_block_index: Optional[int] = None
    user_id: Optional[str] = None


class LLMRequestStartData(BaseModel):
    model: str
    message_count: int
    tool_ids: List[str] = []
    skills: List[str] = []
    metadata: Dict[str, Any] = {}


class LLMRequestPayloadData(BaseModel):
    model: str
    messages: List[Dict[str, Any]] = []
    tools: List[Dict[str, Any]] = []
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    reasoning_effort: Optional[str] = None
    raw_payload: Dict[str, Any] = {}


class LLMResponseCompleteData(BaseModel):
    model: str
    usage: LLMUsage
    finish_reason: str
    duration_ms: int
    has_tool_calls: bool = False


class CapabilitiesChangeData(BaseModel):
    tools: List[ActiveTool] = []
    skills: List[ActiveSkill] = []
    change_type: Literal["added", "removed", "initial"] = "initial"


class ErrorData(BaseModel):
    error: str
    stack: Optional[str] = None


# API Response models
class HealthResponse(BaseModel):
    status: str
    service: str


class SessionsResponse(BaseModel):
    sessions: List[DebugSession]


class ChatsResponse(BaseModel):
    chats: List[ChatSession]


class RequestsResponse(BaseModel):
    requests: List[RequestSummary]
    total: int
    offset: int
    limit: int


class RequestDetailResponse(BaseModel):
    request: LLMRequest
