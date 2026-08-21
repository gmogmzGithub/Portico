"""Defect B reproduction — mid-run steer promotion loses the transcript seam.

Incident: chat c0127a20-b67d-40e6-b1e4-9d888f547ef8 (2026-08-06). A user message
sent while a Atlas Opus 5 tool loop was live was consumed as a steer;
``promote_consumed_steer_to_live_turn`` persisted the pre-steer turn + steer to
the DB, reset the loop's in-memory ``content_blocks``, and the next follow-up
round was rebuilt from the frozen request base — dropping the entire pre-steer
assistant turn (61 tool calls) AND the steer user message from the model's
context (224 -> 106 messages on the wire; see
tests/fixtures/steer-seam-c0127a20/).

These tests assert the CORRECT invariants through the real replay machinery
(AST-extracted; see tests/helpers/middleware_replay_extract.py):

  * every pre-steer tool_use/tool_result pair survives post-promotion rounds
  * the steer user message survives on every subsequent round
  * message count is non-decreasing and user-message anchors are never lost

On unfixed builds they are known-red (``portico_REPRO_STRICT=1`` surfaces the
failures for the repro report). They flip green when the seam-fold fix lands
(module-level helpers ``fold_promoted_seam_into_replay`` +
``build_followup_replay_messages`` wired into both the tool_followup and
stream_continue seams).
"""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers.middleware_replay_extract import (  # noqa: E402
    load_incident_fixture,
    load_replay_namespace,
    user_message_shas,
)

NS = load_replay_namespace()

STEER_PROMPT = (
    "Why not just use the docx skill and create a docx locally then upload it "
    "to Google Drive like you did the first time dude?"
)
BASE_USER_PROMPT = (
    "Create a new google doc with all the corrections. "
    "Search the web to figure out the AWS thing."
)


def base_messages():
    return [
        {"role": "system", "content": ""},
        {"role": "user", "content": BASE_USER_PROMPT},
    ]


def pre_steer_content_blocks():
    """Incident-shaped pre-steer outer turn: reasoning + text + tool loops."""
    return [
        {
            "type": "reasoning",
            "content": "Need to verify the AWS quota formula before editing the doc.",
            "duration": 4,
        },
        {"type": "text", "content": "Let me research the quota question first."},
        {
            "type": "tool_calls",
            "content": [
                {
                    "id": "call_ws_1",
                    "type": "function",
                    "function": {
                        "name": "web_tools_web_search",
                        "arguments": json.dumps(
                            {
                                "query": (
                                    "AWS Bedrock prompt caching cache read tokens "
                                    "count toward TPM quota tokens per minute"
                                )
                            }
                        ),
                    },
                }
            ],
            "results": [
                {
                    "tool_call_id": "call_ws_1",
                    "content": (
                        "Search results: AWS documents the quota formula; cache "
                        "reads are excluded from TPM. " + "detail " * 40
                    ),
                }
            ],
        },
        {
            "type": "text",
            "content": "This is a decisive answer - Formula B is the correct one.",
        },
        {
            "type": "tool_calls",
            "content": [
                {
                    "id": "call_doc_1",
                    "type": "function",
                    "function": {
                        "name": "google_workspace_create_doc",
                        "arguments": json.dumps({"title": "Corrections"}),
                    },
                },
                {
                    "id": "call_doc_2",
                    "type": "function",
                    "function": {
                        "name": "google_workspace_batch_edit_doc",
                        "arguments": json.dumps({"doc_id": "d1", "ops": 3}),
                    },
                },
            ],
            "results": [
                {"tool_call_id": "call_doc_1", "content": "created doc d1"},
                {"tool_call_id": "call_doc_2", "content": "applied 3 edits to d1"},
            ],
        },
        {"type": "text", "content": "Doc updated with the corrected numbers."},
    ]


def steer_item(item_id="steer-1", prompt=STEER_PROMPT):
    return {"id": item_id, "prompt": prompt, "files": [], "created_at": 1786057537}


FRESH_OUTER_BLOCKS = [{"type": "text", "content": ""}]


def build_pre_promotion_round(ns, replay_mode="tool_followup"):
    """The round that consumes the steer (wire shape of incident followup/58)."""
    followup = [
        *base_messages(),
        *ns["convert_content_blocks_to_messages"](
            pre_steer_content_blocks(), True, replay_mode=replay_mode
        ),
    ]
    injected, _files = ns["inject_pending_steer_into_followup_messages"](
        base_messages=followup, steer_item=steer_item()
    )
    return injected


