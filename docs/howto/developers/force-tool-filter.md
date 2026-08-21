# Force Specific Tools with a Global Filter

This guide explains how to add a filter function that guarantees one or more tools are always included in every chat request, regardless of what the frontend sends. It relies on Open WebUI’s filter pipeline, which runs before tools are resolved and executed.

## Why a Filter?

- Every incoming chat payload passes through `process_filter_functions(..., filter_type="inlet")` (`backend/open_webui/utils/middleware.py:1131`).
- The filter is invoked *before* the tool resolver copies `tool_ids` into `metadata` and instantiates the callable tool objects (`backend/open_webui/utils/middleware.py:1175`, `backend/open_webui/utils/tools.py:91`).
- Marking a filter as **Global** and **Active** makes it run for every model automatically (`backend/open_webui/models/functions.py:249`, `backend/open_webui/utils/filter.py:33`).

## Filter Template

Create a new function (Admin → Functions → New) of type **filter**, paste the code below, save it, mark it *Global* and *Active*, and adjust the valves in the UI to list the tool IDs you need.

```python
"""
title: Force Tool Filter
version: 1.0.0
"""

import logging
from typing import Optional, Sequence

from pydantic import BaseModel, Field

from open_webui.models.tools import Tools

logger = logging.getLogger("ForceToolFilter")


class Filter:
    class Valves(BaseModel):
        enable: bool = Field(default=True, description="Toggle filter on/off.")
        tool_ids: Sequence[str] = Field(
            default=("your_tool_id",),
            description="Tool IDs to inject when they are missing.",
        )
        fail_if_missing: bool = Field(
            default=False,
            description="Raise an error when a configured tool is not installed.",
        )

    def __init__(self) -> None:
        self.valves = self.Valves()

    async def inlet(
        self,
        body: dict,
        __user__: Optional[dict] = None,
        __metadata__: Optional[dict] = None,
    ) -> dict:
        if not self.valves.enable:
            return body

        required = [tool_id.strip() for tool_id in self.valves.tool_ids if tool_id.strip()]
        if not required:
            return body

        current_ids = body.get("tool_ids") or []
        if isinstance(current_ids, str):
            current_ids = [current_ids]
        else:
            current_ids = list(current_ids)

        for tool_id in required:
            if tool_id in current_ids:
                continue

            if Tools.get_tool_by_id(tool_id) is None:
                message = f"Configured tool '{tool_id}' is not installed."
                if self.valves.fail_if_missing:
                    raise RuntimeError(message)
                logger.warning(message)
                continue

            current_ids.append(tool_id)

        if current_ids:
            body["tool_ids"] = current_ids

        return body
```

### Key Behaviours

- **Idempotent** – avoids duplicates and honours existing user-selected tools.
- **Validation** – optionally fails fast when a configured tool is missing, helping surface misconfiguration.
- **User-aware** – receives `__user__` and `__metadata__` if you need per-user logic later.

## Deployment Checklist

- Add the filter via the admin UI and paste the template.
- Configure the valve `tool_ids` with the tool identifiers you want to enforce.
- Set the filter to **Global** and **Active** so it runs for every model.
- Submit a chat request and confirm the required tool appears in the payload (e.g., via logs or debugging overlay).
- Monitor logs for warnings if `fail_if_missing` is false; enable it when you want misconfiguration to raise an error.

Once the filter is in place, every chat request automatically carries the specified tools, ensuring downstream tool execution always includes your required capabilities.
