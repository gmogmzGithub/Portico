---
name: lm-studio-setup
display_name: LM Studio Setup
description: Guided setup for LM Studio local models, OpenAI-compatible local server registration, and a text-only local-model smoke test.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "1.0"
  priority: high
  triggers:
    - "lm studio"
    - "local models"
    - "local model setup"
    - "install lm studio"
    - "configure lm studio"
---

# LM Studio Setup

This skill guides a user through installing LM Studio, downloading or loading a local chat model, enabling LM Studio's OpenAI-compatible local server, wiring the provider into Open WebUI, and smoke-testing one local model through Subagents.

Do not require any local model at skill activation time. The skill exists to make local models usable, so use only core tools until LM Studio is configured and a local model is discovered.

## Visual Guidance

Show the relevant setup images inline as you guide each step. Load all images in one `skills_get_skill_assets` call using the current chat ID and this `asset_paths` list, then include each returned URL-based `markdown_image` in your response:

1. `assets/01-download-lm-studio.png` - Download LM Studio from the official site.
2. `assets/02-install-lm-studio.png` - Drag LM Studio into Applications.
3. `assets/03-open-downloaded-app.png` - Open the downloaded app.
4. `assets/04-lm-studio-welcome.png` - Click through the welcome screen.
5. `assets/05-download-first-model.png` - Download the first local chat model.
6. `assets/06-model-download-progress.png` - Wait for the model download to progress.
7. `assets/07-model-download-complete.png` - Confirm the model download completed.
8. `assets/08-enable-local-service-login.png` - Enable the local LLM service on login if desired.
9. `assets/09-open-developer-panel.png` - Open the Developer panel.
10. `assets/10-start-local-server.png` - Start the local server.

Initial response contract:

- In the first response after this skill activates, call only `skills_get_skill_assets`, show the visual guide, and give the user the manual steps.
- Do not call `skills_ask_user_question` in the same response that first shows these images.
- End the first response by telling the user to reply when they have reached Step 10 and started the local server.
- Only call `skills_ask_user_question` after a later user message explicitly indicates they reached Step 10, started the server, are ready to continue, or wants help checking the server.

## Manual Setup Flow

1. Guide the user to download LM Studio from the official LM Studio site and install it.
2. Ask the user to open LM Studio and complete the welcome flow.
3. If LM Studio recommends a first model, let the user download it. If LM Studio does not recommend one, do not name hardcoded model examples during the manual walkthrough. Tell the user to skip model download for now or continue to the Developer panel; after the server is reachable, use system information and current-source lookup before recommending any specific model.
4. Ask the user to open Advanced settings, enable the local LLM service on login if they want it, then continue to the Developer panel.
5. Ask the user to start the local server. The default user-facing server is `http://127.0.0.1:1234`; from Docker this app reaches it as `http://host.docker.internal:1234`.
6. Stop after the manual instructions. Wait for the user's next message before any automation or modal question.

## Model Recommendation Policy

Never recommend stale or hardcoded model examples from memory.

Do not mention specific model names such as Llama 3.2, Gemma 2, or any baked-in fallback examples unless that model is already present in LM Studio's live `GET /api/v1/models` output or was verified during the current setup turn using current sources.

When no usable model is installed, first use `subagents_get_system_information`, then search current sources including `https://lmstudio.ai/models`. Recommend 2-3 current chat/instruct models sized for the user's machine, include the practical reason for each recommendation such as size, quantization, memory fit, and context support, and ask before starting a large download.

During the initial visual walkthrough, prefer wording like "skip model download for now; I can recommend a current model after checking your machine and the current LM Studio catalog" instead of naming examples.

## Security Boundaries

Keep LM Studio local. Only use `http://127.0.0.1:<port>` for the user-facing local server and `http://host.docker.internal:<port>` from Docker or Agent VM.

Never suggest `ngrok`, Cloudflare Tunnel, localtunnel, Serveo, public reverse proxies, port forwarding, public DNS, or asking an admin to add a user-created public tunnel URL for LM Studio.

If the current app build cannot connect safely, tell the user to use the new LM Studio setup build or a company-approved/admin-managed connection path. Do not offer a public tunnel workaround.

If the user asks about exposing LM Studio publicly, briefly explain that it can expose prompts, responses, local APIs, and confidential work data through third-party infrastructure, then return to the local setup flow.

## Server Confirmation Flow

After the user explicitly says they reached Step 10, started the server, are ready to continue, or wants help checking the server, do not open a question modal first.

First run `agent_vm_execute_skill_script` for `scripts/lmstudio_setup.py` with the `probe` command against `http://host.docker.internal:1234`. The script calls native `GET /api/v1/models` and returns structured JSON with `reachable=true` or `reachable=false`.

If the default probe returns `reachable=true`, do not ask the user for confirmation. Continue directly to the automation flow using port `1234`.

Only if the default probe returns `reachable=false`, tell the user that the app could not reach LM Studio at `http://127.0.0.1:1234`, include the short probe error, and then call `skills_ask_user_question` to ask whether LM Studio is on a different port or not started yet. If the user provides a different port, run the same `probe` command against `http://host.docker.internal:<port>` before continuing.

