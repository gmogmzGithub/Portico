"""PORTICO-410 hard-disable opacity tests for the unified context filter.

A hard-disabled MCP server must be fully opaque to the model: absent from the
<disabled> listing, absent from every <integrations_status> section (even when
mcp_toggles.json is unreadable and toggle checks fail open), while its stale
tool history is still scrubbed.
"""

import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "src" / "filters" / "unified_context.py"
SPEC = importlib.util.spec_from_file_location("unified_context_disable_modes_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def build_filter():
    instance = MODULE.Filter.__new__(MODULE.Filter)
    instance.valves = MODULE.Filter.Valves()
    instance.redis_client = None
    instance.ldap_id = "tester"
    instance.user_name = "Tester"
    instance._toggles_cache = None
    instance._disable_modes_cache = None
    instance._cached_disabled_integrations = None
    instance._cached_unconfigured = None
    instance._cached_unauthenticated = None
    instance._unconfigured_server_ids = set()
    instance._unauthenticated_server_ids = set()
    instance._health_status_snapshot_cache = {}
    return instance


def write_modes_file(payload) -> str:
    handle = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, prefix="disable-modes-"
    )
    with handle as f:
        if isinstance(payload, str):
            f.write(payload)
        else:
            json.dump(payload, f)
    return handle.name


class DisableModesLoaderTests(unittest.TestCase):
    def _load_with_file(self, payload):
        modes_path = write_modes_file(payload)
        self.addCleanup(os.unlink, modes_path)
        instance = build_filter()
        with mock.patch.dict(os.environ, {"PORTICO_DISABLE_MODES_PATH": modes_path}):
            return instance, instance._load_disable_modes()

    def test_bare_map_is_loaded_and_non_hard_values_are_kept_lowercased(self):
        _, modes = self._load_with_file({"n8n": "HARD", "slack": "soft"})
        self.assertEqual(modes, {"n8n": "hard", "slack": "soft"})

    def test_snapshot_wrapper_is_unwrapped(self):
        _, modes = self._load_with_file(
            {"schemaVersion": 1, "revision": "sha256:abc", "modes": {"n8n": "hard"}}
        )
        self.assertEqual(modes, {"n8n": "hard"})

    def test_non_string_values_are_dropped(self):
        _, modes = self._load_with_file({"n8n": "hard", "bad": 42, "worse": True})
        self.assertEqual(modes, {"n8n": "hard"})

    def test_corrupt_file_fails_open_to_empty(self):
        _, modes = self._load_with_file("{definitely not json")
        self.assertEqual(modes, {})

    def test_missing_file_fails_open_to_empty(self):
        instance = build_filter()
        with mock.patch.dict(
            os.environ,
            {"PORTICO_DISABLE_MODES_PATH": "/nonexistent/disable-modes.json"},
        ):
            self.assertEqual(instance._load_disable_modes(), {})

    def test_result_is_cached_per_request_until_reset(self):
        modes_path = write_modes_file({"n8n": "hard"})
        self.addCleanup(os.unlink, modes_path)
        instance = build_filter()
        with mock.patch.dict(os.environ, {"PORTICO_DISABLE_MODES_PATH": modes_path}):
            self.assertTrue(instance._is_server_hard_disabled("n8n"))
            with open(modes_path, "w") as f:
                json.dump({}, f)
            self.assertTrue(
                instance._is_server_hard_disabled("n8n"),
                "cached value must persist within a request",
            )
            instance._disable_modes_cache = None
            self.assertFalse(
                instance._is_server_hard_disabled("n8n"),
                "inlet reset must pick up the new file contents",
            )

    def test_server_prefix_is_stripped_for_lookup(self):
        instance = build_filter()
        instance._disable_modes_cache = {"n8n": "hard"}
        self.assertTrue(instance._is_server_hard_disabled("server:n8n"))
        self.assertTrue(instance._is_server_hard_disabled("n8n"))
        self.assertFalse(instance._is_server_hard_disabled("slack"))
        self.assertFalse(instance._is_server_hard_disabled(""))

    def test_hard_id_set_ignores_blank_ids_and_non_hard_modes(self):
        instance = build_filter()
        instance._disable_modes_cache = {
            "n8n": "hard",
            "  ": "hard",
            "": "hard",
            "slack": "soft",
        }
        self.assertEqual(instance._get_hard_disabled_server_ids(), {"n8n"})


