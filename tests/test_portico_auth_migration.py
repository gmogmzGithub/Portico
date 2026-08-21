from pathlib import Path
import importlib.util
import os
import sys
import types

import pytest

from open_webui.utils.portico_auth_migration import preserve_legacy_user_settings


REPO_ROOT = Path(__file__).resolve().parents[1]
AUTH_BRIDGE_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "routers"
    / "portico_auth_bridge.py"
)


class UserFixture:
    def __init__(self, settings):
        self.settings = settings


class FakeRow:
    def __init__(self, **values):
        self.__dict__.update(values)


class FakeState:
    def __init__(self, users=None, auths=None):
        self.users = list(users or [])
        self.auths = list(auths or [])


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.criteria = {}

    def filter_by(self, **criteria):
        self.criteria.update(criteria)
        return self

    def first(self):
        for row in self.rows:
            if all(getattr(row, key, None) == value for key, value in self.criteria.items()):
                return row
        return None

    def delete(self):
        return 0


class FakeDb:
    def __init__(self, state):
        self.state = state
        self.committed = False
        self.rolled_back = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def query(self, model):
        if model.__name__ == "FakeUser":
            return FakeQuery(self.state.users)
        if model.__name__ == "FakeAuth":
            return FakeQuery(self.state.auths)
        return FakeQuery([])

    def add(self, row):
        if row.__class__.__name__ == "FakeUser":
            self.state.users.append(row)
        elif row.__class__.__name__ == "FakeAuth":
            self.state.auths.append(row)

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


def _install_fake_module(monkeypatch, name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, name, module)
    return module


def _install_fake_package(monkeypatch, name):
    module = types.ModuleType(name)
    module.__path__ = []
    monkeypatch.setitem(sys.modules, name, module)
    return module


