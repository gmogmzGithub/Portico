import importlib.util
from pathlib import Path
import sys
import types


def _load_api_client_module():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "integration"
        / "framework"
        / "utils"
        / "api_client.py"
    )
    spec = importlib.util.spec_from_file_location("integration_api_client", source_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    previous_httpx = sys.modules.get("httpx")
    fake_httpx = types.SimpleNamespace(
        Client=object,
        HTTPError=Exception,
        get=lambda *args, **kwargs: None,
        post=lambda *args, **kwargs: None,
    )
    sys.modules["httpx"] = fake_httpx
    spec.loader.exec_module(module)
    if previous_httpx is None:
        sys.modules.pop("httpx", None)
    else:
        sys.modules["httpx"] = previous_httpx
    return module


def test_poll_for_completion_reads_assistant_from_history_when_messages_only_has_users():
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://unused", token="test-token")

    first_user = {
        "id": "user-1",
        "role": "user",
        "parentId": None,
        "content": "Hello",
    }
    first_assistant = {
        "id": "assistant-1",
        "role": "assistant",
        "parentId": "user-1",
        "content": "Hi there",
        "done": True,
    }
    second_user = {
        "id": "user-2",
        "role": "user",
        "parentId": "assistant-1",
        "content": "Thank you!",
    }
    second_assistant = {
        "id": "assistant-2",
        "role": "assistant",
        "parentId": "user-2",
        "content": "You're welcome!",
        "done": True,
        "tool_calls": [],
        "model": "GPT-5.4",
    }

    client.get_chat = lambda _chat_id: {
        "chat": {
            "messages": [first_user, second_user],
            "history": {
                "messages": {
                    first_user["id"]: first_user,
                    first_assistant["id"]: first_assistant,
                    second_user["id"]: second_user,
                    second_assistant["id"]: second_assistant,
                }
            },
        }
    }

    result = client.poll_for_completion(
        chat_id="chat-1",
        user_message_id="user-2",
        timeout_seconds=1,
        poll_interval=0,
    )

    assert result == {
        "assistant_message_id": "assistant-2",
        "content": "You're welcome!",
        "tool_calls": [],
        "content_blocks": [],
        "model": "GPT-5.4",
        "complete": True,
    }


def test_poll_for_completion_ignores_incomplete_history_assistant(monkeypatch):
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://unused", token="test-token")

    states = [
        {
            "chat": {
                "messages": [{"id": "user-2", "role": "user", "content": "Thank you!"}],
                "history": {
                    "messages": {
                        "user-2": {
                            "id": "user-2",
                            "role": "user",
                            "content": "Thank you!",
                        },
                        "assistant-2": {
                            "id": "assistant-2",
                            "role": "assistant",
                            "parentId": "user-2",
                            "content": "Partial",
                            "done": False,
                        },
                    }
                },
            }
        },
        {
            "chat": {
                "messages": [{"id": "user-2", "role": "user", "content": "Thank you!"}],
                "history": {
                    "messages": {
                        "user-2": {
                            "id": "user-2",
                            "role": "user",
                            "content": "Thank you!",
                        },
                        "assistant-2": {
                            "id": "assistant-2",
                            "role": "assistant",
                            "parentId": "user-2",
                            "content": "You're welcome!",
                            "done": True,
                        },
                    }
                },
            }
        },
    ]

    def _next_state(_chat_id):
        if len(states) > 1:
            return states.pop(0)
        return states[0]

    client.get_chat = _next_state
    monkeypatch.setattr(module.time, "sleep", lambda *_args, **_kwargs: None)

    result = client.poll_for_completion(
        chat_id="chat-1",
        user_message_id="user-2",
        timeout_seconds=1,
        poll_interval=0,
    )

    assert result["assistant_message_id"] == "assistant-2"
    assert result["content"] == "You're welcome!"
    assert result["complete"] is True


def test_poll_for_completion_done_true_waits_for_tool_results(monkeypatch):
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://unused", token="test-token")

    states = [
        {
            "chat": {
                "messages": [{"id": "user-2", "role": "user", "content": "Prompt"}],
                "history": {
                    "messages": {
                        "user-2": {
                            "id": "user-2",
                            "role": "user",
                            "content": "Prompt",
                        },
                        "assistant-2": {
                            "id": "assistant-2",
                            "role": "assistant",
                            "parentId": "user-2",
                            "content": '<details type="tool_calls" done="false"></details>',
                            "done": True,
                        },
                    }
                },
            }
        },
        {
            "chat": {
                "messages": [{"id": "user-2", "role": "user", "content": "Prompt"}],
                "history": {
                    "messages": {
                        "user-2": {
                            "id": "user-2",
                            "role": "user",
                            "content": "Prompt",
                        },
                        "assistant-2": {
                            "id": "assistant-2",
                            "role": "assistant",
                            "parentId": "user-2",
                            "content": "Final answer",
                            "done": True,
                        },
                    }
                },
            }
        },
    ]

    def _next_state(_chat_id):
        if len(states) > 1:
            return states.pop(0)
        return states[0]

    client.get_chat = _next_state
    monkeypatch.setattr(module.time, "sleep", lambda *_args, **_kwargs: None)

    result = client.poll_for_completion(
        chat_id="chat-1",
        user_message_id="user-2",
        timeout_seconds=1,
        poll_interval=0,
    )

    assert result["assistant_message_id"] == "assistant-2"
    assert result["content"] == "Final answer"
    assert result["complete"] is True


def test_poll_for_completion_does_not_return_partial_assistant_without_done(monkeypatch):
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://unused", token="test-token")

    states = [
        {
            "chat": {
                "messages": [{"id": "user-2", "role": "user", "content": "Thank you!"}],
                "history": {
                    "messages": {
                        "user-2": {
                            "id": "user-2",
                            "role": "user",
                            "content": "Thank you!",
                        },
                        "assistant-2": {
                            "id": "assistant-2",
                            "role": "assistant",
                            "parentId": "user-2",
                            "content": "I'll help you with that.",
                            "done": None,
                            "usage": {},
                        },
                    }
                },
            }
        },
        {
            "chat": {
                "messages": [{"id": "user-2", "role": "user", "content": "Thank you!"}],
                "history": {
                    "messages": {
                        "user-2": {
                            "id": "user-2",
                            "role": "user",
                            "content": "Thank you!",
                        },
                        "assistant-2": {
                            "id": "assistant-2",
                            "role": "assistant",
                            "parentId": "user-2",
                            "content": "You're welcome!",
                            "done": True,
                        },
                    }
                },
            }
        },
    ]

    def _next_state(_chat_id):
        if len(states) > 1:
            return states.pop(0)
        return states[0]

    client.get_chat = _next_state
    monkeypatch.setattr(module.time, "sleep", lambda *_args, **_kwargs: None)

    result = client.poll_for_completion(
        chat_id="chat-1",
        user_message_id="user-2",
        timeout_seconds=1,
        poll_interval=0,
    )

    assert result["assistant_message_id"] == "assistant-2"
    assert result["content"] == "You're welcome!"
    assert result["complete"] is True


def test_poll_for_completion_retries_after_transient_get_chat_error(monkeypatch):
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://unused", token="test-token")

    calls = {"count": 0}

    def _next_state(_chat_id):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("timed out")
        return {
            "chat": {
                "messages": [{"id": "user-2", "role": "user", "content": "Prompt"}],
                "history": {
                    "messages": {
                        "user-2": {
                            "id": "user-2",
                            "role": "user",
                            "content": "Prompt",
                        },
                        "assistant-2": {
                            "id": "assistant-2",
                            "role": "assistant",
                            "parentId": "user-2",
                            "content": "Recovered answer",
                            "done": True,
                        },
                    }
                },
            }
        }

    client.get_chat = _next_state
    monkeypatch.setattr(module.time, "sleep", lambda *_args, **_kwargs: None)

    result = client.poll_for_completion(
        chat_id="chat-1",
        user_message_id="user-2",
        timeout_seconds=1,
        poll_interval=0,
    )

    assert result["assistant_message_id"] == "assistant-2"
    assert result["content"] == "Recovered answer"
    assert result["complete"] is True


def test_poll_for_completion_accepts_usage_backed_completion_without_done():
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://unused", token="test-token")

    assistant = {
        "id": "assistant-2",
        "role": "assistant",
        "parentId": "user-2",
        "content": "Final answer",
        "done": None,
        "usage": {"total_tokens": 42},
        "contentBlocks": [{"type": "text", "content": "Final answer"}],
    }

    client.get_chat = lambda _chat_id: {
        "chat": {
            "messages": [{"id": "user-2", "role": "user", "content": "Prompt"}],
            "history": {
                "messages": {
                    "user-2": {
                        "id": "user-2",
                        "role": "user",
                        "content": "Prompt",
                    },
                    "assistant-2": assistant,
                }
            },
        }
    }

    result = client.poll_for_completion(
        chat_id="chat-1",
        user_message_id="user-2",
        timeout_seconds=1,
        poll_interval=0,
    )

    assert result == {
        "assistant_message_id": "assistant-2",
        "content": "Final answer",
        "tool_calls": [],
        "content_blocks": [{"type": "text", "content": "Final answer"}],
        "model": None,
        "complete": True,
    }


def test_poll_for_completion_returns_chat_error_immediately():
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://unused", token="test-token")

    client.get_chat = lambda _chat_id: {
        "chat": {
            "messages": [
                {
                    "id": "assistant-2",
                    "role": "assistant",
                    "parentId": "user-2",
                    "error": {
                        "content": {"message": "backend exploded"},
                    },
                }
            ],
            "history": {"messages": {}},
        }
    }

    result = client.poll_for_completion(
        chat_id="chat-1",
        user_message_id="user-2",
        timeout_seconds=1,
        poll_interval=0,
    )

    assert result == {
        "complete": False,
        "error": "backend exploded",
        "assistant_message_id": "assistant-2",
    }
