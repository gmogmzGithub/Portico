"""
Patched tasks.py - Fixed TASK_MODEL_EXTERNAL support

This patch ensures TASK_MODEL and TASK_MODEL_EXTERNAL environment variables
are always respected for auxiliary task requests (title, tags, follow-ups, etc.)
by reading directly from os.environ instead of relying on PersistentConfig.
"""
from fastapi import APIRouter, Depends, HTTPException, Response, status, Request
from fastapi.responses import JSONResponse, RedirectResponse

from pydantic import BaseModel
from typing import Optional
import logging
import re
import os

from open_webui.utils.chat import generate_chat_completion
from open_webui.utils.task import (
    title_generation_template,
    follow_up_generation_template,
    query_generation_template,
    image_prompt_generation_template,
    autocomplete_generation_template,
    tags_generation_template,
    emoji_generation_template,
    moa_response_generation_template,
)
from open_webui.utils.auth import get_admin_user, get_verified_user
from open_webui.constants import TASKS

from open_webui.routers.pipelines import process_pipeline_inlet_filter

from open_webui.utils.task import get_task_model_id
from open_webui.utils.llm_debug import (
    build_auxiliary_task_metadata,
    restore_auxiliary_task_metadata,
)
from open_webui.utils.chat_titles import (
    append_no_emoji_title_instruction,
    sanitize_title_completion_response,
)

from open_webui.config import (
    DEFAULT_FOLLOW_UP_GENERATION_PROMPT_TEMPLATE,
    DEFAULT_TAGS_GENERATION_PROMPT_TEMPLATE,
    DEFAULT_IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE,
    DEFAULT_QUERY_GENERATION_PROMPT_TEMPLATE,
    DEFAULT_AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE,
    DEFAULT_EMOJI_GENERATION_PROMPT_TEMPLATE,
    DEFAULT_MOA_GENERATION_PROMPT_TEMPLATE,
    DEFAULT_VOICE_MODE_PROMPT_TEMPLATE,
)


log = logging.getLogger(__name__)

router = APIRouter()


portico_DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE = """### Task:
Generate a concise 3-5 word title that summarizes the chat history.

### Guidelines:
- Capture the main subject or request.
- Use plain words only, with no emoji, pictographs, decorative symbols, or icons.
- Keep the title clear, accurate, and in the chat's primary language.
- Return only a JSON object in this format: {\"title\": \"Concise Chat Title\"}

### Chat History:
<chat_history>
{{MESSAGES:END:6}}
</chat_history>"""


def build_task_metadata(request, form_data: dict, task_name) -> dict:
    return build_auxiliary_task_metadata(
        request.state.metadata if hasattr(request.state, "metadata") else None,
        task_name=task_name,
        task_body=form_data,
        chat_id=form_data.get("chat_id", None),
    )


def restore_task_metadata(
    payload: dict, auxiliary_metadata: dict, form_data: dict, task_name
) -> dict:
    payload["metadata"] = restore_auxiliary_task_metadata(
        payload.get("metadata"),
        auxiliary_metadata,
        task_name=task_name,
        task_body=form_data,
        chat_id=form_data.get("chat_id", None),
    )
    return payload


def get_available_task_models(request):
    """Return the full task model registry, including the active direct model."""
    models = dict(getattr(request.app.state, "MODELS", {}) or {})

    if getattr(request.state, "direct", False) and hasattr(request.state, "model"):
        model = request.state.model
        model_id = model.get("id")
        if model_id:
            models[model_id] = model

    return models


def get_task_model_config(request):
    """
    Get task model configuration, prioritizing environment variables.

    This ensures TASK_MODEL and TASK_MODEL_EXTERNAL env vars are always respected,
    bypassing any potential PersistentConfig/database override issues.
    """
    # Read directly from environment variables first
    task_model = os.environ.get("TASK_MODEL", "")
    task_model_external = os.environ.get("TASK_MODEL_EXTERNAL", "")

    # Strip quotes that may be included from docker-compose.yml
    # e.g., TASK_MODEL_EXTERNAL="Atlas Haiku 4.5" becomes '"Atlas Haiku 4.5"' in os.environ
    task_model = task_model.strip('"\'')
    task_model_external = task_model_external.strip('"\'')

    # Fall back to app config if env vars are empty
    if not task_model:
        task_model = request.app.state.config.TASK_MODEL or ""
    if not task_model_external:
        task_model_external = request.app.state.config.TASK_MODEL_EXTERNAL or ""

    # Persistent config may also contain quoted values from compose input.
    task_model = task_model.strip('"\'')
    task_model_external = task_model_external.strip('"\'')

    return task_model, task_model_external


