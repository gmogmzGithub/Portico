---
name: guided-flows
description: Build clean, in-chat guided experiences (create an agent, create a scheduled task, configure capabilities) using the Ask User Question modal with curated capability pickers, so the user never has to leave the chat for the busy control-plane screens.
license: Proprietary
compatibility: Portico
metadata:
  author: Portico Team
  version: "1.0"
  priority: high
  triggers:
    - "help me create a new agent"
    - "create an agent"
    - "make me an agent"
    - "build an agent"
    - "help me create a scheduled task"
    - "create a scheduled task"
    - "set up a recurring task"
    - "pick skills"
    - "choose capabilities"
    - "what capabilities should"
required_mcp_servers: []
---

# Guided In-Chat Flows

When a user asks for help with something the control plane normally handles — **creating an agent**,
**creating a scheduled task**, **choosing capabilities** — do it *in the chat* as a friendly,
step-by-step wizard instead of sending them to a busy multi-step screen. Use `ask_user_question`
(on the always-on Skills server) and, where a real choice of skills / MCP servers / models is needed,
render the app's **actual pickers** inside the modal with the `components` field.

## The `components` DSL

Each question in `ask_user_question` may include a `components` array **instead of** (or alongside)
plain `options`. The app substitutes its real capability pickers and returns the user's selection.

Supported component types:

- **`skill_picker`** — the user picks agent skills; returns skill ids.
- **`mcp_server_picker`** — the user picks MCP tool servers; returns `server:<id>` ids.
- **`model_picker`** — the user picks a base model; returns a model id (set `"multiple": false`).
  The modal requires a model pick before the question counts as answered — notes can't stand in.
- **`reasoning_effort_picker`** — the user picks a reasoning effort for the chosen model; renders
  disabled until a `model_picker` selects a reasoning-capable model, so keep it optional. The
  `model_picker` may sit in the same question or in an earlier question of the same flow — the
  effort stops always follow the model chosen anywhere in that flow.

Each component object:

```json
{ "type": "skill_picker", "id": "skills", "label": "Skills", "multiple": true }
```

- `type` (required): one of the types above.
- `id` (required): the key your answer comes back under in `component_selections`.
- `label` (optional): heading shown above the picker.
- `multiple` (optional, default `true`): allow multiple selections. Use `false` for a single choice
  (e.g. `model_picker`).
- `components_gated_by_option_id` (optional, **question-level**, not per component): only valid when
  the question has BOTH `options` and `components`. Names the option id that reveals the pickers —
  they stay hidden until the user selects that option, and answers for any other option come back
  without `component_selections`.
- `default_selected` (optional, per component): ids to preselect when the picker appears ungated
  (or when the revealing option has no `component_defaults` entry for it).
- `component_defaults` (optional, **per option**, not per component): a map of component id → ids
  to preselect when the user chooses that option. An option carrying `component_defaults` also
  REVEALS the components (seeded with those ids) — combine with `components_gated_by_option_id` on
  a *different* option to offer a "start from scratch" path whose pickers open empty. Any other
  option keeps the pickers hidden and answers as a plain option.

Default ids must use the SAME formats the pickers return — skills as catalog ids
(`company-knowledge`, `marketplace/plugin/skill`), servers as `server:<id>`, models as the listed
model name, efforts as an effort string the chosen model supports. Unresolvable ids are silently
dropped, so copy them from catalogs/list tools or a previous answer — never invent them. The user
can add/remove before submitting, so always read the answer's `component_selections` as the final
truth.

A question must have `options` (2–5) and/or `components` (1–4). Prefer components alone for
capability steps (do **not** add a "Something else" option — the picker is the answer). If you do
combine both, the answer carries `selected_option_id` alongside `component_selections`. You may
still set `freeform_placeholder` so the user can add notes.

## The output contract (how the answer comes back)

`ask_user_question` returns `answers[]`. For a component question, the answer looks like:

```json
{
  "question_id": "capabilities",
  "component_selections": {
    "skills": ["company-knowledge", "web-search"],
    "servers": ["server:glean"]
  },
  "freeform_text": "make it fast"
}
```

- `component_selections` is keyed by each component's `id`; each value is the list of selected ids.
- Single-select components (`multiple: false`) return a list with at most one id.
- Read the ids directly and pass them into the create call (e.g. `subagents_create_agent`'s
  `skill_ids` / `tool_server_ids`, or `model` / `base_model_id`).

## Example — "Help me create a new agent"

Ask a few small, friendly questions instead of one overwhelming form. Split the steps across
questions so nothing feels crowded.

