import ast
import json
import re
from pathlib import Path
from typing import Any, Optional


class _FakeLog:
    def debug(self, *args, **kwargs):
        return None

    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


def _load_tool_ordering_helpers():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    )
    module_ast = ast.parse(source_path.read_text())
    wanted_functions = {
        "_is_openai_prompt_cache_tool_model",
        "_is_gpt5_responses_api_model",
        "_get_gpt_openai_route_mode",
        "_canonicalize_openai_tool_value",
        "_stable_tool_payload_dump",
        "_normalize_server_id",
        "_sanitize_tool_name",
        "_build_tool_namespace_metadata",
        "_trim_openai_tool_description",
        "_compact_openai_parameter_schema",
        "_compact_openai_function_tool",
        "_load_openai_prompt_cache_server_allowlist",
        "_tool_payload_matches_server_allowlist",
        "_openai_tool_sort_key",
        "_canonicalize_openai_function_tools",
        "_normalize_openai_function_tools_payloads",
        "_build_openai_function_tools_payload",
        "_rebuild_followup_function_tools_payload",
    }
    selected_nodes = [
        node
        for node in module_ast.body
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions
    ]

    namespace = {
        "Any": Any,
        "Optional": Optional,
        "DYNAMIC_TOOLS_REDIS_AVAILABLE": False,
        "RedisClient": None,
        "get_skill_manager": None,
        "_OPENAI_PROMPT_CACHE_CORE_SERVER_IDS": frozenset(
            {"mcp-assistant", "skills", "subagents"}
        ),
        "_GPT_OPENAI_ROUTE_MODE_ENV": "GPT_OPENAI_ROUTE_MODE",
        "_GPT_OPENAI_ROUTE_MODE_DIRECT": "direct",
        "_GPT_OPENAI_ROUTE_MODE_BIFROST": "bifrost",
        "_load_server_metadata": lambda server_id: {
            "description": f"{server_id} description",
            "is_core": server_id in {"skills", "mcp-assistant", "subagents"},
        },
        "_TOOL_NAME_SANITIZE_RE": re.compile(r"[^A-Za-z0-9_]+"),
        "json": json,
        "log": _FakeLog(),
        "os": __import__("os"),
        "re": re,
    }
    exec(
        compile(
            ast.Module(body=selected_nodes, type_ignores=[]),
            str(source_path),
            "exec",
        ),
        namespace,
    )
    return namespace


def test_gpt_tool_payload_is_sorted_and_canonicalized():
    helpers = _load_tool_ordering_helpers()
    build_payload = helpers["_build_openai_function_tools_payload"]

    tools_dict = {
        "zeta_tool": {
            "spec": {
                "parameters": {
                    "type": "object",
                    "properties": {
                        "b": {"type": "string"},
                        "a": {"type": "string"},
                    },
                },
                "name": "zeta_tool",
                "description": "Run zeta",
            }
        },
        "alpha_tool": {
            "spec": {
                "parameters": {
                    "required": ["x"],
                    "type": "object",
                    "properties": {
                        "x": {"description": "value", "type": "string"},
                    },
                },
                "description": "Run alpha",
                "name": "alpha_tool",
            }
        },
    }

    payload = build_payload(tools_dict, "GPT-5.4")

    assert [tool["function"]["name"] for tool in payload] == [
        "alpha_tool",
        "zeta_tool",
    ]
    assert list(payload[0]["function"].keys()) == [
        "description",
        "name",
        "parameters",
    ]
    assert payload[0]["function"]["parameters"] == {
        "properties": {"x": {"type": "string"}},
        "required": ["x"],
        "type": "object",
    }
    assert payload[1]["function"]["parameters"] == {
        "properties": {
            "a": {"type": "string"},
            "b": {"type": "string"},
        },
        "type": "object",
    }


