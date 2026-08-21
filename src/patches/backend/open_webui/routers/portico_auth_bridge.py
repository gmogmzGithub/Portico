import datetime
import html
import hmac
import json
import logging
import os
import secrets
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, RedirectResponse
try:
    from open_webui.env import (
        WEBUI_SESSION_COOKIE_SAME_SITE as WEBUI_AUTH_COOKIE_SAME_SITE,
        WEBUI_SESSION_COOKIE_SECURE as WEBUI_AUTH_COOKIE_SECURE,
    )
except ImportError:  # pragma: no cover - compatibility with older OWUI bases.
    try:
        from open_webui.env import WEBUI_AUTH_COOKIE_SAME_SITE, WEBUI_AUTH_COOKIE_SECURE
    except ImportError:
        from open_webui.config import WEBUI_AUTH_COOKIE_SAME_SITE, WEBUI_AUTH_COOKIE_SECURE
from open_webui.internal.db import get_db
from open_webui.models.auths import Auth, Auths
from open_webui.models.users import User, Users
from open_webui.utils.access_control import get_permissions
from open_webui.utils.auth import create_token, get_password_hash
try:
    from open_webui.utils.db_diagnostics import get_database_diagnostics_snapshot
except Exception:  # Diagnostics must never prevent the auth router from loading.
    def get_database_diagnostics_snapshot():
        return {"schemaVersion": 1, "installed": False, "unavailable": True}

from open_webui.utils.portico_auth_migration import preserve_legacy_user_settings
from open_webui.utils.misc import parse_duration
from pydantic import BaseModel
from sqlalchemy import bindparam, text
from urllib.parse import urlencode

log = logging.getLogger(__name__)

router = APIRouter()

BRIDGE_SECRET_ENV = "OWUI_AUTH_BRIDGE_SECRET"
BRIDGE_SECRET_FILE_ENV = "OWUI_AUTH_BRIDGE_SECRET_FILE"
SERVICE_EMAIL = "portico-service@localhost"
SERVICE_USER_ID = "portico-service"
SERVICE_NAME = "Portico Service"
LEGACY_ADMIN_EMAIL = "admin@localhost"
HANDOFF_TTL_SECONDS = 60
MAX_HANDOFFS = 128
APP_SUPPORT_DIR_ENV = "PORTICO_APP_SUPPORT_DIR"
FUSE_DIR_NAME = "compatibility-fuses"
OWUI_AUTH_MIGRATION_FUSE_FILENAME = "owui-auth-user-migration.json"
OWUI_AUTH_MIGRATION_FUSE_NAME = "owui-auth-user-migration"

_handoffs: dict[str, dict] = {}


class HumanSessionRequest(BaseModel):
    email: str
    name: str
    user_id: Optional[str] = None
    preferred_username: Optional[str] = None
    claims: Optional[dict] = None
    handoff: Optional[bool] = False
    redirect: Optional[str] = "/"


class ServiceTokenRequest(BaseModel):
    reason: Optional[str] = None


def _read_secret() -> str:
    file_path = os.environ.get(BRIDGE_SECRET_FILE_ENV, "").strip()
    if file_path:
        try:
            return Path(file_path).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return os.environ.get(BRIDGE_SECRET_ENV, "").strip()


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _write_owui_auth_migration_fuse(migration: dict) -> Optional[str]:
    app_support_dir = os.environ.get(APP_SUPPORT_DIR_ENV, "").strip()
    if not app_support_dir:
        log.warning(
            "OWUI auth migration fuse not written because %s is not configured",
            APP_SUPPORT_DIR_ENV,
        )
        return None

    migrated_tables = migration.get("migrated_tables") if isinstance(migration, dict) else []
    migrated_table_count = len(migrated_tables) if isinstance(migrated_tables, list) else 0
    migration_status = migration.get("status") if isinstance(migration, dict) else None
    migration_reason = migration.get("reason") if isinstance(migration, dict) else None
    fuse_path = (
        Path(app_support_dir)
        / FUSE_DIR_NAME
        / OWUI_AUTH_MIGRATION_FUSE_FILENAME
    )
    payload = {
        "schemaVersion": 1,
        "fuse": OWUI_AUTH_MIGRATION_FUSE_NAME,
        "blownAt": _utc_now_iso(),
        "source": "pre-beta-tmp",
        "details": {
            "migrationStatus": migration_status,
            "migrationReason": migration_reason,
            "migratedTableCount": migrated_table_count,
        },
    }

    try:
        fuse_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = fuse_path.with_name(f"{fuse_path.name}.tmp-{uuid.uuid4().hex}")
        tmp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        tmp_path.chmod(0o600)
        tmp_path.replace(fuse_path)
        log.info("OWUI auth migration fuse written to %s", fuse_path)
        return str(fuse_path)
    except OSError as exc:
        log.warning("Failed to write OWUI auth migration fuse to %s: %s", fuse_path, exc)
        return None


