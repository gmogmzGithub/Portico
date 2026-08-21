# Reasoning Effort Configuration

This document describes the reasoning effort feature that allows users to control how deeply AI models "think" before responding.

## Overview

Different AI model families have different APIs for controlling reasoning/thinking depth:

- **Claude/Bedrock models**: Use `thinking: { type: "enabled", budget_tokens: <number> }`
- **GPT-5+ Responses API**: Use `reasoning: { effort: "<value>", summary: "auto" }`
- **GPT-5.6 Sol Ultra**: Uses OpenAI server-side Multi-agent mode with ordinary reasoning fixed at `max`

### OpenAI Reasoning Summaries

Active GPT models use `summary: "auto"`. GPT-5.6 accepts the ordinary effort family `none`, `low`, `medium`, `high`, `xhigh`, and `max`; the UI exposes the exact subset declared for each catalog entry.

## Requirements

### User-Facing Requirements

1. **Per-Model Reasoning Control**: When multiple models are selected, each model gets its own reasoning effort selector
2. **Model-Specific Options**: Each selector shows only the options available for that specific model
3. **Tooltips**: When multiple models are selected, hovering shows the model name
4. **Default Value**: New chats default to "Low" reasoning effort when supported by the model; otherwise they fall back to the lowest available supported default
5. **Persistence**: Reasoning effort settings persist per-chat via the chat state API

### Model-Specific Options

| Model Family | Available Options | Notes |
|--------------|-------------------|-------|
| Claude Sonnet 5, Claude Opus 5, Claude Opus 4.8 | Low, Medium, High, XHigh, Max | Adaptive reasoning |
| Claude Sonnet 4.6, Claude Haiku 4.5 | Low, Medium, High, Max | Model-specific adaptive/budget mapping |
| GPT-5.5 | Low, Medium, High, Max | Responses API reasoning |
| GPT-5.6 Sol | None, Low, Medium, High, XHigh, Max, Ultra | Ultra enables OpenAI server-side Multi-agent mode |
| GPT-5.6 Sol Pro | None, Low, Medium, High, XHigh, Max | Uses Sol with `reasoning.mode: "pro"` |
| GPT-5.6 Terra, GPT-5.6 Luna | None, Low, Medium, High, XHigh, Max | Responses API reasoning |
| Gemini 3.6 Flash, Gemini 3.5 Flash, Gemini 3.1 Pro Preview, Gemini 3.5 Flash-Lite, Gemini 3.1 Flash-Lite | Low, Medium, High | Gemini thinking controls |

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  MessageInput.svelte                                                     │
│  ├── reasoningEffortByModel: Record<string, string>                     │
│  ├── reasoningCapableModels (computed from model capabilities)          │
│  └── Renders one dropdown per reasoning-capable model                   │
│                                  │                                       │
│                                  ▼                                       │
│  Chat.svelte                                                             │
│  ├── Passes reasoningEffortByModel[model.id] to each API call           │
│  └── Saves to chat state API for persistence                            │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Backend (Bifrost bridge)                              │
├─────────────────────────────────────────────────────────────────────────┤
│  Bifrost bridge                                                     │
│  ├── get_model_family(model) → classifies model                         │
│  ├── Transforms reasoning_effort based on model family:                 │
│  │   ├── Claude → thinking: { type, budget_tokens }                     │
│  │   ├── GPT-5+ → reasoning_effort: { effort, summary }                 │
│  │   └── GPT-4.x/Haiku → removes reasoning_effort entirely              │
│  └── Passes to upstream API                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### Budget Token Values (Claude Models)

Based on Anthropic documentation:
- Minimum: 1,024 tokens
- Recommended starting point: 16k+ for complex tasks
- Above 32k may cause timeouts

| UI Value | Sonnet 4.5 (64K max output) | Opus 4.1 (32K max output) |
|----------|----------------------------|---------------------------|
| Low      | 1,024                      | 1,024                     |
| Medium   | 10,000                     | 10,000                    |
| High     | 32,000                     | 16,000                    |
| Max      | 50,000                     | 28,000                    |

### GPT-5 Effort Mapping

| UI Value | GPT-5.5 | GPT-5.6 Sol | GPT-5.6 Sol Pro | GPT-5.6 Terra/Luna |
|----------|---------|-------------|-----------------|--------------------|
| None     | N/A     | none        | none            | none               |
| Low      | low     | low         | low             | low                |
| Medium   | medium  | medium      | medium          | medium             |
| High     | high    | high        | high            | high               |
| XHigh    | N/A     | xhigh       | xhigh           | xhigh              |
| Max      | xhigh   | max         | max             | max                |
| Ultra    | N/A     | Multi-agent + max | N/A       | N/A                |

## Implementation Details

### Files Modified

#### Backend