def test_gpt_route_helpers_detect_prompt_cache_and_responses_api_models(monkeypatch):
    helpers = _load_tool_ordering_helpers()
    is_prompt_cache_tool_model = helpers["_is_openai_prompt_cache_tool_model"]
    is_gpt5_responses_api_model = helpers["_is_gpt5_responses_api_model"]
    get_route_mode = helpers["_get_gpt_openai_route_mode"]

    assert is_prompt_cache_tool_model("GPT-5.5") is True
    assert is_prompt_cache_tool_model("GPT-5.4") is True
    assert is_prompt_cache_tool_model("gpt-4.1-mini") is True
    assert is_prompt_cache_tool_model("GPT-5.4 Pro") is False
    assert is_prompt_cache_tool_model("Atlas Opus 4.6") is False

    assert is_gpt5_responses_api_model("gpt-5") is True
    assert is_gpt5_responses_api_model("gpt-5.5") is True
    assert is_gpt5_responses_api_model("gpt-5.4") is True
    assert is_gpt5_responses_api_model("gpt-4.1") is False

    monkeypatch.delenv("GPT_OPENAI_ROUTE_MODE", raising=False)
    assert get_route_mode() == "direct"

    monkeypatch.setenv("GPT_OPENAI_ROUTE_MODE", "bifrost")
    assert get_route_mode() == "bifrost"

    monkeypatch.setenv("GPT_OPENAI_ROUTE_MODE", "invalid")
    assert get_route_mode() == "direct"


def test_trim_openai_tool_description_normalizes_whitespace_and_handles_invalid_values():
    helpers = _load_tool_ordering_helpers()
    trim_description = helpers["_trim_openai_tool_description"]

    assert trim_description(None) is None
    assert trim_description("   ") is None
    assert trim_description("  Search   company   docs  ") == "Search company docs"
    assert trim_description("x" * 260, max_chars=10) == "xxxxxxx..."


def test_compact_openai_parameter_schema_handles_nested_objects_lists_and_unions():
    helpers = _load_tool_ordering_helpers()
    compact_schema = helpers["_compact_openai_parameter_schema"]

    result = compact_schema(
        {
            "type": ["object", "null"],
            "required": ["z", "a", 1],
            "properties": {
                "config": {
                    "type": "object",
                    "additionalProperties": {
                        "type": "array",
                        "items": {"type": "integer", "description": "ignored"},
                    },
                },
                "mode": {
                    "anyOf": [
                        {"type": "string", "enum": ["fast", "safe"]},
                        {"type": "null"},
                    ]
                },
            },
        }
    )

    assert result == {
        "type": ["object", "null"],
        "required": ["a", "z"],
        "properties": {
            "config": {
                "type": "object",
                "properties": {},
                "additionalProperties": {
                    "type": "array",
                    "items": {"type": "integer"},
                },
            },
            "mode": {
                "anyOf": [
                    {"type": "string", "enum": ["fast", "safe"]},
                    {"type": "null"},
                ]
            },
        },
    }


def test_compact_openai_function_tool_passes_through_non_function_and_malformed_payloads():
    helpers = _load_tool_ordering_helpers()
    compact_tool = helpers["_compact_openai_function_tool"]

    assert compact_tool("bad") == {}
    assert compact_tool({"type": "web_search", "query": {"z": 1, "a": 2}}) == {
        "query": {"a": 2, "z": 1},
        "type": "web_search",
    }
    assert compact_tool({"type": "function", "function": "bad"}) == {
        "function": "bad",
        "type": "function",
    }


def test_gpt_tool_payload_compacts_verbose_schema_fields():
    helpers = _load_tool_ordering_helpers()
    build_payload = helpers["_build_openai_function_tools_payload"]

    tools_dict = {
        "verbose_tool": {
            "spec": {
                "name": "verbose_tool",
                "description": " ".join(["Very detailed"] * 80),
                "parameters": {
                    "type": "object",
                    "title": "VerboseArgs",
                    "properties": {
                        "script": {
                            "type": "string",
                            "description": "Run this script inside the VM with all the details.",
                            "examples": ["print('hi')"],
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["fast", "safe"],
                            "default": "fast",
                        },
                    },
                    "required": ["script"],
                    "$defs": {
                        "vm_ref": {
                            "type": "object",
                            "description": "A verbose nested definition.",
                            "properties": {
                                "vm_id": {
                                    "type": "string",
                                    "description": "Agent VM identifier",
                                }
                            },
                        }
                    },
                },
                "strict": True,
            }
        }
    }

    payload = build_payload(tools_dict, "GPT-5.4")
    function = payload[0]["function"]
    parameters = function["parameters"]

    assert len(function["description"]) <= 240
    assert function["description"].endswith("...")
    assert parameters == {
        "properties": {
            "mode": {
                "enum": ["fast", "safe"],
                "type": "string",
            },
            "script": {
                "type": "string",
            },
        },
        "required": ["script"],
        "type": "object",
    }
    assert function["strict"] is True