def _require_bridge_secret(request: Request) -> None:
    configured = _read_secret()
    if not configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OWUI auth bridge secret is not configured",
        )

    authorization = request.headers.get("Authorization", "")
    prefix = "Bearer "
    supplied = authorization[len(prefix) :].strip() if authorization.startswith(prefix) else ""
    if not supplied or not hmac.compare_digest(supplied, configured):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid OWUI auth bridge token",
        )


def _normalize_email(email: str) -> str:
    normalized = str(email or "").strip().lower()
    if not normalized or "@" not in normalized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A valid email is required",
        )
    return normalized


def _normalize_name(name: str, email: str) -> str:
    normalized = str(name or "").strip()
    if normalized:
        return normalized
    return email.split("@", 1)[0] or email


def _random_password_hash() -> str:
    return get_password_hash(secrets.token_urlsafe(48))


def _ensure_auth_row(user_id: str, email: str) -> None:
    with get_db() as db:
        existing = db.query(Auth).filter_by(id=user_id).first()
        if existing:
            existing.email = email
            existing.active = True
        else:
            db.add(
                Auth(
                    id=user_id,
                    email=email,
                    password=_random_password_hash(),
                    active=True,
                )
            )
        db.commit()


def _commit_or_service_user_error(db, reason: str) -> None:
    try:
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            log.warning("OWUI service user reconciliation rollback failed", exc_info=True)
        log.exception("OWUI service user reconciliation failed: %s", reason)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reconcile OWUI service user",
        )


