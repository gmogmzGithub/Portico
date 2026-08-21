from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
PATCHER_PATHS = [
    ROOT / "dev" / "entrypoint.sh",
    ROOT / "dev" / "entrypoint-fullstack.sh",
    ROOT / "src" / "patches" / "patch-openwebui-entrypoint.sh",
]


def _extract_merge_block(path: Path) -> str:
    text = path.read_text()
    matches = [
        candidate
        for candidate in re.findall(r"new_block = '''(.*?)'''", text, re.DOTALL)
        if 'existing_usage = existing_message.get("usage")' in candidate
    ]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one chats.py merge block in {path}, found {len(matches)}")
    return matches[0]


def _build_merge_function(block: str):
    function_source = ["def apply(history, message_id, message):"]
    function_source.extend(f"    {line}" for line in block.splitlines())
    namespace: dict[str, object] = {}
    exec("\n".join(function_source), namespace)
    return namespace["apply"]


class ChatUsageMergePatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.blocks = {path: _extract_merge_block(path) for path in PATCHER_PATHS}
        cls.merge_functions = {
            path: _build_merge_function(block) for path, block in cls.blocks.items()
        }

    def test_all_patchers_share_same_merge_block(self):
        unique_blocks = {block for block in self.blocks.values()}
        self.assertEqual(len(unique_blocks), 1)

    def test_repeated_usage_snapshots_do_not_sum_prompt_tokens(self):
        initial = {
            "id": "message-1",
            "content": "first",
            "usage": {
                "prompt_tokens": 21_455,
                "completion_tokens": 200,
                "total_tokens": 21_655,
                "cached_tokens": 19_759,
                "cache_read_input_tokens": 19_759,
                "cache_creation_input_tokens": 19_759,
                "cache_write_input_tokens": 19_759,
                "cost": 0.13837,
                "prompt_tokens_details": {
                    "cached_tokens": 19_759,
                    "cached_write_tokens": 19_759,
                },
            },
        }
        second = {
            "id": "message-1",
            "content": "second",
            "usage": {
                "prompt_tokens": 28_675,
                "completion_tokens": 201,
                "total_tokens": 28_876,
                "cached_tokens": 26_828,
                "cache_read_input_tokens": 26_828,
                "cache_creation_input_tokens": 26_828,
                "cache_write_input_tokens": 26_828,
                "cost": 0.18611,
                "prompt_tokens_details": {
                    "cached_tokens": 26_828,
                    "cached_write_tokens": 26_828,
                },
            },
        }
        final = {
            "id": "message-1",
            "content": "final",
            "usage": {
                "prompt_tokens": 46_481,
                "completion_tokens": 2_678,
                "total_tokens": 49_159,
                "cached_tokens": 31_703,
                "cache_read_input_tokens": 31_703,
                "cost": 0.15669,
                "prompt_tokens_details": {
                    "cached_tokens": 31_703,
                    "cached_read_tokens": 31_703,
                },
            },
        }

        for merge in self.merge_functions.values():
            history = {"messages": {}}
            merge(history, "message-1", deepcopy(initial))
            merge(history, "message-1", deepcopy(second))
            merge(history, "message-1", deepcopy(final))

            usage = history["messages"]["message-1"]["usage"]
            self.assertEqual(usage["prompt_tokens"], 46_481)
            self.assertEqual(usage["completion_tokens"], 2_678)
            self.assertEqual(usage["total_tokens"], 49_159)
            self.assertEqual(usage["cached_tokens"], 31_703)
            self.assertEqual(usage["cache_read_input_tokens"], 31_703)
            self.assertEqual(usage["cache_creation_input_tokens"], 26_828)
            self.assertEqual(usage["cache_write_input_tokens"], 26_828)
            self.assertEqual(usage["cost"], 0.18611)
            self.assertEqual(usage["prompt_tokens_details"]["cached_tokens"], 31_703)
            self.assertEqual(usage["prompt_tokens_details"]["cached_write_tokens"], 26_828)
            self.assertEqual(usage["prompt_tokens_details"]["cached_read_tokens"], 31_703)

    def test_duplicate_terminal_usage_event_is_idempotent(self):
        snapshot = {
            "id": "message-2",
            "usage": {
                "prompt_tokens": 75_670,
                "completion_tokens": 536,
                "total_tokens": 76_206,
                "cached_tokens": 66_612,
                "cache_read_input_tokens": 66_612,
                "cache_creation_input_tokens": 5_142,
                "cache_write_input_tokens": 5_142,
                "cost": 0.09842,
            },
        }

        for merge in self.merge_functions.values():
            history = {"messages": {}}
            merge(history, "message-2", deepcopy(snapshot))
            merge(history, "message-2", deepcopy(snapshot))

            usage = history["messages"]["message-2"]["usage"]
            self.assertEqual(usage, snapshot["usage"])

    def test_content_update_without_usage_preserves_existing_usage_and_content_blocks(self):
        original = {
            "id": "message-3",
            "content": "before",
            "contentBlocks": [{"type": "reasoning"}],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 2,
                "total_tokens": 12,
            },
        }
        content_only = {
            "id": "message-3",
            "content": "after",
        }

        for merge in self.merge_functions.values():
            history = {"messages": {}}
            merge(history, "message-3", deepcopy(original))
            merge(history, "message-3", deepcopy(content_only))

            merged = history["messages"]["message-3"]
            self.assertEqual(merged["content"], "after")
            self.assertEqual(merged["usage"], original["usage"])
            self.assertEqual(merged["contentBlocks"], original["contentBlocks"])

    def test_cache_and_cost_fields_merge_by_max(self):
        first = {
            "id": "message-4",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 1,
                "total_tokens": 11,
                "cached_tokens": 8,
                "cache_read_input_tokens": 8,
                "cache_creation_input_tokens": 2,
                "cache_write_input_tokens": 2,
                "cost": 1.25,
                "prompt_tokens_details": {
                    "cached_tokens": 8,
                    "cache_read_tokens": 8,
                    "cache_creation_tokens": 2,
                },
            },
        }
        second = {
            "id": "message-4",
            "usage": {
                "prompt_tokens": 7,
                "completion_tokens": 3,
                "total_tokens": 13,
                "cached_tokens": 6,
                "cache_read_input_tokens": 6,
                "cache_creation_input_tokens": 5,
                "cache_write_input_tokens": 5,
                "cost": 1.4,
                "prompt_tokens_details": {
                    "cached_tokens": 6,
                    "cache_read_tokens": 6,
                    "cache_creation_tokens": 5,
                },
            },
        }

        for merge in self.merge_functions.values():
            history = {"messages": {}}
            merge(history, "message-4", deepcopy(first))
            merge(history, "message-4", deepcopy(second))

            usage = history["messages"]["message-4"]["usage"]
            self.assertEqual(usage["prompt_tokens"], 10)
            self.assertEqual(usage["completion_tokens"], 3)
            self.assertEqual(usage["total_tokens"], 13)
            self.assertEqual(usage["cached_tokens"], 8)
            self.assertEqual(usage["cache_read_input_tokens"], 8)
            self.assertEqual(usage["cache_creation_input_tokens"], 5)
            self.assertEqual(usage["cache_write_input_tokens"], 5)
            self.assertEqual(usage["cost"], 1.4)
            self.assertEqual(usage["prompt_tokens_details"]["cached_tokens"], 8)
            self.assertEqual(usage["prompt_tokens_details"]["cache_read_tokens"], 8)
            self.assertEqual(usage["prompt_tokens_details"]["cache_creation_tokens"], 5)


if __name__ == "__main__":
    unittest.main()
