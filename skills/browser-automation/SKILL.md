---
name: browser-automation
description: Browser automation guidance for explicit Chrome DevTools workflows. Use when the user requests browser control, web automation, or browser-only UI interaction.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "1.0"
  priority: medium
  triggers:
    - "browser"
    - "browser-use"
    - "playwright"
    - "web automation"
    - "open browser"
    - "use browser"
required_mcp_servers:
  - "server:chrome-devtools"
---

# Browser Automation Skill

This skill covers deterministic browser automation with Chrome DevTools. Use it when the task requires a real browser session for step-by-step page interaction, DOM inspection, JavaScript evaluation, or screenshots.

## Mandatory Permission Protocol

**ALWAYS ask for explicit user consent before launching or driving a browser unless the user already explicitly requested browser usage.**

### Permission Flow

1. Explain why the browser is needed.
2. Ask for approval.
3. Wait for a clear yes before launching or controlling the browser.

### Exception

If the user explicitly asks you to use a browser, open a page, or automate a web UI, proceed without asking again.

## Browser As Last Resort

### Use Chrome DevTools When

- The task requires interacting with a real web UI
- APIs, CLI tools, or native MCP integrations are not sufficient
- You need DOM state, rendered content, screenshots, or in-page JavaScript
- The user explicitly wants browser automation

### Do Not Use Chrome DevTools When

- An API or CLI already solves the task
- A direct MCP integration exists for the system you need
- A simple HTTP fetch or search result is enough
- The task does not require a rendered browser page

## Setup Requests

If the user asks to set up, install, enable, or configure browser automation or Chrome DevTools, use the `host-mode-setup` skill first. That setup skill can install Host-mode prerequisites and verify Chrome DevTools without requiring Chrome DevTools at activation time.

Do not immediately activate `server:chrome-devtools` for setup requests. Activate Chrome DevTools only after `host-mode-setup` has completed its install, readiness, and verification flow.

## Chrome DevTools Operating Model

Chrome DevTools is lower-level than an autonomous browser agent. Do not treat it like a goal-driven system that figures out the workflow for you. You need to drive the browser explicitly:

1. Navigate to the page you need
2. Inspect page state or DOM structure
3. Click, type, or run JavaScript deliberately
4. Re-check the page after each meaningful action
5. Capture screenshots or extract content when verification matters

Use small, verifiable steps. Confirm page state before moving on.

## Recommended Workflow

1. Confirm the concrete browser-only goal
2. Check for a better non-browser path first
3. Ask permission if browser usage was not explicit
4. Activate `server:chrome-devtools` for the current chat if needed
5. Use the available Chrome DevTools tools to navigate, inspect, click, type, evaluate JS, or capture screenshots
6. Verify the result before reporting success

## Screenshots

When the user needs to see a screenshot in chat, call:

```json
{}
```

with `chrome_devtools_take_screenshot`. Do not pass `filePath` for inline chat display.

Use `filePath` only when the user explicitly asks to save a screenshot as a host-local file. A `filePath` result is a local save path, not the preferred inline display path.

If a screenshot tool result says an inline image was rendered, treat the screenshot as visible in the chat. Reference the visible screenshot or describe what you can verify from it; do not tell the user that the screenshot cannot be displayed.

## Examples

### Good Permission Request

**User**: "I need to check the status of our staging dashboard."

**Correct approach**:
1. Check whether an API, CLI, or internal tool can answer first
2. If not: "I don’t have a direct API for that dashboard. I can use a browser to inspect it. Would you like me to do that?"
3. Wait for approval
4. If approved, activate Chrome DevTools and proceed step by step

### Explicit Browser Request

**User**: "Open the site in a browser and walk through the signup flow."

**Correct approach**:
1. Recognize that browser usage was explicitly requested
2. Activate Chrome DevTools if needed
3. Execute the flow step by step and verify each page state

### Prefer A Better Integration

**User**: "What’s on my calendar today?"

**Correct approach**:
1. Prefer `server:google_workspace`
2. Use calendar tools directly
3. Do not use a browser for data that already has a direct integration

## Activation

If Chrome DevTools is available but not yet attached to this chat:

```json
{
  "chat_id": "your-chat-id",
  "tool_server_ids": ["server:chrome-devtools"]
}
```

Call:

```text
mcp_assistant_activate_integration(...)
```

## Important Reminders

1. Permission first unless browser usage was explicitly requested
2. Browser work should be explicit and stepwise
3. Prefer direct integrations, APIs, and CLI tools whenever possible
4. Verify browser state before claiming success
5. Use screenshots or extracted DOM evidence when the result needs proof