def get_task_model_id_with_logging(model_id, request, models):
    """
    Wrapper around get_task_model_id that reads env vars directly and logs values.
    """
    task_model, task_model_external = get_task_model_config(request)

    # Check if the task model is in available models
    task_external_available = task_model_external in models if task_model_external else False
    task_local_available = task_model in models if task_model else False

    # Get connection type of the chat model
    chat_model_info = models.get(model_id, {})
    connection_type = chat_model_info.get("connection_type", "external")

    log.info(
        f"Task model selection - chat_model: {model_id}, connection_type: {connection_type}, "
        f"TASK_MODEL: '{task_model}' (available: {task_local_available}), "
        f"TASK_MODEL_EXTERNAL: '{task_model_external}' (available: {task_external_available})"
    )

    task_model_id = get_task_model_id(
        model_id,
        task_model,
        task_model_external,
        models,
    )

    log.info(f"Selected task_model_id: {task_model_id}")

    return task_model_id


##################################
#
# Task Endpoints
#
##################################


@router.get("/config")
async def get_task_config(request: Request, user=Depends(get_verified_user)):
    return {
        "TASK_MODEL": request.app.state.config.TASK_MODEL,
        "TASK_MODEL_EXTERNAL": request.app.state.config.TASK_MODEL_EXTERNAL,
        "TITLE_GENERATION_PROMPT_TEMPLATE": request.app.state.config.TITLE_GENERATION_PROMPT_TEMPLATE,
        "IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE": request.app.state.config.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE,
        "ENABLE_AUTOCOMPLETE_GENERATION": request.app.state.config.ENABLE_AUTOCOMPLETE_GENERATION,
        "AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH": request.app.state.config.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH,
        "TAGS_GENERATION_PROMPT_TEMPLATE": request.app.state.config.TAGS_GENERATION_PROMPT_TEMPLATE,
        "FOLLOW_UP_GENERATION_PROMPT_TEMPLATE": request.app.state.config.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE,
        "ENABLE_FOLLOW_UP_GENERATION": request.app.state.config.ENABLE_FOLLOW_UP_GENERATION,
        "ENABLE_TAGS_GENERATION": request.app.state.config.ENABLE_TAGS_GENERATION,
        "ENABLE_TITLE_GENERATION": request.app.state.config.ENABLE_TITLE_GENERATION,
        "ENABLE_SEARCH_QUERY_GENERATION": request.app.state.config.ENABLE_SEARCH_QUERY_GENERATION,
        "ENABLE_RETRIEVAL_QUERY_GENERATION": request.app.state.config.ENABLE_RETRIEVAL_QUERY_GENERATION,
        "QUERY_GENERATION_PROMPT_TEMPLATE": request.app.state.config.QUERY_GENERATION_PROMPT_TEMPLATE,
        "TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE": request.app.state.config.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE,
        "VOICE_MODE_PROMPT_TEMPLATE": request.app.state.config.VOICE_MODE_PROMPT_TEMPLATE,
    }


class TaskConfigForm(BaseModel):
    TASK_MODEL: Optional[str]
    TASK_MODEL_EXTERNAL: Optional[str]
    ENABLE_TITLE_GENERATION: bool
    TITLE_GENERATION_PROMPT_TEMPLATE: str
    IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE: str
    ENABLE_AUTOCOMPLETE_GENERATION: bool
    AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH: int
    TAGS_GENERATION_PROMPT_TEMPLATE: str
    FOLLOW_UP_GENERATION_PROMPT_TEMPLATE: str
    ENABLE_FOLLOW_UP_GENERATION: bool
    ENABLE_TAGS_GENERATION: bool
    ENABLE_SEARCH_QUERY_GENERATION: bool
    ENABLE_RETRIEVAL_QUERY_GENERATION: bool
    QUERY_GENERATION_PROMPT_TEMPLATE: str
    TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE: str
    VOICE_MODE_PROMPT_TEMPLATE: Optional[str]


