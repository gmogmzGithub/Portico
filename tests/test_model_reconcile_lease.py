import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from uuid import UUID, uuid4

status = SimpleNamespace(
    HTTP_409_CONFLICT=409,
    HTTP_503_SERVICE_UNAVAILABLE=503,
)

MAIN_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "main.py"
)


def _load_helpers():
    module = ast.parse(MAIN_PATH.read_text(encoding="utf-8"))
    assignments = {
        "MODEL_RECONCILE_LEASE_KEY",
        "MODEL_RECONCILE_EPOCH_HEADER",
        "MODEL_RECONCILE_OWNER_HEADER",
        "MODEL_WRITER_LEASE_TTL_MS",
        "MODEL_RECONCILE_LEASE_TTL_MS",
        "MODEL_WRITER_HEARTBEAT_SECONDS",
        "MODEL_RECONCILE_MUTATION_PATHS",
        "MODEL_WRITER_COMPARE_DELETE_LUA",
        "MODEL_WRITER_COMPARE_RENEW_LUA",
    }
    functions = {
        "_is_model_reconcile_mutation",
        "_redis_text",
        "_requested_model_reconcile_fence",
        "_acquire_model_writer_or_validate_fence",
        "_release_model_writer",
        "_renew_model_writer",
        "_model_writer_heartbeat",
        "_cancel_model_writer_task",
        "_run_with_model_writer_heartbeat",
    }
    selected = []
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in assignments
            for target in node.targets
        ):
            selected.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in functions:
            selected.append(node)
        elif isinstance(node, ast.ClassDef) and node.name == "ModelReconcileLeaseError":
            selected.append(node)

    namespace = {
        "Optional": Optional,
        "asyncio": asyncio,
        "status": status,
        "uuid4": uuid4,
    }
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(MAIN_PATH), "exec"), namespace)
    return namespace


HELPERS = _load_helpers()


class FakeAsyncRedis:
    def __init__(self):
        self.store = {}
        self.ttls = {}
        self.fail = False
        self.fail_renew = False
        self.lose_on_renew = False
        self.renew_calls = 0

    async def get(self, key):
        if self.fail:
            raise RuntimeError("redis unavailable")
        return self.store.get(key)

    async def set(self, key, value, nx=False, px=None):
        if self.fail:
            raise RuntimeError("redis unavailable")
        if nx and key in self.store:
            return False
        self.store[key] = value
        self.ttls[key] = px
        return True

    async def eval(self, script, key_count, key, expected, *args):
        if self.fail:
            raise RuntimeError("redis unavailable")
        assert key_count == 1
        current = self.store.get(key)
        if isinstance(current, bytes):
            current = current.decode("utf-8")
        if "PEXPIRE" in script:
            self.renew_calls += 1
            if self.fail_renew:
                raise RuntimeError("redis renewal unavailable")
            if self.lose_on_renew:
                self.store[key] = "writer:successor"
                return 0
            if current != expected:
                return 0
            assert len(args) == 1
            self.ttls[key] = args[0]
            return 1
        if current != expected:
            return 0
        del self.store[key]
        self.ttls.pop(key, None)
        return 1


def _run(coro):
    return asyncio.run(coro)


def _error_status(coro):
    error_type = HELPERS["ModelReconcileLeaseError"]
    try:
        _run(coro)
    except error_type as error:
        return error.status_code
    raise AssertionError("expected ModelReconcileLeaseError")


def test_mutation_path_inventory_is_exact_and_method_bounded():
    is_mutation = HELPERS["_is_model_reconcile_mutation"]
    assert is_mutation("POST", "/api/v1/models/create")
    assert is_mutation("POST", "/api/v1/models/model/update")
    assert is_mutation("POST", "/api/v1/models/model/delete")
    assert is_mutation("DELETE", "/api/v1/models/legacy/delete")
    assert is_mutation("POST", "/api/v1/users/user/settings/update")
    assert not is_mutation("GET", "/api/v1/models/create")
    assert not is_mutation("POST", "/api/v1/users/user/settings")


