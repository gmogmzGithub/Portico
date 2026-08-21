---
name: workflows
description: 'Coordinate multi-chat agent workflows — including single-reviewer "review/critique my output" workflows. Use when the user asks for a workflow (e.g. a reviewer workflow), wants two or more chats/agents collaborating (drafting, reviewing, iterating), or when this chat receives a "[Message from another chat: ...]" prompt. Reviewers and peers are always separate CHATS started with subagents_start_chat (never run_subagent); they exchange work through markdown files in the shared workspace and notify each other with short cross-chat messages.'
license: Proprietary
compatibility: Portico
metadata:
  author: Portico Team
  version: "1.0"
  priority: high
  triggers:
    - "workflow"
    - "reviewer workflow"
    - "review workflow"
    - "message from another chat"
    - "multi-agent"
    - "multi agent"
    - "collaborate with another chat"
    - "review in a new chat"
    - "start a chat with"
required_mcp_servers:
  - "server:subagents"
  - "server:agent-vm"
---

# Workflows Skill

Coordinate work across multiple chats, each driven by its own model or agent, working in ONE shared workspace. This is peer collaboration between visible chats — not delegation.

## The two roles

- **Initiator (Orchestrator)**: the chat that starts the workflow. It creates peer chats with `subagents_start_chat` and coordinates rounds. Only the orchestrator may start chats.
- **Collaborator**: a chat that receives a prompt beginning with `[Message from another chat: ...]`. The sender's chat_id is embedded in that prefix — in new chats it arrives inside a token like `[[xchat:<chat_id>|<display_name>|<model_name>|<model_id>|<model|agent>]]` (older chats used the plain form `[Message from another chat: <chat_id> from Model/Agent <name>]`). Extract the chat_id and remember it; it is the `target_chat_id` for every reply you send back.

## Hard rules

