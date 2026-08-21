from pathlib import Path
import ast
import asyncio
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
TASKS_PATH = REPO_ROOT / "src/patches/backend/open_webui/tasks.py"


def _load_cleanup_helper():
    source = TASKS_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(TASKS_PATH))
    wanted_names = {
        "REDIS_TASKS_KEY",
        "REDIS_ITEM_TASKS_KEY",
        "redis_cleanup_task",
        "cleanup_task",
    }
    selected_nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in wanted_names:
                    selected_nodes.append(node)
                    break
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in wanted_names:
                selected_nodes.append(node)

    module = ast.Module(body=selected_nodes, type_ignores=[])
    namespace = {
        "asyncio": asyncio,
        "log": type("FakeLog", (), {"exception": staticmethod(lambda *_args, **_kwargs: None)})(),
        "Optional": Optional,
        "Redis": object,
        "REDIS_KEY_PREFIX": "open-webui",
        "tasks": {},
        "item_tasks": {},
    }
    exec(compile(module, str(TASKS_PATH), "exec"), namespace)
    return namespace


HELPERS = _load_cleanup_helper()
REDIS_TASKS_KEY = HELPERS["REDIS_TASKS_KEY"]
REDIS_ITEM_TASKS_KEY = HELPERS["REDIS_ITEM_TASKS_KEY"]
redis_cleanup_task = HELPERS["redis_cleanup_task"]
cleanup_task = HELPERS["cleanup_task"]


class FakePipeline:
    def __init__(self, redis):
        self.redis = redis
        self.commands = []

    def hdel(self, key, field):
        self.commands.append(("hdel", key, field))
        return self

    def srem(self, key, member):
        self.commands.append(("srem", key, member))
        return self

    async def execute(self):
        results = []
        for command, key, value in self.commands:
            if command == "hdel":
                bucket = self.redis.hashes.setdefault(key, {})
                results.append(1 if bucket.pop(value, None) is not None else 0)
            elif command == "srem":
                members = self.redis.sets.setdefault(key, set())
                removed = 1 if value in members else 0
                members.discard(value)
                results.append(removed)
        self.commands = []
        return results


class FakeRedis:
    def __init__(self):
        self.hashes = {}
        self.sets = {}
        self.deleted_keys = []

    def pipeline(self):
        return FakePipeline(self)

    async def scard(self, key):
        return len(self.sets.get(key, set()))

    async def delete(self, key):
        self.deleted_keys.append(key)
        self.sets.pop(key, None)
        return 1


def test_redis_cleanup_task_deletes_empty_item_set():
    redis = FakeRedis()
    item_key = f"{REDIS_ITEM_TASKS_KEY}:chat-1"
    redis.hashes[REDIS_TASKS_KEY] = {"task-1": "chat-1"}
    redis.sets[item_key] = {"task-1"}

    asyncio.run(redis_cleanup_task(redis, "task-1", "chat-1"))

    assert redis.hashes[REDIS_TASKS_KEY] == {}
    assert item_key in redis.deleted_keys
    assert item_key not in redis.sets


def test_redis_cleanup_task_preserves_item_set_when_other_tasks_remain():
    redis = FakeRedis()
    item_key = f"{REDIS_ITEM_TASKS_KEY}:chat-1"
    redis.hashes[REDIS_TASKS_KEY] = {"task-1": "chat-1", "task-2": "chat-1"}
    redis.sets[item_key] = {"task-1", "task-2"}

    asyncio.run(redis_cleanup_task(redis, "task-1", "chat-1"))

    assert redis.hashes[REDIS_TASKS_KEY] == {"task-2": "chat-1"}
    assert redis.sets[item_key] == {"task-2"}
    assert redis.deleted_keys == []


def test_cleanup_task_runs_async_cleanup_callback_after_task_removal():
    redis = FakeRedis()
    item_key = f"{REDIS_ITEM_TASKS_KEY}:chat-1"
    redis.hashes[REDIS_TASKS_KEY] = {"task-1": "chat-1"}
    redis.sets[item_key] = {"task-1"}
    callback_calls = []

    async def on_cleanup(**kwargs):
        callback_calls.append(kwargs)

    asyncio.run(cleanup_task(redis, "task-1", "chat-1", on_cleanup))

    assert item_key in redis.deleted_keys
    assert callback_calls == [{"task_id": "task-1", "item_id": "chat-1"}]