def test_followup_tool_payload_rebuild_respects_existing_tool_allowlist():
    helpers = _load_tool_ordering_helpers()
    rebuild_payload = helpers["_rebuild_followup_function_tools_payload"]

    existing_tool_payloads = [
        {
            "type": "function",
            "function": {
                "name": "glean_search",
                "description": "Search company knowledge",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]
    metadata_tools = {
        "agent_vm_bash": {
            "spec": {
                "name": "agent_vm_bash",
                "description": "Run bash",
                "parameters": {"type": "object", "properties": {}},
            }
        },
        "subagents_run_subagent": {
            "spec": {
                "name": "subagents_run_subagent",
                "description": "Run a subagent",
                "parameters": {"type": "object", "properties": {}},
            }
        },
        "glean_search": {
            "spec": {
                "name": "glean_search",
                "description": "Search company knowledge",
                "parameters": {"type": "object", "properties": {}},
            }
        },
    }

    payload = rebuild_payload(
        existing_tool_payloads=existing_tool_payloads,
        metadata_tools=metadata_tools,
        model_name="GPT-5.4",
        chat_id="chat-123",
    )

    assert [tool["function"]["name"] for tool in payload] == ["glean_search"]


def test_followup_tool_payload_rebuild_prefers_core_allowlist_over_existing_payload_names():
    helpers = _load_tool_ordering_helpers()
    rebuild_payload = helpers["_rebuild_followup_function_tools_payload"]

    class _FakeRedis:
        def get(self, key):
            if key == "chat_skills:chat-123":
                return None
            if key == "chat_tools:chat-123":
                return json.dumps(["server:google_workspace"])
            return None

    helpers["DYNAMIC_TOOLS_REDIS_AVAILABLE"] = True
    helpers["RedisClient"] = lambda **kwargs: _FakeRedis()
    helpers["get_skill_manager"] = None

    payload = rebuild_payload(
        existing_tool_payloads=[
            {
                "type": "function",
                "function": {
                    "name": "skills_list_skills",
                    "description": "skills",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        metadata_tools={
            "skills_list_skills": {
                "spec": {
                    "name": "skills_list_skills",
                    "description": "skills",
                    "parameters": {"type": "object", "properties": {}},
                }
            },
            "google_workspace_get_events": {
                "spec": {
                    "name": "google_workspace_get_events",
                    "description": "calendar",
                    "parameters": {"type": "object", "properties": {}},
                }
            },
        },
        model_name="GPT-5.4",
        chat_id="chat-123",
        prefer_core_tool_allowlist=True,
    )

    assert [tool["function"]["name"] for tool in payload] == [
        "google_workspace_get_events",
        "skills_list_skills",
    ]


def test_followup_tool_payload_rebuild_uses_full_metadata_registry_when_allowlist_missing():
    helpers = _load_tool_ordering_helpers()
    rebuild_payload = helpers["_rebuild_followup_function_tools_payload"]

    metadata_tools = {
        "agent_vm_bash": {
            "spec": {
                "name": "agent_vm_bash",
                "description": "Run bash",
                "parameters": {"type": "object", "properties": {}},
            }
        },
        "subagents_run_subagent": {
            "spec": {
                "name": "subagents_run_subagent",
                "description": "Run a subagent",
                "parameters": {"type": "object", "properties": {}},
            }
        },
        "glean_search": {
            "spec": {
                "name": "glean_search",
                "description": "Search company knowledge",
                "parameters": {"type": "object", "properties": {}},
            }
        },
    }

    payload = rebuild_payload(
        existing_tool_payloads=[],
        metadata_tools=metadata_tools,
        model_name="GPT-5.4",
        chat_id="chat-123",
    )

    assert len(payload) == 3
    descriptions = {tool["function"]["description"] for tool in payload}
    assert descriptions == {
        "Run bash",
        "Run a subagent",
        "Search company knowledge",
    }


def test_followup_tool_payload_rebuild_preserves_local_tools_after_external_prune():
    helpers = _load_tool_ordering_helpers()
    rebuild_payload = helpers["_rebuild_followup_function_tools_payload"]

    metadata_tools = {
        "agent_vm_execute_skill_script": {
            "spec": {
                "name": "agent_vm_execute_skill_script",
                "description": "Run skill script",
                "parameters": {"type": "object", "properties": {}},
            }
        }
    }

    payload = rebuild_payload(
        existing_tool_payloads=[],
        metadata_tools=metadata_tools,
        model_name="Atlas Opus 4.6",
        chat_id="chat-123",
    )

    assert [tool["function"]["name"] for tool in payload] == [
        "agent_vm_execute_skill_script"
    ]


def test_followup_tool_payload_rebuild_falls_back_to_existing_gpt_payloads():
    helpers = _load_tool_ordering_helpers()
    rebuild_payload = helpers["_rebuild_followup_function_tools_payload"]

    existing_tool_payloads = [
        {
            "type": "function",
            "function": {
                "name": "glean_search",
                "description": "Search company knowledge",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]

    payload = rebuild_payload(
        existing_tool_payloads=existing_tool_payloads,
        metadata_tools=None,
        model_name="GPT-5.4",
        chat_id="chat-123",
    )

    assert [tool["function"]["name"] for tool in payload] == ["glean_search"]


def test_gpt_tool_payload_preserves_nested_array_and_union_shape():
    helpers = _load_tool_ordering_helpers()
    build_payload = helpers["_build_openai_function_tools_payload"]

    tools_dict = {
        "complex_tool": {
            "spec": {
                "name": "complex_tool",
                "description": "Complex tool",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "entries": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {
                                        "type": "string",
                                        "description": "Entry name",
                                    },
                                    "count": {
                                        "type": "integer",
                                        "default": 0,
                                    },
                                },
                                "required": ["name"],
                            },
                        },
                        "mode": {
                            "oneOf": [
                                {"type": "string", "enum": ["fast", "safe"]},
                                {"type": "null"},
                            ]
                        },
                    },
                    "additionalProperties": False,
                },
            }
        }
    }

    payload = build_payload(tools_dict, "GPT-5.4")
    parameters = payload[0]["function"]["parameters"]

    assert parameters == {
        "additionalProperties": False,
        "properties": {
            "entries": {
                "items": {
                    "properties": {
                        "count": {"type": "integer"},
                        "name": {"type": "string"},
                    },
                    "required": ["name"],
                    "type": "object",
                },
                "type": "array",
            },
            "mode": {
                "oneOf": [
                    {"enum": ["fast", "safe"], "type": "string"},
                    {"type": "null"},
                ]
            },
        },
        "type": "object",
    }


def test_gpt_tool_payload_preserves_empty_object_properties_for_no_arg_tools():
    helpers = _load_tool_ordering_helpers()
    build_payload = helpers["_build_openai_function_tools_payload"]

    tools_dict = {
        "no_arg_tool": {
            "spec": {
                "name": "no_arg_tool",
                "description": "No arg tool",
                "parameters": {
                    "type": "object",
                },
            }
        }
    }

    payload = build_payload(tools_dict, "GPT-5.4")

    assert payload[0]["function"]["parameters"] == {
        "properties": {},
        "type": "object",
    }


def test_tool_payload_matches_server_allowlist_uses_normalized_prefixes():
    helpers = _load_tool_ordering_helpers()
    matches_allowlist = helpers["_tool_payload_matches_server_allowlist"]

    assert matches_allowlist(
        {"type": "function", "function": {"name": "google_workspace_get_events"}},
        {"google_workspace"},
    ) is True
    assert matches_allowlist(
        {"type": "function", "function": {"name": "agent_vm_bash"}},
        {"agent-vm"},
    ) is True
    assert matches_allowlist(
        {"type": "function", "function": {"name": "slack_post_message"}},
        {"google_workspace", "agent-vm"},
    ) is False
    assert matches_allowlist({"type": "function"}, {"google_workspace"}) is True


def test_non_gpt_tool_payload_preserves_existing_order():
    helpers = _load_tool_ordering_helpers()
    build_payload = helpers["_build_openai_function_tools_payload"]

    tools_dict = {
        "zeta_tool": {
            "spec": {
                "parameters": {"type": "object"},
                "name": "zeta_tool",
            }
        },
        "alpha_tool": {
            "spec": {
                "parameters": {"type": "object"},
                "name": "alpha_tool",
            }
        },
    }

    payload = build_payload(tools_dict, "Atlas Sonnet 4.6")

    assert [tool["function"]["name"] for tool in payload] == [
        "zeta_tool",
        "alpha_tool",
    ]


def test_non_gpt_tool_payload_preserves_verbose_schema_fields():
    helpers = _load_tool_ordering_helpers()
    build_payload = helpers["_build_openai_function_tools_payload"]

    tools_dict = {
        "verbose_tool": {
            "spec": {
                "name": "verbose_tool",
                "description": "Verbose tool",
                "parameters": {
                    "type": "object",
                    "title": "VerboseArgs",
                    "properties": {
                        "script": {
                            "type": "string",
                            "description": "Run this script inside the VM.",
                            "default": "print('hi')",
                        }
                    },
                    "required": ["script"],
                },
            }
        }
    }

    payload = build_payload(tools_dict, "Atlas Sonnet 4.6")

    assert payload[0]["function"]["parameters"]["title"] == "VerboseArgs"
    assert (
        payload[0]["function"]["parameters"]["properties"]["script"]["description"]
        == "Run this script inside the VM."
    )
    assert (
        payload[0]["function"]["parameters"]["properties"]["script"]["default"]
        == "print('hi')"
    )


def test_build_tool_namespace_metadata_prefers_explicit_tool_server_ids():
    helpers = _load_tool_ordering_helpers()
    build_namespace_metadata = helpers["_build_tool_namespace_metadata"]

    metadata = build_namespace_metadata(
        {
            "google_workspace_get_events": {
                "spec": {"name": "google_workspace_get_events"},
                "server_id": "google_workspace",
            },
            "agent_vm_bash": {
                "spec": {"name": "agent_vm_bash"},
            },
        },
        tool_ids=["server:agent-vm", "server:slack"],
    )

    assert metadata == {
        "google_workspace": {
            "description": "google_workspace description",
            "server_id": "google_workspace",
            "is_core": False,
        },
    }


def test_build_tool_namespace_metadata_uses_tool_id_fallback_when_tool_entries_lack_server_ids():
    helpers = _load_tool_ordering_helpers()
    build_namespace_metadata = helpers["_build_tool_namespace_metadata"]

    metadata = build_namespace_metadata(
        {
            "agent_vm_bash": {
                "spec": {"name": "agent_vm_bash"},
            },
            "misc_tool": {
                "spec": {"name": "misc_tool"},
            },
        },
        tool_ids=["server:agent-vm", "server:slack"],
    )

    assert metadata == {
        "agent_vm": {
            "description": "agent-vm description",
            "server_id": "agent-vm",
            "is_core": False,
        }
    }


def test_gpt_tool_payload_prefers_core_and_activated_skill_servers():
    helpers = _load_tool_ordering_helpers()
    normalize_payloads = helpers["_normalize_openai_function_tools_payloads"]

    class _FakeRedis:
        def get(self, key):
            if key == "chat_skills:chat-123":
                return json.dumps(["code-execution"])
            if key == "chat_tools:chat-123":
                return None
            raise AssertionError(key)

    class _FakeSkillMetadata:
        required_mcp_servers = ["server:agent-vm"]

    class _FakeSkillManager:
        def get_skill_metadata(self, skill_name):
            assert skill_name == "code-execution"
            return _FakeSkillMetadata()

    helpers["DYNAMIC_TOOLS_REDIS_AVAILABLE"] = True
    helpers["RedisClient"] = lambda **kwargs: _FakeRedis()
    helpers["get_skill_manager"] = lambda: _FakeSkillManager()

    payload = normalize_payloads(
        [
            {"type": "function", "function": {"name": "agent_vm_python"}},
            {"type": "function", "function": {"name": "skills_list_skills"}},
            {"type": "function", "function": {"name": "subagents_run_subagent"}},
            {"type": "function", "function": {"name": "mcp_assistant_get_chat_tools"}},
            {"type": "function", "function": {"name": "google_workspace_create_doc"}},
        ],
        chat_id="chat-123",
    )

    assert [tool["function"]["name"] for tool in payload] == [
        "agent_vm_python",
        "mcp_assistant_get_chat_tools",
        "skills_list_skills",
        "subagents_run_subagent",
    ]


def test_load_openai_prompt_cache_server_allowlist_returns_none_on_missing_chat_or_redis_failure():
    helpers = _load_tool_ordering_helpers()
    allowlist_loader = helpers["_load_openai_prompt_cache_server_allowlist"]

    assert allowlist_loader(None) is None

    helpers["DYNAMIC_TOOLS_REDIS_AVAILABLE"] = True

    class _ExplodingRedis:
        def __init__(self, **_kwargs):
            raise RuntimeError("redis down")

    helpers["RedisClient"] = _ExplodingRedis
    helpers["get_skill_manager"] = None

    assert allowlist_loader("chat-123") is None


def test_gpt_bifrost_tool_payload_does_not_prune_without_chat_allowlist():
    helpers = _load_tool_ordering_helpers()
    build_payload = helpers["_build_openai_function_tools_payload"]

    tools_dict = {
        "google_workspace_get_events": {
            "spec": {
                "name": "google_workspace_get_events",
                "description": "calendar",
            }
        },
        "mcp_assistant_get_chat_tools": {
            "spec": {
                "name": "mcp_assistant_get_chat_tools",
                "description": "chat",
            }
        },
        "skills_list_skills": {
            "spec": {
                "name": "skills_list_skills",
                "description": "skills",
            }
        },
        "subagents_run_subagent": {
            "spec": {
                "name": "subagents_run_subagent",
                "description": "subagents",
            }
        },
    }

    payload = build_payload(
        tools_dict,
        "GPT-5.4",
        chat_id="chat-123",
        prefer_core_tool_allowlist=True,
    )

    assert [tool["function"]["name"] for tool in payload] == [
        "google_workspace_get_events",
        "mcp_assistant_get_chat_tools",
        "skills_list_skills",
        "subagents_run_subagent",
    ]


def test_normalize_openai_function_tools_payloads_keeps_full_set_when_allowlist_matches_nothing():
    helpers = _load_tool_ordering_helpers()
    normalize_payloads = helpers["_normalize_openai_function_tools_payloads"]
    helpers["_load_openai_prompt_cache_server_allowlist"] = lambda chat_id, default_to_core=False: {
        "totally_unknown_server"
    }

    payload = normalize_payloads(
        [
            {"type": "function", "function": {"name": "skills_list_skills"}},
            {"type": "function", "function": {"name": "google_workspace_get_events"}},
        ],
        chat_id="chat-123",
    )

    assert [tool["function"]["name"] for tool in payload] == [
        "google_workspace_get_events",
        "skills_list_skills",
    ]


def test_gpt_bifrost_followup_rebuild_includes_chat_activated_server_tools():
    helpers = _load_tool_ordering_helpers()
    rebuild_payload = helpers["_rebuild_followup_function_tools_payload"]

    class _FakeRedis:
        def get(self, key):
            if key == "chat_skills:chat-123":
                return None
            if key == "chat_tools:chat-123":
                return json.dumps(["server:google_workspace"])
            return None

    helpers["DYNAMIC_TOOLS_REDIS_AVAILABLE"] = True
    helpers["RedisClient"] = lambda **kwargs: _FakeRedis()
    helpers["get_skill_manager"] = None

    payload = rebuild_payload(
        existing_tool_payloads=[
            {
                "type": "function",
                "function": {
                    "name": "mcp_assistant_get_chat_tools",
                    "description": "chat",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        metadata_tools={
            "mcp_assistant_get_chat_tools": {
                "spec": {
                    "name": "mcp_assistant_get_chat_tools",
                    "description": "chat",
                    "parameters": {"type": "object", "properties": {}},
                }
            },
            "google_workspace_get_events": {
                "spec": {
                    "name": "google_workspace_get_events",
                    "description": "calendar",
                    "parameters": {"type": "object", "properties": {}},
                }
            },
        },
        model_name="GPT-5.4",
        chat_id="chat-123",
        prefer_core_tool_allowlist=True,
    )

    assert [tool["function"]["name"] for tool in payload] == [
        "google_workspace_get_events",
        "mcp_assistant_get_chat_tools",
    ]


def test_gpt_function_tool_payload_is_stable_across_dict_insertion_order():
    helpers = _load_tool_ordering_helpers()
    build_payload = helpers["_build_openai_function_tools_payload"]

    tools_a = {
        "google_workspace_get_events": {
            "spec": {"name": "google_workspace_get_events", "description": "calendar"}
        },
        "agent_vm_bash": {
            "spec": {"name": "agent_vm_bash", "description": "bash"}
        },
        "mcp_assistant_get_chat_tools": {
            "spec": {"name": "mcp_assistant_get_chat_tools", "description": "chat"}
        },
    }
    tools_b = {
        "mcp_assistant_get_chat_tools": tools_a["mcp_assistant_get_chat_tools"],
        "agent_vm_bash": tools_a["agent_vm_bash"],
        "google_workspace_get_events": tools_a["google_workspace_get_events"],
    }

    payload_a = build_payload(tools_a, "GPT-5.4", chat_id="chat-123")
    payload_b = build_payload(tools_b, "GPT-5.4", chat_id="chat-123")

    assert payload_a == payload_b
    assert [tool["function"]["name"] for tool in payload_a] == sorted(
        tool["function"]["name"] for tool in payload_a
    )
