import asyncio
from typing import Optional

_rate_limit_cancel_events = {}
_rate_limit_cancel_lock = asyncio.Lock()


def build_rate_limit_cancel_key(
    user_id: Optional[str], chat_id: Optional[str], message_id: Optional[str]
) -> Optional[str]:
    if not user_id or not chat_id or not message_id:
        return None
    return f"{user_id}:{chat_id}:{message_id}"


async def register_rate_limit_cancel(key: str) -> asyncio.Event:
    async with _rate_limit_cancel_lock:
        event = asyncio.Event()
        _rate_limit_cancel_events[key] = event
        return event


async def clear_rate_limit_cancel(
    key: str, event: Optional[asyncio.Event] = None
) -> None:
    async with _rate_limit_cancel_lock:
        current = _rate_limit_cancel_events.get(key)
        if event is not None and current is not event:
            return
        _rate_limit_cancel_events.pop(key, None)


async def request_rate_limit_cancel(key: str) -> bool:
    async with _rate_limit_cancel_lock:
        event = _rate_limit_cancel_events.get(key)
        if not event:
            return False
        event.set()
        return True


async def wait_for_rate_limit_cancel(event: asyncio.Event, timeout: float) -> bool:
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return False