**`src/bifrost-bridge-rust/`**
- Added `get_model_family(model: str) -> str` function to classify models
- Added budget token constants:
  ```python
  CLAUDE_SONNET_BUDGET = {'low': 1024, 'medium': 10000, 'high': 32000, 'max': 50000}
  CLAUDE_OPUS_BUDGET = {'low': 1024, 'medium': 10000, 'high': 16000, 'max': 28000}
  GPT5_EFFORT_MAP = {
      'gpt5.1': {'low': 'low', 'medium': 'medium', 'high': 'high', 'max': 'high'},
      'gpt5.2': {'low': 'low', 'medium': 'medium', 'high': 'high', 'max': 'xhigh'},
      'gpt5-mini': {'low': 'low', 'medium': 'medium', 'high': 'high', 'max': 'high'},
  }
  ```
- Transforms `reasoning_effort` in `async_pre_call_hook` based on model family

**`model_catalog.yaml`**
- Removed static `reasoning_config` from Claude models (now dynamic)
- Set `supports_reasoning: False` for GPT-4.x and GPT-5 pro models

#### Frontend Configuration

**`src/scripts/generate-model-config.cjs`**
- Added `getReasoningEffortOptionsForModel(modelName)` function
- Outputs `reasoningEffortOptions` array per model in generated config

**`src/patches/frontend/src/lib/config/model-capabilities.ts`** (auto-generated)
- Added `reasoningEffortOptions` field to `ModelCapability` interface
- Added `getReasoningEffortOptions(modelName)` helper function

#### Frontend Components

**`src/patches/frontend/src/lib/components/chat/MessageInput.svelte`**
- Changed from `reasoningEffort: string` to `reasoningEffortByModel: Record<string, string>`
- Added `reasoningCapableModels` computed property (filters models with reasoning support)
- Renders one dropdown per reasoning-capable model using `{#each}`
- Shows model name in dropdown header when multiple models selected
- Filters options to show only those available for each model

**`src/patches/frontend/src/lib/components/chat/Chat.svelte`**
- Changed from `reasoningEffort` to `reasoningEffortByModel`
- Updated API calls to pass `reasoningEffortByModel[model.id]`
- Updated chat state persistence to use `reasoning_effort_by_model`
- Added migration support for old single-value format

**`src/patches/frontend/src/lib/apis/chatState.ts`**
- Updated interfaces to support both legacy `reasoning_effort` and new `reasoning_effort_by_model`

### State Management

```typescript
// Per-model reasoning effort state
let reasoningEffortByModel: Record<string, string> = {};

// Example state for a chat with 2 models:
// {
//   "model-id-1": "medium",
//   "model-id-2": "high"
// }
```

### Persistence

Reasoning effort is persisted in two places:

1. **localStorage** (`reasoningEffortByModel`): For cross-chat defaults
2. **Chat State API** (`reasoning_effort_by_model`): For per-chat settings

Migration from old format is automatic:
- If `reasoning_effort_by_model` exists, use it
- Else if `reasoning_effort` exists, apply to all selected models
- Else default to 'low' when supported, otherwise 'medium', otherwise the first allowed option

## API Transformations

### Claude/Bedrock Models

Input (from frontend):
```json
{
  "model": "Claude Sonnet 4.5",
  "reasoning_effort": "high"
}
```

Output (to Bedrock API):
```json
{
  "model": "bedrock/converse_like/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "thinking": {
    "type": "enabled",
    "budget_tokens": 32000
  }
}
```

### GPT-5.6 Models

Input (from frontend):
```json
{
  "model": "GPT-5.6 Sol",
  "reasoning_effort": "max"
}
```

Output (to OpenAI Responses API):
```json
{
  "model": "gpt-5.6-sol",
  "reasoning": {
    "effort": "max",
    "summary": "auto"
  }
}
```

Sol Pro uses the same provider model with `reasoning.mode: "pro"`.

### GPT-5.6 Ultra

For GPT-5.6 Sol only, the UI value `ultra` is translated to OpenAI's server-side Multi-agent mode with `reasoning.effort: "max"`. Child output remains private; PORTICO projects only the `/root` final answer and allows only `/root` developer MCP tool requests to execute locally through the authenticated continuation adapter.

## Testing

To test the implementation:

1. **GPT-5.6 Sol**: Verify None through Max plus Ultra appear, and Ultra is absent for Sol Pro, Terra, and Luna
2. **Multiple reasoning models**: Select Claude Sonnet 5 and GPT-5.6 Sol, then verify separate dropdowns and per-model persistence
3. **Sol Pro**: Verify ordinary efforts send Sol plus `reasoning.mode: "pro"`
4. **Ultra privacy**: Verify child text never appears in the chat and only the `/root` final answer is projected
5. **Ultra tools**: Verify a root-issued local MCP call resumes via `previous_response_id` and completes exactly once
6. **API payload**: Check the LLM debug monitor for the model-specific provider controls
