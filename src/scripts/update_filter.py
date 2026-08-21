#!/usr/bin/env python3
"""Update the auto_agent_vm filter in Open WebUI."""
import requests
import redis
from pathlib import Path

def main():
    # Get token from Redis
    r = redis.Redis(host='redis', port=6379, decode_responses=True)
    token = r.get('openwebui:api_token')
    if not token:
        print("ERROR: No token found in Redis")
        return False

    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    base_url = 'http://open-webui:8080/api/v1'

    # Read the filter code
    code_path = Path('/tmp/auto_agent_vm.py')
    if not code_path.exists():
        print(f"ERROR: Filter code not found at {code_path}")
        return False

    code = code_path.read_text()
    print(f"Code length: {len(code)} chars")

    # Check if httpx is in the code (should be in new version)
    if 'httpx' in code:
        print("✅ Code uses httpx (HTTP-based approach)")
    else:
        print("❌ Code does NOT use httpx - this is the OLD broken version!")
        return False

    # Format the code first
    format_resp = requests.post(
        f'{base_url}/utils/code/format',
        headers=headers,
        json={'code': code}
    )
    if format_resp.status_code != 200:
        print(f"Format warning: {format_resp.status_code}")
        formatted_code = code
    else:
        formatted_code = format_resp.json().get('code', code)
        print(f"Formatted: {len(formatted_code)} chars")

    # Delete existing function first
    filter_id = 'portico_core_auto_agent_vm'
    del_resp = requests.delete(
        f'{base_url}/functions/id/{filter_id}/delete',
        headers=headers
    )
    print(f"Delete existing: {del_resp.status_code}")

    # Create the function
    payload = {
        'id': 'portico_core_auto_agent_vm',
        'name': 'portico_core_auto_agent_vm',
        'meta': {
            'description': 'Automatically creates a dedicated Agent VM for each new chat and injects VM ID into system prompt.'
        },
        'content': formatted_code
    }

    create_resp = requests.post(
        f'{base_url}/functions/create',
        headers=headers,
        json=payload
    )

    print(f"Create status: {create_resp.status_code}")
    if create_resp.status_code not in [200, 201]:
        print(f"Create response: {create_resp.text[:300]}")
        return False

    # Toggle global
    global_resp = requests.post(
        f'{base_url}/functions/id/portico_core_auto_agent_vm/toggle/global',
        headers=headers
    )
    print(f"Toggle global: {global_resp.status_code}")

    # Toggle active
    active_resp = requests.post(
        f'{base_url}/functions/id/portico_core_auto_agent_vm/toggle',
        headers=headers
    )
    print(f"Toggle active: {active_resp.status_code}")

    print("✅ Filter update complete!")
    return True

if __name__ == '__main__':
    main()
