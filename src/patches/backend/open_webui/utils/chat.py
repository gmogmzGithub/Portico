import time
import logging
import sys

from aiocache import cached
from typing import Any, Optional
import random
import json
import inspect
import uuid
import asyncio

from fastapi import Request, status
from starlette.responses import Response, StreamingResponse, JSONResponse


from open_webui.models.users import UserModel

from open_webui.socket.main import (
    sio,
    get_event_call,
)
from open_webui.utils.delegated_events import get_event_emitter
from open_webui.functions import generate_function_chat_completion

from open_webui.routers.openai import (
    generate_chat_completion as generate_openai_chat_completion,
)

from open_webui.routers.ollama import (
    generate_chat_completion as generate_ollama_chat_completion,
)

from open_webui.routers.pipelines import (
    process_pipeline_inlet_filter,
    process_pipeline_outlet_filter,
)

from open_webui.models.functions import Functions
from open_webui.models.models import Models


from open_webui.utils.plugin import (
    load_function_module_by_id,
    get_function_module_from_cache,
)
from open_webui.utils.models import get_all_models, check_model_access
from open_webui.utils.payload import convert_payload_openai_to_ollama
from open_webui.utils.response import (
    convert_response_ollama_to_openai,
    convert_streaming_response_ollama_to_openai,
)
from open_webui.utils.filter import (
    get_sorted_filter_ids,
    process_filter_functions,
)
from open_webui.utils.llm_debug import is_auxiliary_task_name

from open_webui.env import GLOBAL_LOG_LEVEL, BYPASS_MODEL_ACCESS_CONTROL

CONTAINER_SRC_DIR = "/app/src"
if CONTAINER_SRC_DIR not in sys.path:
    sys.path.insert(0, CONTAINER_SRC_DIR)

try:
    from event_publisher import publish_error, publish_response_complete

    LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = True
except ImportError:
    LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = False

    async def publish_response_complete(*args, **kwargs):
        return False

    async def publish_error(*args, **kwargs):
        return False


logging.basicConfig(stream=sys.stdout, level=GLOBAL_LOG_LEVEL)
log = logging.getLogger(__name__)


def _summarize_chat_request_for_logging(form_data: Any) -> dict[str, Any]:
    summary = {
        "model": None,
        "stream": False,
        "messages": 0,
        "system": 0,
        "user": 0,
        "assistant": 0,
        "tool": 0,
        "files": 0,
        "tools": 0,
    }
    if not isinstance(form_data, dict):
        return summary

    summary["model"] = form_data.get("model")
    summary["stream"] = bool(form_data.get("stream", False))
    summary["files"] = len(form_data.get("files") or [])
    summary["tools"] = len(form_data.get("tools") or [])

    messages = form_data.get("messages")
    if not isinstance(messages, list):
        return summary

    summary["messages"] = len(messages)
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role in ("system", "user", "assistant", "tool"):
            summary[role] += 1

    return summary


def _merge_request_and_form_metadata(
    request_metadata: Any, form_metadata: Any
) -> Optional[dict]:
    """Nested task calls must keep their own debug identity."""
    has_request_metadata = isinstance(request_metadata, dict)
    has_form_metadata = isinstance(form_metadata, dict)

    if has_request_metadata and has_form_metadata:
        return {
            **request_metadata,
            **form_metadata,
        }
    if has_form_metadata:
        return dict(form_metadata)
    if has_request_metadata:
        return dict(request_metadata)
    return None


def _should_publish_auxiliary_terminal_event(
    metadata: Any, form_data: Any
) -> bool:
    if not LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE:
        return False
    if not isinstance(metadata, dict) or not isinstance(form_data, dict):
        return False
    if form_data.get("stream", False):
        return False
    if not metadata.get("chat_id") or not metadata.get("session_id"):
        return False
    if not metadata.get("debug_request_id"):
        return False
    return is_auxiliary_task_name(metadata.get("task"))


def _coerce_debug_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, default=str)
    except Exception:
        return str(value)


def _extract_error_message(payload: Any, body_text: str, exc: Optional[Exception] = None) -> str:
    if isinstance(payload, dict):
        error_value = payload.get("error")
        if isinstance(error_value, dict):
            message = error_value.get("message")
            if message:
                return _coerce_debug_text(message)
        if error_value:
            return _coerce_debug_text(error_value)
        detail = payload.get("detail")
        if detail:
            return _coerce_debug_text(detail)
        message = payload.get("message")
        if message:
            return _coerce_debug_text(message)
    if body_text:
        return body_text
    if exc is not None:
        detail = getattr(exc, "detail", None)
        if detail:
            return _coerce_debug_text(detail)
        return _coerce_debug_text(exc)
    return "Unknown auxiliary request error"


