#!/usr/bin/env python3
"""
Health check script for single MCP server during OAuth setup.
Polls the server's OpenAPI endpoint and verifies tools are exposed.
Used by the guided setup wizard to verify server readiness.
"""

import sys
import time
import json
import argparse
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, List, Tuple


def get_server_openapi(server_id: str, base_url: str = "http://localhost:8770", timeout: int = 10) -> Optional[Dict[str, Any]]:
    """
    Fetch OpenAPI spec from a single MCP server.

    Args:
        server_id: The MCP server ID
        base_url: Base URL of the MCPO endpoint
        timeout: Request timeout in seconds

    Returns:
        OpenAPI spec dict if successful, None otherwise
    """
    url = f"{base_url}/{server_id}/openapi.json"
    try:
        request = urllib.request.Request(url)
        request.add_header('Accept', 'application/json')
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status == 200:
                return json.loads(response.read().decode('utf-8'))
    except urllib.error.URLError as e:
        pass
    except json.JSONDecodeError:
        pass
    except Exception:
        pass
    return None


def check_health_endpoint(base_url: str = "http://localhost:8770", timeout: int = 5) -> bool:
    """
    Check if the nginx health endpoint is responding.

    Args:
        base_url: Base URL of the MCPO endpoint
        timeout: Request timeout in seconds

    Returns:
        True if healthy, False otherwise
    """
    url = f"{base_url}/health"
    try:
        request = urllib.request.Request(url)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def get_tools_from_openapi(openapi_spec: Dict[str, Any]) -> List[str]:
    """
    Extract tool names from an OpenAPI spec.

    Args:
        openapi_spec: The OpenAPI spec dict

    Returns:
        List of tool/endpoint names
    """
    tools = []
    paths = openapi_spec.get('paths', {})
    for path, methods in paths.items():
        # Skip OAuth-related paths
        if 'oauth' in path.lower():
            continue
        # Extract tool name from path
        # Handle both formats:
        # - /google_workspace/list_files -> list_files
        # - /glean_chat -> glean_chat
        parts = path.strip('/').split('/')
        tool_name = parts[-1] if parts else None
        if tool_name and tool_name not in ['openapi.json', 'docs', '']:
            tools.append(tool_name)
    return tools


def check_oauth_status(openapi_spec: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Check if the server has OAuth requirements and their status.

    Args:
        openapi_spec: The OpenAPI spec dict

    Returns:
        Tuple of (requires_oauth, oauth_status)
        oauth_status can be 'authorized', 'pending', or None
    """
    # Check for OAuth-related paths or security schemes
    paths = openapi_spec.get('paths', {})
    security_schemes = openapi_spec.get('components', {}).get('securitySchemes', {})

    has_oauth_path = any('oauth' in path.lower() for path in paths.keys())
    has_oauth_security = any('oauth' in scheme.lower() for scheme in security_schemes.keys())

    if not (has_oauth_path or has_oauth_security):
        return False, None

    # Check for OAuth status endpoint
    # TODO: Implement actual OAuth status check if needed
    return True, 'pending'


def wait_for_server(
    server_id: str,
    base_url: str = "http://localhost:8770",
    max_wait: int = 60,
    poll_interval: int = 2,
    min_tools: int = 1,
    verbose: bool = False
) -> Dict[str, Any]:
    """
    Wait for a single MCP server to become healthy.

    Args:
        server_id: The MCP server ID
        base_url: Base URL of the MCPO endpoint
        max_wait: Maximum time to wait in seconds
        poll_interval: Time between polls in seconds
        min_tools: Minimum number of non-OAuth tools required
        verbose: Print progress messages

    Returns:
        Dict with status information:
        {
            'success': bool,
            'server_id': str,
            'tools': list,
            'tool_count': int,
            'requires_oauth': bool,
            'oauth_status': str or None,
            'error': str or None,
            'elapsed': float
        }
    """
    start_time = time.time()
    last_error = None

    if verbose:
        print(f"Waiting for server '{server_id}' to be ready (max {max_wait}s)...")

    while time.time() - start_time < max_wait:
        elapsed = time.time() - start_time

        # First check basic health
        if not check_health_endpoint(base_url):
            last_error = "Health endpoint not responding"
            if verbose:
                print(f"  [{elapsed:.1f}s] {last_error}")
            time.sleep(poll_interval)
            continue

        # Try to get OpenAPI spec
        openapi_spec = get_server_openapi(server_id, base_url)
        if not openapi_spec:
            last_error = "OpenAPI endpoint not responding"
            if verbose:
                print(f"  [{elapsed:.1f}s] {last_error}")
            time.sleep(poll_interval)
            continue

        # Extract tools
        tools = get_tools_from_openapi(openapi_spec)

        # Check OAuth status
        requires_oauth, oauth_status = check_oauth_status(openapi_spec)

        # Verify minimum tools
        if len(tools) < min_tools:
            last_error = f"Insufficient tools ({len(tools)} < {min_tools})"
            if verbose:
                print(f"  [{elapsed:.1f}s] {last_error}")
            time.sleep(poll_interval)
            continue

        # Success!
        elapsed = time.time() - start_time
        if verbose:
            print(f"  [{elapsed:.1f}s] Server ready with {len(tools)} tools")

        return {
            'success': True,
            'server_id': server_id,
            'tools': tools,
            'tool_count': len(tools),
            'requires_oauth': requires_oauth,
            'oauth_status': oauth_status,
            'error': None,
            'elapsed': elapsed
        }

    # Timeout
    elapsed = time.time() - start_time
    return {
        'success': False,
        'server_id': server_id,
        'tools': [],
        'tool_count': 0,
        'requires_oauth': False,
        'oauth_status': None,
        'error': last_error or "Timeout waiting for server",
        'elapsed': elapsed
    }


def main():
    """Main entry point for CLI usage."""
    parser = argparse.ArgumentParser(
        description='Health check for single MCP server during OAuth setup'
    )
    parser.add_argument(
        'server_id',
        help='The MCP server ID to check (e.g., google_workspace)'
    )
    parser.add_argument(
        '--base-url',
        default='http://localhost:8770',
        help='Base URL of the MCPO endpoint (default: http://localhost:8770)'
    )
    parser.add_argument(
        '--max-wait',
        type=int,
        default=60,
        help='Maximum time to wait in seconds (default: 60)'
    )
    parser.add_argument(
        '--poll-interval',
        type=int,
        default=2,
        help='Time between polls in seconds (default: 2)'
    )
    parser.add_argument(
        '--min-tools',
        type=int,
        default=1,
        help='Minimum number of non-OAuth tools required (default: 1)'
    )
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Print progress messages'
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='Output result as JSON'
    )

    args = parser.parse_args()

    result = wait_for_server(
        server_id=args.server_id,
        base_url=args.base_url,
        max_wait=args.max_wait,
        poll_interval=args.poll_interval,
        min_tools=args.min_tools,
        verbose=args.verbose
    )

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result['success']:
            print(f"SUCCESS: Server '{result['server_id']}' is ready")
            print(f"  Tools: {result['tool_count']}")
            if result['requires_oauth']:
                print(f"  OAuth: {result['oauth_status']}")
            print(f"  Elapsed: {result['elapsed']:.1f}s")
        else:
            print(f"FAILED: Server '{result['server_id']}' not ready")
            print(f"  Error: {result['error']}")
            print(f"  Elapsed: {result['elapsed']:.1f}s")

    sys.exit(0 if result['success'] else 1)


if __name__ == '__main__':
    main()