def _ensure_service_user() -> object:
    """Ensure the fixed service principal has matching User and Auth rows."""
    with get_db() as db:
        now = int(time.time())
        user_by_id = db.query(User).filter_by(id=SERVICE_USER_ID).first()
        user_by_email = db.query(User).filter_by(email=SERVICE_EMAIL).first()
        if user_by_id and user_by_email and user_by_id.id != user_by_email.id:
            log.error(
                "OWUI service user reconciliation found conflicting user rows",
                extra={
                    "service_user_id_present": True,
                    "service_email_row_present": True,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Conflicting OWUI service user records",
            )

        service_user = user_by_id or user_by_email
        if service_user:
            service_user.id = SERVICE_USER_ID
            service_user.email = SERVICE_EMAIL
            service_user.name = SERVICE_NAME
            service_user.role = "admin"
            service_user.profile_image_url = getattr(
                service_user,
                "profile_image_url",
                None,
            ) or "/user.png"
            service_user.updated_at = now
            if hasattr(service_user, "last_active_at") and not getattr(
                service_user,
                "last_active_at",
                None,
            ):
                service_user.last_active_at = now
            service_user.oauth = {"portico-service": {"sub": SERVICE_USER_ID}}
        else:
            db.add(
                User(
                    id=SERVICE_USER_ID,
                    email=SERVICE_EMAIL,
                    name=SERVICE_NAME,
                    role="admin",
                    profile_image_url="/user.png",
                    last_active_at=now,
                    created_at=now,
                    updated_at=now,
                    oauth={"portico-service": {"sub": SERVICE_USER_ID}},
                )
            )

        auth_by_id = db.query(Auth).filter_by(id=SERVICE_USER_ID).first()
        auth_by_email = db.query(Auth).filter_by(email=SERVICE_EMAIL).first()
        if auth_by_id and auth_by_email and auth_by_id.id != auth_by_email.id:
            log.error(
                "OWUI service user reconciliation found conflicting auth rows",
                extra={
                    "service_auth_id_present": True,
                    "service_auth_email_row_present": True,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Conflicting OWUI service auth records",
            )

        service_auth = auth_by_id or auth_by_email
        if service_auth:
            service_auth.id = SERVICE_USER_ID
            service_auth.email = SERVICE_EMAIL
            service_auth.active = True
            if not getattr(service_auth, "password", None):
                service_auth.password = _random_password_hash()
        else:
            db.add(
                Auth(
                    id=SERVICE_USER_ID,
                    email=SERVICE_EMAIL,
                    password=_random_password_hash(),
                    active=True,
                )
            )

        _commit_or_service_user_error(db, "commit")

    user = Users.get_user_by_id(SERVICE_USER_ID) or Users.get_user_by_email(
        SERVICE_EMAIL
    )
    if not user:
        log.error("OWUI service user reconciliation committed but user lookup failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load OWUI service user",
        )
    return user


def _resolve_existing_user_role(existing_role: str, requested_role: str) -> str:
    if existing_role == "admin":
        return "admin"
    if requested_role == "admin":
        return "admin"
    if requested_role == "user" and existing_role == "pending":
        return "user"
    return existing_role


def _ensure_user(
    *,
    email: str,
    name: str,
    role: str,
    user_id: Optional[str] = None,
    oauth: Optional[dict] = None,
    profile_image_url: str = "/user.png",
) -> object:
    email = _normalize_email(email)
    name = _normalize_name(name, email)
    existing = Users.get_user_by_email(email)
    if existing:
        updates = {
            "name": name,
            "role": _resolve_existing_user_role(existing.role, role),
            "updated_at": int(time.time()),
        }
        if oauth is not None:
            updates["oauth"] = oauth
        Users.update_user_by_id(existing.id, updates)
        _ensure_auth_row(existing.id, email)
        return Users.get_user_by_id(existing.id)

    requested_id = str(user_id or "").strip()
    if requested_id and not Users.get_user_by_id(requested_id):
        with get_db() as db:
            now = int(time.time())
            db.add(
                User(
                    id=requested_id,
                    email=email,
                    name=name,
                    role=role,
                    profile_image_url=profile_image_url,
                    last_active_at=now,
                    created_at=now,
                    updated_at=now,
                    oauth=oauth,
                )
            )
            db.add(
                Auth(
                    id=requested_id,
                    email=email,
                    password=_random_password_hash(),
                    active=True,
                )
            )
            db.commit()
        return Users.get_user_by_id(requested_id)

    user = Auths.insert_new_auth(
        email,
        _random_password_hash(),
        name,
        profile_image_url,
        role,
        oauth=oauth,
    )
    if not user:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create OWUI user",
        )
    return user


def _token_response(request: Request, user) -> dict:
    expires_delta = parse_duration(request.app.state.config.JWT_EXPIRES_IN)
    expires_at = None
    if expires_delta:
        expires_at = int(time.time()) + int(expires_delta.total_seconds())
    token = create_token(data={"id": user.id}, expires_delta=expires_delta)
    permissions = get_permissions(user.id, request.app.state.config.USER_PERMISSIONS)
    return {
        "token": token,
        "token_type": "Bearer",
        "expires_at": expires_at,
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "profile_image_url": user.profile_image_url,
        "permissions": permissions,
    }


def _cookie_expires(expires_at: Optional[int]):
    if not expires_at:
        return None
    return datetime.datetime.fromtimestamp(expires_at, datetime.timezone.utc)


def _safe_redirect_path(value: Optional[str]) -> str:
    candidate = str(value or "/").strip() or "/"
    try:
        from urllib.parse import urlparse

        parsed = urlparse(candidate)
        if parsed.scheme or parsed.netloc:
            return "/"
    except Exception:
        return "/"
    return candidate if candidate.startswith("/") else "/"


def _no_store_headers(*, nonce: Optional[str] = None) -> dict[str, str]:
    headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    }
    if nonce:
        headers[
            "Content-Security-Policy"
        ] = (
            "default-src 'none'; "
            f"script-src 'nonce-{nonce}'; "
            "style-src 'unsafe-inline'; "
            "base-uri 'none'; "
            "frame-ancestors 'self'; "
            "form-action 'none'"
        )
    return headers