def _decode_response_payload(response: Any) -> tuple[Any, str, Optional[int]]:
    payload = None
    body_text = ""
    status_code = None

    if isinstance(response, dict):
        payload = response
        return payload, body_text, status_code

    if isinstance(response, str):
        body_text = response
        return payload, body_text, status_code

    if isinstance(response, Response):
        status_code = getattr(response, "status_code", None)
        body = getattr(response, "body", None)
        if isinstance(body, (bytes, bytearray)):
            body_text = body.decode("utf-8", "replace")
        elif isinstance(body, str):
            body_text = body
        if body_text:
            try:
                payload = json.loads(body_text)
            except Exception:
                payload = None
        return payload, body_text, status_code

    if response is not None:
        body_text = _coerce_debug_text(response)

    return payload, body_text, status_code


async def _publish_auxiliary_success_event(
    metadata: dict,
    form_data: dict,
    response: Any,
    started_monotonic: float,
) -> None:
    if not _should_publish_auxiliary_terminal_event(metadata, form_data):
        return
    if isinstance(response, StreamingResponse):
        return

    payload, body_text, status_code = _decode_response_payload(response)

    if (
        (status_code is not None and status_code >= 400)
        or (isinstance(payload, dict) and ("error" in payload or "detail" in payload))
    ):
        await _publish_auxiliary_error_event(
            metadata, form_data, started_monotonic, payload=payload, body_text=body_text
        )
        return

    usage = payload.get("usage", {}) if isinstance(payload, dict) else {}
    choices = payload.get("choices", []) if isinstance(payload, dict) else []
    choice = choices[0] if choices and isinstance(choices[0], dict) else {}
    choice_message = choice.get("message", {}) if isinstance(choice.get("message", {}), dict) else {}

    response_content = _coerce_debug_text(choice_message.get("content", ""))
    if not response_content and body_text:
        response_content = body_text
    if not response_content and payload is not None:
        response_content = _coerce_debug_text(payload)

    thinking_content = _coerce_debug_text(
        choice_message.get("reasoning_content")
        or (
            payload.get("reasoning_content")
            if isinstance(payload, dict)
            else ""
        )
    )
    tool_calls = choice_message.get("tool_calls", [])
    if not isinstance(tool_calls, list):
        tool_calls = []

    finish_reason = (
        choice.get("finish_reason")
        or (
            payload.get("finish_reason")
            if isinstance(payload, dict)
            else None
        )
        or (
            payload.get("stop_reason")
            if isinstance(payload, dict)
            else None
        )
        or "stop"
    )
    duration_ms = max(0, int((time.monotonic() - started_monotonic) * 1000))

    try:
        await publish_response_complete(
            session_id=metadata.get("session_id"),
            chat_id=metadata.get("chat_id"),
            model=(
                payload.get("model")
                if isinstance(payload, dict)
                else None
            )
            or form_data.get("model", "unknown"),
            usage=usage if isinstance(usage, dict) else {},
            finish_reason=finish_reason,
            duration_ms=duration_ms,
            has_tool_calls=len(tool_calls) > 0,
            response_content=response_content,
            tool_calls=tool_calls,
            thinking_content=thinking_content,
            debug_request_id=metadata.get("debug_request_id"),
            upstream_request_id=metadata.get("upstream_request_id"),
            task_name=metadata.get("task"),
            request_phase=metadata.get("request_phase"),
            followup_index=metadata.get("followup_index"),
            outer_message_id=metadata.get("outer_message_id"),
            trigger_message_id=metadata.get("trigger_message_id"),
            transcript_anchor_kind=metadata.get("transcript_anchor_kind"),
            transcript_anchor_message_id=metadata.get(
                "transcript_anchor_message_id"
            ),
            transcript_anchor_tool_block_index=metadata.get(
                "transcript_anchor_tool_block_index"
            ),
        )
    except Exception as exc:
        log.warning(
            "[LLM_DEBUG_MONITOR] Failed to publish auxiliary completion event: %s",
            exc,
        )


