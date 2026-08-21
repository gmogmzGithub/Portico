---
name: host-mode-setup
description: Guided macOS setup for opt-in Host-mode dependencies and Chrome DevTools MCP verification. Use when users need help installing host mode, fixing Missing Setup for Chrome DevTools, or enabling browser automation.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "1.0"
  priority: high
  triggers:
    - "host mode"
    - "host-mode"
    - "chrome devtools missing setup"
    - "chrome devtools failed"
    - "install host mode"
    - "browser automation setup"
    - "set up browser automation"
    - "setup browser automation"
    - "enable browser automation"
    - "configure browser automation"
    - "install browser automation"
---

# Host Mode Setup

This skill guides a macOS user through installing the opt-in Host-mode prerequisites, then enables and verifies the Chrome DevTools MCP server.

Do not require or activate `server:chrome-devtools` at skill activation time. This skill exists to make Chrome DevTools usable, so use only core tools until Chrome DevTools is confirmed `tool_ready`.

## Visual Guidance

Show the user the relevant setup images inline as you guide each step. Load all images in one `skills_get_skill_assets` call using the current chat ID and this `asset_paths` list, then include each returned URL-based `markdown_image` in your response:

1. `assets/01-open-spotlight.png` - press Command + Space to open Spotlight.
2. `assets/02-open-terminal.png` - search for and open Terminal.
3. `assets/03-paste-installer-command.png` - paste the installer command into Terminal.
4. `assets/04-sudo-password.png` - enter the Mac login password if prompted.
5. `assets/05-allow-remote-debugging.png` - Chrome's remote debugging permission dialog.

These are the only bundled visual assets for this skill. Show the first four images during Terminal setup. Keep the fifth image for the Chrome DevTools verification step, and show it before calling the Chrome DevTools navigation tool.

## User-Facing Installer Step

Ask the user to open Terminal and run exactly:

```bash
curl -fsSL "https://dl.artifacts.example.invalid/9QfcUgUjk84aWuon/portico/raw/names/install-host-mode-deps/versions/1.0.1/install-host-mode-deps.sh?t=$(date +%s)" | bash
```

Tell them:

- If macOS asks for a password, type the password they use to log in to their Mac. The cursor may not move while typing.
- They do not need to restart the whole app.
- When Terminal says setup is complete, return to chat and say `Setup complete`.

Then wait for the user to confirm setup completion before changing integrations.

## Post-Install Automation

After the user confirms `Setup complete`:

1. Call `mcp_assistant_toggle_integration` with `server_id="chrome-devtools"` and `enabled=true`.
2. Check readiness with `mcp_assistant_list_mcp_servers` or the available readiness metadata.
3. If Chrome DevTools is not `tool_ready`, call `mcp_assistant_restart_mcp_server` with `server_id="chrome-devtools"`.
4. Check readiness again.
5. If it still is not ready, call `mcp_assistant_get_mcp_server_logs` with `server_id="chrome-devtools"` and `lines=200`, then explain the specific log error and the next action.
6. When ready, call `mcp_assistant_activate_integration` with the current `chat_id` and `tool_server_ids=["server:chrome-devtools"]`.
7. Before calling the Chrome DevTools navigation tool, warn the user that Chrome may show an `Allow remote debugging?` dialog. Include the returned `markdown_image` for `assets/05-allow-remote-debugging.png`, tell the user to click `Allow`, and only then continue.
8. Only after showing that warning and dialog image, use the newly available Chrome DevTools tools to open `https://example.com`.
9. Verify the browser reached Example Domain by checking the page title or rendered page content.

## Success Response

When verification succeeds, tell the user Chrome DevTools is installed, enabled, and verified. Include that they can now ask for browser automation in this chat.

## Failure Handling

If logs say Node.js is missing or too old, tell the user to rerun the installer command from this skill. The app should pick up the installed Host-mode sentinel after MCP restart; do not instruct them to restart the entire app.

If logs mention npm double-loading `.npmrc`, tell the user the app build is missing the host npm config fix and needs an app update.

If readiness remains `disabled`, toggle Chrome DevTools on again before restarting it.

If readiness remains `missing_setup`, ask the user whether the Terminal command completed successfully and inspect Chrome DevTools logs before suggesting another installer run.