@router.post("/config/update")
async def update_task_config(
    request: Request, form_data: TaskConfigForm, user=Depends(get_admin_user)
):
    request.app.state.config.TASK_MODEL = form_data.TASK_MODEL
    request.app.state.config.TASK_MODEL_EXTERNAL = form_data.TASK_MODEL_EXTERNAL
    request.app.state.config.ENABLE_TITLE_GENERATION = form_data.ENABLE_TITLE_GENERATION
    request.app.state.config.TITLE_GENERATION_PROMPT_TEMPLATE = (
        form_data.TITLE_GENERATION_PROMPT_TEMPLATE
    )

    request.app.state.config.ENABLE_FOLLOW_UP_GENERATION = (
        form_data.ENABLE_FOLLOW_UP_GENERATION
    )
    request.app.state.config.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE = (
        form_data.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE
    )

    request.app.state.config.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE = (
        form_data.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE
    )

    request.app.state.config.ENABLE_AUTOCOMPLETE_GENERATION = (
        form_data.ENABLE_AUTOCOMPLETE_GENERATION
    )
    request.app.state.config.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH = (
        form_data.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH
    )

    request.app.state.config.TAGS_GENERATION_PROMPT_TEMPLATE = (
        form_data.TAGS_GENERATION_PROMPT_TEMPLATE
    )
    request.app.state.config.ENABLE_TAGS_GENERATION = form_data.ENABLE_TAGS_GENERATION
    request.app.state.config.ENABLE_SEARCH_QUERY_GENERATION = (
        form_data.ENABLE_SEARCH_QUERY_GENERATION
    )
    request.app.state.config.ENABLE_RETRIEVAL_QUERY_GENERATION = (
        form_data.ENABLE_RETRIEVAL_QUERY_GENERATION
    )

    request.app.state.config.QUERY_GENERATION_PROMPT_TEMPLATE = (
        form_data.QUERY_GENERATION_PROMPT_TEMPLATE
    )
    request.app.state.config.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE = (
        form_data.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE
    )

    request.app.state.config.VOICE_MODE_PROMPT_TEMPLATE = (
        form_data.VOICE_MODE_PROMPT_TEMPLATE
    )

    return {
        "TASK_MODEL": request.app.state.config.TASK_MODEL,
        "TASK_MODEL_EXTERNAL": request.app.state.config.TASK_MODEL_EXTERNAL,
        "ENABLE_TITLE_GENERATION": request.app.state.config.ENABLE_TITLE_GENERATION,
        "TITLE_GENERATION_PROMPT_TEMPLATE": request.app.state.config.TITLE_GENERATION_PROMPT_TEMPLATE,
        "IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE": request.app.state.config.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE,
        "ENABLE_AUTOCOMPLETE_GENERATION": request.app.state.config.ENABLE_AUTOCOMPLETE_GENERATION,
        "AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH": request.app.state.config.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH,
        "TAGS_GENERATION_PROMPT_TEMPLATE": request.app.state.config.TAGS_GENERATION_PROMPT_TEMPLATE,
        "ENABLE_TAGS_GENERATION": request.app.state.config.ENABLE_TAGS_GENERATION,
        "ENABLE_FOLLOW_UP_GENERATION": request.app.state.config.ENABLE_FOLLOW_UP_GENERATION,
        "FOLLOW_UP_GENERATION_PROMPT_TEMPLATE": request.app.state.config.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE,
        "ENABLE_SEARCH_QUERY_GENERATION": request.app.state.config.ENABLE_SEARCH_QUERY_GENERATION,
        "ENABLE_RETRIEVAL_QUERY_GENERATION": request.app.state.config.ENABLE_RETRIEVAL_QUERY_GENERATION,
        "QUERY_GENERATION_PROMPT_TEMPLATE": request.app.state.config.QUERY_GENERATION_PROMPT_TEMPLATE,
        "TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE": request.app.state.config.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE,
        "VOICE_MODE_PROMPT_TEMPLATE": request.app.state.config.VOICE_MODE_PROMPT_TEMPLATE,
    }