Do not infer readiness just because the skill was activated. The setup is manual until the user confirms they have had time to follow the guide.

## Automation Flow

Once the server confirmation flow has a successful script probe, switch from manual guidance to automation:

1. Determine the working port from the successful probe. Default to `1234` when the default probe succeeds.
2. Call `subagents_get_system_information` before making context-window decisions. Use OS, CPU, memory, and GPU information to judge whether full context is reasonable. Default to LM Studio's live `max_context_length`; choose a lower explicit `--context-length` only if the system information indicates likely memory pressure or the model load retry ladder proves the maximum is not viable.
3. Run `agent_vm_execute_skill_script` for `scripts/lmstudio_setup.py` with the `inspect` command against `http://host.docker.internal:<port>`. The script calls native `GET /api/v1/models`, filters embeddings and rerankers, reports downloaded and loaded chat-capable LLMs, and chooses a best candidate.
4. If `inspect` returns a loaded chat model whose `loaded_context_length` is lower than `max_context_length`, do not continue directly to app wiring. Run `agent_vm_execute_skill_script` with the `load` command for that model. The script unloads the existing LM Studio instance, then reloads it with LM Studio's live max context when possible.
5. If `inspect` returns downloaded chat models but none are loaded, run `agent_vm_execute_skill_script` with the `load` command. The script calls `POST /api/v1/models/load` with `model`, `context_length`, `echo_load_config=true`, `flash_attention=true`, and `offload_kv_cache_to_gpu=true`, preferring LM Studio's live `max_context_length` and retrying smaller safe context lengths if needed.
6. If no usable model is installed, follow the Model Recommendation Policy: use the already-collected `subagents_get_system_information` result, then use web search against current sources, including `https://lmstudio.ai/models`, to recommend 2-3 current chat/instruct models sized for the user's machine. Ask before starting a large download.
7. If the user approves a download, run `agent_vm_execute_skill_script` with `download`, then poll with `download-status`. The script uses `POST /api/v1/models/download` and `GET /api/v1/models/download/status/:job_id`. After completion, run `load`.
8. After any load or reload, rerun `inspect` and verify the chosen model's `loaded_context_length` is the attempted context length. If it had to fall back below `max_context_length`, explain the fallback briefly before continuing.
9. Call `subagents_get_lm_studio_status` with the working port to verify the native/API inspection and the app-side probe agree that LM Studio is reachable.
10. Call `subagents_configure_lm_studio` with the working port. This persists `lm-studio.json` in Application Support, registers the OpenAI-compatible `/v1` provider, syncs loaded local model wrappers, and requests an immediate chat model refresh.
11. Choose one returned `internal_model_ids` entry and call `subagents_run_subagent` with:
   - `model` set to that local model ID.
   - `prompt` set to a short text-only smoke test such as `Reply with one short sentence confirming this LM Studio local model is responding.`
   - `include_core_tools=false`.
   - `folder_name="LM Studio Setup"`.
   - Do not pass `skill_ids` or `tool_server_ids`. This is a text-only smoke test; extra skills or tool servers add unnecessary context and can create false context-window failures.

## Script Commands

Use `agent_vm_execute_skill_script` with `scripts/lmstudio_setup.py`:

- `probe --base-url http://host.docker.internal:<port>` checks native `GET /api/v1/models` and returns `reachable=true` or `reachable=false` without failing the script command.
- `inspect --base-url http://host.docker.internal:<port>` returns compact JSON for downloaded LLMs, loaded LLMs, filtered embedding model IDs, max context, loaded context, quantization, size, capabilities, and best candidate.
- `load --base-url http://host.docker.internal:<port> [--model-key <id>] [--context-length <tokens>]` loads the best or specified model with an auto-selected context window. If the model is already loaded below the target context, it calls `POST /api/v1/models/unload` with `instance_id`, then reloads with `POST /api/v1/models/load` using the `model` field and the target `context_length`.
- `download --base-url http://host.docker.internal:<port> --model-key <id>` starts a model download.
- `download-status --base-url http://host.docker.internal:<port> --job-id <job_id>` checks a model download job.

## Success Response

When configuration and the smoke test succeed, tell the user LM Studio is connected and the local models are now available in the model picker under `Local Models`.

## Failure Handling

If the user says the server is not ready, wait for them to start LM Studio's local server before running automation.

If `probe` cannot reach LM Studio on the default port, ask the user to verify that LM Studio is open and the local server is started, then ask for the port shown in LM Studio. If `inspect` later cannot reach LM Studio on a previously successful port, report the specific script error and ask the user to re-check the running server.

If `subagents_configure_lm_studio` reports `reachable=false`, explain that the app saved the configuration but marked existing local models disabled with: `LM Studio is not running. Start LM Studio and enable the local server.`

If no model IDs are returned after a successful load, ask the user to keep LM Studio open, verify the loaded model appears in the Developer panel, and rerun configuration.

If the Subagents smoke test fails but `subagents_configure_lm_studio` succeeded, tell the user the provider was wired into the app and include the specific smoke-test error so they can pick a different downloaded model.
