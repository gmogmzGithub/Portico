#!/usr/bin/env python3
"""
Simulate Open WebUI Chat Flow

Creates a chat in the Sub-agents folder, sends a prompt to a model,
and polls for the response.

Usage:
    python src/scripts/simulate-owui-chat.py "What is 2+2?" "Atlas Sonnet 4.6"

    # With custom API key
    OWUI_API_TOKEN=your_token python src/scripts/simulate-owui-chat.py "prompt" "model"
"""

import argparse
import json
import os
import random
import string
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

import httpx

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False
    print("⚠️  redis-py not installed. Set OWUI_API_TOKEN environment variable.")


class TeeOutput:
    """Write to both console and file simultaneously."""

    def __init__(self, file_path: str):
        self.terminal = sys.stdout
        self.log_file = open(file_path, 'a', encoding='utf-8')

    def write(self, message):
        self.terminal.write(message)
        self.log_file.write(message)
        self.log_file.flush()  # Ensure immediate write

    def flush(self):
        self.terminal.flush()
        self.log_file.flush()

    def close(self):
        self.log_file.close()


# Debug flag - set to False to disable verbose output
DEBUG = True

# Human mode flag - will be set by command line argument
HUMAN_MODE = False

# Interactive mode flag - will be set by command line argument
INTERACTIVE_MODE = False


class Context:
    """Holds all state for interactive mode."""

    def __init__(self, prompt: str, model: str):
        self.prompt = prompt
        self.model = model
        self.folder_id: Optional[str] = None
        self.chat_id: Optional[str] = None
        self.user_message_id: Optional[str] = None
        self.assistant_message_id: Optional[str] = None
        self.timestamp: Optional[int] = None
        self.session_id: Optional[str] = None
        self.model_item: Optional[Dict] = None
        self.tool_ids: Optional[list] = None
        self.task_id: Optional[str] = None
        self.assistant_message: Optional[Dict] = None
        self.completed: bool = False

    def display(self):
        """Display current context."""
        print("\n" + "="*80)
        print("📋 CURRENT CONTEXT")
        print("="*80)
        print(f"Prompt: {self.prompt[:60]}..." if len(self.prompt) > 60 else f"Prompt: {self.prompt}")
        print(f"Model: {self.model}")
        print(f"Folder ID: {self.folder_id or '(not set)'}")
        print(f"Chat ID: {self.chat_id or '(not set)'}")
        print(f"User Message ID: {self.user_message_id or '(not set)'}")
        print(f"Assistant Message ID: {self.assistant_message_id or '(not set)'}")
        print(f"Timestamp: {self.timestamp or '(not set)'}")
        print(f"Session ID: {self.session_id or '(not set)'}")
        print(f"Model Item: {'✅ Loaded' if self.model_item else '(not set)'}")
        print(f"Tool IDs: {len(self.tool_ids) if self.tool_ids else 0} tools")
        print(f"Task ID: {self.task_id or '(not set)'}")
        print(f"Completed: {'✅ Yes' if self.completed else '❌ No'}")
        print("="*80 + "\n")


def human_confirmation(method: str, url: str, payload: Optional[Dict] = None) -> bool:
    """
    Ask for human confirmation before sending API request.

    Args:
        method: HTTP method (GET, POST, etc.)
        url: Request URL
        payload: Optional request payload

    Returns:
        bool: True to proceed, False to skip
    """
    if not HUMAN_MODE:
        return True

    print("\n" + "🔔" * 40)
    print("🤚 HUMAN CONFIRMATION REQUIRED")
    print("🔔" * 40)
    print(f"Method: {method}")
    print(f"URL: {url}")

    if payload:
        print("\nPayload:")
        print(json.dumps(payload, indent=2))

    print("\n" + "="*80)
    response = input("Proceed with this request? [Y/n]: ").strip().lower()

    if response in ['', 'y', 'yes']:
        print("✅ Proceeding...\n")
        return True
    else:
        print("❌ Skipped by user\n")
        return False


def debug_print(label: str, data: any):
    """Pretty print JSON data for debugging."""
    if not DEBUG:
        return

    print(f"\n{'='*80}")
    print(f"🔍 {label}")
    print('='*80)

    if isinstance(data, (dict, list)):
        print(json.dumps(data, indent=2))
    else:
        print(data)

    print('='*80 + '\n')


# Configuration
OPENWEBUI_BASE_URL = os.getenv("OPENWEBUI_BASE_URL", "http://open-webui:8080")
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
POLL_INTERVAL = 5  # seconds
MAX_POLL_ATTEMPTS = 60  # 5 minutes max


def get_api_token() -> str:
    """
    Get API token from Redis or environment variable.

    Returns:
        str: The API token

    Raises:
        RuntimeError: If token not found
    """
    # Try environment variable first
    token = os.getenv("OWUI_API_TOKEN")
    if token:
        print(f"✅ Using API token from OWUI_API_TOKEN environment variable")
        return token

    # Try Redis
    if not REDIS_AVAILABLE:
        raise RuntimeError(
            "No API token found. Set OWUI_API_TOKEN environment variable or install redis-py."
        )

    try:
        redis_client = redis.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            db=0,
            socket_connect_timeout=5,
            decode_responses=True
        )
        redis_client.ping()

        token = redis_client.get('openwebui:api_token')
        if not token:
            raise RuntimeError(
                "Token not found in Redis. Run health check or set OWUI_API_TOKEN."
            )

        print(f"✅ Retrieved API token from Redis")
        return token

    except redis.ConnectionError as e:
        raise RuntimeError(f"Failed to connect to Redis: {e}")


