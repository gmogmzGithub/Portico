import copy
import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, ValidationError

REPO_ROOT = Path(__file__).resolve().parents[1]
ROUTER_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "routers"
    / "portico_managed_functions.py"
)


class FakeFunction:
    def __init__(self, **values):
        self.__dict__.update(values)


class FakeFunctionMeta(BaseModel):
    description: str | None = None
    manifest: dict = {}
    model_config = ConfigDict(extra="allow")


class FakeFunctionWithValvesModel(BaseModel):
    id: str
    user_id: str
    name: str
    type: str
    content: str
    meta: FakeFunctionMeta
    valves: dict | None = None
    is_active: bool
    is_global: bool
    updated_at: int
    created_at: int
    model_config = ConfigDict(from_attributes=True)


class FakeDatabaseState:
    def __init__(self):
        self.rows = {}
        self.commits = 0
        self.rollbacks = 0
        self.fail_commit = False
        self.before_commit = None


class FakeDb:
    def __init__(self, state):
        self.state = state
        self.snapshot = None

    def __enter__(self):
        self.snapshot = copy.deepcopy(self.state.rows)
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def get(self, _model, function_id):
        return self.state.rows.get(function_id)

    def add(self, function):
        self.state.rows[function.id] = function

    def commit(self):
        if self.state.before_commit:
            self.state.before_commit()
        if self.state.fail_commit:
            raise RuntimeError("injected commit failure")
        self.state.commits += 1

    def rollback(self):
        self.state.rollbacks += 1
        self.state.rows = self.snapshot

    def flush(self):
        return None


def _install_fake_package(monkeypatch, name):
    package = types.ModuleType(name)
    package.__path__ = []
    monkeypatch.setitem(sys.modules, name, package)


def _install_fake_module(monkeypatch, name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, name, module)


def load_router(monkeypatch, tmp_path, state):
    async def get_admin_user():
        return SimpleNamespace(id="admin-from-dependency")

    _install_fake_package(monkeypatch, "open_webui")
    _install_fake_package(monkeypatch, "open_webui.internal")
    _install_fake_package(monkeypatch, "open_webui.models")
    _install_fake_package(monkeypatch, "open_webui.utils")
    _install_fake_module(monkeypatch, "open_webui.config", CACHE_DIR=tmp_path)
    _install_fake_module(
        monkeypatch,
        "open_webui.internal.db",
        get_db=lambda: FakeDb(state),
    )
    _install_fake_module(
        monkeypatch,
        "open_webui.models.functions",
        Function=FakeFunction,
        FunctionMeta=FakeFunctionMeta,
        FunctionWithValvesModel=FakeFunctionWithValvesModel,
    )
    _install_fake_module(
        monkeypatch,
        "open_webui.utils.auth",
        get_admin_user=get_admin_user,
    )
    _install_fake_module(
        monkeypatch,
        "open_webui.utils.plugin",
        extract_frontmatter=lambda _content: {"title": "Managed filter"},
        install_frontmatter_requirements=lambda _requirements: None,
        replace_imports=lambda content: content,
    )

    module_name = "test_portico_managed_functions_loaded"
    monkeypatch.delitem(sys.modules, module_name, raising=False)
    spec = importlib.util.spec_from_file_location(module_name, ROUTER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module, get_admin_user


def request_with_cache(function_id=None, function=None, content=None):
    functions = {} if function_id is None else {function_id: function}
    contents = {} if function_id is None else {function_id: content}
    return SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(FUNCTIONS=functions, FUNCTION_CONTENTS=contents)
        )
    )


def filter_source(default_enabled=True):
    return f"""
from pydantic import BaseModel

class Filter:
    class Valves(BaseModel):
        enabled: bool = {default_enabled!r}
"""


@pytest.mark.asyncio
async def test_create_commits_complete_state_before_publishing_runtime_cache(
    monkeypatch, tmp_path
):
    state = FakeDatabaseState()
    module, _ = load_router(monkeypatch, tmp_path, state)
    request = request_with_cache()
    state.before_commit = lambda: (
        (
            request.app.state.FUNCTIONS == {}
            and request.app.state.FUNCTION_CONTENTS == {}
        )
        or pytest.fail("runtime cache was published before the database commit")
    )
    form = module.ManagedFunctionUpsertForm(
        name="portico_core_example",
        content=filter_source(),
        meta={"description": "Example"},
        valves={"enabled": False},
        is_active=True,
        is_global=True,
    )

    result = await module.upsert_managed_function(
        request,
        "portico_core_example",
        form,
        SimpleNamespace(id="service-admin"),
    )

    row = state.rows["portico_core_example"]
    assert state.commits == 1
    assert row.user_id == "service-admin"
    assert row.type == "filter"
    assert row.valves == {"enabled": False}
    assert row.is_active is True
    assert row.is_global is True
    assert result.is_active is True
    assert result.is_global is True
    assert request.app.state.FUNCTION_CONTENTS["portico_core_example"] == filter_source()
    assert "portico_core_example" in request.app.state.FUNCTIONS


