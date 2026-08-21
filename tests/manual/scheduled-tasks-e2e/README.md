# Scheduled-tasks end-to-end miss-scenario harness

Exercises the REAL `scheduling-daemon` binary against a throwaway Redis
(docker) and a mock Open WebUI, with tasks created through the REAL
scheduling-server `create_task` MCP tool over stdio. Downtime is simulated
the way it actually happens on user machines: the task file was armed in
the past and the daemon wasn't running when the occurrence came due
(laptop asleep, app closed, morning update restart).

## Run

```bash
cd src/core-mcp-rust && cargo build -p scheduling-server --bins && cd ../..
python3 tests/manual/scheduled-tasks-e2e/run_scenarios.py
```

Requires docker (throwaway `redis:7-alpine` on 127.0.0.1:63790) and free
port 18990 for the mock. Total runtime ≈ 2–3 minutes. Exits non-zero on
any failed assertion. Fully isolated: temp task stores, its own redis,
no contact with the dev compose stack.

## Scenario matrix

| Scenario | What it proves |
|---|---|
| on_time_run_and_prompt_contract | On-time occurrence runs end-to-end (chat created with `run_origin: scheduled` meta, completion posted, success terminal, cron advanced); the completion's system prompt carries the unattended-run contract (never ask the user; block-and-explain). |
| catch_up_after_downtime | An occurrence that came due 2h earlier (daemon down) runs late — no missed row while it is still the current occurrence. |
| superseded_multi_miss_and_restart_idempotence | Armed 3h ago on an hourly cron: exactly ONE `missed` row ("Skipped 3 scheduled runs…", `missed_run` attention), one run for the current occurrence; daemon restart adds no rows and starts no duplicates. |
| throttle_one_catch_up_per_sweep | Three tasks overdue together drain one catch-up launch per sweep, most-overdue-first — the wake-from-sleep pile-up guard. |
| bridge_defer_and_recover | Host bridge down at fire time: run deferred (no terminal, occurrence NOT burned, no chat); bridge recovery → the same occurrence runs. |
| once_catch_up_and_expiry | One-off task 1h late runs then disables; one-off 30h late records missed+disabled with the expiry explanation and never creates a chat. |
| orphan_reattach_after_kill | SIGKILL mid-run, restart: daemon re-attaches to the in-flight chat (same run_id, no duplicate chat/completion) and completes it. |
| needs_attention_explanation | A run finalized `needs_attention` (blocked on user input) records a failed terminal with the blocker reason on the task and the explanation as the chat's final message — the block-and-explain contract end-to-end. |

## How runs complete

The daemon requires the model to call `scheduling_finalize_run`; here the
harness plays the model: once `current_run` appears in the task file it
writes the verdict to the shared redis (`scheduling_run_verdict:<run_id>`)
and marks the mock chat's assistant message done — the exact contract the
real finalizer tool implements.