1. **Peers cannot read your chat.** Replying inline in your own chat does NOT notify or inform the chat that messaged you. Every deliverable must be (a) written to a file in the shared workspace, and (b) announced back to the peer with `subagents_send_message_to_chat`. A workflow turn that ends without a `subagents_send_message_to_chat` call back to the peer is a dropped ball.
2. **Files carry the work; messages carry only notifications.** Write full content (drafts, reviews, plans, data) to markdown files in the shared workspace. Keep cross-chat messages to 2-4 sentences: what you did, which file holds it, the one-line takeaway, and what you need next. Format for reading, not density: put distinct points on their own lines with a blank line between them instead of one wall-of-text paragraph — but keep it light; a short note needs no headers, numbered sections, or bullet ceremony. **Never attach files — especially images/renders — to a cross-chat message.** Attachments are copied into the peer's chat history permanently and keep pointing at the workspace file as it was at send time, so the peer's later turns break or mislead once that file is replaced or deleted. Share every artifact as a workspace path instead: peers read files with the code-execution tools and view images by calling `agent_vm_request_images` with those paths.
3. **Do NOT use `subagents_run_subagent` for workflows — not even for a one-shot review.** A "reviewer" in ANY workflow is a PEER CHAT started with `subagents_start_chat`, never a subagent; sending work "to the reviewer" means `subagents_send_message_to_chat`, never delegation. Delegation to a subagent is a different mechanism reserved for when the user explicitly asks for it. Peer collaboration always uses `subagents_start_chat` + `subagents_send_message_to_chat`.
4. **Bounded iteration.** Agree on completion criteria in the first message. If a workflow exceeds 5 rounds without converging, stop and ask the user how to proceed instead of continuing to ping-pong.
5. **Collaborators must NEVER call `subagents_start_chat`.** Only the orchestrator (root) chat starts peer chats; the system rejects starts from started chats. A workflow supports at most 3 peers (the chats tile automatically in the user's window, up to 4 panes including the orchestrator). If you need another perspective as a collaborator, ask the orchestrator for it via `subagents_send_message_to_chat`.
6. **Exact model names.** When a workflow names a specific model for a peer/reviewer, pass that model's name EXACTLY to `subagents_start_chat` — never substitute a variant (e.g. "GPT-5.6 Sol" must never become "GPT-5.6 Sol Pro"). If the exact name is not in the model list, ask the user instead of guessing. The same exactness applies to `reasoning_effort` values a workflow specifies.
7. **Workflows are ASYNCHRONOUS. Never wait, never poll.** After `subagents_start_chat` or `subagents_send_message_to_chat`, STOP and END YOUR TURN — the peer's reply arrives later, automatically, as a NEW prompt in this chat (`[Message from another chat: ...]`). Explicitly:
   - Do NOT call the `wait` tool (`skills_wait`) to wait for a peer — not once, not in a loop. There is nothing to poll; the notification is pushed to you.
   - While a reply is pending, do NOT send the peer another message — no status checks, no re-sends, no "just checking in". Every message you send triggers ANOTHER peer turn, and messages written before your previous one arrives produce crossed replies that compound. (To check on a peer without triggering a turn, use `subagents_get_chat_status`.)
   - Do NOT respond to the user with the deliverable prematurely. If the peer has not replied yet, end your turn and wait for the notification; never "give up" on the workflow and self-deliver.

## Reviewer workflows (the most common shape)

A "basic reviewer workflow" (or "review workflow") = this protocol with exactly ONE peer:

1. **Default reviewer model** (when the user names none): if THIS chat runs any Atlas model, the reviewer is exactly `GPT-5.6 Sol` — never `GPT-5.6 Sol Pro` or any other variant; otherwise the reviewer is exactly `Atlas Opus 5`. Either way pass `reasoning_effort: "xhigh"` EXACTLY — never substitute `max`, `high`, or any other tier (Extra High = `"xhigh"`, per hard rule 6). If the user names a model, use that exact name per hard rule 6.
2. Produce the deliverable first (write it to a `workflow/` file).
3. `subagents_start_chat` with `display_name: "Reviewer"`, the model per step 1, and a role prompt that includes the FULL original user prompt (context) plus the deliverable's workspace path — the reviewer must always receive the complete context of what was asked in addition to the produced output that is ready for review. This is NOT a `run_subagent` job — the reviewer is a visible peer chat. **Then STOP — end your turn.** The review is asynchronous: the reviewer will MESSAGE THIS CHAT when the review is ready. Do not call `skills_wait`, do not poll, do not message the reviewer again while its review is pending (each extra message spawns another reviewer turn and the crossed replies compound), and do not answer the user before the verdict arrives (hard rule 7).
4. The reviewer writes its verdict to a `workflow/` file and messages back APPROVE or REVISE with reasons.
5. On REVISE: fix, write the next round file, notify the reviewer again. Bounded: up to 3 review cycles, then deliver with explicit caveats.
6. **Do not deliver the final answer to the user until the reviewer has APPROVED it** (or the 3-cycle bound is reached).
7. **End the workflow silently — no thank-you message.** The moment you have the APPROVE (or hit the cycle bound), deliver the final answer to the user as your very next action. Do NOT send the reviewer a closing thanks/acknowledgement: every cross-chat message triggers another reviewer turn, and that reply (plus your close-out of it) becomes the last thing the user sees instead of their deliverable. The reviewer needs no goodbye.

## Shared workspace

Chats started with `subagents_start_chat` share the initiator's workspace by default (`share_workspace: true`) and FOLLOW the root chat's workspace if the user changes it. Inside an Agent VM the workspace is `/work`; your `<chat_workspace>` context block shows the current host path and, for shared chats, `mode="shared"` with the root chat id.

File conventions:
- Put workflow files under `workflow/` in the workspace (create it if missing).
- Name files `<topic>-<role>-r<round>.md`, e.g. `workflow/histogram-review-r1.md`, `workflow/histogram-revision-r2.md`.
- Start each file with a short header: who wrote it (chat id + model/agent name), the round number, and a one-line verdict/summary.
- Never overwrite a peer's file; add a new round file instead.
- Images and other binary artifacts (slide renders, screenshots, charts) follow the same rule as text: leave them in the workspace and send PATHS — the receiving chat views them with `agent_vm_request_images`. Never attach them to a cross-chat message (hard rule 2).
- Give re-rendered artifacts fresh per-round names (`r2-slide-1.jpg`, never `slide-1.jpg` again) and leave earlier rounds' files in place until the workflow ends — a peer's history may still reference them.
- Use the code-execution tools (Agent VM) to read and write these files.

## Initiator playbook

1. Ensure any input files the peer needs are already in the workspace, then start the peer:
   - `subagents_start_chat` with a clear role prompt: the task, the files to read (workspace paths), where to write output (`workflow/<topic>-<role>-r1.md`), the completion criteria, and an explicit instruction to reply via `subagents_send_message_to_chat` when the file is ready. Break the role prompt into short paragraphs (task / inputs / output / completion criteria on separate lines) — a single run-on block is hard for the user to follow when it renders in the peer's chat.
   - `display_name` is REQUIRED: a one-word role label for the chat's tile badge, e.g. `Reviewer`, `Critic`, `Researcher` (1-24 letters/digits/hyphens/underscores; never `Orchestrator`).
   - Include `skill_ids: ["workflows", "code-execution"]` so the peer follows this same protocol and can read/write workspace files.
   - At most 3 peers per workflow; the peers tile alongside this chat in the user's window automatically.
2. Do NOT poll or block. The peer's notification will arrive in this chat as a new prompt. Continue other work or end your turn.
3. When the peer's notification arrives, read the referenced file from the workspace, act on it, write your response file, and notify the peer again. Repeat until the completion criteria are met.
4. Close the loop for the user: summarize the final state and name the files that hold the full history.

## Collaborator playbook

When a prompt starts with `[Message from another chat: <chat_id> ...]`:

1. Note the sender's chat_id — every reply goes to it via `subagents_send_message_to_chat`.
2. Read the referenced workspace files before doing anything else.
3. Do the work. Write the full deliverable to a `workflow/` markdown file (next round number).
4. Send the notification back, for example:
   - `subagents_send_message_to_chat(target_chat_id="<sender chat_id>", message="Review round 1 is ready in workflow/histogram-review-r1.md. Verdict: approve with changes — 3 accessibility fixes needed. Send round 2 when revised.")`
5. Also render a brief summary in your own chat so the user can follow along from either side.

## What NOT to do

- Do not paste full deliverables into cross-chat messages (they bloat the peer's context; the file is the source of truth).
- Do not attach files or images to `subagents_send_message_to_chat` — send workspace paths and let the peer pull images with `agent_vm_request_images`. An attachment freezes into the peer's history and goes stale or dead the moment the workspace file changes.
- Do not start a new chat for every round — keep the round-trip between the two existing chats.
- Do not use `subagents_run_subagent` to "ask" the peer something; message the peer chat instead.
- Do not assume the peer saw anything you did not explicitly send with `subagents_send_message_to_chat`.
- Do not use the `wait` tool (`skills_wait`) or any polling loop to wait for a peer's reply, and do not message a peer just to check on it — replies arrive automatically as new prompts (use `subagents_get_chat_status` if you must check whether a peer is still working).
- Do not send courtesy messages (thanks, acknowledgements, "workflow complete") to a peer once you have what you need — each one triggers another peer turn and buries the user's deliverable. When the work is done, deliver to the user and stop messaging peers. As a collaborator, if a message needs no action from you, do not reply to it.
