# D — Chat UI & Open WebUI patches

Model picker, streaming, conversation list, attachments, copy paths, and the Bedrock thinking-signature regression.

- Up: [`docs/testing/README.md`](../../README.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    10 |      7 |    3 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                  | Type | Coverage | Status | Last run | File |
|-------|---------------------------------------------------------------------------|------|----------|--------|----------|------|
| D-01  | Model picker shows available models (Bifrost output)                      | Chat | Partial  | NotRun | -        | [message-flow.md](message-flow.md) |
| D-02  | Switch models mid-chat preserves conversation history                     | Chat | Manual   | NotRun | -        | [message-flow.md](message-flow.md) |
| D-03  | Streaming tokens render incrementally; final message persists             | Chat | Manual   | NotRun | -        | [message-flow.md](message-flow.md) |
| D-04  | Model access denied (403) shows the temporary CBO-745 message             | Chat | Manual   | NotRun | -        | [message-flow.md](message-flow.md) |
| D-05  | Conversation list shows all chats; rename updates tab title               | Chat | Partial  | Pass   | 2026-04-28 | [message-flow.md](message-flow.md) |
| D-06  | Message edit & resend                                                     | Chat | Manual   | NotRun | -        | [composer-and-attachments.md](composer-and-attachments.md) |
| D-07  | Attach a file/image; model references it                                  | Chat | Manual   | NotRun | -        | [composer-and-attachments.md](composer-and-attachments.md) |
| D-08  | Copy text from a message via Electron IPC                                 | Chat | Auto     | Pass   | 2026-04-28 | [composer-and-attachments.md](composer-and-attachments.md) |
| D-09  | Copy fallback uses `navigator.clipboard.writeText`                        | Chat | Auto     | Pass   | 2026-04-28 | [composer-and-attachments.md](composer-and-attachments.md) |
| D-10  | Bedrock thinking signature survives long guided setup (~83s)              | Chat | Partial  | NotRun | -        | [composer-and-attachments.md](composer-and-attachments.md) |

## Files in this folder

- [message-flow.md](message-flow.md) — model picker, streaming, errors, conversation list (D-01 .. D-05).
- [composer-and-attachments.md](composer-and-attachments.md) — composer actions, attachments, copy paths, signature (D-06 .. D-10).