async def _publish_auxiliary_error_event(
    metadata: dict,
    form_data: dict,
    started_monotonic: float,
    *,
    payload: Any = None,
    body_text: str = "",
    exc: Optional[Exception] = None,
) -> None:
    if not _should_publish_auxiliary_terminal_event(metadata, form_data):
        return

    error_message = _extract_error_message(payload, body_text, exc)
    try:
        await publish_error(
            session_id=metadata.get("session_id"),
            chat_id=metadata.get("chat_id"),
            error=error_message,
            stack=None,
            debug_request_id=metadata.get("debug_request_id"),
            upstream_request_id=metadata.get("upstream_request_id"),
            task_name=metadata.get("task"),
            request_phase=metadata.get("request_phase"),
            followup_index=metadata.get("followup_index"),
            outer_message_id=metadata.get("outer_message_id"),
            trigger_message_id=metadata.get("trigger_message_id"),
            transcript_anchor_kind=metadata.get("transcript_anchor_kind"),
            transcript_anchor_message_id=metadata.get(
                "transcript_anchor_message_id"
            ),
            transcript_anchor_tool_block_index=metadata.get(
                "transcript_anchor_tool_block_index"
            ),
        )
    except Exception as publish_exc:
        log.warning(
            "[LLM_DEBUG_MONITOR] Failed to publish auxiliary error event: %s",
            publish_exc,
        )


async def generate_direct_chat_completion(
    request: Request,
    form_data: dict,
    user: Any,
    models: dict,
):
    log.info("generate_direct_chat_completion")

    metadata = form_data.pop("metadata", {})

    user_id = metadata.get("user_id")
    session_id = metadata.get("session_id")
    request_id = str(uuid.uuid4())  # Generate a unique request ID

    event_caller = get_event_call(metadata)

    channel = f"{user_id}:{session_id}:{request_id}"
    logging.info(f"WebSocket channel: {channel}")

    if form_data.get("stream"):
        q = asyncio.Queue()

        async def message_listener(sid, data):
            """
            Handle received socket messages and push them into the queue.
            """
            await q.put(data)

        # Register the listener
        sio.on(channel, message_listener)

        # Start processing chat completion in background
        res = await event_caller(
            {
                "type": "request:chat:completion",
                "data": {
                    "form_data": form_data,
                    "model": models[form_data["model"]],
                    "channel": channel,
                    "session_id": session_id,
                },
            }
        )

        log.info(f"res: {res}")

        if res.get("status", False):
            # Define a generator to stream responses
            async def event_generator():
                nonlocal q
                try:
                    while True:
                        data = await q.get()  # Wait for new messages
                        if isinstance(data, dict):
                            if "done" in data and data["done"]:
                                break  # Stop streaming when 'done' is received

                            yield f"data: {json.dumps(data)}\n\n"
                        elif isinstance(data, str):
                            if "data:" in data:
                                yield f"{data}\n\n"
                            else:
                                yield f"data: {data}\n\n"
                except Exception as e:
                    log.debug(f"Error in event generator: {e}")
                    pass

            # Define a background task to run the event generator
            async def background():
                try:
                    del sio.handlers["/"][channel]
                except Exception as e:
                    pass

            # Return the streaming response
            return StreamingResponse(
                event_generator(), media_type="text/event-stream", background=background
            )
        else:
            raise Exception(str(res))
    else:
        res = await event_caller(
            {
                "type": "request:chat:completion",
                "data": {
                    "form_data": form_data,
                    "model": models[form_data["model"]],
                    "channel": channel,
                    "session_id": session_id,
                },
            }
        )

        if "error" in res and res["error"]:
            raise Exception(res["error"])

        return res