class DisabledIntegrationsOpacityTests(unittest.TestCase):
    def _run_get_disabled(self, instance, configs):
        """Drive _get_disabled_integrations against an in-memory config dir."""
        yaml_stub = mock.Mock()
        yaml_stub.safe_load = mock.Mock(side_effect=list(configs.values()))
        listdir = mock.Mock(return_value=list(configs.keys()))
        with mock.patch.object(MODULE.os, "listdir", listdir), \
                mock.patch.object(MODULE.os.path, "isdir", return_value=True), \
                mock.patch.object(MODULE.os.path, "isfile", return_value=True), \
                mock.patch.object(MODULE, "YAML_AVAILABLE", True), \
                mock.patch.object(MODULE, "yaml", yaml_stub, create=True), \
                mock.patch("builtins.open", mock.mock_open(read_data="unused: true")):
            return instance._get_disabled_integrations()

    def test_hard_disabled_servers_vanish_from_the_disabled_listing(self):
        instance = build_filter()
        instance._toggles_cache = {"n8n": False, "slack": False}
        instance._disable_modes_cache = {"n8n": "hard"}

        disabled = self._run_get_disabled(
            instance,
            {
                "n8n": {"id": "n8n", "display_name": "n8n", "description": "workflows"},
                "slack": {"id": "slack", "display_name": "Slack", "description": "chat"},
            },
        )

        self.assertEqual([info["id"] for info in disabled], ["slack"])

    def test_soft_disabled_servers_still_appear(self):
        instance = build_filter()
        instance._toggles_cache = {"n8n": False}
        instance._disable_modes_cache = {}

        disabled = self._run_get_disabled(
            instance,
            {"n8n": {"id": "n8n", "display_name": "n8n", "description": "workflows"}},
        )

        self.assertEqual([info["id"] for info in disabled], ["n8n"])


class IntegrationsStatusBeltAndBracesTests(unittest.TestCase):
    def _build_block(self, instance, metadata):
        instance._cached_disabled_integrations = []
        instance._cached_unconfigured = []
        instance._cached_unauthenticated = []
        return instance._build_integrations_status_context(
            metadata,
            enabled_tool_ids=[],
            chat_id=None,
            include_active=True,
            include_inactive=True,
            include_setup_guidance=False,
        )

    def test_hard_disabled_server_never_surfaces_even_when_toggles_fail_open(self):
        instance = build_filter()
        # Unreadable toggles simulate the fail-open path: every server reads
        # as toggled on, so only the hard-disable check can keep it out.
        instance._toggles_cache = {}
        instance._disable_modes_cache = {"n8n": "hard"}

        block = instance._build_integrations_status_context(
            {
                "n8n": {
                    "id": "n8n",
                    "display_name": "n8n",
                    "description": "workflows",
                    "is_core": False,
                    "always_enabled": False,
                    "oauth": False,
                },
            },
            enabled_tool_ids=[],
            chat_id=None,
        )
        # With the sole candidate hard-disabled the whole block collapses.
        self.assertNotIn("n8n", block)

        instance._disable_modes_cache = {}
        instance._cached_disabled_integrations = None
        block_without_hard = instance._build_integrations_status_context(
            {
                "n8n": {
                    "id": "n8n",
                    "display_name": "n8n",
                    "description": "workflows",
                    "is_core": False,
                    "always_enabled": False,
                    "oauth": False,
                },
            },
            enabled_tool_ids=[],
            chat_id=None,
        )
        self.assertIn(
            "n8n",
            block_without_hard,
            "without a hard mode the same server must surface (guards test validity)",
        )

    def test_core_servers_are_not_hidden_by_stray_hard_entries(self):
        instance = build_filter()
        instance._toggles_cache = {}
        instance._disable_modes_cache = {"mcp-assistant": "hard"}

        block = instance._build_integrations_status_context(
            {
                "mcp-assistant": {
                    "id": "mcp-assistant",
                    "display_name": "MCP Assistant",
                    "description": "core",
                    "is_core": True,
                    "always_enabled": True,
                    "oauth": False,
                },
            },
            enabled_tool_ids=[],
            chat_id=None,
        )
        self.assertIn("mcp-assistant", block)


class ToolServersCatalogOpacityTests(unittest.TestCase):
    def test_hard_disabled_server_never_reaches_the_tool_catalog(self):
        instance = build_filter()
        # Stale/fail-open toggles claim the server is enabled — the modes
        # check alone must keep it out (observed live: file-bind staleness).
        instance._toggles_cache = {"n8n-community-fork": True}
        instance._disable_modes_cache = {"n8n-community-fork": "hard"}

        block = instance._build_tools_context(
            [
                {"id": "server:n8n-community-fork", "name": "n8n (Community Fork)", "description": "legacy"},
                {"id": "server:slack", "name": "Slack", "description": "chat"},
            ],
            [],
            {
                "n8n-community-fork": {"is_core": False, "user_installed": True},
                "slack": {"is_core": False, "user_installed": False},
            },
            include_available=True,
            include_enabled=False,
        )

        self.assertNotIn("n8n-community-fork", block)
        self.assertIn("server:slack", block)


class TogglesSnapshotFirstTests(unittest.TestCase):
    def test_toggles_prefer_the_snapshot_wrapper(self):
        instance = build_filter()
        snapshot = write_modes_file(
            {"schemaVersion": 1, "revision": "sha256:x", "toggles": {"n8n-community-fork": False}}
        )
        self.addCleanup(os.unlink, snapshot)
        real_open = open

        def fake_open(path, *args, **kwargs):
            if path == "/app/health-status/mcp_toggles_snapshot.json":
                return real_open(snapshot, *args, **kwargs)
            if path == "/app/mcp_toggles.json":
                raise FileNotFoundError(path)
            return real_open(path, *args, **kwargs)

        with mock.patch("builtins.open", side_effect=fake_open):
            self.assertEqual(
                instance._load_toggles(), {"n8n-community-fork": False}
            )