def seam_fold_available(ns):
    return callable(ns.get("fold_promoted_seam_into_replay")) and callable(
        ns.get("build_followup_replay_messages")
    )


def build_post_promotion_round(
    ns, *, replay_mode="tool_followup", seams=None
):
    """First round dispatched for the NEW outer message after steer promotion.

    Fixed builds: fold each promoted seam (finalized pre-steer blocks + steer)
    into the replay via the real helpers, exactly as both seam builders do.

    Unfixed builds: ``promote_consumed_steer_to_live_turn`` resets the loop's
    ``content_blocks`` to a single empty text block and folds nothing back, and
    the follow-up builder composes base + convert(current blocks) only. That
    composition — reproduced here through the real convert function — is what
    produced the 224 -> 106 collapse captured in the incident fixtures.
    """
    seams = seams if seams is not None else [
        (pre_steer_content_blocks(), steer_item())
    ]
    if seam_fold_available(ns):
        seam_blocks = []
        for finalized_blocks, item in seams:
            seam_blocks = ns["fold_promoted_seam_into_replay"](
                seam_blocks, copy.deepcopy(finalized_blocks), item
            )
        return ns["build_followup_replay_messages"](
            base_messages(),
            seam_blocks,
            copy.deepcopy(FRESH_OUTER_BLOCKS),
            replay_mode,
        )
    return [
        *base_messages(),
        *ns["convert_content_blocks_to_messages"](
            copy.deepcopy(FRESH_OUTER_BLOCKS), True, replay_mode=replay_mode
        ),
    ]


def tool_pairs(messages):
    calls = set()
    results = set()
    for m in messages:
        if not isinstance(m, dict):
            continue
        if m.get("role") == "assistant":
            for tc in m.get("tool_calls") or []:
                if isinstance(tc, dict) and tc.get("id"):
                    calls.add(tc["id"])
        elif m.get("role") == "tool" and m.get("tool_call_id"):
            results.add(m["tool_call_id"])
    return calls, results


def flat_text(messages):
    chunks = []
    for m in messages:
        c = m.get("content") if isinstance(m, dict) else None
        chunks.append(c if isinstance(c, str) else json.dumps(c))
    return "\n".join(chunks)