def test_normal_writer_contention_and_compare_delete_release():
    redis = FakeAsyncRedis()
    acquire = HELPERS["_acquire_model_writer_or_validate_fence"]
    release = HELPERS["_release_model_writer"]
    key = HELPERS["MODEL_RECONCILE_LEASE_KEY"]

    token = _run(acquire(redis, {}))
    assert token.startswith("writer:")
    UUID(token.removeprefix("writer:"))
    assert redis.store[key] == token
    assert redis.ttls[key] == HELPERS["MODEL_WRITER_LEASE_TTL_MS"]
    assert _error_status(acquire(redis, {})) == status.HTTP_409_CONFLICT

    _run(release(redis, token))
    assert key not in redis.store
    assert _run(acquire(redis, {})).startswith("writer:")


def test_matching_reconcile_fence_bypasses_and_forged_or_stale_fence_fails():
    redis = FakeAsyncRedis()
    acquire = HELPERS["_acquire_model_writer_or_validate_fence"]
    key = HELPERS["MODEL_RECONCILE_LEASE_KEY"]
    epoch_header = HELPERS["MODEL_RECONCILE_EPOCH_HEADER"]
    owner_header = HELPERS["MODEL_RECONCILE_OWNER_HEADER"]
    redis.store[key] = b"17:health-run"

    assert _run(acquire(redis, {epoch_header: "17", owner_header: "health-run"})) is None
    assert redis.ttls[key] == HELPERS["MODEL_RECONCILE_LEASE_TTL_MS"]
    assert redis.renew_calls == 1
    assert (
        _error_status(acquire(redis, {epoch_header: "16", owner_header: "health-run"}))
        == status.HTTP_409_CONFLICT
    )
    assert (
        _error_status(acquire(redis, {epoch_header: "17", owner_header: "forged"}))
        == status.HTTP_409_CONFLICT
    )
    assert _error_status(acquire(redis, {epoch_header: "17"})) == status.HTTP_409_CONFLICT


def test_normal_writer_and_reconcile_are_mutually_exclusive_and_redis_errors_fail_closed():
    redis = FakeAsyncRedis()
    acquire = HELPERS["_acquire_model_writer_or_validate_fence"]
    release = HELPERS["_release_model_writer"]
    key = HELPERS["MODEL_RECONCILE_LEASE_KEY"]
    epoch_header = HELPERS["MODEL_RECONCILE_EPOCH_HEADER"]
    owner_header = HELPERS["MODEL_RECONCILE_OWNER_HEADER"]

    writer = _run(acquire(redis, {}))
    assert (
        _error_status(acquire(redis, {epoch_header: "4", owner_header: "health"}))
        == status.HTTP_409_CONFLICT
    )
    _run(release(redis, writer))

    redis.store[key] = "4:health"
    assert _error_status(acquire(redis, {})) == status.HTTP_409_CONFLICT
    assert _run(acquire(redis, {epoch_header: "4", owner_header: "health"})) is None
    assert _error_status(release(redis, "writer:not-owner")) == status.HTTP_503_SERVICE_UNAVAILABLE
    assert redis.store[key] == "4:health"

    redis.fail = True
    assert _error_status(acquire(redis, {})) == status.HTTP_503_SERVICE_UNAVAILABLE
    assert (
        _error_status(acquire(redis, {epoch_header: "4", owner_header: "health"}))
        == status.HTTP_503_SERVICE_UNAVAILABLE
    )