class HistorySanitizeUnionTests(unittest.TestCase):
    def test_union_includes_hard_disabled_ids_missing_from_the_listing(self):
        instance = build_filter()
        instance._cached_disabled_integrations = [
            {"id": "slack", "name": "Slack", "description": "", "auth_type": "token"}
        ]
        instance._disable_modes_cache = {"n8n": "hard"}

        self.assertEqual(
            instance._get_history_sanitize_server_ids(),
            {"slack", "n8n"},
        )

    def test_hard_disabled_history_is_rewritten(self):
        instance = build_filter()
        instance._cached_disabled_integrations = []
        instance._disable_modes_cache = {"n8n": "hard"}

        messages = [
            {
                "role": "assistant",
                "content": "ok",
                "tool_calls": [
                    {"id": "call-1", "function": {"name": "n8n_run_workflow"}}
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call-1",
                "content": "workflow output",
            },
        ]
        sanitized = instance._sanitize_disabled_tool_history(
            messages, instance._get_history_sanitize_server_ids()
        )

        self.assertGreaterEqual(sanitized, 1)
        self.assertIn("disabled by the user", messages[1]["content"])


if __name__ == "__main__":
    unittest.main()


class NeedsConfigAuthHardDisableOpacityTests(unittest.TestCase):
    """Hard-disabled servers must be absent from <needs_config>/<needs_auth>.

    These listings gate on _is_server_toggled_on, which fails OPEN for an
    ABSENT toggle key — and set-mcp-disable-mode accepts absent-toggle
    servers. Without an explicit hard-disable check a hard-disabled but
    never-toggled server would still surface to the model.
    """

    def _run_listing(self, fn_name, yaml_text, modes, phase):
        import shutil

        instance = build_filter()
        instance._toggles_cache = {}  # absent key = fail-open "toggled on"
        instance._disable_modes_cache = modes
        instance._load_health_status_snapshot = lambda: {}
        instance._readiness_from_health_snapshot = lambda sid, snap: {
            "readiness_phase": phase
        }

        tmp = tempfile.mkdtemp(prefix="uc-hard-opacity-")
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, "testsrv"))
        with open(os.path.join(tmp, "testsrv", "testsrv.yaml"), "w") as f:
            f.write(yaml_text)

        real_isdir = os.path.isdir
        real_isfile = os.path.isfile
        real_listdir = os.listdir
        real_open = open

        def redirect(p):
            if isinstance(p, str) and p.startswith("/app/mcp-configs"):
                return p.replace("/app/mcp-configs", tmp, 1)
            return p

        with mock.patch.object(
            MODULE.os, "listdir", side_effect=lambda p: real_listdir(redirect(p))
        ), mock.patch.object(
            MODULE.os.path, "isdir", side_effect=lambda p: real_isdir(redirect(p))
        ), mock.patch.object(
            MODULE.os.path, "isfile", side_effect=lambda p: real_isfile(redirect(p))
        ), mock.patch(
            "builtins.open",
            side_effect=lambda p, *a, **k: real_open(redirect(p), *a, **k),
        ):
            return getattr(instance, fn_name)()

    UNCONFIGURED_YAML = (
        "id: testsrv\n"
        "display_name: Test Server\n"
        "description: fixture\n"
        "required_env_vars:\n"
        "  - name: API_KEY\n"
    )
    OAUTH_YAML = (
        "id: testsrv\n"
        "display_name: Test Server\n"
        "description: fixture\n"
        "oauth:\n"
        "  requires_user_authorization: true\n"
    )

    def test_hard_disabled_absent_toggle_excluded_from_needs_config(self):
        listed = self._run_listing(
            "_get_unconfigured_integrations",
            self.UNCONFIGURED_YAML,
            {"testsrv": "hard"},
            "needs_config",
        )
        self.assertEqual(listed, [])

    def test_positive_control_unconfigured_surfaces_without_hard_mode(self):
        listed = self._run_listing(
            "_get_unconfigured_integrations",
            self.UNCONFIGURED_YAML,
            {},
            "needs_config",
        )
        self.assertEqual([info["id"] for info in listed], ["testsrv"])

    def test_hard_disabled_absent_toggle_excluded_from_needs_auth(self):
        listed = self._run_listing(
            "_get_unauthenticated_integrations",
            self.OAUTH_YAML,
            {"testsrv": "hard"},
            "needs_oauth",
        )
        self.assertEqual(listed, [])

    def test_positive_control_unauthenticated_surfaces_without_hard_mode(self):
        listed = self._run_listing(
            "_get_unauthenticated_integrations",
            self.OAUTH_YAML,
            {},
            "needs_oauth",
        )
        self.assertEqual([info["id"] for info in listed], ["testsrv"])
