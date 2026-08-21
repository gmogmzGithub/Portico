# Managing your tool allowlists

**Audience:** end users.
**Last reviewed:** 2026-05-05.

The Portico asks for explicit approval before any destructive
action runs (sending a Slack message, creating a Jira ticket,
emailing someone, ...). The "tool allowlist" is your way to say
"yes — this specific kind of action is fine, dispatch silently from
now on".

This page explains the user-facing flow. The full architectural
write-up lives at
[`../../architecture/chat-ui/chip-system.md`](../../architecture/chat-ui/chip-system.md).

## Adding an allowlist entry from a chip

Whenever a destructive action is proposed, you'll see a confirmation
**chip** above the chat input with four buttons:

- **Yes, send** — approve THIS call only. The chip disappears and
  the action runs.
- **No** — reject THIS call.
- **Reply with changes** — propose modified arguments; the chip
  re-prompts the model.
- **Always allow** — approve THIS call AND record a persistent rule
  so future identical calls (same tool + same integration) run
  without showing a chip.

Clicking "Always allow" is the recommended way to populate your
allowlist — you only ever consent in context, and only after the
chip has shown you exactly what's about to happen.

## Reviewing your allowlists

1. Open Settings.
2. Click the **Allowlists** tab.
3. The page lists your active rules grouped by integration ("slack",
   "asana", "google-workspace", ...).

For each entry you can:

- Toggle the per-row checkbox to disable / re-enable the rule.
  Disabled rules stay on disk but the chip flow returns next time
  the action is proposed.
- Click the X icon to delete the rule outright. A toast offers Undo
  for 5 seconds — clicking Undo restores the rule with no further
  action.

## The master "Allowlists enabled" toggle

At the top of the Settings → Allowlists page is a master toggle.
When set to **OFF** ("Allowlists temporarily disabled"), every
destructive action will show a confirmation chip even if you have a
rule for it. This is your panic button — it's reversible (your
rules are not deleted), and you can flip it back ON whenever
you're ready.

## What's safe to "Always allow"?

- Actions whose argument shape varies but whose intent is bounded
  ("send a Slack message" — the message body changes, but the
  blast radius is the same).
- Actions you recognise as part of your daily workflow and where
  the model has already proven it picks reasonable arguments.

## What's NOT safe to allowlist?

- Actions that broadcast publicly (publish to a public channel,
  send mass email).
- Anything irreversible at scale (mass delete, financial action).
- Tools you don't fully recognise — when in doubt, keep the chip.

## Scheduled tasks behave differently

Scheduled tasks already approve a specific class of actions at
**task creation** time (the `tool_server_ids` you confirm before
`scheduling_create_task` fires). That consent applies inside the
sub-agent run. The persistent allowlist is independent — it
governs interactive chats. A scheduled run that uses an
out-of-scope tool will still show a clarification chip in the
sub-agent chat (see
[`../../architecture/mcp/scheduled-task-runtime.md`](../../architecture/mcp/scheduled-task-runtime.md)
"Scope-binding model").

## Where the allowlist lives

Your allowlist is stored on the same machine as your chat data, in
a per-user file under `<DATA_DIR>/tool-allowlists/<your-user-id>.json`,
readable only by your user account. It is NOT synced across
devices in this round. Re-add rules on a new device or copy the
file over manually.

## Audit trail

Every allowlist-driven dispatch is recorded in the audit log as
`dispatched_user_allowlist`, distinct from `dispatched_after_approval`
(per-chat chip click) and `dispatched_safe` (read-only tools). If
you suspect a rule fired unexpectedly, ask your administrator to
grep the audit log for your user id.