def ensure_sub_agents_folder(client: httpx.Client, token: str) -> str:
    """
    Ensure the Sub-agents folder exists, create if needed.

    Args:
        client: HTTP client
        token: API token

    Returns:
        str: Folder ID
    """
    print("📁 Checking for Sub-agents folder...")

    # Check existing folders
    url = f"{OPENWEBUI_BASE_URL}/api/v1/folders/"
    if not human_confirmation("GET", url):
        raise RuntimeError("User cancelled request")

    response = client.get(
        url,
        headers={"Authorization": f"Bearer {token}"}
    )
    response.raise_for_status()
    folders = response.json()

    debug_print("GET /api/v1/folders/ - Response", folders)

    matches = [
        folder
        for folder in folders
        if folder.get("name") == "Sub-agents" and folder.get("id")
    ]
    if matches:
        canonical_folder = min(
            matches,
            key=lambda folder: (
                0 if folder.get("parent_id") in (None, "", "null") else 1,
                int(folder.get("created_at", sys.maxsize))
                if str(folder.get("created_at", "")).isdigit()
                else sys.maxsize,
                str(folder.get("id", "")),
            ),
        )
        folder_id = canonical_folder["id"]
        if len(matches) > 1:
            print(
                f"⚠️ Found {len(matches)} matching Sub-agents folders; reusing canonical folder: {folder_id}"
            )
        else:
            print(f"✅ Found existing Sub-agents folder: {folder_id}")
        return folder_id

    # Create folder
    print("📁 Creating Sub-agents folder...")
    create_payload = {
        "name": "Sub-agents",
        "data": {
            "system_prompt": "",
            "files": []
        }
    }

    debug_print("POST /api/v1/folders/ - Request", create_payload)

    url = f"{OPENWEBUI_BASE_URL}/api/v1/folders/"
    if not human_confirmation("POST", url, create_payload):
        raise RuntimeError("User cancelled request")

    response = client.post(
        url,
        headers={"Authorization": f"Bearer {token}"},
        json=create_payload
    )
    response.raise_for_status()
    folder_data = response.json()

    debug_print("POST /api/v1/folders/ - Response", folder_data)

    folder_id = folder_data["id"]
    print(f"✅ Created Sub-agents folder: {folder_id}")
    return folder_id


def create_chat(
    client: httpx.Client,
    token: str,
    folder_id: str,
    model: str,
    prompt: str
) -> str:
    """
    Create a new chat with the initial user message.

    Args:
        client: HTTP client
        token: API token
        folder_id: Folder to create chat in
        model: Model to use
        prompt: User prompt

    Returns:
        str: Chat ID
    """
    print(f"💬 Creating new chat with model: {model}")

    # Generate UUIDs
    user_message_id = str(uuid.uuid4())
    timestamp = int(time.time())

    # Build chat payload
    chat_payload = {
        "chat": {
            "id": "",
            "title": "New Chat",
            "models": [model],
            "params": {},
            "history": {
                "messages": {
                    user_message_id: {
                        "id": user_message_id,
                        "parentId": None,
                        "childrenIds": [],
                        "role": "user",
                        "content": prompt,
                        "timestamp": timestamp,
                        "models": [model]
                    }
                },
                "currentId": user_message_id
            },
            "messages": [
                {
                    "id": user_message_id,
                    "parentId": None,
                    "childrenIds": [],
                    "role": "user",
                    "content": prompt,
                    "timestamp": timestamp,
                    "models": [model]
                }
            ],
            "tags": [],
            "timestamp": timestamp * 1000
        },
        "folder_id": folder_id
    }

    debug_print("POST /api/v1/chats/new - Request", chat_payload)

    # Create chat
    url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/new"
    if not human_confirmation("POST", url, chat_payload):
        raise RuntimeError("User cancelled request")

    response = client.post(
        url,
        headers={"Authorization": f"Bearer {token}"},
        json=chat_payload
    )
    response.raise_for_status()
    chat_data = response.json()

    debug_print("POST /api/v1/chats/new - Response", chat_data)

    chat_id = chat_data["id"]
    print(f"✅ Created chat: {chat_id}")
    return chat_id, user_message_id, timestamp


def setup_assistant_message(
    client: httpx.Client,
    token: str,
    chat_id: str,
    model: str,
    prompt: str,
    user_message_id: str,
    timestamp: int
) -> str:
    """
    Set up the empty assistant message in the chat before generating completions.

    Args:
        client: HTTP client
        token: API token
        chat_id: Chat ID
        model: Model to use
        prompt: User prompt (for reconstructing the chat)
        user_message_id: ID of the user message
        timestamp: Timestamp of the user message

    Returns:
        str: Assistant message ID
    """
    print(f"🤖 Setting up empty assistant message...")

    # Generate assistant message ID
    assistant_message_id = str(uuid.uuid4())

    # Build the updated chat payload
    chat_update_payload = {
        "chat": {
            "models": [model],
            "history": {
                "messages": {
                    user_message_id: {
                        "id": user_message_id,
                        "parentId": None,
                        "childrenIds": [assistant_message_id],  # Link to assistant message
                        "role": "user",
                        "content": prompt,
                        "timestamp": timestamp,
                        "models": [model]
                    },
                    assistant_message_id: {
                        "parentId": user_message_id,  # Link back to user message
                        "id": assistant_message_id,
                        "childrenIds": [],
                        "role": "assistant",
                        "content": "",  # Empty content initially
                        "model": model,
                        "modelName": model,
                        "modelIdx": 0,
                        "timestamp": timestamp
                    }
                },
                "currentId": assistant_message_id  # Point to assistant message
            },
            "messages": [
                {
                    "id": user_message_id,
                    "parentId": None,
                    "childrenIds": [assistant_message_id],
                    "role": "user",
                    "content": prompt,
                    "timestamp": timestamp,
                    "models": [model]
                },
                {
                    "parentId": user_message_id,
                    "id": assistant_message_id,
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "",  # Empty content
                    "model": model,
                    "modelName": model,
                    "modelIdx": 0,
                    "timestamp": timestamp
                }
            ],
            "params": {},
            "files": []
        }
    }

    debug_print(f"POST /api/v1/chats/{chat_id} - Request (Setup Assistant)", chat_update_payload)

    # Update the chat
    url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/{chat_id}"
    if not human_confirmation("POST", url, chat_update_payload):
        raise RuntimeError("User cancelled request")

    response = client.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json=chat_update_payload
    )
    response.raise_for_status()
    result = response.json()

    debug_print(f"POST /api/v1/chats/{chat_id} - Response (Setup Assistant)", result)

    print(f"✅ Set up assistant message: {assistant_message_id}")
    return assistant_message_id


def generate_session_id() -> str:
    """
    Generate a random session ID similar to Open WebUI's format.

    Returns:
        str: Session ID (e.g., "kim8kHF_9a0NOx7FAAAR")
    """
    chars = string.ascii_letters + string.digits + '_'
    session_id = ''.join(random.choice(chars) for _ in range(24))
    return session_id


def generate_variables() -> Dict[str, str]:
    """
    Generate variables object with current datetime information.

    Returns:
        Dict with user and datetime variables
    """
    now = datetime.now()
    return {
        "{{USER_NAME}}": "User",
        "{{USER_LOCATION}}": "Unknown",
        "{{CURRENT_DATETIME}}": now.strftime("%Y-%m-%d %H:%M:%S"),
        "{{CURRENT_DATE}}": now.strftime("%Y-%m-%d"),
        "{{CURRENT_TIME}}": now.strftime("%H:%M:%S"),
        "{{CURRENT_WEEKDAY}}": now.strftime("%A"),
        "{{CURRENT_TIMEZONE}}": "America/New_York",
        "{{USER_LANGUAGE}}": "en-US"
    }


