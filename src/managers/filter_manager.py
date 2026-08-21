"""
Filter Manager for Open WebUI
Handles discovery, installation, and management of filter functions.
"""

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


class OpenWebUIApiError(Exception):
    """Raised when an Open WebUI API request fails."""

    def __init__(self, message: str, *, status: Optional[int] = None, response_text: str = ""):
        super().__init__(message)
        self.status = status
        self.response_text = response_text


@runtime_checkable
class OpenWebUIApiClient(Protocol):
    """Small async client surface for Open WebUI API interactions."""

    async def get_json(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Any:
        """Issue a GET request and parse the response body as JSON."""

    async def post_json(
        self,
        path: str,
        payload: Optional[Any] = None,
        *,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Issue a POST request and parse the response body as JSON."""

    async def post_text(
        self,
        path: str,
        payload: Optional[Any] = None,
        *,
        params: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Issue a POST request and return the response body as text."""

    async def delete(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> None:
        """Issue a DELETE request."""


def _build_http_error_message(status: Optional[int], response_text: str) -> str:
    """Build a compact HTTP error message similar to the legacy browser-side logs."""
    if status is None:
        return response_text or "Unknown error"

    response_preview = (response_text or "").strip()[:100]
    if response_preview:
        return f"HTTP {status}: {response_preview}"
    return f"HTTP {status}"


class PlaywrightOpenWebUIApiClient:
    """Compatibility adapter that speaks the client protocol via a Playwright page."""

    def __init__(self, page: Any):
        self.page = page

    async def _request(
        self,
        method: str,
        path: str,
        *,
        payload: Optional[Any] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        result = await self.page.evaluate(
            """
            async ({ method, path, payload, params }) => {
                try {
                    const token = localStorage.getItem('token');

                    if (!token) {
                        return {
                            ok: false,
                            error: 'No token found in localStorage'
                        };
                    }

                    const url = new URL(path, window.location.origin);
                    if (params) {
                        for (const [key, value] of Object.entries(params)) {
                            if (value !== null && value !== undefined) {
                                url.searchParams.set(key, String(value));
                            }
                        }
                    }

                    const options = {
                        method,
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        credentials: 'include'
                    };

                    if (payload !== null && payload !== undefined && method !== 'GET') {
                        options.body = JSON.stringify(payload);
                    }

                    const response = await fetch(url.toString(), options);
                    const text = await response.text();
                    let data = null;

                    if (text) {
                        try {
                            data = JSON.parse(text);
                        } catch (error) {
                            data = null;
                        }
                    }

                    return {
                        ok: response.ok,
                        status: response.status,
                        text,
                        data
                    };
                } catch (error) {
                    return {
                        ok: false,
                        error: error.toString()
                    };
                }
            }
            """,
            {
                "method": method,
                "path": path,
                "payload": payload,
                "params": params,
            },
        )

        if result.get("status") is None:
            raise OpenWebUIApiError(result.get("error", "Unknown error"))

        return result

    async def get_json(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Any:
        result = await self._request("GET", path, params=params)
        if not result["ok"]:
            raise OpenWebUIApiError(
                _build_http_error_message(result.get("status"), result.get("text", "")),
                status=result.get("status"),
                response_text=result.get("text", ""),
            )
        if result.get("data") is None:
            raise OpenWebUIApiError(
                f"Expected JSON response from {path}",
                status=result.get("status"),
                response_text=result.get("text", ""),
            )
        return result["data"]

    async def post_json(
        self,
        path: str,
        payload: Optional[Any] = None,
        *,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        result = await self._request("POST", path, payload=payload, params=params)
        if not result["ok"]:
            raise OpenWebUIApiError(
                _build_http_error_message(result.get("status"), result.get("text", "")),
                status=result.get("status"),
                response_text=result.get("text", ""),
            )
        if result.get("data") is None:
            raise OpenWebUIApiError(
                f"Expected JSON response from {path}",
                status=result.get("status"),
                response_text=result.get("text", ""),
            )
        return result["data"]

    async def post_text(
        self,
        path: str,
        payload: Optional[Any] = None,
        *,
        params: Optional[Dict[str, Any]] = None,
    ) -> str:
        result = await self._request("POST", path, payload=payload, params=params)
        if not result["ok"]:
            raise OpenWebUIApiError(
                _build_http_error_message(result.get("status"), result.get("text", "")),
                status=result.get("status"),
                response_text=result.get("text", ""),
            )
        return result.get("text", "")

    async def delete(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> None:
        result = await self._request("DELETE", path, params=params)
        if not result["ok"]:
            raise OpenWebUIApiError(
                _build_http_error_message(result.get("status"), result.get("text", "")),
                status=result.get("status"),
                response_text=result.get("text", ""),
            )


def coerce_open_webui_api_client(page_or_client: Any) -> OpenWebUIApiClient:
    """Accept either a real API client or the legacy Playwright page object."""
    if isinstance(page_or_client, OpenWebUIApiClient):
        return page_or_client

    if hasattr(page_or_client, "evaluate"):
        return PlaywrightOpenWebUIApiClient(page_or_client)

    raise TypeError(
        "Expected an OpenWebUIApiClient-compatible object or a Playwright page with evaluate()"
    )


class FilterManager:
    """Manages installation and updates of Open WebUI filter functions."""

    portico_CORE_PREFIX = "portico_core_"

    def __init__(self, base_url: str, filters_dir: str):
        """
        Initialize the FilterManager.

        Args:
            base_url: Base URL for Open WebUI API (e.g., http://open-webui:8080)
            filters_dir: Path to directory containing filter Python files
        """
        self.base_url = base_url
        self.filters_dir = filters_dir

    def discover_filters(self) -> List[Dict[str, str]]:
        """
        Scan filters directory and return list of filter files with metadata.

        Returns:
            List of dicts with keys: file_path, filter_id, name, description, code, valves
        """
        filters = []
        filters_path = Path(self.filters_dir)

        if not filters_path.exists():
            logger.warning(f"Filters directory not found: {self.filters_dir}")
            return filters

        for py_file in filters_path.glob("*.py"):
            if py_file.name.startswith("_"):
                # Skip private files like __init__.py
                continue

            try:
                code = py_file.read_text()
                description = self.extract_description(code)

                # Generate filter ID from filename
                filename_base = py_file.stem  # filename without extension
                filter_id = f"{self.portico_CORE_PREFIX}{filename_base}"

                # Check for corresponding .valves file
                valves_file = py_file.with_suffix('.valves')
                valves_data = None
                if valves_file.exists():
                    try:
                        valves_content = valves_file.read_text()
                        valves_data = json.loads(valves_content)
                        logger.info(f"  Found valves configuration: {valves_file.name} ({len(valves_data)} settings)")
                    except json.JSONDecodeError as e:
                        logger.error(f"  Failed to parse valves file {valves_file.name}: {e}")
                    except Exception as e:
                        logger.error(f"  Error reading valves file {valves_file.name}: {e}")

                filters.append({
                    "file_path": str(py_file),
                    "filter_id": filter_id,
                    "name": filter_id,
                    "description": description,
                    "code": code,
                    "valves": valves_data
                })

                logger.info(f"Discovered filter: {filter_id} ({py_file.name})")

            except Exception as e:
                logger.error(f"Failed to process filter file {py_file}: {e}")
                continue

        return filters

    def extract_description(self, code: str) -> str:
        """
        Extract description from filter file docstring.

        Args:
            code: Python source code

        Returns:
            Description string or empty string if not found
        """
        # Look for description: line in the module docstring
        # Pattern: """...\ndescription: Some description text\n..."""
        match = re.search(r'description:\s*(.+?)(?:\n|$)', code)
        if match:
            return match.group(1).strip()

        logger.warning("No description found in filter code")
        return ""

    def normalize_code(self, code: str) -> str:
        """
        Normalize Python code for comparison by removing whitespace variations.

        Args:
            code: Python source code

        Returns:
            Normalized code string suitable for comparison
        """
        import re

        # Remove all comments
        code = re.sub(r'#.*$', '', code, flags=re.MULTILINE)

        # Remove docstrings (triple-quoted strings)
        code = re.sub(r'""".*?"""', '', code, flags=re.DOTALL)
        code = re.sub(r"'''.*?'''", '', code, flags=re.DOTALL)

        # Normalize whitespace: collapse multiple spaces/tabs to single space
        code = re.sub(r'[ \t]+', ' ', code)

        # Remove leading/trailing whitespace from each line
        lines = [line.strip() for line in code.split('\n')]

        # Remove empty lines
        lines = [line for line in lines if line]

        # Join with single newline
        normalized = '\n'.join(lines)

        return normalized

    async def get_existing_functions(self, page_or_client) -> List[Dict]:
        """
        Get list of existing functions from Open WebUI.

        Args:
            page_or_client: Playwright page object or Open WebUI API client

        Returns:
            List of function objects
        """
        logger.info("Fetching existing functions...")
        client = coerce_open_webui_api_client(page_or_client)

        try:
            functions = await client.get_json("/api/v1/functions/")
            logger.info(f"Found {len(functions)} existing functions")
            return functions
        except OpenWebUIApiError as exc:
            logger.error(f"Failed to get existing functions: {exc}")
            return []

    async def get_function_by_id(self, page_or_client, function_id: str) -> Optional[Dict]:
        """
        Get a specific function by ID from Open WebUI.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            function_id: ID of function to fetch

        Returns:
            Function object or None if not found
        """
        logger.debug(f"Fetching function: {function_id}")
        client = coerce_open_webui_api_client(page_or_client)

        try:
            function = await client.get_json(f"/api/v1/functions/id/{function_id}")
        except OpenWebUIApiError as exc:
            if exc.status == 404:
                logger.debug(f"Function not found: {function_id}")
                return None
            logger.error(f"Failed to get function {function_id}: {exc}")
            return None

        if function is None:
            logger.debug(f"Function not found: {function_id}")
            return None

        logger.debug(f"Successfully fetched function: {function_id}")
        return function

    async def delete_function(self, page_or_client, function_id: str) -> bool:
        """
        Delete a function by ID.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            function_id: ID of function to delete

        Returns:
            True if successful, False otherwise
        """
        logger.info(f"  Deleting function: {function_id}")
        client = coerce_open_webui_api_client(page_or_client)

        try:
            await client.delete(f"/api/v1/functions/id/{function_id}/delete")
            logger.info(f"    ✅ Deleted function: {function_id}")
            return True
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to delete function {function_id}: {exc}")
            return False

    async def delete_existing_portico_core_functions(self, page_or_client) -> bool:
        """
        Delete all portico_core_* functions to prepare for fresh installation.

        Args:
            page_or_client: Playwright page object or Open WebUI API client

        Returns:
            True if successful, False otherwise
        """
        logger.info("🗑️  Cleaning up existing portico_core functions...")

        functions = await self.get_existing_functions(page_or_client)
        portico_core_functions = [f for f in functions if f.get('id', '').startswith(self.portico_CORE_PREFIX)]

        if not portico_core_functions:
            logger.info("  No existing portico_core functions to delete")
            return True

        logger.info(f"  Found {len(portico_core_functions)} portico_core functions to delete")

        success = True
        for func in portico_core_functions:
            func_id = func.get('id', '')
            if not await self.delete_function(page_or_client, func_id):
                success = False

        return success

    async def compare_filter_content(self, page_or_client, fs_filter: Dict, owui_function: Dict) -> tuple[bool, str]:
        """
        Compare filesystem filter with OWUI function to determine if update is needed.

        IMPORTANT: This method formats the filesystem code before comparison to ensure
        apples-to-apples comparison (since OWUI stores formatted code).

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            fs_filter: Filter metadata from filesystem (with 'code' and 'valves' keys)
            owui_function: Function data from OWUI API

        Returns:
            Tuple of (needs_update: bool, reason: str)
        """
        filter_id = fs_filter['filter_id']

        # Get full function details from OWUI
        full_function = await self.get_function_by_id(page_or_client, filter_id)
        if not full_function:
            logger.warning(f"Could not fetch full function data for {filter_id}, will update to be safe")
            return (True, "Could not fetch function data")

        # Get raw filesystem code
        fs_code_raw = fs_filter.get('code', '')
        owui_code = full_function.get('content', '')

        # FORMAT the filesystem code before comparison (OWUI stores formatted code)
        # This ensures apples-to-apples comparison
        logger.debug(f"  Formatting filesystem code for {filter_id} before comparison...")
        fs_code_formatted = await self.format_filter_code(page_or_client, fs_code_raw)

        if fs_code_formatted is None:
            logger.warning(f"  Could not format filesystem code for {filter_id}, will update to be safe")
            return (True, "Could not format filesystem code for comparison")

        # Normalize both for comparison (both are now formatted)
        fs_normalized = self.normalize_code(fs_code_formatted)
        owui_normalized = self.normalize_code(owui_code)

        if fs_normalized != owui_normalized:
            fs_hash = hash(fs_normalized)
            owui_hash = hash(owui_normalized)
            logger.debug(f"  Code mismatch for {filter_id}: fs_hash={fs_hash}, owui_hash={owui_hash}")
            logger.debug(f"  Sizes: fs_formatted={len(fs_code_formatted)}, owui={len(owui_code)}")
            return (True, f"Code content changed (fs_raw={len(fs_code_raw)}, fs_formatted={len(fs_code_formatted)}, owui={len(owui_code)})")

        # Compare valves configuration if present
        fs_valves = fs_filter.get('valves')
        if fs_valves is not None:
            # Get current valves from OWUI
            owui_valves = full_function.get('valves', {})

            # Compare valve values (not specs, just values)
            for valve_key, valve_value in fs_valves.items():
                owui_valve_value = owui_valves.get(valve_key)
                if owui_valve_value != valve_value:
                    logger.debug(f"  Valve mismatch for {filter_id}.{valve_key}: fs={valve_value}, owui={owui_valve_value}")
                    return (True, f"Valve '{valve_key}' changed: {owui_valve_value} → {valve_value}")

        # No changes detected
        logger.debug(f"  {filter_id}: Formatted code matches OWUI (no changes)")
        return (False, "Content and valves unchanged")

    async def format_filter_code(self, page_or_client, code: str) -> Optional[str]:
        """
        Format filter code using Open WebUI API.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            code: Python source code to format

        Returns:
            Formatted code string or None if failed
        """
        client = coerce_open_webui_api_client(page_or_client)

        try:
            result = await client.post_json("/api/v1/utils/code/format", {"code": code})
            formatted_code = result.get('code', code)
            return formatted_code
        except OpenWebUIApiError as exc:
            logger.error(f"Failed to format code: {exc}")
            return None

    async def create_filter(self, page_or_client, filter_id: str, filter_name: str,
                          description: str, formatted_code: str) -> bool:
        """
        Create filter function in Open WebUI.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            filter_id: Function ID
            filter_name: Function name
            description: Function description
            formatted_code: Formatted Python code

        Returns:
            True if successful, False otherwise
        """
        logger.info(f"  Creating function: {filter_id}")

        payload = {
            "id": filter_id,
            "name": filter_name,
            "meta": {
                "description": description
            },
            "content": formatted_code
        }

        client = coerce_open_webui_api_client(page_or_client)

        try:
            await client.post_text("/api/v1/functions/create", payload)
            logger.info(f"    ✅ Created function: {filter_id}")
            return True
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to create function {filter_id}: {exc}")
            return False

    async def toggle_global(self, page_or_client, filter_id: str) -> bool:
        """
        Make filter function global.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            filter_id: Function ID

        Returns:
            True if successful, False otherwise
        """
        client = coerce_open_webui_api_client(page_or_client)

        try:
            await client.post_text(f"/api/v1/functions/id/{filter_id}/toggle/global")
            logger.info(f"    ✅ Set as global: {filter_id}")
            return True
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to toggle global for {filter_id}: {exc}")
            return False

    async def activate_filter(self, page_or_client, filter_id: str) -> bool:
        """
        Activate filter function.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            filter_id: Function ID

        Returns:
            True if successful, False otherwise
        """
        client = coerce_open_webui_api_client(page_or_client)

        try:
            await client.post_text(f"/api/v1/functions/id/{filter_id}/toggle")
            logger.info(f"    ✅ Activated: {filter_id}")
            return True
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to activate {filter_id}: {exc}")
            return False

    async def update_valves(self, page_or_client, filter_id: str, valves_data: Dict) -> bool:
        """
        Update filter valves configuration.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            filter_id: Function ID
            valves_data: Dictionary of valve key/value pairs

        Returns:
            True if successful, False otherwise
        """
        logger.info(f"    Updating {len(valves_data)} valve settings...")
        client = coerce_open_webui_api_client(page_or_client)

        try:
            await client.post_text(
                f"/api/v1/functions/id/{filter_id}/valves/update",
                valves_data,
            )
            logger.info(f"    ✅ Updated valves: {list(valves_data.keys())}")
            return True
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to update valves for {filter_id}: {exc}")
            return False

    async def _install_single_filter(self, page_or_client, filter_info: Dict) -> bool:
        """
        Install a single filter (extracted logic for reuse).

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            filter_info: Filter metadata dict with keys: filter_id, name, description, code, valves

        Returns:
            True if successfully installed, False otherwise
        """
        filter_id = filter_info['filter_id']
        logger.debug(f"  Installing single filter: {filter_id}")

        try:
            # Format code
            formatted_code = await self.format_filter_code(page_or_client, filter_info['code'])
            if formatted_code is None:
                logger.error(f"    ❌ Failed to format code for {filter_id}")
                return False

            # Create function
            if not await self.create_filter(page_or_client, filter_id, filter_info['name'],
                                           filter_info['description'], formatted_code):
                logger.error(f"    ❌ Failed to create function {filter_id}")
                return False

            # Toggle global
            if not await self.toggle_global(page_or_client, filter_id):
                logger.error(f"    ❌ Failed to toggle global for {filter_id}")
                return False

            # Activate
            if not await self.activate_filter(page_or_client, filter_id):
                logger.error(f"    ❌ Failed to activate {filter_id}")
                return False

            # Update valves if configuration exists
            if filter_info.get('valves'):
                if not await self.update_valves(page_or_client, filter_id, filter_info['valves']):
                    logger.warning(f"    ⚠️  Valves update failed for {filter_id}, but filter is installed")
                    # Don't fail the entire installation for valve update failure
                    return True

            logger.info(f"    ✅ Successfully installed: {filter_id}")
            return True

        except Exception as e:
            logger.error(f"    ❌ Error installing {filter_id}: {e}", exc_info=True)
            return False

    async def install_all_filters(self, page_or_client) -> bool:
        """
        Intelligently install/update filters using 3-phase approach.

        Phase 1: Discovery - Scan filesystem and OWUI
        Phase 2: Change Detection - Compare and categorize filters
        Phase 3: Minimal Execution - Only update what changed

        Args:
            page_or_client: Playwright page object or Open WebUI API client

        Returns:
            True if all operations successful, False otherwise
        """
        import time
        start_time = time.time()

        logger.info("=" * 60)
        logger.info("🔧 Intelligent Filter Update System")
        logger.info("=" * 60)

        # ========== PHASE 1: DISCOVERY ==========
        logger.info("")
        logger.info("📁 PHASE 1: Discovery")
        logger.info("-" * 60)

        # Scan filesystem for filters
        fs_filters = self.discover_filters()
        if not fs_filters:
            logger.warning("No filters found on filesystem")
            return True

        logger.info(f"  Filesystem: {len(fs_filters)} filters discovered")

        # Get existing OWUI functions
        owui_functions = await self.get_existing_functions(page_or_client)
        portico_core_functions = [f for f in owui_functions if f.get('id', '').startswith(self.portico_CORE_PREFIX)]

        logger.info(f"  OWUI: {len(portico_core_functions)} portico_core functions found")

        # Build comparison maps
        fs_filter_map = {f['filter_id']: f for f in fs_filters}
        owui_function_map = {f['id']: f for f in portico_core_functions}

        logger.info(f"  Built comparison maps for analysis")

        # ========== PHASE 2: CHANGE DETECTION ==========
        logger.info("")
        logger.info("🔍 PHASE 2: Change Detection")
        logger.info("-" * 60)

        to_delete = []    # Legacy functions (in OWUI but not on filesystem)
        to_update = []    # Changed content (in both but content differs)
        to_create = []    # New filters (on filesystem but not in OWUI)
        to_skip = []      # Unchanged (content matches)

        # Analyze each OWUI function
        for func_id, owui_func in owui_function_map.items():
            if func_id not in fs_filter_map:
                # Function exists in OWUI but not on filesystem → legacy cleanup
                to_delete.append(func_id)
                logger.info(f"  🗑️  {func_id}: Not in filesystem (legacy function)")
            else:
                # Function exists in both → compare content
                fs_filter = fs_filter_map[func_id]
                needs_update, reason = await self.compare_filter_content(page_or_client, fs_filter, owui_func)

                if needs_update:
                    to_update.append(func_id)
                    logger.info(f"  🔄 {func_id}: {reason}")
                else:
                    to_skip.append(func_id)
                    logger.info(f"  ✅ {func_id}: {reason}")

        # Find new filters (on filesystem but not in OWUI)
        for filter_id in fs_filter_map.keys():
            if filter_id not in owui_function_map:
                to_create.append(filter_id)
                logger.info(f"  ✨ {filter_id}: New filter to install")

        # Summary of changes
        logger.info("")
        logger.info(f"📊 Change Analysis Summary:")
        logger.info(f"  ✅ Unchanged (skip):     {len(to_skip)}")
        logger.info(f"  🔄 Changed (update):     {len(to_update)}")
        logger.info(f"  ✨ New (create):         {len(to_create)}")
        logger.info(f"  🗑️  Legacy (delete):      {len(to_delete)}")
        logger.info(f"  📊 Total operations:     {len(to_delete) + len(to_update) + len(to_create)}")

        # ========== PHASE 3: MINIMAL EXECUTION ==========
        logger.info("")
        logger.info("⚡ PHASE 3: Minimal Execution")
        logger.info("-" * 60)

        operation_count = 0
        success_count = 0
        fail_count = 0

        # Delete legacy functions
        if to_delete:
            logger.info(f"🗑️  Deleting {len(to_delete)} legacy functions...")
            for func_id in to_delete:
                operation_count += 1
                if await self.delete_function(page_or_client, func_id):
                    success_count += 1
                    logger.info(f"    ✅ Deleted: {func_id}")
                else:
                    fail_count += 1
                    logger.error(f"    ❌ Failed to delete: {func_id}")

        # Update changed filters
        if to_update:
            logger.info(f"🔄 Updating {len(to_update)} changed filters...")
            for func_id in to_update:
                operation_count += 2  # Delete + create
                logger.info(f"  Updating: {func_id}")

                # Delete old version
                if not await self.delete_function(page_or_client, func_id):
                    fail_count += 1
                    logger.error(f"    ❌ Failed to delete old version: {func_id}")
                    continue

                # Install new version
                if await self._install_single_filter(page_or_client, fs_filter_map[func_id]):
                    success_count += 2
                    logger.info(f"    ✅ Updated: {func_id}")
                else:
                    fail_count += 1
                    logger.error(f"    ❌ Failed to install new version: {func_id}")

        # Create new filters
        if to_create:
            logger.info(f"✨ Creating {len(to_create)} new filters...")
            for filter_id in to_create:
                operation_count += 1
                logger.info(f"  Creating: {filter_id}")

                if await self._install_single_filter(page_or_client, fs_filter_map[filter_id]):
                    success_count += 1
                    logger.info(f"    ✅ Created: {filter_id}")
                else:
                    fail_count += 1
                    logger.error(f"    ❌ Failed to create: {filter_id}")

        # Skipped filters (no action needed)
        if to_skip:
            logger.info(f"✅ Skipped {len(to_skip)} unchanged filters (no action needed)")
            for filter_id in to_skip:
                logger.debug(f"    ⏭️  {filter_id}")

        # ========== FINAL SUMMARY ==========
        elapsed_time = time.time() - start_time
        logger.info("")
        logger.info("=" * 60)
        logger.info("📊 Filter Update Summary")
        logger.info("=" * 60)
        logger.info(f"  Total filters on filesystem: {len(fs_filters)}")
        logger.info(f"  Unchanged (skipped):        {len(to_skip)}")
        logger.info(f"  Updated:                    {len(to_update)}")
        logger.info(f"  Created:                    {len(to_create)}")
        logger.info(f"  Deleted (legacy):           {len(to_delete)}")
        logger.info(f"  Total operations:           {operation_count}")
        logger.info(f"  Successful operations:      {success_count}")
        logger.info(f"  Failed operations:          {fail_count}")
        logger.info(f"  Execution time:             {elapsed_time:.2f}s")
        logger.info("=" * 60)

        # Return success if no failures
        return fail_count == 0
