# Release Notes: Tool Calling Regression Fixes

## Overview

This release fixes regressions that caused active chat tools to behave like prompt-only instructions instead of provider-native function calls, and hardens streaming translation for Bedrock/Anthropic tool-use events.

The failures showed up as agents saying they would call tools but not executing them, GPT-family models claiming they had no tool access, or tool/result text appearing inline instead of being routed through the structured tool-call path.

---

## 1. Active Tools Now Force Native Function Calling

Open WebUI can load active tools dynamically from chat/runtime state even when the incoming request does not explicitly set `function_calling`.

Before this fix, those loaded tools could remain under `function_calling=default`, which routed the chat through Open WebUI's legacy prompt-based tool fallback instead of sending real provider-native tool schemas.

Key changes:

- When `tools_dict` is populated, `metadata["params"]["function_calling"]` is promoted to `"native"`.
- Native OpenAI-compatible tool payloads are attached to `form_data["tools"]` before the legacy fallback selector can run.
- A warning log records the promotion with chat/model/tool-count context for future diagnosis.

Expected behavior:

- GPT/OpenAI-compatible models receive actual function-tool definitions whenever active tools are available.
- The model should no longer say it has no tool access merely because the request omitted an explicit `function_calling=native` parameter.
- Legacy prompt-based tool selection remains available only for requests without active tools or native routing.

---

## 2. Legacy Tool Fallback Post-Processes Successful Results

The non-native fallback executor now post-processes both successful and failed tool executions consistently.

Before this fix, `process_tool_result(...)` only ran on the exception path, so successful results could skip file/embed normalization and leave result metadata uninitialized.

Key changes:

- Initialize `tool_result_files` and `tool_result_embeds` before execution.
- Always run `process_tool_result(...)` after execution, whether the tool succeeded or returned a normalized error.
- Keep event emission behavior consistent for files, embeds, and plain results.

---

## 3. Bedrock Tool-Use Deltas Preserve Anthropic Stream Ordering

The Rust Bedrock/Anthropic stream translator now guarantees that a `tool_use` content block is opened before any tool input delta is emitted.

Before this fix, fine-grained/interleaved tool streaming could produce a tool input delta before a matching `content_block_start`, which breaks downstream consumers expecting Anthropic's ordered stream contract.

Why the translator emits a start event:

- Bifrost is translating Bedrock Converse chunks into an Anthropic-compatible SSE stream; it is not a byte-for-byte pass-through.
- Bedrock sends `contentBlockStart` / `contentBlockDelta` shapes, while downstream clients expect Anthropic `content_block_start` / `content_block_delta` shapes.
- Anthropic clients cannot apply an `input_json_delta` to a block index until the corresponding `tool_use` content block exists.
- The translator already used this defensive pattern for text deltas that arrived before a known text block; tool-use deltas now follow the same invariant-preserving path.
- When a `contentBlockDelta.delta.toolUse` chunk carries `toolUseId`, `name`, and `input` for an unseen block index, the translator has enough metadata to synthesize the equivalent Anthropic `content_block_start` before forwarding the partial JSON input.

This does not replace provider start events when they are present. It repairs delta-first or start-missing streams at the translation boundary so the output protocol remains valid.

Key changes:

- Added a shared `ensure_tool_use_block_start(...)` helper.
- `contentBlockStart.start.toolUse` and `contentBlockDelta.delta.toolUse` now both use the same block-start path.
- If a tool delta arrives first, the translator synthesizes the required `content_block_start` before forwarding the partial JSON delta.

---

## Validation

Targeted coverage was added for:

- Active dynamic tools forcing native provider tool calling.
- Non-native fallback post-processing success and error results.
- Bedrock tool-use deltas emitting a `content_block_start` before partial input JSON.

Validation commands used during development:

- `python3 -m py_compile src/patches/backend/open_webui/utils/middleware.py`
- `uv run --with pytest --with pytest-asyncio pytest -q tests/test_dynamic_tool_loading_regressions.py`
- `cargo test stream_translation_covers_text_tool_reasoning_metadata_and_exceptions --manifest-path src/bifrost-bridge-rust/Cargo.toml`
- `git diff --check`
- `./run-tests.sh`
