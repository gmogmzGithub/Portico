import logging
import os
import sys
import tempfile
import threading
import time
import types
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from open_webui.config import CACHE_DIR
from open_webui.internal.db import get_db
from open_webui.models.functions import (
    Function,
    FunctionMeta,
    FunctionWithValvesModel,
)
from open_webui.utils.auth import get_admin_user
from open_webui.utils.plugin import (
    extract_frontmatter,
    install_frontmatter_requirements,
    replace_imports,
)
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter()

MANAGED_FUNCTION_PREFIX = "portico_core_"
_managed_function_lock = threading.Lock()


class ManagedFunctionUpsertForm(BaseModel):
    name: str
    content: str
    meta: FunctionMeta
    valves: dict | None = None
    is_active: Literal[True] = True
    is_global: Literal[True] = True


def _validate_managed_function_id(function_id: str) -> None:
    if (
        function_id != function_id.lower()
        or not function_id.isidentifier()
        or not function_id.startswith(MANAGED_FUNCTION_PREFIX)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Managed function ids must be lowercase identifiers with the portico_core_ prefix",
        )


def _restore_module(module_name: str, previous_module) -> None:
    if previous_module is None:
        sys.modules.pop(module_name, None)
    else:
        sys.modules[module_name] = previous_module


def _load_managed_filter_module(function_id: str, content: str):
    """Load and validate managed filter code without mutating persisted state."""
    frontmatter = extract_frontmatter(content)
    install_frontmatter_requirements(frontmatter.get("requirements", ""))

    module_name = f"function_{function_id}"
    previous_module = sys.modules.get(module_name)
    module = types.ModuleType(module_name)
    sys.modules[module_name] = module

    with tempfile.NamedTemporaryFile(delete=False) as temp_file:
        temp_file_path = temp_file.name
    try:
        with open(temp_file_path, "w", encoding="utf-8") as file:
            file.write(content)
        module.__dict__["__file__"] = temp_file_path
        exec(content, module.__dict__)  # noqa: S102 - managed Open WebUI plugin source
        if not hasattr(module, "Filter"):
            raise ValueError("Managed function must define a Filter class")
        return module, module.Filter(), frontmatter, previous_module
    except Exception:
        _restore_module(module_name, previous_module)
        raise
    finally:
        os.unlink(temp_file_path)


def _validated_valves(function_instance, valves: dict | None) -> dict | None:
    if valves is None:
        return None
    if not hasattr(function_instance, "Valves"):
        if valves:
            raise ValueError("Managed filter does not define valves")
        return {}

    Valves = function_instance.Valves
    validated = Valves(
        **{key: value for key, value in valves.items() if value is not None}
    )
    return validated.model_dump(exclude_unset=True)


def _read_managed_function(function_id: str) -> FunctionWithValvesModel | None:
    with get_db() as db:
        function = db.get(Function, function_id)
        if function is None:
            return None
        return FunctionWithValvesModel.model_validate(function)


@router.get("/id/{function_id}", response_model=FunctionWithValvesModel)
async def get_managed_function(
    function_id: str,
    user=Depends(get_admin_user),  # noqa: B008 - FastAPI dependency injection
):
    _validate_managed_function_id(function_id)
    function = _read_managed_function(function_id)
    if function is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Managed function not found",
        )
    return function


@router.put("/id/{function_id}", response_model=FunctionWithValvesModel)
async def upsert_managed_function(
    request: Request,
    function_id: str,
    form_data: ManagedFunctionUpsertForm,
    user=Depends(get_admin_user),  # noqa: B008 - FastAPI dependency injection
):
    _validate_managed_function_id(function_id)
    content = replace_imports(form_data.content)

    with _managed_function_lock:
        module_name = f"function_{function_id}"
        previous_module = sys.modules.get(module_name)
        try:
            _function_module, function_instance, frontmatter, previous_module = (
                _load_managed_filter_module(function_id, content)
            )
            valves = _validated_valves(function_instance, form_data.valves)
        except Exception as error:
            _restore_module(module_name, previous_module)
            log.exception("Managed filter validation failed for %s", function_id)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Managed filter validation failed: {error}",
            ) from error

        metadata = form_data.meta.model_dump()
        metadata["manifest"] = frontmatter
        if getattr(function_instance, "toggle", None):
            metadata["toggle"] = True

        try:
            function_cache_dir = CACHE_DIR / "functions" / function_id
            function_cache_dir.mkdir(parents=True, exist_ok=True)

            with get_db() as db:
                try:
                    now = int(time.time())
                    function = db.get(Function, function_id)
                    if function is None:
                        function = Function(
                            id=function_id,
                            user_id=user.id,
                            created_at=now,
                        )
                        db.add(function)

                    function.name = form_data.name
                    function.type = "filter"
                    function.content = content
                    function.meta = metadata
                    function.valves = valves
                    function.is_active = form_data.is_active
                    function.is_global = form_data.is_global
                    function.updated_at = now

                    db.flush()
                    result = FunctionWithValvesModel.model_validate(function)
                    db.commit()
                except Exception:
                    db.rollback()
                    raise
        except Exception as error:
            _restore_module(module_name, previous_module)
            log.exception("Managed filter upsert failed for %s", function_id)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Managed filter upsert failed",
            ) from error

        if not hasattr(request.app.state, "FUNCTIONS"):
            request.app.state.FUNCTIONS = {}
        if not hasattr(request.app.state, "FUNCTION_CONTENTS"):
            request.app.state.FUNCTION_CONTENTS = {}
        request.app.state.FUNCTIONS[function_id] = function_instance
        request.app.state.FUNCTION_CONTENTS[function_id] = content

        return result