async def generate_chat_completion(
    request: Request,
    form_data: dict,
    user: Any,
    bypass_filter: bool = False,
):
    request_summary = _summarize_chat_request_for_logging(form_data)
    log.debug(
        "[CHAT] generate_chat_completion model=%s stream=%s messages=%d system_msgs=%d user_msgs=%d assistant_msgs=%d tool_msgs=%d files=%d tools=%d",
        request_summary["model"],
        request_summary["stream"],
        request_summary["messages"],
        request_summary["system"],
        request_summary["user"],
        request_summary["assistant"],
        request_summary["tool"],
        request_summary["files"],
        request_summary["tools"],
    )
    if BYPASS_MODEL_ACCESS_CONTROL:
        bypass_filter = True

    request_metadata = (
        getattr(request.state, "metadata", None)
        if hasattr(request, "state")
        else None
    )
    merged_metadata = _merge_request_and_form_metadata(
        request_metadata, form_data.get("metadata")
    )
    if merged_metadata is not None:
        form_data["metadata"] = merged_metadata
    metadata = form_data.get("metadata") if isinstance(form_data.get("metadata"), dict) else None
    request_started_monotonic = time.monotonic()

    if getattr(request.state, "direct", False) and hasattr(request.state, "model"):
        models = {
            request.state.model["id"]: request.state.model,
        }
        log.debug(f"direct connection to model: {models}")
    else:
        models = request.app.state.MODELS

    model_id = form_data["model"]
    if model_id not in models:
        raise Exception("Model not found")

    model = models[model_id]

    if getattr(request.state, "direct", False):
        try:
            response = await generate_direct_chat_completion(
                request, form_data, user=user, models=models
            )
        except Exception as exc:
            await _publish_auxiliary_error_event(
                metadata, form_data, request_started_monotonic, exc=exc
            )
            raise
        await _publish_auxiliary_success_event(
            metadata, form_data, response, request_started_monotonic
        )
        return response
    else:
        # Check if user has access to the model
        if not bypass_filter and user.role == "user":
            try:
                check_model_access(user, model)
            except Exception as e:
                raise e

        if model.get("owned_by") == "arena":
            model_ids = model.get("info", {}).get("meta", {}).get("model_ids")
            filter_mode = model.get("info", {}).get("meta", {}).get("filter_mode")
            if model_ids and filter_mode == "exclude":
                model_ids = [
                    model["id"]
                    for model in list(request.app.state.MODELS.values())
                    if model.get("owned_by") != "arena" and model["id"] not in model_ids
                ]

            selected_model_id = None
            if isinstance(model_ids, list) and model_ids:
                selected_model_id = random.choice(model_ids)
            else:
                model_ids = [
                    model["id"]
                    for model in list(request.app.state.MODELS.values())
                    if model.get("owned_by") != "arena"
                ]
                selected_model_id = random.choice(model_ids)

            form_data["model"] = selected_model_id

            if form_data.get("stream") == True:

                async def stream_wrapper(stream):
                    yield f"data: {json.dumps({'selected_model_id': selected_model_id})}\n\n"
                    async for chunk in stream:
                        yield chunk

                response = await generate_chat_completion(
                    request, form_data, user, bypass_filter=True
                )
                return StreamingResponse(
                    stream_wrapper(response.body_iterator),
                    media_type="text/event-stream",
                    background=response.background,
                )
            else:
                return {
                    **(
                        await generate_chat_completion(
                            request, form_data, user, bypass_filter=True
                        )
                    ),
                    "selected_model_id": selected_model_id,
                }

        if model.get("pipe"):
            # Below does not require bypass_filter because this is the only route the uses this function and it is already bypassing the filter
            try:
                response = await generate_function_chat_completion(
                    request, form_data, user=user, models=models
                )
            except Exception as exc:
                await _publish_auxiliary_error_event(
                    metadata, form_data, request_started_monotonic, exc=exc
                )
                raise
            await _publish_auxiliary_success_event(
                metadata, form_data, response, request_started_monotonic
            )
            return response
        if model.get("owned_by") == "ollama":
            # Using /ollama/api/chat endpoint
            form_data = convert_payload_openai_to_ollama(form_data)
            try:
                response = await generate_ollama_chat_completion(
                    request=request,
                    form_data=form_data,
                    user=user,
                    bypass_filter=bypass_filter,
                )
            except Exception as exc:
                await _publish_auxiliary_error_event(
                    metadata, form_data, request_started_monotonic, exc=exc
                )
                raise
            if form_data.get("stream"):
                response.headers["content-type"] = "text/event-stream"
                return StreamingResponse(
                    convert_streaming_response_ollama_to_openai(response),
                    headers=dict(response.headers),
                    background=response.background,
                )
            else:
                response = convert_response_ollama_to_openai(response)
                await _publish_auxiliary_success_event(
                    metadata, form_data, response, request_started_monotonic
                )
                return response
        else:
            try:
                response = await generate_openai_chat_completion(
                    request=request,
                    form_data=form_data,
                    user=user,
                    bypass_filter=bypass_filter,
                )
            except Exception as exc:
                await _publish_auxiliary_error_event(
                    metadata, form_data, request_started_monotonic, exc=exc
                )
                raise
            await _publish_auxiliary_success_event(
                metadata, form_data, response, request_started_monotonic
            )
            return response