def test_writer_heartbeat_renews_while_request_is_active_and_stops_on_completion():
    async def scenario():
        redis = FakeAsyncRedis()
        acquire = HELPERS["_acquire_model_writer_or_validate_fence"]
        run_with_heartbeat = HELPERS["_run_with_model_writer_heartbeat"]
        key = HELPERS["MODEL_RECONCILE_LEASE_KEY"]
        token = await acquire(redis, {})

        async def request():
            for _ in range(50):
                if redis.renew_calls >= 2:
                    return "complete"
                await asyncio.sleep(0)
            raise AssertionError("heartbeat did not renew deterministically")

        assert (
            await run_with_heartbeat(
                redis,
                token,
                request(),
                interval_seconds=0,
            )
            == "complete"
        )
        renew_calls_at_completion = redis.renew_calls
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert redis.renew_calls == renew_calls_at_completion
        assert redis.store[key] == token
        assert redis.ttls[key] == HELPERS["MODEL_WRITER_LEASE_TTL_MS"]

    _run(scenario())


def test_writer_heartbeat_lost_ownership_fails_closed_and_preserves_successor():
    async def scenario():
        redis = FakeAsyncRedis()
        acquire = HELPERS["_acquire_model_writer_or_validate_fence"]
        release = HELPERS["_release_model_writer"]
        run_with_heartbeat = HELPERS["_run_with_model_writer_heartbeat"]
        error_type = HELPERS["ModelReconcileLeaseError"]
        key = HELPERS["MODEL_RECONCILE_LEASE_KEY"]
        token = await acquire(redis, {})
        redis.lose_on_renew = True
        request_cancelled = asyncio.Event()

        async def request():
            try:
                await asyncio.Event().wait()
            finally:
                request_cancelled.set()

        try:
            await run_with_heartbeat(
                redis,
                token,
                request(),
                interval_seconds=0,
            )
        except error_type as error:
            assert error.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        else:
            raise AssertionError("expected lost heartbeat ownership to fail closed")

        assert request_cancelled.is_set()
        assert redis.store[key] == "writer:successor"
        try:
            await release(redis, token)
        except error_type as error:
            assert error.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        else:
            raise AssertionError("stale writer must not release successor lease")
        assert redis.store[key] == "writer:successor"

    _run(scenario())


def test_writer_heartbeat_redis_failure_fails_closed_and_cancels_request():
    async def scenario():
        redis = FakeAsyncRedis()
        acquire = HELPERS["_acquire_model_writer_or_validate_fence"]
        run_with_heartbeat = HELPERS["_run_with_model_writer_heartbeat"]
        error_type = HELPERS["ModelReconcileLeaseError"]
        token = await acquire(redis, {})
        redis.fail_renew = True
        request_cancelled = asyncio.Event()

        async def request():
            try:
                await asyncio.Event().wait()
            finally:
                request_cancelled.set()

        try:
            await run_with_heartbeat(
                redis,
                token,
                request(),
                interval_seconds=0,
            )
        except error_type as error:
            assert error.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        else:
            raise AssertionError("expected Redis renewal error to fail closed")

        assert request_cancelled.is_set()
        assert redis.renew_calls == 1

    _run(scenario())


def test_writer_heartbeat_cancellation_awaits_all_child_tasks():
    async def scenario():
        redis = FakeAsyncRedis()
        acquire = HELPERS["_acquire_model_writer_or_validate_fence"]
        release = HELPERS["_release_model_writer"]
        run_with_heartbeat = HELPERS["_run_with_model_writer_heartbeat"]
        token = await acquire(redis, {})
        request_started = asyncio.Event()
        request_cancelled = asyncio.Event()
        current_task = asyncio.current_task()

        async def request():
            request_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                request_cancelled.set()

        runner = asyncio.create_task(
            run_with_heartbeat(
                redis,
                token,
                request(),
                interval_seconds=3600,
            )
        )
        await request_started.wait()
        runner.cancel()
        try:
            await runner
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("expected heartbeat wrapper cancellation")

        await asyncio.sleep(0)
        assert request_cancelled.is_set()
        assert [
            task
            for task in asyncio.all_tasks()
            if task is not current_task and not task.done()
        ] == []
        await release(redis, token)

    _run(scenario())