def fetch_tool_ids(client: httpx.Client, token: str) -> list:
    """
    Fetch available tool IDs from Open WebUI.

    Args:
        client: HTTP client
        token: API token

    Returns:
        List of tool IDs
    """
    print(f"🔧 Fetching tool IDs...")

    url = f"{OPENWEBUI_BASE_URL}/api/v1/tools/"
    if not human_confirmation("GET", url):
        raise RuntimeError("User cancelled request")

    response = client.get(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
    )
    response.raise_for_status()
    tools = response.json()

    debug_print("GET /api/v1/tools/ - Response", tools)

    tool_ids = [tool["id"] for tool in tools if "id" in tool]
    print(f"✅ Found {len(tool_ids)} tools: {tool_ids}")
    return tool_ids


def fetch_model_item(client: httpx.Client, token: str, model: str) -> Dict:
    """
    Fetch model item information from Open WebUI.

    Args:
        client: HTTP client
        token: API token
        model: Model ID to fetch

    Returns:
        Dict: Model item object

    Raises:
        ValueError: If model not found
    """
    print(f"📦 Fetching model item for: {model}")

    try:
        url = f"{OPENWEBUI_BASE_URL}/api/models?"
        if not human_confirmation("GET", url):
            raise RuntimeError("User cancelled request")

        response = client.get(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Content-Type": "application/json"
            }
        )

        # Debug: show status code and raw response
        print(f"  HTTP Status: {response.status_code}")
        debug_print("GET /api/models? - Raw Response Text", response.text[:500] if response.text else "(empty)")

        response.raise_for_status()

        # Try to parse JSON
        data = response.json()
        debug_print("GET /api/models? - Parsed Response", data)

        # Find the model in the data array
        models = data.get("data", [])
        for model_item in models:
            if model_item.get("id") == model:
                print(f"✅ Found model item: {model}")
                return model_item

        raise ValueError(
            f"Model '{model}' not found in available models. "
            f"Available: {', '.join([m.get('id', 'unknown') for m in models])}"
        )

    except httpx.HTTPStatusError as e:
        print(f"❌ HTTP Error: {e.response.status_code}")
        debug_print("Error Response", e.response.text)
        raise
    except json.JSONDecodeError as e:
        print(f"❌ JSON Decode Error: {e}")
        print(f"Response text: {response.text[:1000]}")
        raise


def generate_completion(
    client: httpx.Client,
    token: str,
    chat_id: str,
    model: str,
    prompt: str
) -> tuple[Dict, str]:
    """
    Trigger completion generation for the chat.

    Args:
        client: HTTP client
        token: API token
        chat_id: Chat ID
        model: Model to use
        prompt: User prompt

    Returns:
        tuple: (model_item, session_id)
    """
    print(f"🚀 Generating completion...")

    # Fetch required data
    tool_ids = fetch_tool_ids(client, token)
    model_item = fetch_model_item(client, token, model)
    session_id = generate_session_id()
    variables = generate_variables()

    print(f"📝 Generated session_id: {session_id}")

    # Build complete completion payload
    completion_payload = {
        "stream": True,
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": prompt
            }
        ],
        "params": {
            "function_calling": "native"
        },
        "tool_ids": tool_ids,
        "tool_servers": [],
        "features": {
            "image_generation": False,
            "code_interpreter": False,
            "web_search": False
        },
        "variables": variables,
        "model_item": model_item,
        "session_id": session_id,
        "chat_id": chat_id,
        "id": str(uuid.uuid4()),
        "background_tasks": {
            "title_generation": True,
            "tags_generation": True,
            "follow_up_generation": True
        }
    }

    debug_print("POST /api/chat/completions - Request", completion_payload)

    # Trigger completion
    url = f"{OPENWEBUI_BASE_URL}/api/chat/completions"
    if not human_confirmation("POST", url, completion_payload):
        raise RuntimeError("User cancelled request")

    response = client.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json=completion_payload,
        timeout=30.0
    )
    response.raise_for_status()
    result = response.json()

    debug_print("POST /api/chat/completions - Response", result)

    # Check for expected response shape
    if not (result.get("status") and result.get("task_id")):
        raise RuntimeError(f"Unexpected response from completion endpoint: {result}")

    print(f"✅ Completion triggered (task_id: {result['task_id']})")

    return model_item, session_id


def call_chat_completed(
    client: httpx.Client,
    token: str,
    chat_id: str,
    model: str,
    model_item: Dict,
    session_id: str,
    messages: list,
    assistant_msg: Dict,
    assistant_msg_id: str
) -> Dict:
    """
    Call /api/chat/completed with the properly constructed payload.

    Args:
        client: HTTP client
        token: API token
        chat_id: Chat ID
        model: Model ID
        model_item: Full model item object
        session_id: Session ID
        messages: Messages array from chat (contains user message)
        assistant_msg: Assistant message from history
        assistant_msg_id: ID of the assistant message (dictionary key)

    Returns:
        Dict: The assistant message
    """
    print(f"📤 Calling /api/chat/completed...")

    # Build the messages array: user message + assistant message
    completed_messages = []

    # Add user message
    for msg in messages:
        if msg.get("role") == "user":
            completed_messages.append({
                "id": msg.get("id"),
                "role": "user",
                "content": msg.get("content"),
                "timestamp": msg.get("timestamp")
            })

    # Add assistant message from history with current timestamp
    current_timestamp = int(time.time())
    completed_messages.append({
        "id": assistant_msg_id,  # Use the dictionary key as the ID
        "role": "assistant",
        "content": assistant_msg.get("content"),
        "timestamp": current_timestamp  # Generate current timestamp
    })

    # Build the payload
    completed_payload = {
        "id": str(uuid.uuid4()),  # Generate unique request ID
        "model": model,
        "messages": completed_messages,
        "model_item": model_item,
        "chat_id": chat_id,
        "session_id": session_id
    }

    debug_print("POST /api/chat/completed - Request", completed_payload)

    # Call the endpoint
    try:
        url = f"{OPENWEBUI_BASE_URL}/api/chat/completed"
        if not human_confirmation("POST", url, completed_payload):
            raise RuntimeError("User cancelled request")

        response = client.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json"
            },
            json=completed_payload,
            timeout=30.0
        )
        response.raise_for_status()
        result = response.json()

        debug_print("POST /api/chat/completed - Response", result)
    except httpx.HTTPStatusError as e:
        print(f"\n❌ HTTP ERROR: {e.response.status_code}")
        print(f"Response Text:")
        print("="*80)
        print(e.response.text)
        print("="*80)
        debug_print("POST /api/chat/completed - Error Response", e.response.text)
        raise

    print(f"✅ Chat completed")

    # Return a complete assistant message object with ID and timestamp
    return {
        "id": assistant_msg_id,
        "role": "assistant",
        "content": assistant_msg.get("content"),
        "timestamp": current_timestamp,
        "model": assistant_msg.get("model"),
        "done": True
    }