@router.post("/title/completions")
async def generate_title(
    request: Request, form_data: dict, user=Depends(get_verified_user)
):

    if not request.app.state.config.ENABLE_TITLE_GENERATION:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"detail": "Title generation is disabled"},
        )

    models = get_available_task_models(request)

    model_id = form_data["model"]
    if model_id not in models:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    # Use patched helper function that reads env vars directly
    task_model_id = get_task_model_id_with_logging(model_id, request, models)

    log.debug(
        f"generating chat title using model {task_model_id} for user {user.email} "
    )

    if request.app.state.config.TITLE_GENERATION_PROMPT_TEMPLATE != "":
        template = request.app.state.config.TITLE_GENERATION_PROMPT_TEMPLATE
    else:
        template = portico_DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE

    content = title_generation_template(template, form_data["messages"], user)
    content = append_no_emoji_title_instruction(content)

    max_tokens = (
        models[task_model_id].get("info", {}).get("params", {}).get("max_tokens", 1000)
    )
    auxiliary_metadata = build_task_metadata(
        request, form_data, TASKS.TITLE_GENERATION
    )

    payload = {
        "model": task_model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        **(
            {"max_tokens": max_tokens}
            if models[task_model_id].get("owned_by") == "ollama"
            else {
                "max_completion_tokens": max_tokens,
            }
        ),
        "metadata": auxiliary_metadata,
    }

    # Process the payload through the pipeline
    try:
        payload = await process_pipeline_inlet_filter(request, payload, user, models)
        payload = restore_task_metadata(
            payload, auxiliary_metadata, form_data, TASKS.TITLE_GENERATION
        )
    except Exception as e:
        raise e

    try:
        response = await generate_chat_completion(request, form_data=payload, user=user)
        return sanitize_title_completion_response(response)
    except Exception as e:
        log.error("Exception occurred", exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": "An internal error has occurred."},
        )


@router.post("/follow_up/completions")
async def generate_follow_ups(
    request: Request, form_data: dict, user=Depends(get_verified_user)
):

    if not request.app.state.config.ENABLE_FOLLOW_UP_GENERATION:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"detail": "Follow-up generation is disabled"},
        )

    models = get_available_task_models(request)

    model_id = form_data["model"]
    if model_id not in models:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    # Use patched helper function that reads env vars directly
    task_model_id = get_task_model_id_with_logging(model_id, request, models)

    log.debug(
        f"generating follow-ups using model {task_model_id} for user {user.email} "
    )

    if request.app.state.config.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE != "":
        template = request.app.state.config.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE
    else:
        template = DEFAULT_FOLLOW_UP_GENERATION_PROMPT_TEMPLATE

    content = follow_up_generation_template(template, form_data["messages"], user)
    auxiliary_metadata = build_task_metadata(
        request, form_data, TASKS.FOLLOW_UP_GENERATION
    )

    payload = {
        "model": task_model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        "metadata": auxiliary_metadata,
    }

    # Process the payload through the pipeline
    try:
        payload = await process_pipeline_inlet_filter(request, payload, user, models)
        payload = restore_task_metadata(
            payload, auxiliary_metadata, form_data, TASKS.FOLLOW_UP_GENERATION
        )
    except Exception as e:
        raise e

    try:
        return await generate_chat_completion(request, form_data=payload, user=user)
    except Exception as e:
        log.error("Exception occurred", exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": "An internal error has occurred."},
        )