def _handoff_error_response(message: str) -> HTMLResponse:
    escaped_message = html.escape(message)
    return HTMLResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        headers=_no_store_headers(),
        content=f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Open WebUI Authentication</title>
    <style>
      html, body {{
        height: 100%;
        margin: 0;
        background: #050505;
        color: #f4f4f5;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }}
      body {{
        display: grid;
        place-items: center;
      }}
      main {{
        max-width: 36rem;
        padding: 2rem;
        text-align: center;
      }}
    </style>
  </head>
  <body>
    <main>
      <h1>Open WebUI authentication failed</h1>
      <p>{escaped_message}</p>
    </main>
  </body>
</html>""",
    )


def _handoff_bootstrap_response(token: str, expires_at: Optional[int], redirect: str) -> HTMLResponse:
    nonce = secrets.token_urlsafe(24)
    token_json = json.dumps(token)
    redirect_json = json.dumps(_safe_redirect_path(redirect))
    response = HTMLResponse(
        headers=_no_store_headers(nonce=nonce),
        content=f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Opening Open WebUI</title>
    <style>
      html, body {{
        height: 100%;
        margin: 0;
        background: #050505;
        color: #f4f4f5;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }}
      body {{
        display: grid;
        place-items: center;
      }}
    </style>
  </head>
  <body>
    <main>Opening Open WebUI...</main>
    <script nonce="{nonce}">
      (() => {{
        const token = {token_json};
        const redirect = {redirect_json};
        try {{
          window.localStorage.setItem("token", token);
          window.location.replace(redirect || "/");
        }} catch (error) {{
          document.body.textContent = "Open WebUI authentication could not be stored.";
        }}
      }})();
    </script>
  </body>
</html>""",
    )
    response.set_cookie(
        key="token",
        value=token,
        expires=_cookie_expires(expires_at),
        httponly=True,
        samesite=WEBUI_AUTH_COOKIE_SAME_SITE,
        secure=WEBUI_AUTH_COOKIE_SECURE,
    )
    return response


def _prune_handoffs() -> None:
    now = time.time()
    expired = [
        key for key, handoff in _handoffs.items() if handoff.get("expires_at", 0) <= now
    ]
    for key in expired:
        _handoffs.pop(key, None)
    while len(_handoffs) > MAX_HANDOFFS:
        oldest = min(_handoffs.items(), key=lambda item: item[1].get("created_at", 0))[0]
        _handoffs.pop(oldest, None)


def _store_handoff(payload: dict) -> str:
    _prune_handoffs()
    handoff_id = secrets.token_urlsafe(32)
    _handoffs[handoff_id] = {
        **payload,
        "created_at": time.time(),
        "expires_at": time.time() + HANDOFF_TTL_SECONDS,
    }
    return handoff_id


def _load_catalog_model_ids() -> set[str]:
    catalog_path = Path(os.environ.get("OWUI_MODEL_CATALOG_PATH", "/app/model_catalog.yaml"))
    if not catalog_path.exists():
        return set()
    try:
        import yaml

        payload = yaml.safe_load(catalog_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return set()
    model_ids = set()
    for item in payload.get("model_list") or []:
        name = str(item.get("model_name") or "").strip()
        if name:
            model_ids.add(name)
    return model_ids


def _backup_sqlite_db() -> Optional[str]:
    db_path = Path(os.environ.get("DATABASE_URL", "")).as_posix()
    if db_path.startswith("sqlite:///"):
        db_file = Path(db_path[len("sqlite:///") :])
    else:
        db_file = Path(os.environ.get("DATA_DIR", "/app/backend/data")) / "webui.db"
    if not db_file.exists():
        return None
    backup_dir = (
        db_file.parent
        / "auth-migration-backups"
        / f"webui-auth-adoption-{int(time.time())}"
    )
    backup_dir.mkdir(parents=True, exist_ok=True)
    for suffix in ["", "-wal", "-shm"]:
        source = Path(f"{db_file}{suffix}")
        if source.exists():
            shutil.copy2(source, backup_dir / source.name)
    return str(backup_dir)


def _table_names_with_user_id(db) -> list[str]:
    rows = db.execute(
        text(
            """
            SELECT m.name
            FROM sqlite_master m
            JOIN pragma_table_info(m.name) p
            WHERE m.type = 'table'
              AND p.name = 'user_id'
              AND m.name NOT LIKE 'sqlite_%'
            """
        )
    ).fetchall()
    names = []
    for row in rows:
        name = row[0]
        if isinstance(name, str) and name.replace("_", "").isalnum():
            names.append(name)
    return names


def _adopt_legacy_admin_user(human_user_id: str, service_user_id: str) -> dict:
    if not human_user_id or human_user_id == service_user_id:
        return {"status": "skipped", "reason": "invalid_target"}

    catalog_model_ids = _load_catalog_model_ids()
    backup_dir = None

    with get_db() as db:
        legacy = db.query(User).filter_by(email=LEGACY_ADMIN_EMAIL).first()
        if not legacy:
            return {"status": "skipped", "reason": "legacy_user_absent"}
        if legacy.id in {human_user_id, service_user_id}:
            return {"status": "skipped", "reason": "legacy_already_reused"}

        human = db.query(User).filter_by(id=human_user_id).first()
        if not human:
            return {"status": "skipped", "reason": "human_user_absent"}

        blocking_users = (
            db.query(User)
            .filter(User.id.notin_([legacy.id, human_user_id, service_user_id]))
            .all()
        )
        if blocking_users:
            return {
                "status": "skipped",
                "reason": "multiple_existing_users",
                "blocking_user_count": len(blocking_users),
            }

        backup_dir = _backup_sqlite_db()
        settings_preserved = preserve_legacy_user_settings(legacy, human)
        migrated_tables = []
        for table in _table_names_with_user_id(db):
            db.execute(
                text(f'UPDATE "{table}" SET user_id = :human WHERE user_id = :legacy'),
                {"human": human_user_id, "legacy": legacy.id},
            )
            migrated_tables.append(table)

        service_model_ids = set(catalog_model_ids)
        model_update = text(
                """
                UPDATE model
                SET user_id = :service
                WHERE user_id = :human
                  AND (
                    id LIKE 'portico_agent_%'
                    OR id LIKE 'local/%'
                    OR id IN :catalog_ids
                  )
                """
            ).bindparams(bindparam("catalog_ids", expanding=True))
        db.execute(
            model_update,
            {
                "service": service_user_id,
                "human": human_user_id,
                "catalog_ids": list(service_model_ids) or ["__none__"],
            },
        )
        db.execute(
            text(
                """
                UPDATE function
                SET user_id = :service
                WHERE user_id = :human
                  AND id LIKE 'portico_core_%'
                """
            ),
            {"service": service_user_id, "human": human_user_id},
        )
        db.query(Auth).filter_by(id=legacy.id).delete()
        db.query(User).filter_by(id=legacy.id).delete()
        db.commit()

    return {
        "status": "complete",
        "backup_dir": backup_dir,
        "migrated_tables": migrated_tables,
        "catalog_model_count": len(catalog_model_ids),
        "settings_preserved": settings_preserved,
    }


def _oauth_claims(provider: str, claims: Optional[dict]) -> dict:
    raw = claims if isinstance(claims, dict) else {}
    sub = str(raw.get("sub") or raw.get("preferred_username") or raw.get("email") or "").strip()
    return {provider: {"sub": sub, "claims": raw}}


@router.get("/diagnostics/database")
async def get_database_diagnostics(request: Request):
    """Return the redacted process-memory ledger without touching SQLite."""
    _require_bridge_secret(request)
    return get_database_diagnostics_snapshot()


@router.post("/human/session")
async def create_human_session(
    request: Request, response: Response, form_data: HumanSessionRequest
):
    _require_bridge_secret(request)
    email = _normalize_email(form_data.email)
    name = _normalize_name(form_data.name, email)
    user = _ensure_user(
        email=email,
        name=name,
        role="user",
        oauth=_oauth_claims("portico-okta", form_data.claims),
    )
    service_user = _ensure_service_user()
    migration = _adopt_legacy_admin_user(user.id, service_user.id)
    _write_owui_auth_migration_fuse(migration)
    token_payload = _token_response(request, user)
    token_payload["migration"] = migration

    if form_data.handoff:
        handoff_id = _store_handoff(
            {
                "token": token_payload["token"],
                "expires_at_token": token_payload["expires_at"],
                "redirect": _safe_redirect_path(form_data.redirect),
            }
        )
        return {
            "handoff_id": handoff_id,
            "complete_url": f"/api/v1/portico/auth/complete?handoff_id={handoff_id}",
            "expires_in": HANDOFF_TTL_SECONDS,
            "migration": migration,
        }

    response.set_cookie(
        key="token",
        value=token_payload["token"],
        expires=_cookie_expires(token_payload["expires_at"]),
        httponly=True,
        samesite=WEBUI_AUTH_COOKIE_SAME_SITE,
        secure=WEBUI_AUTH_COOKIE_SECURE,
    )
    return token_payload


@router.post("/service-token")
async def create_service_token(request: Request, form_data: ServiceTokenRequest):
    _require_bridge_secret(request)
    user = _ensure_service_user()
    payload = _token_response(request, user)
    payload["service"] = True
    return payload


@router.get("/browser/start")
async def start_browser_login(redirect: Optional[str] = "/"):
    query = urlencode({"return_to": _safe_redirect_path(redirect)})
    return RedirectResponse(url=f"http://127.0.0.1:8877/owui/login?{query}")


@router.get("/complete")
async def complete_handoff(handoff_id: str):
    _prune_handoffs()
    handoff = _handoffs.pop(handoff_id, None)
    if not handoff:
        return _handoff_error_response("The authentication handoff is invalid or expired.")
    token = str(handoff.get("token") or "").strip()
    if not token:
        return _handoff_error_response("The authentication handoff did not include a token.")
    return _handoff_bootstrap_response(
        token=token,
        expires_at=handoff.get("expires_at_token"),
        redirect=handoff.get("redirect"),
    )