def poll_for_completion(
    client: httpx.Client,
    token: str,
    chat_id: str,
    model: str,
    model_item: Dict,
    session_id: str
) -> Dict:
    """
    Poll the chat until the assistant message is complete.

    Args:
        client: HTTP client
        token: API token
        chat_id: Chat ID
        model: Model ID
        model_item: Full model item object
        session_id: Session ID

    Returns:
        Dict: The completed assistant message

    Raises:
        TimeoutError: If polling exceeds MAX_POLL_ATTEMPTS
        RuntimeError: If an error is detected in the chat response
    """
    print(f"⏳ Polling for completion (checking every {POLL_INTERVAL}s)...")

    for attempt in range(1, MAX_POLL_ATTEMPTS + 1):
        url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/{chat_id}"
        if not human_confirmation("GET", url):
            raise RuntimeError("User cancelled request")

        response = client.get(
            url,
            headers={"Authorization": f"Bearer {token}"}
        )
        response.raise_for_status()
        chat_data = response.json()

        debug_print(f"GET /api/v1/chats/{chat_id} - Response (Attempt {attempt})", chat_data)

        # Check for errors in history.messages (this is where errors appear)
        history_messages = chat_data.get("chat", {}).get("history", {}).get("messages", {})
        for msg_id, message in history_messages.items():
            if "error" in message:
                error_data = message.get("error", {})
                error_content = error_data.get("content", {})
                error_message = error_content.get("message", "Unknown error")
                error_code = error_content.get("code", "unknown")
                model_name = message.get("model", "unknown")

                print(f"\n❌ Error detected in chat response!")
                debug_print("Error Message Object", message)

                raise RuntimeError(
                    f"Chat completion failed with error:\n"
                    f"  Model: {model_name}\n"
                    f"  Code: {error_code}\n"
                    f"  Message: {error_message}"
                )

        # Get messages array
        messages = chat_data.get("chat", {}).get("messages", [])
        if not messages:
            print(f"  Attempt {attempt}: No messages yet...")
            time.sleep(POLL_INTERVAL)
            continue

        # Check last message
        last_message = messages[-1]

        # Also check if last message in array has an error
        if "error" in last_message:
            error_data = last_message.get("error", {})
            error_content = error_data.get("content", {})
            error_message = error_content.get("message", "Unknown error")
            error_code = error_content.get("code", "unknown")
            model_name = last_message.get("model", "unknown")

            print(f"\n❌ Error detected in chat response!")
            debug_print("Error Message Object", last_message)

            raise RuntimeError(
                f"Chat completion failed with error:\n"
                f"  Model: {model_name}\n"
                f"  Code: {error_code}\n"
                f"  Message: {error_message}"
            )

        # Check for the signal: extra message in history with content
        if len(history_messages) > len(messages):
            # Find the assistant message in history (has content)
            assistant_msg = None
            assistant_msg_id = None
            for msg_id, msg in history_messages.items():
                # Skip user messages
                if msg.get("role") == "user":
                    continue
                # Assistant message has content field
                if "content" in msg:
                    assistant_msg = msg
                    assistant_msg_id = msg_id  # The ID is the dictionary key
                    break

            if assistant_msg and assistant_msg_id:
                print(f"🔔 Detected completion signal (content present)")

                # Call /api/chat/completed
                return call_chat_completed(
                    client, token, chat_id, model, model_item,
                    session_id, messages, assistant_msg, assistant_msg_id
                )

        if last_message.get("role") == "assistant" and last_message.get("done"):
            print(f"✅ Completion received after {attempt * POLL_INTERVAL}s")
            debug_print("Final Assistant Message", last_message)
            return last_message

        print(f"  Attempt {attempt}: Waiting for completion...")
        time.sleep(POLL_INTERVAL)

    raise TimeoutError(
        f"Chat did not complete after {MAX_POLL_ATTEMPTS * POLL_INTERVAL} seconds"
    )


def extract_last_sentence(content: str) -> str:
    """
    Extract the lastSentence from content by removing reasoning details block.

    Args:
        content: Full content string

    Returns:
        Content after the </details> block, or full content if no details block
    """
    import re

    # Look for <details type="reasoning"...>...</details> block
    details_pattern = r'<details\s+type="reasoning"[^>]*>.*?</details>\s*'

    # Remove the details block and any trailing whitespace/newlines after it
    last_sentence = re.sub(details_pattern, '', content, flags=re.DOTALL)

    return last_sentence