@router.post("/tags/completions")
async def generate_chat_tags(
    request: Request, form_data: dict, user=Depends(get_verified_user)
):

    if not request.app.state.config.ENABLE_TAGS_GENERATION:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"detail": "Tags generation is disabled"},
        )

    models = get_available_task_models(request)

    model_id = form_data["model"]
    if model_id not in models:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    # Use patched helper function that reads env vars directly
    task_model_id = get_task_model_id_with_logging(model_id, request, models)

    log.debug(
        f"generating chat tags using model {task_model_id} for user {user.email} "
    )

    if request.app.state.config.TAGS_GENERATION_PROMPT_TEMPLATE != "":
        template = request.app.state.config.TAGS_GENERATION_PROMPT_TEMPLATE
    else:
        template = DEFAULT_TAGS_GENERATION_PROMPT_TEMPLATE

    content = tags_generation_template(template, form_data["messages"], user)
    auxiliary_metadata = build_task_metadata(
        request, form_data, TASKS.TAGS_GENERATION
    )

    payload = {
        "model": task_model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        "metadata": auxiliary_metadata,
    }

    # Process the payload through the pipeline
    try:
        payload = await process_pipeline_inlet_filter(request, payload, user, models)
        payload = restore_task_metadata(
            payload, auxiliary_metadata, form_data, TASKS.TAGS_GENERATION
        )
    except Exception as e:
        raise e

    try:
        return await generate_chat_completion(request, form_data=payload, user=user)
    except Exception as e:
        log.error(f"Error generating chat completion: {e}")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "An internal error has occurred."},
        )


@router.post("/image_prompt/completions")
async def generate_image_prompt(
    request: Request, form_data: dict, user=Depends(get_verified_user)
):
    models = get_available_task_models(request)

    model_id = form_data["model"]
    if model_id not in models:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    # Use patched helper function that reads env vars directly
    task_model_id = get_task_model_id_with_logging(model_id, request, models)

    log.debug(
        f"generating image prompt using model {task_model_id} for user {user.email} "
    )

    if request.app.state.config.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE != "":
        template = request.app.state.config.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE
    else:
        template = DEFAULT_IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE

    content = image_prompt_generation_template(template, form_data["messages"], user)
    auxiliary_metadata = build_task_metadata(
        request, form_data, TASKS.IMAGE_PROMPT_GENERATION
    )

    payload = {
        "model": task_model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        "metadata": auxiliary_metadata,
    }

    # Process the payload through the pipeline
    try:
        payload = await process_pipeline_inlet_filter(request, payload, user, models)
        payload = restore_task_metadata(
            payload, auxiliary_metadata, form_data, TASKS.IMAGE_PROMPT_GENERATION
        )
    except Exception as e:
        raise e

    try:
        return await generate_chat_completion(request, form_data=payload, user=user)
    except Exception as e:
        log.error("Exception occurred", exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": "An internal error has occurred."},
        )


@router.post("/queries/completions")
async def generate_queries(
    request: Request, form_data: dict, user=Depends(get_verified_user)
):

    type = form_data.get("type")
    if type == "web_search":
        if not request.app.state.config.ENABLE_SEARCH_QUERY_GENERATION:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Search query generation is disabled",
            )
    elif type == "retrieval":
        if not request.app.state.config.ENABLE_RETRIEVAL_QUERY_GENERATION:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Query generation is disabled",
            )

    if getattr(request.state, "cached_queries", None):
        log.info(f"Reusing cached queries: {request.state.cached_queries}")
        return request.state.cached_queries

    models = get_available_task_models(request)

    model_id = form_data["model"]
    if model_id not in models:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    # Use patched helper function that reads env vars directly
    task_model_id = get_task_model_id_with_logging(model_id, request, models)

    log.debug(
        f"generating {type} queries using model {task_model_id} for user {user.email}"
    )

    if (request.app.state.config.QUERY_GENERATION_PROMPT_TEMPLATE).strip() != "":
        template = request.app.state.config.QUERY_GENERATION_PROMPT_TEMPLATE
    else:
        template = DEFAULT_QUERY_GENERATION_PROMPT_TEMPLATE

    content = query_generation_template(template, form_data["messages"], user)
    auxiliary_metadata = build_task_metadata(
        request, form_data, TASKS.QUERY_GENERATION
    )

    payload = {
        "model": task_model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        "metadata": auxiliary_metadata,
    }

    # Process the payload through the pipeline
    try:
        payload = await process_pipeline_inlet_filter(request, payload, user, models)
        payload = restore_task_metadata(
            payload, auxiliary_metadata, form_data, TASKS.QUERY_GENERATION
        )
    except Exception as e:
        raise e

    try:
        return await generate_chat_completion(request, form_data=payload, user=user)
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": str(e)},
        )