@pytest.mark.asyncio
async def test_update_repairs_flags_without_replacing_owner_or_creation_time(
    monkeypatch, tmp_path
):
    state = FakeDatabaseState()
    state.rows["portico_core_existing"] = FakeFunction(
        id="portico_core_existing",
        user_id="original-owner",
        name="old",
        type="filter",
        content="old content",
        meta={},
        valves=None,
        is_active=False,
        is_global=False,
        updated_at=10,
        created_at=5,
    )
    module, _ = load_router(monkeypatch, tmp_path, state)
    request = request_with_cache()
    form = module.ManagedFunctionUpsertForm(
        name="portico_core_existing",
        content=filter_source(),
        meta={"description": "Repaired"},
        valves={"enabled": True},
    )

    result = await module.upsert_managed_function(
        request,
        "portico_core_existing",
        form,
        SimpleNamespace(id="different-admin"),
    )

    row = state.rows["portico_core_existing"]
    assert row.user_id == "original-owner"
    assert row.created_at == 5
    assert row.is_active is True
    assert row.is_global is True
    assert result.valves == {"enabled": True}


@pytest.mark.asyncio
async def test_invalid_source_does_not_mutate_database_or_runtime_state(
    monkeypatch, tmp_path
):
    state = FakeDatabaseState()
    original_row = FakeFunction(
        id="portico_core_existing",
        user_id="owner",
        name="existing",
        type="filter",
        content="working content",
        meta={},
        valves=None,
        is_active=True,
        is_global=True,
        updated_at=10,
        created_at=5,
    )
    state.rows[original_row.id] = original_row
    module, _ = load_router(monkeypatch, tmp_path, state)
    cached_function = object()
    request = request_with_cache(original_row.id, cached_function, original_row.content)
    module_name = f"function_{original_row.id}"
    previous_import_module = types.ModuleType(module_name)
    monkeypatch.setitem(sys.modules, module_name, previous_import_module)
    form = module.ManagedFunctionUpsertForm(
        name=original_row.id,
        content="raise RuntimeError('invalid source')",
        meta={},
    )

    with pytest.raises(HTTPException) as error:
        await module.upsert_managed_function(
            request,
            original_row.id,
            form,
            SimpleNamespace(id="admin"),
        )

    assert error.value.status_code == 400
    assert state.commits == 0
    assert state.rows[original_row.id].content == "working content"
    assert state.rows[original_row.id].is_active is True
    assert request.app.state.FUNCTIONS[original_row.id] is cached_function
    assert request.app.state.FUNCTION_CONTENTS[original_row.id] == "working content"
    assert sys.modules[module_name] is previous_import_module


@pytest.mark.asyncio
async def test_commit_failure_rolls_back_database_and_preserves_runtime_cache(
    monkeypatch, tmp_path
):
    state = FakeDatabaseState()
    original_row = FakeFunction(
        id="portico_core_existing",
        user_id="owner",
        name="existing",
        type="filter",
        content="working content",
        meta={},
        valves=None,
        is_active=False,
        is_global=False,
        updated_at=10,
        created_at=5,
    )
    state.rows[original_row.id] = original_row
    state.fail_commit = True
    module, _ = load_router(monkeypatch, tmp_path, state)
    cached_function = object()
    request = request_with_cache(original_row.id, cached_function, original_row.content)
    module_name = f"function_{original_row.id}"
    previous_import_module = types.ModuleType(module_name)
    monkeypatch.setitem(sys.modules, module_name, previous_import_module)
    form = module.ManagedFunctionUpsertForm(
        name=original_row.id,
        content=filter_source(),
        meta={},
    )

    with pytest.raises(HTTPException) as error:
        await module.upsert_managed_function(
            request,
            original_row.id,
            form,
            SimpleNamespace(id="admin"),
        )

    assert error.value.status_code == 500
    assert state.rollbacks == 1
    assert state.rows[original_row.id].content == "working content"
    assert state.rows[original_row.id].is_active is False
    assert state.rows[original_row.id].is_global is False
    assert request.app.state.FUNCTIONS[original_row.id] is cached_function
    assert request.app.state.FUNCTION_CONTENTS[original_row.id] == "working content"
    assert sys.modules[module_name] is previous_import_module


def test_routes_are_admin_only_and_reject_noncanonical_state(monkeypatch, tmp_path):
    state = FakeDatabaseState()
    module, get_admin_user = load_router(monkeypatch, tmp_path, state)

    managed_routes = [
        route for route in module.router.routes if route.path == "/id/{function_id}"
    ]
    assert {method for route in managed_routes for method in route.methods} == {
        "GET",
        "PUT",
    }
    assert all(
        any(
            dependency.call is get_admin_user
            for dependency in route.dependant.dependencies
        )
        for route in managed_routes
    )

    with pytest.raises(HTTPException) as error:
        module._validate_managed_function_id("user_function")
    assert error.value.status_code == 400

    with pytest.raises(ValidationError):
        module.ManagedFunctionUpsertForm(
            name="portico_core_example",
            content=filter_source(),
            meta={},
            is_active=False,
            is_global=True,
        )