def interactive_mode(client: httpx.Client, token: str, ctx: Context):
    """Run interactive mode where user chooses API calls."""
    while True:
        ctx.display()

        print("🎮 INTERACTIVE MENU")
        print("="*80)
        print("1. Ensure Sub-agents folder exists")
        print("2. Create chat (requires: folder_id)")
        print("3. Setup assistant message (requires: chat_id, user_message_id, timestamp)")
        print("4. Fetch tool IDs")
        print("5. Fetch model item")
        print("6. Generate session ID")
        print("7. Generate completion (requires: chat_id, model_item, session_id)")
        print("8. Poll for completion (one iteration) (requires: chat_id, model_item, session_id)")
        print("9. Call chat completed (requires: detection of content)")
        print("10. Show assistant response")
        print("11. Align Messages to History (requires: chat_id)")
        print("0. Exit")
        print("="*80)

        choice = input("\nChoose an operation (0-11): ").strip()

        try:
            if choice == "0":
                print("👋 Exiting...")
                break

            elif choice == "1":
                print("\n🔄 Ensuring Sub-agents folder exists...")
                ctx.folder_id = ensure_sub_agents_folder(client, token)

            elif choice == "2":
                if not ctx.folder_id:
                    print("❌ Error: folder_id required. Run option 1 first.")
                    continue
                print("\n🔄 Creating chat...")
                ctx.chat_id, ctx.user_message_id, ctx.timestamp = create_chat(
                    client, token, ctx.folder_id, ctx.model, ctx.prompt
                )

            elif choice == "3":
                if not ctx.chat_id or not ctx.user_message_id or not ctx.timestamp:
                    print("❌ Error: chat_id, user_message_id, timestamp required. Run option 2 first.")
                    continue
                print("\n🔄 Setting up assistant message...")
                ctx.assistant_message_id = setup_assistant_message(
                    client, token, ctx.chat_id, ctx.model, ctx.prompt,
                    ctx.user_message_id, ctx.timestamp
                )

            elif choice == "4":
                print("\n🔄 Fetching tool IDs...")
                ctx.tool_ids = fetch_tool_ids(client, token)

            elif choice == "5":
                print("\n🔄 Fetching model item...")
                ctx.model_item = fetch_model_item(client, token, ctx.model)

            elif choice == "6":
                print("\n🔄 Generating session ID...")
                ctx.session_id = generate_session_id()
                print(f"✅ Generated session_id: {ctx.session_id}")

            elif choice == "7":
                if not ctx.chat_id:
                    print("❌ Error: chat_id required. Run option 2 first.")
                    continue
                if not ctx.model_item:
                    print("⚠️  Warning: model_item not loaded. Fetching now...")
                    ctx.model_item = fetch_model_item(client, token, ctx.model)
                if not ctx.session_id:
                    print("⚠️  Warning: session_id not generated. Generating now...")
                    ctx.session_id = generate_session_id()
                    print(f"✅ Generated session_id: {ctx.session_id}")
                if not ctx.tool_ids:
                    print("⚠️  Warning: tool_ids not fetched. Fetching now...")
                    ctx.tool_ids = fetch_tool_ids(client, token)

                print("\n🔄 Generating completion...")
                # Call generate_completion logic inline
                variables = generate_variables()
                completion_payload = {
                    "stream": True,
                    "model": ctx.model,
                    "messages": [{"role": "user", "content": ctx.prompt}],
                    "params": {"function_calling": "native"},
                    "tool_ids": ctx.tool_ids,
                    "tool_servers": [],
                    "features": {
                        "image_generation": False,
                        "code_interpreter": False,
                        "web_search": False
                    },
                    "variables": variables,
                    "model_item": ctx.model_item,
                    "session_id": ctx.session_id,
                    "chat_id": ctx.chat_id,
                    "id": str(uuid.uuid4()),
                    "background_tasks": {
                        "title_generation": True,
                        "tags_generation": True,
                        "follow_up_generation": True
                    }
                }

                debug_print("POST /api/chat/completions - Request", completion_payload)

                url = f"{OPENWEBUI_BASE_URL}/api/chat/completions"
                if not human_confirmation("POST", url, completion_payload):
                    print("❌ Skipped")
                    continue

                response = client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json"
                    },
                    json=completion_payload,
                    timeout=30.0
                )
                response.raise_for_status()
                result = response.json()

                debug_print("POST /api/chat/completions - Response", result)

                if not (result.get("status") and result.get("task_id")):
                    print(f"❌ Unexpected response: {result}")
                    continue

                ctx.task_id = result["task_id"]
                print(f"✅ Completion triggered (task_id: {ctx.task_id})")

            elif choice == "8":
                if not ctx.chat_id:
                    print("❌ Error: chat_id required.")
                    continue

                print("\n🔄 Polling for completion (one iteration)...")
                url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/{ctx.chat_id}"
                if not human_confirmation("GET", url):
                    print("❌ Skipped")
                    continue

                response = client.get(
                    url,
                    headers={"Authorization": f"Bearer {token}"}
                )
                response.raise_for_status()
                chat_data = response.json()

                debug_print(f"GET /api/v1/chats/{ctx.chat_id} - Response", chat_data)

                # Check for errors
                history_messages = chat_data.get("chat", {}).get("history", {}).get("messages", {})
                for msg_id, message in history_messages.items():
                    if "error" in message:
                        error_data = message.get("error", {})
                        error_content = error_data.get("content", {})
                        error_message = error_content.get("message", "Unknown error")
                        error_code = error_content.get("code", "unknown")
                        model_name = message.get("model", "unknown")

                        print(f"\n❌ Error detected in chat response!")
                        debug_print("Error Message Object", message)
                        print(f"  Model: {model_name}")
                        print(f"  Code: {error_code}")
                        print(f"  Message: {error_message}")
                        continue

                messages = chat_data.get("chat", {}).get("messages", [])
                print(f"📊 Messages count: {len(messages)}")
                print(f"📊 History messages count: {len(history_messages)}")

                # Check for completion signal
                if len(history_messages) > len(messages):
                    assistant_msg = None
                    assistant_msg_id = None
                    for msg_id, msg in history_messages.items():
                        if msg.get("role") == "user":
                            continue
                        if "content" in msg:
                            assistant_msg = msg
                            assistant_msg_id = msg_id
                            break

                    if assistant_msg and assistant_msg_id:
                        print(f"🔔 Detected completion signal (content present)")
                        ctx.assistant_message = assistant_msg
                        ctx.assistant_message_id = assistant_msg_id
                        print(f"💬 Assistant content preview: {assistant_msg.get('content', '')[:100]}...")
                        print("⚠️  Ready to call chat completed (option 9)")

                # Check old completion pattern
                if messages:
                    last_message = messages[-1]
                    if last_message.get("role") == "assistant" and last_message.get("done"):
                        print(f"✅ Old-style completion detected")
                        ctx.assistant_message = last_message
                        ctx.completed = True

            elif choice == "9":
                if not ctx.assistant_message or not ctx.assistant_message_id:
                    print("❌ Error: assistant message not detected. Run option 8 until content appears.")
                    continue
                if not ctx.model_item or not ctx.session_id:
                    print("❌ Error: model_item and session_id required.")
                    continue

                print("\n🔄 Calling chat completed...")

                messages = [
                    {
                        "id": ctx.user_message_id,
                        "role": "user",
                        "content": ctx.prompt,
                        "timestamp": ctx.timestamp
                    }
                ]

                current_timestamp = int(time.time())
                messages.append({
                    "id": ctx.assistant_message_id,
                    "role": "assistant",
                    "content": ctx.assistant_message.get("content"),
                    "timestamp": current_timestamp
                })

                completed_payload = {
                    "id": str(uuid.uuid4()),
                    "model": ctx.model,
                    "messages": messages,
                    "model_item": ctx.model_item,
                    "chat_id": ctx.chat_id,
                    "session_id": ctx.session_id
                }

                debug_print("POST /api/chat/completed - Request", completed_payload)

                url = f"{OPENWEBUI_BASE_URL}/api/chat/completed"
                if not human_confirmation("POST", url, completed_payload):
                    print("❌ Skipped")
                    continue

                try:
                    response = client.post(
                        url,
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Content-Type": "application/json"
                        },
                        json=completed_payload,
                        timeout=30.0
                    )
                    response.raise_for_status()
                    result = response.json()

                    debug_print("POST /api/chat/completed - Response", result)
                    print(f"✅ Chat completed successfully")
                    ctx.completed = True

                except httpx.HTTPStatusError as e:
                    print(f"\n❌ HTTP ERROR: {e.response.status_code}")
                    print(f"Response Text:")
                    print("="*80)
                    print(e.response.text)
                    print("="*80)

            elif choice == "10":
                if not ctx.assistant_message:
                    print("❌ Error: No assistant message available yet.")
                    continue

                content = ctx.assistant_message.get("content", "")
                print("\n" + "="*80)
                print("📝 ASSISTANT RESPONSE:")
                print("="*80)
                print(content)
                print("="*80)

            elif choice == "11":
                if not ctx.chat_id:
                    print("❌ Error: chat_id required.")
                    continue

                print("\n🔄 Aligning messages to history...")

                # First, poll for completion to get latest chat state
                url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/{ctx.chat_id}"
                if not human_confirmation("GET", url):
                    print("❌ Skipped")
                    continue

                response = client.get(
                    url,
                    headers={"Authorization": f"Bearer {token}"}
                )
                response.raise_for_status()
                current_chat_data = response.json()

                debug_print(f"GET /api/v1/chats/{ctx.chat_id} - Current Chat", current_chat_data)

                # Extract history.messages
                history_messages = current_chat_data.get("chat", {}).get("history", {}).get("messages", {})

                if not history_messages:
                    print("❌ Error: No history messages found in chat.")
                    continue

                if len(history_messages) != 2:
                    print(f"⚠️  Warning: Expected 2 messages, found {len(history_messages)}")

                print(f"📊 Found {len(history_messages)} messages in history")

                # Generate current timestamp for assistant message
                align_timestamp = int(time.time())
                print(f"⏰ Using timestamp {align_timestamp} for assistant message")

                # Find user and assistant messages
                user_msg_id = None
                assistant_msg_id = None
                user_msg_data = None
                assistant_msg_data = None

                for msg_id, msg_data in history_messages.items():
                    if msg_data.get("role") == "user":
                        user_msg_id = msg_id
                        user_msg_data = msg_data
                    else:
                        # Assistant message may not have role field set
                        assistant_msg_id = msg_id
                        assistant_msg_data = msg_data

                if not user_msg_id or not assistant_msg_id:
                    print("❌ Error: Could not identify user and assistant messages")
                    continue

                print(f"👤 User message: {user_msg_id}")
                print(f"🤖 Assistant message: {assistant_msg_id}")

                # Fix the history.messages structure
                # Update user message with childrenIds
                history_messages[user_msg_id]["parentId"] = None
                history_messages[user_msg_id]["childrenIds"] = [assistant_msg_id]

                # Extract lastSentence from content
                assistant_content = assistant_msg_data.get("content", "")
                last_sentence = extract_last_sentence(assistant_content)
                print(f"📝 Extracted lastSentence ({len(last_sentence)} chars)")

                # Update assistant message with all required fields
                history_messages[assistant_msg_id]["id"] = assistant_msg_id  # Add id field
                history_messages[assistant_msg_id]["parentId"] = user_msg_id
                history_messages[assistant_msg_id]["childrenIds"] = []
                history_messages[assistant_msg_id]["role"] = "assistant"
                history_messages[assistant_msg_id]["model"] = ctx.model
                history_messages[assistant_msg_id]["modelName"] = ctx.model
                history_messages[assistant_msg_id]["modelIdx"] = 0
                history_messages[assistant_msg_id]["timestamp"] = align_timestamp
                history_messages[assistant_msg_id]["done"] = True
                history_messages[assistant_msg_id]["lastSentence"] = last_sentence

                # Build the messages array: user first, then assistant
                messages_array = []

                # User message
                user_message_obj = {
                    "id": user_msg_id,
                    "parentId": None,
                    "childrenIds": [assistant_msg_id],
                    "role": "user",
                    "content": user_msg_data.get("content"),
                    "timestamp": user_msg_data.get("timestamp"),
                    "models": user_msg_data.get("models", [ctx.model])
                }
                messages_array.append(user_message_obj)

                # Assistant message
                assistant_message_obj = {
                    "id": assistant_msg_id,
                    "parentId": user_msg_id,
                    "childrenIds": [],
                    "role": "assistant",
                    "content": assistant_content,
                    "model": ctx.model,
                    "modelName": ctx.model,
                    "modelIdx": 0,
                    "timestamp": align_timestamp,
                    "done": True,
                    "lastSentence": last_sentence
                }
                messages_array.append(assistant_message_obj)

                # Get the currentId from history (should be assistant message)
                current_id = assistant_msg_id

                # Build the complete chat payload
                aligned_chat_payload = {
                    "chat": {
                        "models": current_chat_data.get("chat", {}).get("models", [ctx.model]),
                        "history": {
                            "messages": history_messages,  # Updated dict with fixed parent/child IDs
                            "currentId": current_id
                        },
                        "messages": messages_array,  # Aligned array with user first, assistant second
                        "params": current_chat_data.get("chat", {}).get("params", {}),
                        "files": current_chat_data.get("chat", {}).get("files", [])
                    }
                }

                debug_print(f"POST /api/v1/chats/{ctx.chat_id} - Align Messages Request", aligned_chat_payload)

                # POST to align
                post_url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/{ctx.chat_id}"
                if not human_confirmation("POST", post_url, aligned_chat_payload):
                    print("❌ Skipped")
                    continue

                response = client.post(
                    post_url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json"
                    },
                    json=aligned_chat_payload
                )
                response.raise_for_status()
                result = response.json()

                debug_print(f"POST /api/v1/chats/{ctx.chat_id} - Align Messages Response", result)

                print(f"✅ Messages aligned successfully")
                print(f"📊 Fixed parent/child IDs in history.messages")
                print(f"📊 Synced {len(messages_array)} messages to messages array (user → assistant)")

            else:
                print("❌ Invalid choice. Please enter 0-11.")

        except Exception as e:
            print(f"\n❌ Error: {e}")
            import traceback
            traceback.print_exc()

        input("\nPress Enter to continue...")


