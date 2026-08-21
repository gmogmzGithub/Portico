import importlib.util
import pathlib
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "src" / "filters" / "unified_context.py"
SPEC = importlib.util.spec_from_file_location(
    "unified_context_reasoning_test", MODULE_PATH
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)

BASE_PROMPT_PATH = REPO_ROOT / "agents" / "base_system_prompt.md"


class ExtractRequestReasoningEffortTests(unittest.TestCase):
    def _extract(self, body):
        return MODULE.Filter._extract_request_reasoning_effort(body)

    def test_reads_effort_from_request_params(self):
        self.assertEqual(
            self._extract({"params": {"reasoning_effort": "high"}}), "high"
        )
        self.assertEqual(
            self._extract({"params": {"reasoning_effort": "  medium  "}}), "medium"
        )

    def test_missing_or_empty_effort_returns_empty_string(self):
        self.assertEqual(self._extract({"params": {}}), "")
        self.assertEqual(self._extract({"params": {"reasoning_effort": ""}}), "")
        self.assertEqual(self._extract({"params": {"reasoning_effort": None}}), "")
        self.assertEqual(self._extract({}), "")

    def test_non_string_effort_values_are_ignored(self):
        # Only string efforts are surfaced; a numeric/bool/collection must never be
        # stringified ("5"/"True"/...) into the injected <reasoning_effort> tag.
        self.assertEqual(self._extract({"params": {"reasoning_effort": 5}}), "")
        self.assertEqual(self._extract({"params": {"reasoning_effort": True}}), "")
        self.assertEqual(self._extract({"params": {"reasoning_effort": ["high"]}}), "")
        self.assertEqual(self._extract({"params": {"reasoning_effort": {"v": 1}}}), "")

    def test_non_dict_inputs_are_safe(self):
        self.assertEqual(self._extract(None), "")
        self.assertEqual(self._extract("nope"), "")
        self.assertEqual(self._extract({"params": "nope"}), "")
        self.assertEqual(self._extract([]), "")


class BasePromptReasoningGuidanceTests(unittest.TestCase):
    def setUp(self):
        self.prompt = BASE_PROMPT_PATH.read_text(encoding="utf-8")

    def test_prompt_has_reasoning_effort_inheritance_section(self):
        self.assertIn("Default Reasoning Effort Inheritance", self.prompt)
        # Instructs inheriting the current chat's effort from the injected context.
        self.assertIn("<reasoning_effort>", self.prompt)
        self.assertIn("reasoning_effort", self.prompt)

    def test_prompt_lists_the_three_override_sources(self):
        section = self.prompt.split("### Default Reasoning Effort Inheritance", 1)[1]
        section = section.split("### Source of Truth for Model Names", 1)[0].lower()
        self.assertIn("user", section)
        self.assertIn("system prompt", section)
        self.assertIn("skill", section)


if __name__ == "__main__":
    unittest.main()