chat_completion = generate_chat_completion


async def chat_completed(request: Request, form_data: dict, user: Any):
    if not request.app.state.MODELS:
        await get_all_models(request, user=user)

    if getattr(request.state, "direct", False) and hasattr(request.state, "model"):
        models = {
            request.state.model["id"]: request.state.model,
        }
    else:
        models = request.app.state.MODELS

    data = form_data
    model_id = data["model"]
    if model_id not in models:
        raise Exception("Model not found")

    model = models[model_id]

    try:
        data = await process_pipeline_outlet_filter(request, data, user, models)
    except Exception as e:
        return Exception(f"Error: {e}")

    metadata = {
        "chat_id": data["chat_id"],
        "message_id": data["id"],
        "filter_ids": data.get("filter_ids", []),
        "session_id": data["session_id"],
        "user_id": user.id,
    }

    extra_params = {
        "__event_emitter__": get_event_emitter(metadata),
        "__event_call__": get_event_call(metadata),
        "__user__": user.model_dump() if isinstance(user, UserModel) else {},
        "__metadata__": metadata,
        "__request__": request,
        "__model__": model,
    }

    try:
        filter_functions = [
            Functions.get_function_by_id(filter_id)
            for filter_id in get_sorted_filter_ids(
                request, model, metadata.get("filter_ids", [])
            )
        ]

        result, _ = await process_filter_functions(
            request=request,
            filter_functions=filter_functions,
            filter_type="outlet",
            form_data=data,
            extra_params=extra_params,
        )
        return result
    except Exception as e:
        return Exception(f"Error: {e}")


async def chat_action(request: Request, action_id: str, form_data: dict, user: Any):
    if "." in action_id:
        action_id, sub_action_id = action_id.split(".")
    else:
        sub_action_id = None

    action = Functions.get_function_by_id(action_id)
    if not action:
        raise Exception(f"Action not found: {action_id}")

    if not request.app.state.MODELS:
        await get_all_models(request, user=user)

    if getattr(request.state, "direct", False) and hasattr(request.state, "model"):
        models = {
            request.state.model["id"]: request.state.model,
        }
    else:
        models = request.app.state.MODELS

    data = form_data
    model_id = data["model"]

    if model_id not in models:
        raise Exception("Model not found")
    model = models[model_id]

    __event_emitter__ = get_event_emitter(
        {
            "chat_id": data["chat_id"],
            "message_id": data["id"],
            "session_id": data["session_id"],
            "user_id": user.id,
        }
    )
    __event_call__ = get_event_call(
        {
            "chat_id": data["chat_id"],
            "message_id": data["id"],
            "session_id": data["session_id"],
            "user_id": user.id,
        }
    )

    function_module, _, _ = get_function_module_from_cache(request, action_id)

    if hasattr(function_module, "valves") and hasattr(function_module, "Valves"):
        valves = Functions.get_function_valves_by_id(action_id)
        function_module.valves = function_module.Valves(**(valves if valves else {}))

    if hasattr(function_module, "action"):
        try:
            action = function_module.action

            # Get the signature of the function
            sig = inspect.signature(action)
            params = {"body": data}

            # Extra parameters to be passed to the function
            extra_params = {
                "__model__": model,
                "__id__": sub_action_id if sub_action_id is not None else action_id,
                "__event_emitter__": __event_emitter__,
                "__event_call__": __event_call__,
                "__request__": request,
            }

            # Add extra params in contained in function signature
            for key, value in extra_params.items():
                if key in sig.parameters:
                    params[key] = value

            if "__user__" in sig.parameters:
                __user__ = user.model_dump() if isinstance(user, UserModel) else {}

                try:
                    if hasattr(function_module, "UserValves"):
                        __user__["valves"] = function_module.UserValves(
                            **Functions.get_user_valves_by_id_and_user_id(
                                action_id, user.id
                            )
                        )
                except Exception as e:
                    log.exception(f"Failed to get user values: {e}")

                params = {**params, "__user__": __user__}

            if inspect.iscoroutinefunction(action):
                data = await action(**params)
            else:
                data = action(**params)

        except Exception as e:
            return Exception(f"Error: {e}")

    return data