def automatic_mode(client: httpx.Client, token: str, ctx: Context):
    """Run automatic mode with correct flow using context object."""
    print("🤖 Starting AUTOMATIC MODE")
    print("="*80 + "\n")

    # Step 1: Ensure Sub-agents folder exists
    print("1️⃣ Ensuring Sub-agents folder exists...")
    ctx.folder_id = ensure_sub_agents_folder(client, token)
    print(f"✅ Folder ID: {ctx.folder_id}\n")

    # Step 2: Create chat
    print("2️⃣ Creating chat...")
    ctx.chat_id, ctx.user_message_id, ctx.timestamp = create_chat(
        client, token, ctx.folder_id, ctx.model, ctx.prompt
    )
    print(f"✅ Chat ID: {ctx.chat_id}")
    print(f"✅ User Message ID: {ctx.user_message_id}\n")

    # Step 3: Fetch tool IDs
    print("3️⃣ Fetching tool IDs...")
    ctx.tool_ids = fetch_tool_ids(client, token)
    print(f"✅ Found {len(ctx.tool_ids)} tools\n")

    # Step 4: Fetch model item
    print("4️⃣ Fetching model item...")
    ctx.model_item = fetch_model_item(client, token, ctx.model)
    print(f"✅ Model item loaded\n")

    # Step 5: Generate session ID
    print("5️⃣ Generating session ID...")
    ctx.session_id = generate_session_id()
    print(f"✅ Session ID: {ctx.session_id}\n")

    # Step 6: Generate completion
    print("6️⃣ Generating completion...")
    variables = generate_variables()
    completion_payload = {
        "stream": True,
        "model": ctx.model,
        "messages": [{"role": "user", "content": ctx.prompt}],
        "params": {"function_calling": "native"},
        "tool_ids": ctx.tool_ids,
        "tool_servers": [],
        "features": {
            "image_generation": False,
            "code_interpreter": False,
            "web_search": False
        },
        "variables": variables,
        "model_item": ctx.model_item,
        "session_id": ctx.session_id,
        "chat_id": ctx.chat_id,
        "id": str(uuid.uuid4()),
        "background_tasks": {
            "title_generation": True,
            "tags_generation": True,
            "follow_up_generation": True
        }
    }

    debug_print("POST /api/chat/completions - Request", completion_payload)

    url = f"{OPENWEBUI_BASE_URL}/api/chat/completions"
    if not human_confirmation("POST", url, completion_payload):
        raise RuntimeError("User cancelled request")

    response = client.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json=completion_payload,
        timeout=30.0
    )
    response.raise_for_status()
    result = response.json()

    debug_print("POST /api/chat/completions - Response", result)

    if not (result.get("status") and result.get("task_id")):
        raise RuntimeError(f"Unexpected response: {result}")

    ctx.task_id = result["task_id"]
    print(f"✅ Completion triggered (task_id: {ctx.task_id})\n")

    # Step 7: Poll for completion until we detect the completion signal
    print("7️⃣ Polling for completion...")
    max_attempts = 300  # 30 minutes with 5 second intervals
    poll_interval = 5

    for attempt in range(1, max_attempts + 1):
        url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/{ctx.chat_id}"
        if not human_confirmation("GET", url):
            raise RuntimeError("User cancelled request")

        response = client.get(
            url,
            headers={"Authorization": f"Bearer {token}"}
        )
        response.raise_for_status()
        chat_data = response.json()

        debug_print(f"GET /api/v1/chats/{ctx.chat_id} - Response (Attempt {attempt})", chat_data)

        # Check for errors
        history_messages = chat_data.get("chat", {}).get("history", {}).get("messages", {})
        for msg_id, message in history_messages.items():
            if "error" in message:
                error_data = message.get("error", {})
                error_content = error_data.get("content", {})
                error_message = error_content.get("message", "Unknown error")
                error_code = error_content.get("code", "unknown")
                model_name = message.get("model", "unknown")

                print(f"\n❌ Error detected in chat response!")
                debug_print("Error Message Object", message)

                raise RuntimeError(
                    f"Chat completion failed with error:\n"
                    f"  Model: {model_name}\n"
                    f"  Code: {error_code}\n"
                    f"  Message: {error_message}"
                )

        messages = chat_data.get("chat", {}).get("messages", [])

        # Check for completion signal (content in history)
        if len(history_messages) > len(messages):
            assistant_msg = None
            assistant_msg_id = None
            for msg_id, msg in history_messages.items():
                if msg.get("role") == "user":
                    continue
                if "content" in msg:
                    assistant_msg = msg
                    assistant_msg_id = msg_id
                    break

            if assistant_msg and assistant_msg_id:
                print(f"🔔 Detected completion signal (content present) after {attempt * poll_interval}s")
                ctx.assistant_message = assistant_msg
                ctx.assistant_message_id = assistant_msg_id
                break

        # Check old completion pattern
        if messages:
            last_message = messages[-1]
            if last_message.get("role") == "assistant" and last_message.get("done"):
                print(f"✅ Old-style completion detected after {attempt * poll_interval}s")
                ctx.assistant_message = last_message
                ctx.assistant_message_id = last_message.get("id")
                ctx.completed = True
                break

        print(f"  Attempt {attempt}/{max_attempts}: Waiting for completion...")
        time.sleep(poll_interval)
    else:
        raise TimeoutError(f"Chat did not complete after {max_attempts * poll_interval} seconds")

    print(f"✅ Completion detected\n")

    # Step 8: Align messages to history
    print("8️⃣ Aligning messages to history...")

    # Fetch current chat state
    url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/{ctx.chat_id}"
    if not human_confirmation("GET", url):
        raise RuntimeError("User cancelled request")

    response = client.get(
        url,
        headers={"Authorization": f"Bearer {token}"}
    )
    response.raise_for_status()
    current_chat_data = response.json()

    debug_print(f"GET /api/v1/chats/{ctx.chat_id} - Current Chat", current_chat_data)

    # Extract history.messages
    history_messages = current_chat_data.get("chat", {}).get("history", {}).get("messages", {})

    # Find user and assistant messages
    user_msg_id = None
    assistant_msg_id = None
    user_msg_data = None
    assistant_msg_data = None

    for msg_id, msg_data in history_messages.items():
        if msg_data.get("role") == "user":
            user_msg_id = msg_id
            user_msg_data = msg_data
        else:
            assistant_msg_id = msg_id
            assistant_msg_data = msg_data

    if not user_msg_id or not assistant_msg_id:
        raise RuntimeError("Could not identify user and assistant messages")

    # Extract lastSentence from content
    assistant_content = assistant_msg_data.get("content", "")
    last_sentence = extract_last_sentence(assistant_content)

    # Generate alignment timestamp
    align_timestamp = int(time.time())

    # Fix the history.messages structure
    history_messages[user_msg_id]["parentId"] = None
    history_messages[user_msg_id]["childrenIds"] = [assistant_msg_id]

    history_messages[assistant_msg_id]["id"] = assistant_msg_id
    history_messages[assistant_msg_id]["parentId"] = user_msg_id
    history_messages[assistant_msg_id]["childrenIds"] = []
    history_messages[assistant_msg_id]["role"] = "assistant"
    history_messages[assistant_msg_id]["model"] = ctx.model
    history_messages[assistant_msg_id]["modelName"] = ctx.model
    history_messages[assistant_msg_id]["modelIdx"] = 0
    history_messages[assistant_msg_id]["timestamp"] = align_timestamp
    history_messages[assistant_msg_id]["done"] = True
    history_messages[assistant_msg_id]["lastSentence"] = last_sentence

    # Build the messages array
    messages_array = [
        {
            "id": user_msg_id,
            "parentId": None,
            "childrenIds": [assistant_msg_id],
            "role": "user",
            "content": user_msg_data.get("content"),
            "timestamp": user_msg_data.get("timestamp"),
            "models": user_msg_data.get("models", [ctx.model])
        },
        {
            "id": assistant_msg_id,
            "parentId": user_msg_id,
            "childrenIds": [],
            "role": "assistant",
            "content": assistant_content,
            "model": ctx.model,
            "modelName": ctx.model,
            "modelIdx": 0,
            "timestamp": align_timestamp,
            "done": True,
            "lastSentence": last_sentence
        }
    ]

    # Build the complete chat payload
    aligned_chat_payload = {
        "chat": {
            "models": current_chat_data.get("chat", {}).get("models", [ctx.model]),
            "history": {
                "messages": history_messages,
                "currentId": assistant_msg_id
            },
            "messages": messages_array,
            "params": current_chat_data.get("chat", {}).get("params", {}),
            "files": current_chat_data.get("chat", {}).get("files", [])
        }
    }

    debug_print(f"POST /api/v1/chats/{ctx.chat_id} - Align Messages Request", aligned_chat_payload)

    # POST to align
    post_url = f"{OPENWEBUI_BASE_URL}/api/v1/chats/{ctx.chat_id}"
    if not human_confirmation("POST", post_url, aligned_chat_payload):
        raise RuntimeError("User cancelled request")

    response = client.post(
        post_url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json=aligned_chat_payload
    )
    response.raise_for_status()
    result = response.json()

    debug_print(f"POST /api/v1/chats/{ctx.chat_id} - Align Messages Response", result)

    print(f"✅ Messages aligned successfully\n")

    # Display final result
    print("\n" + "="*80)
    print("📝 ASSISTANT RESPONSE:")
    print("="*80)
    print(last_sentence)
    print("="*80)

    print(f"\n📊 Metadata:")
    print(f"  Chat ID: {ctx.chat_id}")
    print(f"  Model: {ctx.model}")
    print(f"  User Message ID: {ctx.user_message_id}")
    print(f"  Assistant Message ID: {ctx.assistant_message_id}")
    print(f"  Session ID: {ctx.session_id}")

    ctx.completed = True


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Simulate Open WebUI chat flow",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python src/scripts/simulate-owui-chat.py "What is 2+2?" "Atlas Sonnet 4.6"

  # With custom API key
  OWUI_API_TOKEN=your_token python src/scripts/simulate-owui-chat.py "prompt" "model"

  # Custom base URL (if running outside Docker)
  OPENWEBUI_BASE_URL=http://localhost:8080 python src/scripts/simulate-owui-chat.py "prompt" "model"

  # Human-in-the-loop mode (ask for confirmation before each API request)
  python src/scripts/simulate-owui-chat.py "prompt" "model" --human-mode

  # Interactive mode (manually choose order of API calls)
  python src/scripts/simulate-owui-chat.py "prompt" "model" --interactive
        """
    )
    parser.add_argument("prompt", help="User prompt to send to the model")
    parser.add_argument(
        "model",
        nargs="?",
        default="Atlas Sonnet 4.6",
        help="Model to use (default: Atlas Sonnet 4.6)"
    )
    parser.add_argument(
        "--human-mode",
        action="store_true",
        help="Ask for confirmation before each API request (for debugging)"
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Interactive mode: choose the order of API calls manually"
    )

    args = parser.parse_args()

    # Set global flags
    global HUMAN_MODE, INTERACTIVE_MODE
    HUMAN_MODE = args.human_mode
    INTERACTIVE_MODE = args.interactive

    # Set up logging to file
    logs_dir = Path("logs")
    logs_dir.mkdir(exist_ok=True)

    epoch_timestamp = int(time.time())
    log_file_path = logs_dir / f"logs_{epoch_timestamp}.log"

    # Redirect stdout to both console and file
    tee = TeeOutput(str(log_file_path))
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    sys.stdout = tee
    sys.stderr = tee

    print(f"📝 Logging to: {log_file_path}")
    print(f"⏰ Timestamp: {epoch_timestamp} ({datetime.fromtimestamp(epoch_timestamp)})")
    print("="*80 + "\n")

    try:
        # Get API token
        token = get_api_token()

        # Create HTTP client
        with httpx.Client(timeout=300.0) as client:
            # Create context object
            ctx = Context(args.prompt, args.model)

            # Check if interactive mode
            if INTERACTIVE_MODE:
                print("🎮 Starting INTERACTIVE MODE")
                print("You can choose the order of API calls manually.\n")
                interactive_mode(client, token, ctx)
                return 0

            # Automatic mode: run full flow automatically
            automatic_mode(client, token, ctx)
            return 0

    except Exception as e:
        print(f"\n❌ Error: {e}")
        return 1

    finally:
        # Restore stdout/stderr and close log file
        sys.stdout = original_stdout
        sys.stderr = original_stderr
        tee.close()
        print(f"✅ Log saved to: {log_file_path}", file=original_stdout)


if __name__ == "__main__":
    sys.exit(main())