@router.post("/auto/completions")
async def generate_autocompletion(
    request: Request, form_data: dict, user=Depends(get_verified_user)
):
    if not request.app.state.config.ENABLE_AUTOCOMPLETE_GENERATION:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Autocompletion generation is disabled",
        )

    type = form_data.get("type")
    prompt = form_data.get("prompt")
    messages = form_data.get("messages")

    if request.app.state.config.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH > 0:
        if (
            len(prompt)
            > request.app.state.config.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Input prompt exceeds maximum length of {request.app.state.config.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH}",
            )

    models = get_available_task_models(request)

    model_id = form_data["model"]
    if model_id not in models:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    # Use patched helper function that reads env vars directly
    task_model_id = get_task_model_id_with_logging(model_id, request, models)

    log.debug(
        f"generating autocompletion using model {task_model_id} for user {user.email}"
    )

    if (request.app.state.config.AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE).strip() != "":
        template = request.app.state.config.AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE
    else:
        template = DEFAULT_AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE

    content = autocomplete_generation_template(template, prompt, messages, type, user)
    auxiliary_metadata = build_task_metadata(
        request, form_data, TASKS.AUTOCOMPLETE_GENERATION
    )

    payload = {
        "model": task_model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        "metadata": auxiliary_metadata,
    }

    # Process the payload through the pipeline
    try:
        payload = await process_pipeline_inlet_filter(request, payload, user, models)
        payload = restore_task_metadata(
            payload, auxiliary_metadata, form_data, TASKS.AUTOCOMPLETE_GENERATION
        )
    except Exception as e:
        raise e

    try:
        return await generate_chat_completion(request, form_data=payload, user=user)
    except Exception as e:
        log.error(f"Error generating chat completion: {e}")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "An internal error has occurred."},
        )


@router.post("/emoji/completions")
async def generate_emoji(
    request: Request, form_data: dict, user=Depends(get_verified_user)
):

    models = get_available_task_models(request)

    model_id = form_data["model"]
    if model_id not in models:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    # Use patched helper function that reads env vars directly
    task_model_id = get_task_model_id_with_logging(model_id, request, models)

    log.debug(f"generating emoji using model {task_model_id} for user {user.email} ")

    template = DEFAULT_EMOJI_GENERATION_PROMPT_TEMPLATE

    content = emoji_generation_template(template, form_data["prompt"], user)
    auxiliary_metadata = build_task_metadata(
        request, form_data, TASKS.EMOJI_GENERATION
    )

    payload = {
        "model": task_model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        **(
            {"max_tokens": 4}
            if models[task_model_id].get("owned_by") == "ollama"
            else {
                "max_completion_tokens": 4,
            }
        ),
        "metadata": auxiliary_metadata,
    }

    # Process the payload through the pipeline
    try:
        payload = await process_pipeline_inlet_filter(request, payload, user, models)
        payload = restore_task_metadata(
            payload, auxiliary_metadata, form_data, TASKS.EMOJI_GENERATION
        )
    except Exception as e:
        raise e

    try:
        return await generate_chat_completion(request, form_data=payload, user=user)
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": str(e)},
        )


@router.post("/moa/completions")
async def generate_moa_response(
    request: Request, form_data: dict, user=Depends(get_verified_user)
):

    models = get_available_task_models(request)

    model_id = form_data["model"]

    if model_id not in models:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Model not found",
        )

    template = DEFAULT_MOA_GENERATION_PROMPT_TEMPLATE

    content = moa_response_generation_template(
        template,
        form_data["prompt"],
        form_data["responses"],
    )
    auxiliary_metadata = build_task_metadata(
        request, form_data, TASKS.MOA_RESPONSE_GENERATION
    )

    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": form_data.get("stream", False),
        "metadata": auxiliary_metadata,
    }

    # Process the payload through the pipeline
    try:
        payload = await process_pipeline_inlet_filter(request, payload, user, models)
        payload = restore_task_metadata(
            payload, auxiliary_metadata, form_data, TASKS.MOA_RESPONSE_GENERATION
        )
    except Exception as e:
        raise e

    try:
        return await generate_chat_completion(request, form_data=payload, user=user)
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": str(e)},
        )