class SteerSeamContinuityTests(unittest.TestCase):
    maxDiff = None

    def test_B_U1_prior_outer_tool_pairs_survive_promotion(self):
        post = build_post_promotion_round(NS)
        calls, results = tool_pairs(post)
        expected = {"call_ws_1", "call_doc_1", "call_doc_2"}
        self.assertTrue(
            expected.issubset(calls),
            f"pre-steer tool calls missing from post-promotion replay: "
            f"{sorted(expected - calls)}",
        )
        self.assertTrue(
            expected.issubset(results),
            f"pre-steer tool results missing from post-promotion replay: "
            f"{sorted(expected - results)}",
        )

    def test_B_U2_steer_user_message_survives_promotion(self):
        post = build_post_promotion_round(NS)
        steer_texts = [
            m.get("content")
            for m in post
            if isinstance(m, dict) and m.get("role") == "user"
        ]
        self.assertTrue(
            any(
                isinstance(c, str) and STEER_PROMPT in c
                or (not isinstance(c, str) and STEER_PROMPT in json.dumps(c))
                for c in steer_texts
            ),
            "steer user message absent from post-promotion replay "
            f"(user messages: {[str(c)[:60] for c in steer_texts]})",
        )

    def test_B_U3_count_non_decreasing_and_user_anchors_kept(self):
        pre = build_pre_promotion_round(NS)
        post = build_post_promotion_round(NS)
        self.assertGreaterEqual(
            len(post),
            len(pre),
            f"message count collapsed across promotion: {len(pre)} -> {len(post)}",
        )
        pre_anchors = set(user_message_shas(pre))
        post_anchors = set(user_message_shas(post))
        self.assertTrue(
            pre_anchors.issubset(post_anchors),
            f"user-message anchors lost across promotion: "
            f"{len(pre_anchors - post_anchors)} of {len(pre_anchors)}",
        )

    def test_B_U4_stream_continue_seam_same_invariants(self):
        pre = build_pre_promotion_round(NS, replay_mode="stream_continue")
        post = build_post_promotion_round(NS, replay_mode="stream_continue")
        self.assertGreaterEqual(len(post), len(pre))
        calls, results = tool_pairs(post)
        self.assertIn("call_ws_1", calls)
        self.assertIn("call_ws_1", results)
        self.assertIn(STEER_PROMPT, flat_text(post))

    def test_B_U7_multiple_promotions_accumulate_seams(self):
        second_outer_blocks = [
            {"type": "text", "content": "Retrying the upload path."},
            {
                "type": "tool_calls",
                "content": [
                    {
                        "id": "call_up_1",
                        "type": "function",
                        "function": {
                            "name": "google_workspace_update_drive_file",
                            "arguments": json.dumps({"file_id": "f1"}),
                        },
                    }
                ],
                "results": [
                    {"tool_call_id": "call_up_1", "content": "file f1 updated"}
                ],
            },
        ]
        second_steer = steer_item("steer-2", "Stop. Just give me the summary.")
        post = build_post_promotion_round(
            NS,
            seams=[
                (pre_steer_content_blocks(), steer_item()),
                (second_outer_blocks, second_steer),
            ],
        )
        calls, results = tool_pairs(post)
        for call_id in ("call_ws_1", "call_doc_1", "call_doc_2", "call_up_1"):
            self.assertIn(call_id, calls, f"{call_id} lost after second promotion")
            self.assertIn(call_id, results, f"{call_id} result lost")
        text = flat_text(post)
        self.assertIn(STEER_PROMPT, text)
        self.assertIn("Stop. Just give me the summary.", text)

    def test_B_U9_history_fidelity_guard_contract(self):
        verify = NS.get("verify_followup_history_fidelity")
        collect = NS.get("collect_followup_user_message_anchors")
        if not callable(verify) or not callable(collect):
            self.fail(
                "history-fidelity guard helpers not implemented "
                "(verify_followup_history_fidelity / "
                "collect_followup_user_message_anchors)"
            )
        pre = build_pre_promotion_round(NS)
        anchors = collect(pre)
        intact = verify(pre, anchors, len(pre))
        self.assertTrue(intact.get("ok"), f"intact payload flagged: {intact}")
        # Drop a user message: the guard must flag the violation.
        broken = [
            m
            for m in pre
            if not (
                isinstance(m, dict)
                and m.get("role") == "user"
                and isinstance(m.get("content"), str)
                and STEER_PROMPT in m["content"]
            )
        ]
        verdict = verify(broken, anchors, len(pre))
        self.assertFalse(verdict.get("ok"), "guard missed a dropped user message")
        self.assertTrue(verdict.get("missing_anchors"))


class IncidentFixtureDocumentationTests(unittest.TestCase):
    """Frozen wire captures from the real incident (always green).

    These pin the historical facts the reproduction above models: followup/58
    carried 224 messages ending with the steer; followup/59 — the next round of
    the same loop — carried 106 with the steer user message and the pre-steer
    turn gone.
    """

    def test_incident_fixture_documents_seam_loss(self):
        f58 = load_incident_fixture("followup58")
        f59 = load_incident_fixture("followup59")
        self.assertEqual(f58["message_count"], 224)
        self.assertEqual(f59["message_count"], 106)
        self.assertEqual(f58["source"]["outer_message_id"], f59["source"]["outer_message_id"])
        self.assertEqual(f58["source"]["request_phase"], "tool_followup")
        self.assertEqual(f59["source"]["request_phase"], "tool_followup")

        f58_users = [m for m in f58["messages"] if m["role"] == "user"]
        f59_users = [m for m in f59["messages"] if m["role"] == "user"]
        self.assertEqual(len(f58_users), 6)
        self.assertEqual(len(f59_users), 5)

        f58_shas = {m["content_sha256"] for m in f58_users}
        f59_shas = {m["content_sha256"] for m in f59_users}
        lost = f58_shas - f59_shas
        self.assertEqual(
            len(lost), 1, "exactly the steer user message vanished at /59"
        )
        lost_sha = next(iter(lost))
        lost_msg = next(m for m in f58_users if m["content_sha256"] == lost_sha)
        self.assertIn("docx skill", lost_msg["content_head"])

    def test_incident_fixture_shows_tool_history_amputation(self):
        f58 = load_incident_fixture("followup58")
        f59 = load_incident_fixture("followup59")
        f58_tool_msgs = sum(1 for m in f58["messages"] if m["role"] == "tool")
        f59_tool_msgs = sum(1 for m in f59["messages"] if m["role"] == "tool")
        self.assertGreater(
            f58_tool_msgs - f59_tool_msgs,
            40,
            "the pre-steer outer's tool history should dominate the collapse",
        )


if __name__ == "__main__":
    unittest.main()