def load_auth_bridge_with_state(monkeypatch, state):
    class FakeHTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class FakeStatus:
        HTTP_400_BAD_REQUEST = 400
        HTTP_401_UNAUTHORIZED = 401
        HTTP_500_INTERNAL_SERVER_ERROR = 500
        HTTP_503_SERVICE_UNAVAILABLE = 503

    class FakeAPIRouter:
        def post(self, *_args, **_kwargs):
            return lambda fn: fn

        def get(self, *_args, **_kwargs):
            return lambda fn: fn

    class FakeBaseModel:
        def __init__(self, **values):
            self.__dict__.update(values)

    class FakeUser(FakeRow):
        pass

    class FakeAuth(FakeRow):
        pass

    class FakeUsers:
        @staticmethod
        def get_user_by_id(user_id):
            return next((user for user in state.users if user.id == user_id), None)

        @staticmethod
        def get_user_by_email(email):
            return next((user for user in state.users if user.email == email), None)

        @staticmethod
        def update_user_by_id(user_id, updates):
            user = FakeUsers.get_user_by_id(user_id)
            if user:
                user.__dict__.update(updates)
            return user

    class FakeAuths:
        @staticmethod
        def insert_new_auth(email, _password, name, profile_image_url, role, oauth=None):
            user = FakeUser(
                id=f"user-{len(state.users) + 1}",
                email=email,
                name=name,
                role=role,
                profile_image_url=profile_image_url,
                oauth=oauth,
            )
            auth = FakeAuth(
                id=user.id,
                email=email,
                password="hashed",
                active=True,
            )
            state.users.append(user)
            state.auths.append(auth)
            return user

    _install_fake_package(monkeypatch, "open_webui")
    _install_fake_package(monkeypatch, "open_webui.internal")
    _install_fake_package(monkeypatch, "open_webui.models")
    _install_fake_package(monkeypatch, "open_webui.utils")

    _install_fake_module(monkeypatch, "fastapi", APIRouter=FakeAPIRouter, HTTPException=FakeHTTPException, Request=object, Response=object, status=FakeStatus)
    _install_fake_module(monkeypatch, "fastapi.responses", HTMLResponse=object, RedirectResponse=object)
    _install_fake_module(monkeypatch, "pydantic", BaseModel=FakeBaseModel)
    _install_fake_module(monkeypatch, "sqlalchemy", bindparam=lambda *_args, **_kwargs: None, text=lambda value: value)
    _install_fake_module(monkeypatch, "open_webui.env", WEBUI_SESSION_COOKIE_SAME_SITE="lax", WEBUI_SESSION_COOKIE_SECURE=False)
    _install_fake_module(monkeypatch, "open_webui.internal.db", get_db=lambda: FakeDb(state))
    _install_fake_module(monkeypatch, "open_webui.models.auths", Auth=FakeAuth, Auths=FakeAuths)
    _install_fake_module(monkeypatch, "open_webui.models.users", User=FakeUser, Users=FakeUsers)
    _install_fake_module(monkeypatch, "open_webui.utils.access_control", get_permissions=lambda *_args, **_kwargs: {})
    _install_fake_module(monkeypatch, "open_webui.utils.auth", create_token=lambda data, expires_delta=None: f"token-for-{data['id']}", get_password_hash=lambda value: f"hashed-{value}")
    _install_fake_module(
        monkeypatch,
        "open_webui.utils.db_diagnostics",
        get_database_diagnostics_snapshot=lambda: {"schemaVersion": 1},
    )
    _install_fake_module(monkeypatch, "open_webui.utils.portico_auth_migration", preserve_legacy_user_settings=lambda *_args, **_kwargs: False)
    _install_fake_module(monkeypatch, "open_webui.utils.misc", parse_duration=lambda _value: None)

    module_name = "test_portico_auth_bridge_loaded"
    monkeypatch.delitem(sys.modules, module_name, raising=False)
    spec = importlib.util.spec_from_file_location(module_name, AUTH_BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class FakeRequest:
    def __init__(self, authorization=""):
        self.headers = {"Authorization": authorization} if authorization else {}


def test_legacy_settings_are_copied_to_the_human_user():
    legacy = UserFixture(
        {
            "ui": {
                "theme": "dark",
                "sidebarExpanded": False,
            }
        }
    )
    human = UserFixture({"freshUser": True})

    assert preserve_legacy_user_settings(legacy, human) is True
    assert human.settings == legacy.settings
    assert human.settings is not legacy.settings
    assert human.settings["ui"] is not legacy.settings["ui"]


def test_missing_legacy_settings_do_not_replace_human_settings():
    human = UserFixture({"freshUser": True})

    assert preserve_legacy_user_settings(UserFixture(None), human) is False
    assert human.settings == {"freshUser": True}


def test_auth_bridge_preserves_settings_before_deleting_the_legacy_user():
    source = AUTH_BRIDGE_PATH.read_text(encoding="utf-8")

    preserve_index = source.index(
        "settings_preserved = preserve_legacy_user_settings(legacy, human)"
    )
    delete_index = source.index(
        "db.query(User).filter_by(id=legacy.id).delete()"
    )
    assert preserve_index < delete_index
    assert '"settings_preserved": settings_preserved' in source


def test_auth_bridge_writes_application_support_downgrade_fuse():
    source = AUTH_BRIDGE_PATH.read_text(encoding="utf-8")

    assert 'APP_SUPPORT_DIR_ENV = "PORTICO_APP_SUPPORT_DIR"' in source
    assert 'FUSE_DIR_NAME = "compatibility-fuses"' in source
    assert 'OWUI_AUTH_MIGRATION_FUSE_FILENAME = "owui-auth-user-migration.json"' in source
    assert 'OWUI_AUTH_MIGRATION_FUSE_NAME = "owui-auth-user-migration"' in source
    assert '"schemaVersion": 1' in source
    assert '"source": "pre-beta-tmp"' in source
    assert '"migratedTableCount": migrated_table_count' in source
    assert "tmp_path.replace(fuse_path)" in source


def test_auth_bridge_blows_fuse_after_human_and_service_users_exist():
    source = AUTH_BRIDGE_PATH.read_text(encoding="utf-8")

    user_index = source.index("user = _ensure_user(")
    service_user_index = source.index("service_user = _ensure_service_user()")
    migration_index = source.index("migration = _adopt_legacy_admin_user(user.id, service_user.id)")
    fuse_index = source.index("_write_owui_auth_migration_fuse(migration)")
    token_index = source.index("token_payload = _token_response(request, user)")

    assert user_index < service_user_index
    assert service_user_index < migration_index
    assert migration_index < fuse_index
    assert fuse_index < token_index


def test_service_user_reconciles_missing_auth_row(monkeypatch):
    state = FakeState(
        users=[
            FakeRow(
                id="portico-service",
                email="portico-service@localhost",
                name="old",
                role="pending",
                profile_image_url="/old.png",
            )
        ]
    )
    bridge = load_auth_bridge_with_state(monkeypatch, state)

    user = bridge._ensure_service_user()

    assert user.id == "portico-service"
    assert user.role == "admin"
    assert len(state.auths) == 1
    assert state.auths[0].id == "portico-service"
    assert state.auths[0].email == "portico-service@localhost"
    assert state.auths[0].active is True


def test_service_user_reconciles_orphan_auth_row_without_duplicate_insert(monkeypatch):
    state = FakeState(
        auths=[
            FakeRow(
                id="portico-service",
                email="portico-service@localhost",
                password="hashed",
                active=False,
            )
        ]
    )
    bridge = load_auth_bridge_with_state(monkeypatch, state)

    user = bridge._ensure_service_user()

    assert user.id == "portico-service"
    assert user.email == "portico-service@localhost"
    assert len(state.users) == 1
    assert len(state.auths) == 1
    assert state.auths[0].active is True


def test_service_user_reconciles_stale_auth_email_row(monkeypatch):
    state = FakeState(
        auths=[
            FakeRow(
                id="stale-service-id",
                email="portico-service@localhost",
                password="hashed",
                active=False,
            )
        ]
    )
    bridge = load_auth_bridge_with_state(monkeypatch, state)

    bridge._ensure_service_user()

    assert len(state.auths) == 1
    assert state.auths[0].id == "portico-service"
    assert state.auths[0].active is True


def test_bridge_secret_failures_do_not_reconcile_service_user(monkeypatch):
    state = FakeState()
    bridge = load_auth_bridge_with_state(monkeypatch, state)

    monkeypatch.delenv("OWUI_AUTH_BRIDGE_SECRET", raising=False)
    with pytest.raises(bridge.HTTPException) as missing_secret:
        bridge._require_bridge_secret(FakeRequest("Bearer ignored"))
    assert missing_secret.value.status_code == 503
    assert state.users == []
    assert state.auths == []

    monkeypatch.setenv("OWUI_AUTH_BRIDGE_SECRET", "expected")
    with pytest.raises(bridge.HTTPException) as invalid_secret:
        bridge._require_bridge_secret(FakeRequest("Bearer wrong"))
    assert invalid_secret.value.status_code == 401
    assert state.users == []
    assert state.auths == []