1. **Name & purpose** — a normal question with 2–5 suggested names as `options` (every
   question needs `options` or `components`; the built-in "Something else" option plus the
   notes box already gives the user a freeform path).
2. **Base model** — a `model_picker` (single select):

   ```json
   {
     "id": "model",
     "header": "Model",
     "question": "Which model should power your agent?",
     "components": [{ "type": "model_picker", "id": "model", "multiple": false }]
   }
   ```

3. **Reasoning effort** — its own question, so the model step stays single-purpose. The control
   renders disabled until the base model above is chosen, and shows only the efforts that model
   supports (a model without reasoning support shows "Not supported by selected model"). Keep it
   optional — leaving it on `(default)` is a valid answer:

   ```json
   {
     "id": "reasoning",
     "header": "Reasoning",
     "question": "How hard should it think?",
     "components": [
       { "type": "reasoning_effort_picker", "id": "reasoning", "multiple": false }
     ]
   }
   ```

4. **Capabilities** — a two-path question: the pickers stay hidden unless the user chooses to
   specify capabilities themselves (`components_gated_by_option_id` gates on the `specify` option):

   ```json
   {
     "id": "capabilities",
     "header": "Capabilities",
     "question": "What capabilities should your agent have?",
     "options": [
       { "id": "let_agent_decide", "label": "Let the agent enable capabilities as needed" },
       { "id": "specify", "label": "I'll specify capabilities" }
     ],
     "components": [
       { "type": "skill_picker", "id": "skills", "label": "Skills" },
       { "type": "mcp_server_picker", "id": "servers", "label": "Tool servers" }
     ],
     "components_gated_by_option_id": "specify"
   }
   ```

   When you already know a good starting set — e.g. the user just ran a workflow manually and
   wants an agent that repeats it — lead with a pre-seeded option instead, so the pickers open
   prefilled and the user only fine-tunes:

   ```json
   {
     "id": "capabilities",
     "header": "Capabilities",
     "question": "Which skills and tool servers should it carry?",
     "options": [
       {
         "id": "recommended",
         "label": "Start from the recommended set (adjust below)",
         "component_defaults": {
           "skills": ["company-knowledge", "slack"],
           "servers": ["server:glean", "server:slack"]
         }
       },
       { "id": "scratch", "label": "Start from scratch" }
     ],
     "components": [
       { "type": "skill_picker", "id": "skills", "label": "Skills" },
       { "type": "mcp_server_picker", "id": "servers", "label": "Tool servers" }
     ],
     "components_gated_by_option_id": "scratch"
   }
   ```

   Selecting **recommended** reveals the pickers pre-seeded with your recommendation; **scratch**
   reveals them empty (it carries no defaults). Each option keeps its own picker state, so
   switching between them never loses the user's edits. Either way the answer returns the user's
   FINAL edited `component_selections` — map those into the create call, never your own
   recommendation echoed back.

Then create the agent from the answers:

- `base_model_id` ← `component_selections.model[0]`
- `reasoning_effort` ← `component_selections.reasoning[0]` from the reasoning question; omit it
  entirely when the user left it on `(default)` (the selection comes back empty).
- If the capabilities answer's `selected_option_id` is `let_agent_decide`, OMIT `skill_ids` and
  `tool_server_ids` entirely in `subagents_create_agent` — the agent then has no pinned capability
  list, and the orchestrating model supplies skills/tool servers per task when invoking it.
- If it is `specify`, map `skill_ids` ← `component_selections.skills` and
  `tool_server_ids` ← `component_selections.servers`.
- If it is `recommended` (or any option carrying `component_defaults`), the user may have edited
  the prefill — map `skill_ids`/`tool_server_ids` from `component_selections` exactly as for
  `specify`.

Call `subagents_create_agent` with those values, confirm the result, and (if the user wants to share
it) hand off to the `skill-publishing` skill to publish it to the AI Marketplace.

## Example — "Help me create a scheduled task"

Use plain-option questions for cadence/time and a `model_picker` for which model runs the task, then
create the task with the scheduling tools. Keep each question focused on one decision.

## Interaction style

- One decision per question; batch only tightly-related pickers (like skills + servers) into one step.
- Always pass `chat_id` from the injected `Chat ID: {id}` line so the modal shows the right model/agent.
- Prefer `components` whenever the real answer is "which skills / servers / model" — it's far nicer
  than making the user type ids, and it returns exactly the ids you need.
- After collecting answers, summarize what you're about to create before you create it.
