#!/usr/bin/env bash

set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_BIN="${portico_SECURITY_AUDIT_DOCKER_BIN:-docker}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "SECURITY AUDIT RESULT: RED"
  echo "[RED] audit execution failure: python3 is required"
  exit 3
fi

exec "$PYTHON_BIN" - "$SCRIPT_ROOT" "$DOCKER_BIN" <<'PY'
import json
import hashlib
import http.client
import os
import re
import shutil
import stat
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

try:
    from tabulate import tabulate as _tabulate
except Exception:
    _tabulate = None

SCRIPT_ROOT = Path(sys.argv[1]).resolve()
DOCKER_BIN = sys.argv[2]
HOME = Path(os.environ.get("HOME", str(Path.home()))).expanduser()
DEFAULT_MANAGED_ROOT = (HOME / "portico" / "portico-managed").resolve()
MANAGED_ROOT = Path(os.environ.get("PORTICO_MANAGED_ROOT", str(DEFAULT_MANAGED_ROOT))).expanduser().resolve()
APP_SUPPORT_DIR = HOME / "Library" / "Application Support" / "portico"
PROJECT_CONFIG_PATH = APP_SUPPORT_DIR / "project-config.json"


def is_filesystem_root(path):
    try:
        resolved = Path(path).expanduser().resolve()
    except Exception:
        return False
    return resolved.parent == resolved


def has_project_shape(path):
    return (path / "src").is_dir() and (path / "docker-compose.yml").is_file()


def load_configured_project_root():
    try:
        if not PROJECT_CONFIG_PATH.is_file():
            return None
        data = json.loads(PROJECT_CONFIG_PATH.read_text(errors="ignore"))
    except Exception:
        return None
    raw_root = data.get("projectRoot") if isinstance(data, dict) else None
    if not isinstance(raw_root, str) or not raw_root.strip():
        return None
    configured = Path(raw_root.strip()).expanduser().resolve()
    if is_filesystem_root(configured):
        return None
    if configured == DEFAULT_MANAGED_ROOT and MANAGED_ROOT != DEFAULT_MANAGED_ROOT:
        return MANAGED_ROOT
    return configured


def resolve_project_root():
    configured = load_configured_project_root()
    if configured is not None:
        return configured, "project-config"
    cwd = Path.cwd().resolve()
    if has_project_shape(cwd):
        return cwd, "cwd"
    return SCRIPT_ROOT, "script-dir"


PROJECT_ROOT, PROJECT_ROOT_SOURCE = resolve_project_root()

SEVERITY = {"INFO": 0, "GREEN": 0, "YELLOW": 1, "RED": 2}
EXIT_BY_SEVERITY = {0: 0, 1: 1, 2: 2}
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
HTTP_AUTH_REJECTION_STATUSES = {401, 403}
HTTP_AUTH_REDIRECT_STATUSES = {302, 303, 307, 308}
HTTP_PROBE_DISCONNECT_ERRORS = (
    ConnectionAbortedError,
    ConnectionResetError,
    http.client.RemoteDisconnected,
)
PACKAGE_MANAGER_COMMANDS = {"npx", "npm", "pnpm", "yarn", "bunx"}
MANAGED_NODE_SENTINEL_COMMAND = "__portico_managed_node_package__"
MANAGED_NODE_PACKAGE_KEY = "managed_node_package"
MANAGED_NODE_STORE_DEST = "/app/open-webui-data/managed-node-mcp-packages"
MANAGED_NODE_ACQUISITION_FRAGMENT = "managed-node-mcp-package-acquisition"
FIRST_PARTY_NAMES = {
    "llm-gateway",
    "docker-socket-proxy",
    "mcpo",
    "mcpo-core",
    "mcpo-group-core",
    "open-webui",
    "redis",
    "mongodb",
    "health-check",
    "portico-open-webui",
    "portico-open-webui",
    "portico-redis",
    "portico-mongodb",
    "portico-health-check",
    "chat-state-api",
    "open-webui-health-check",
    "llm-debug-monitor",
}
RUNTIME_SECRET_KEYS = {
    "PORTICO_LLM_API_KEY",
    "LOCAL_STACK_API_KEY",
    "INTERNAL_OPENAI_API_KEY",
    "OPENAI_API_KEY",
    "BIFROST_BRIDGE_LOCAL_API_KEY",
    "CLOUDSMITH_ENTITLEMENT_TOKEN",
    "CLOUDSMITH_API_KEY",
    "SLACK_OAUTH_CLIENT_ID",
    "SLACK_OAUTH_CLIENT_SECRET",
    "SLACK_MCP_XOXP_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_AUTH_TOKEN",
    "NPM_TOKEN",
    "YARN_NPM_AUTH_TOKEN",
    "YARN_NPM_AUTH_IDENT",
    "COREPACK_NPM_TOKEN",
    "COREPACK_NPM_USERNAME",
    "COREPACK_NPM_PASSWORD",
    "BUN_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
}
SECRET_FILE_NAMES = {
    ".env",
    ".env.runtime",
    ".env.backup",
    "env.runtime",
    "runtime-secrets.env",
    "cloudsmith.env",
    ".npmrc",
}
NON_SECRET_ENV_KEYS = {
    "WEBUI_AUTH",
    "ENABLE_PASSWORD_AUTH",
    "PORTICO_OAUTH_ACCESS_TOKEN_BROKER_URL",
    "PORTICO_OAUTH_ACCESS_TOKEN_SERVER_ID",
    "PORTICO_STATIC_SECRET_BROKER_URL",
    "PORTICO_STATIC_SECRET_TARGETS",
}
DOCKER_SOCKET_PROXY_CONTROL_KEYS = {
    "AUTH",
    "BUILD",
    "COMMIT",
    "CONFIGS",
    "CONTAINERS",
    "DISTRIBUTION",
    "EVENTS",
    "EXEC",
    "GRPC",
    "IMAGES",
    "INFO",
    "NETWORKS",
    "NODES",
    "PING",
    "PLUGINS",
    "POST",
    "SECRETS",
    "SERVICES",
    "SESSION",
    "SWARM",
    "SYSTEM",
    "TASKS",
    "VERSION",
    "VOLUMES",
}
LEGACY_SLACK_TOKEN_ENV_KEYS = {
    "SLACK_MCP_XOXP_TOKEN",
}
LEGACY_OAUTH_STORE_NAMES = {
    "mcpo-oauth-tokens",
    "mcpo-core-oauth-tokens",
}
LEGACY_OAUTH_MOUNT_TARGETS = {
    "/root/.mcpo",
    "/app/mcpo-oauth-tokens",
    "/app/mcpo-core-oauth-tokens",
}
FORBIDDEN_RUNTIME_PACKAGE_MANAGER_ENV_KEYS = {
    "NODE_AUTH_TOKEN",
    "NPM_AUTH_TOKEN",
    "NPM_TOKEN",
    "YARN_NPM_AUTH_TOKEN",
    "YARN_NPM_AUTH_IDENT",
    "COREPACK_NPM_TOKEN",
    "COREPACK_NPM_USERNAME",
    "COREPACK_NPM_PASSWORD",
    "BUN_AUTH_TOKEN",
    "NPM_CONFIG_GLOBALCONFIG",
    "npm_config_globalconfig",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
}

HTTP_AUTH_PROBES = [
    {
        "id": "bifrost-rust-bridge",
        "label": "Bifrost/Rust Bridge",
        "url_env": "portico_SECURITY_AUDIT_BIFROST_URL",
        "default_url": "http://127.0.0.1:4583/v1/models",
        "method": "GET",
    },
    {
        "id": "open-webui",
        "label": "Open WebUI API",
        "url_env": "portico_SECURITY_AUDIT_OPEN_WEBUI_URL",
        "default_url": "http://127.0.0.1:3789/api/models",
        "method": "GET",
        "allow_auth_redirect": True,
    },
    {
        "id": "mcpo",
        "label": "MCPO OpenAPI metadata",
        "url_env": "portico_SECURITY_AUDIT_MCPO_URL",
        "default_url": "http://127.0.0.1:8765/openapi.json",
        "method": "GET",
        "loopback_metadata": True,
    },
    {
        "id": "mcpo-core",
        "label": "MCPO core OpenAPI metadata",
        "url_env": "portico_SECURITY_AUDIT_MCPO_CORE_URL",
        "default_url": "http://127.0.0.1:8766/openapi.json",
        "method": "GET",
        "loopback_metadata": True,
    },
    {
        "id": "chat-state-api",
        "label": "Chat State API",
        "url_env": "portico_SECURITY_AUDIT_CHAT_STATE_URL",
        "default_url": "http://127.0.0.1:3835/api/v1/chat-state/security-audit",
        "method": "GET",
    },
    {
        "id": "llm-debug-monitor",
        "label": "LLM Debug Monitor",
        "url_env": "portico_SECURITY_AUDIT_DEBUG_MONITOR_URL",
        "default_url": "http://127.0.0.1:8879/api/sessions",
        "method": "GET",
        "accepted_statuses": {401, 403, 503},
    },
    {
        "id": "electron-api",
        "label": "Electron local MCP metadata",
        "url_env": "portico_SECURITY_AUDIT_ELECTRON_API_URL",
        "default_url": "http://127.0.0.1:9876/api/mcp/servers",
        "method": "GET",
        "loopback_metadata": True,
    },
    {
        "id": "host-mcp-bridge",
        "label": "Host MCP Bridge streamable HTTP",
        "url_env": "portico_SECURITY_AUDIT_HOST_MCP_BRIDGE_URL",
        "default_url": "http://127.0.0.1:8891/mcp",
        "method": "POST",
        "headers": {
            "Accept": "application/json,text/event-stream",
            "Content-Type": "application/json",
        },
        "json": {
            "jsonrpc": "2.0",
            "id": "security-audit",
            "method": "tools/list",
            "params": {},
        },
    },
    {
        "id": "host-mcp-oauth-token-broker",
        "label": "Host MCP Bridge OAuth token broker",
        "url_env": "portico_SECURITY_AUDIT_HOST_MCP_OAUTH_TOKEN_BROKER_URL",
        "default_url": "http://127.0.0.1:8891/secrets/oauth/access-token",
        "method": "POST",
        "headers": {
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        "json": {
            "server_id": "slack",
        },
    },
]

HOST_LISTENER_TARGETS = [
    ("Bifrost/Rust Bridge", 4583),
    ("Open WebUI", 3789),
    ("MCPO control plane", 8765),
    ("MCPO core control plane", 8766),
    ("MCPO OAuth callback aggregator", 3834),
    ("Chat State API", 3835),
    ("LLM Debug Monitor", 8879),
    ("Electron local API", 9876),
    ("Host MCP Bridge", 8891),
]


class Audit:
    def __init__(self):
        self.findings = []
        self.max_severity = 0
        self.container_sections = []
        self.notes = []

    def report(self, severity, message):
        rank = SEVERITY[severity]
        self.max_severity = max(self.max_severity, rank)
        self.findings.append((severity, message))

    def info(self, message):
        self.notes.append(message.strip())

    def container_info(self, lines):
        self.container_sections.append(lines)

    def exit_code(self):
        return EXIT_BY_SEVERITY.get(self.max_severity, 3)


audit = Audit()
audit.info(f"Project root: {PROJECT_ROOT} (source: {PROJECT_ROOT_SOURCE})")


def table_width_budget():
    columns = shutil.get_terminal_size((160, 40)).columns
    return max(80, min(180, columns - 6))


def table_column_widths(headers, rows):
    count = len(headers)
    if count == 0:
        return []
    max_content_width = table_width_budget() - (3 * count + 1)
    min_widths = [max(4, len(str(header))) for header in headers]
    widths = min_widths[:]
    for row in rows:
        normalized = list(row) + [""] * (count - len(row))
        for index, value in enumerate(normalized[:count]):
            longest_line = max((len(line) for line in str(value).splitlines()), default=0)
            widths[index] = max(widths[index], longest_line)
    widths = [min(width, 72) for width in widths]
    while sum(widths) > max_content_width and any(widths[index] > min_widths[index] for index in range(count)):
        widest = max(range(count), key=lambda index: widths[index] - min_widths[index])
        if widths[widest] <= min_widths[widest]:
            break
        widths[widest] -= 1
    return widths


def fallback_grid_table(headers, rows):
    widths = table_column_widths(headers, rows)

    def border():
        return "+" + "+".join("-" * (width + 2) for width in widths) + "+"

    def wrap_cell(value, width):
        text = str(value)
        lines = []
        for raw_line in text.splitlines() or [""]:
            if len(raw_line) <= width:
                lines.append(raw_line)
                continue
            if "/" in raw_line and not re.search(r"\s", raw_line):
                softened = raw_line.replace("/", "/ ")
                wrapped_path = textwrap.wrap(
                    softened,
                    width=width,
                    break_long_words=True,
                    break_on_hyphens=False,
                )
                lines.extend([line.replace("/ ", "/") for line in wrapped_path] or [""])
                continue
            lines.extend(
                textwrap.wrap(
                    raw_line,
                    width=width,
                    break_long_words=True,
                    break_on_hyphens=False,
                    replace_whitespace=False,
                    drop_whitespace=False,
                )
                or [""]
            )
        return lines

    def render_row(row):
        normalized = list(row) + [""] * (len(widths) - len(row))
        wrapped = [wrap_cell(value, widths[index]) for index, value in enumerate(normalized[: len(widths)])]
        height = max((len(cell_lines) for cell_lines in wrapped), default=1)
        rendered = []
        for line_index in range(height):
            cells = []
            for index, cell_lines in enumerate(wrapped):
                value = cell_lines[line_index] if line_index < len(cell_lines) else ""
                cells.append(value.ljust(widths[index]))
            rendered.append("| " + " | ".join(cells) + " |")
        return rendered

    lines = [border()]
    lines.extend(render_row(headers))
    lines.append(border())
    for row in rows:
        lines.extend(render_row(row))
    lines.append(border())
    return lines


def table_lines(headers, rows):
    if not rows:
        return ["none"]
    if _tabulate:
        try:
            return _tabulate(
                rows,
                headers=headers,
                tablefmt="grid",
                disable_numparse=True,
                maxcolwidths=table_column_widths(headers, rows),
            ).splitlines()
        except TypeError:
            return _tabulate(rows, headers=headers, tablefmt="grid", disable_numparse=True).splitlines()
    return fallback_grid_table(headers, rows)


def env_key_rows(keys, columns=4):
    rows = []
    sorted_keys = sorted(keys)
    for index in range(0, len(sorted_keys), columns):
        row = sorted_keys[index : index + columns]
        rows.append(row + [""] * (columns - len(row)))
    return rows


def append_section(lines, title, headers, rows):
    lines.append(f"  {title}:")
    for line in table_lines(headers, rows):
        lines.append(f"    {line}")


def run_cmd(args, check=False):
    try:
        result = subprocess.run(
            args,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError(f"missing required command: {args[0]}")
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "command failed")
    return result


def mode_string(path):
    return f"{stat.S_IMODE(path.stat().st_mode):04o}"


def is_group_or_world_accessible(path):
    return bool(stat.S_IMODE(path.stat().st_mode) & 0o077)


def parse_env_key(entry):
    return entry.split("=", 1)[0] if "=" in entry else entry


def parse_env_value(entry):
    return entry.split("=", 1)[1] if "=" in entry else ""


def is_sensitive_key(key):
    if not key or key.endswith("_FILE"):
        return False
    upper = key.upper()
    if upper in NON_SECRET_ENV_KEYS:
        return False
    if key in RUNTIME_SECRET_KEYS:
        return True
    if is_sensitive_package_manager_key(key):
        return True
    if upper in RUNTIME_SECRET_KEYS:
        return True
    return bool(
        upper.endswith("_API_KEY")
        or upper.endswith("_TOKEN")
        or "SECRET" in upper
        or upper.endswith("_PASSWORD")
        or upper.endswith("_PRIVATE_KEY")
        or upper.endswith("_AUTH")
        or "XOXP" in upper
        or "XOXB" in upper
    )


def is_sensitive_package_manager_key(key):
    lower = key.lower()
    package_prefixes = (
        "npm_config_",
        "yarn_npm_",
        "corepack_npm_",
        "bun_config_",
    )
    if not lower.startswith(package_prefixes):
        return False
    return any(
        marker in lower
        for marker in (
            "auth",
            "token",
            "password",
            "secret",
            "cert",
            "keyfile",
        )
    )


def is_forbidden_runtime_package_manager_env_key(key):
    if key in FORBIDDEN_RUNTIME_PACKAGE_MANAGER_ENV_KEYS:
        return True
    lower = key.lower()
    return (
        lower.startswith("npm_config_")
        and any(marker in lower for marker in ("auth", "token", "password", "secret", "cert", "keyfile", "userconfig", "globalconfig"))
    )


def should_treat_env_key_as_sensitive(container_name_value, container_class, key):
    upper = key.upper()
    if container_name_value == "docker-socket-proxy" and upper in DOCKER_SOCKET_PROXY_CONTROL_KEYS:
        return False
    return is_sensitive_key(key)


def parse_static_secret_targets(env_entries):
    targets = {}
    token_envs = set()
    raw_targets = ""
    for entry in env_entries:
        if parse_env_key(entry) == "portico_STATIC_SECRET_TARGETS":
            raw_targets = parse_env_value(entry)
            break
    for item in [entry for entry in raw_targets.split(";") if entry]:
        parts = [part.strip() for part in item.split("|", 4)]
        if len(parts) < 4:
            continue
        server_id, secret_name, write_path, token_env = parts[:4]
        link_path = parts[4] if len(parts) >= 5 else ""
        if not server_id or not secret_name or not write_path or not token_env:
            continue
        targets[write_path] = {
            "server_id": server_id,
            "secret_name": secret_name,
            "token_env": token_env,
            "link_path": link_path,
        }
        token_envs.add(token_env)
    return targets, token_envs


def is_scoped_broker_token_env_key(key, static_secret_token_envs):
    return key in {
        "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN",
        "portico_SCHEDULER_BRIDGE_STATUS_TOKEN",
    } or key in static_secret_token_envs


def is_broker_materialized_file_pointer(value, static_secret_targets):
    if not value:
        return False
    if value in static_secret_targets and value.startswith("/dev/shm/portico-runtime-secrets/"):
        return True
    return value.startswith("/dev/shm/portico-oauth-tokens/") or value.startswith("/tmp/portico-oauth-tokens/")


def secret_base_from_file_key(key):
    return key[:-5] if key.endswith("_FILE") else key


def is_loopback_host(host):
    if host in LOOPBACK_HOSTS:
        return True
    if host.startswith("127."):
        return True
    return False


def is_allowed_npm_registry(registry):
    parsed = urlparse(registry.strip())
    return (
        parsed.scheme == "https"
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
    )


def discover_sensitive_required_env_vars():
    sensitive = set()
    for root in [PROJECT_ROOT / "mcp-configs", PROJECT_ROOT / "mcp-configs-user"]:
        if not root.is_dir():
            continue
        for yaml_path in sorted(root.glob("*/*.yaml")):
            in_required = False
            current_name = None
            current_sensitive = False
            for raw_line in yaml_path.read_text(errors="ignore").splitlines():
                line = raw_line.rstrip()
                if re.match(r"^[^\s-][^:]*:", line):
                    if in_required and current_name and current_sensitive:
                        sensitive.add(current_name)
                    current_name = None
                    current_sensitive = False
                    in_required = line.strip() == "required_env_vars:"
                    continue
                if not in_required:
                    continue
                name_match = re.match(r"\s*-\s*name:\s*['\"]?([^'\"\s#]+)", line)
                if name_match:
                    if current_name and current_sensitive:
                        sensitive.add(current_name)
                    current_name = name_match.group(1)
                    current_sensitive = False
                    continue
                if re.match(r"\s*sensitive:\s*true\s*$", line):
                    current_sensitive = True
            if in_required and current_name and current_sensitive:
                sensitive.add(current_name)
    return sensitive


def yaml_scalar(value):
    value = re.sub(r"\s+#.*$", "", str(value or "")).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1].strip()
    return value


def runtime_file_target_from_entry(source, filename, target):
    if target:
        return target
    if filename:
        return f"/app/runtime/{filename}"
    return f"/app/runtime/{Path(source).name}"


def runtime_file_slug(value, fallback):
    slug = re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")
    return slug or fallback


def runtime_file_target_hash(server_id, target):
    digest = hashlib.sha256()
    digest.update(str(server_id or "").encode())
    digest.update(b"\0")
    digest.update(str(target or "").encode())
    return digest.hexdigest()[:12]


def sensitive_runtime_file_secret_name(server_id, target):
    return "portico_runtime_file_{}_{}_{}".format(
        runtime_file_slug(server_id, "server"),
        runtime_file_slug(Path(target).name, "file"),
        runtime_file_target_hash(server_id, target),
    )


def expand_runtime_file_source(source):
    source = str(source or "").strip()
    if source == "~":
        return HOME
    if source.startswith("~/"):
        return HOME / source[2:]
    if source.startswith("~"):
        return Path(source)
    path = Path(source)
    return path if path.is_absolute() else PROJECT_ROOT / path


def discover_sensitive_runtime_files():
    descriptors = []
    for root in [PROJECT_ROOT / "mcp-configs", PROJECT_ROOT / "mcp-configs-user"]:
        if not root.is_dir():
            continue
        for yaml_path in sorted(root.glob("*/*.yaml")):
            server_id = yaml_path.stem
            in_runtime = False
            current = None

            def flush():
                if not current:
                    return
                if current.get("sensitive") != "true":
                    return
                source = current.get("source", "")
                if not source:
                    return
                target = runtime_file_target_from_entry(
                    source,
                    current.get("filename", ""),
                    current.get("target", ""),
                )
                descriptors.append(
                    {
                        "server_id": server_id,
                        "source": source,
                        "source_path": expand_runtime_file_source(source),
                        "target": target,
                        "secret_name": sensitive_runtime_file_secret_name(server_id, target),
                    }
                )

            for raw_line in yaml_path.read_text(errors="ignore").splitlines():
                line = raw_line.rstrip()
                if re.match(r"^[^\s][^:]*:", line):
                    if in_runtime:
                        flush()
                    current = None
                    in_runtime = line.strip() == "runtime_files:"
                    continue
                if not in_runtime:
                    continue
                item_match = re.match(r"\s*-\s*(.*)$", line)
                if item_match:
                    flush()
                    current = {}
                    rest = item_match.group(1)
                    key_value = re.match(r"([^:]+):\s*(.*)$", rest)
                    if key_value:
                        current[yaml_scalar(key_value.group(1))] = yaml_scalar(key_value.group(2))
                    continue
                if current is None:
                    continue
                key_value = re.match(r"\s*([^:]+):\s*(.*)$", line)
                if key_value:
                    current[yaml_scalar(key_value.group(1))] = yaml_scalar(key_value.group(2))
            if in_runtime:
                flush()
    return descriptors


def parse_docker_run_image_and_envs(args):
    env_keys = []
    image = None
    i = 0
    if args and args[0] == "run":
        i = 1
    flags_with_values = {
        "-e",
        "--env",
        "--name",
        "--network",
        "--hostname",
        "-v",
        "--volume",
        "--mount",
        "-p",
        "--publish",
        "-w",
        "--workdir",
        "-u",
        "--user",
        "--entrypoint",
        "--label",
        "--add-host",
        "--cpus",
        "--memory",
    }
    while i < len(args):
        token = args[i]
        if token in ("-e", "--env") and i + 1 < len(args):
            env_keys.append(args[i + 1].split("=", 1)[0])
            i += 2
            continue
        if token.startswith("--env="):
            env_keys.append(token.split("=", 1)[1].split("=", 1)[0])
            i += 1
            continue
        if token in flags_with_values:
            i += 2
            continue
        if token.startswith("-"):
            i += 1
            continue
        image = token
        break
    return image, env_keys


def discover_mcp_child_config(sensitive_keys):
    images = set()
    image_expected_env = {}
    compat_plaintext_oauth = []
    for fragment in sorted(list((PROJECT_ROOT / "mcp-configs").glob("*/*.fragment")) + list((PROJECT_ROOT / "mcp-configs-user").glob("*/*.fragment"))):
        try:
            data = json.loads(fragment.read_text())
        except Exception:
            continue
        http_subprocess = data.get("http_subprocess") if isinstance(data, dict) else None
        if isinstance(http_subprocess, dict):
            env_name = http_subprocess.get("oauth_access_token_env")
            if env_name:
                compat_plaintext_oauth.append((fragment, env_name))
        command = data.get("command") if isinstance(data, dict) else None
        args = data.get("args") if isinstance(data, dict) else None
        if command != "docker" or not isinstance(args, list):
            continue
        image, env_keys = parse_docker_run_image_and_envs(args)
        if not image:
            continue
        images.add(image)
        expected = {key for key in env_keys if key in sensitive_keys or is_sensitive_key(key)}
        image_expected_env.setdefault(image, set()).update(expected)
    return images, image_expected_env, compat_plaintext_oauth


def load_running_containers():
    ps = run_cmd([DOCKER_BIN, "ps", "--format", "{{.ID}}"], check=True)
    ids = [line.strip() for line in ps.stdout.splitlines() if line.strip()]
    if not ids:
        return []
    inspected = run_cmd([DOCKER_BIN, "inspect", *ids], check=True)
    try:
        data = json.loads(inspected.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"docker inspect returned invalid JSON: {error}")
    if isinstance(data, dict):
        return [data]
    return data


def container_name(container):
    return str(container.get("Name") or "").lstrip("/")


def container_image(container):
    config = container.get("Config") or {}
    return str(config.get("Image") or container.get("Image") or "")


def classify_container(container, mcp_child_images):
    labels = ((container.get("Config") or {}).get("Labels") or {})
    name = container_name(container)
    image = container_image(container)
    if labels.get("com.portico.ai-chat.image-role") == "agent-vm" or name.startswith("agent-vm-"):
        return "agent-vm"
    if labels.get("com.docker.compose.project") == "portico":
        return "first-party"
    if name in FIRST_PARTY_NAMES or name.startswith("mcpo-"):
        return "first-party"
    if image in mcp_child_images:
        return "mcp-child"
    return ""


def iter_port_bindings(container):
    ports = ((container.get("NetworkSettings") or {}).get("Ports") or {})
    for container_port, bindings in sorted(ports.items()):
        if not bindings:
            yield container_port, None, None
            continue
        for binding in bindings:
            yield container_port, str(binding.get("HostIp") or ""), str(binding.get("HostPort") or "")


def mount_list(container):
    mounts = container.get("Mounts") or []
    if not isinstance(mounts, list):
        return []
    return mounts


def mount_source(mount):
    return str(mount.get("Source") or "")


def mount_dest(mount):
    return str(mount.get("Destination") or "")


def mount_is_rw(mount):
    return bool(mount.get("RW"))


def path_matches_mount(source, target):
    try:
        return Path(source).resolve() == Path(target).resolve()
    except Exception:
        return source == str(target)


def command_basename(command):
    return Path(str(command)).name


def sanitize_server_id(server_id):
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in str(server_id))


def package_dir(root, package_name):
    path = Path(root) / "node_modules"
    for part in str(package_name).split("/"):
        if part:
            path = path / part
    return path


def mounted_path_for_container_path(mounts, container_path):
    normalized = str(container_path)
    best = None
    for mount in mounts:
        dest = mount_dest(mount).rstrip("/")
        source = mount_source(mount)
        if not dest or not source:
            continue
        if normalized == dest or normalized.startswith(dest + "/"):
            if best is None or len(dest) > len(best[0]):
                suffix = normalized[len(dest) :].lstrip("/")
                best = (dest, Path(source) / suffix, mount)
    return best


def unsafe_package_url(value):
    if isinstance(value, str):
        try:
            parsed = urlparse(value)
        except Exception:
            return None
        if parsed.scheme in {"http", "https"} and parsed.hostname:
            if parsed.scheme != "https" or parsed.username is not None or parsed.password is not None:
                return value
    return None


def first_unsafe_lock_resolved_url(value):
    if isinstance(value, list):
        for entry in value:
            unsafe_url = first_unsafe_lock_resolved_url(entry)
            if unsafe_url:
                return unsafe_url
    if isinstance(value, dict):
        unsafe_url = unsafe_package_url(value.get("resolved"))
        if unsafe_url:
            return unsafe_url
        for entry in value.values():
            unsafe_url = first_unsafe_lock_resolved_url(entry)
            if unsafe_url:
                return unsafe_url
    return None


def managed_node_config_host_paths(mounts):
    paths = []
    for mount in mounts:
        source = mount_source(mount)
        dest = mount_dest(mount)
        if not source:
            continue
        source_path = Path(source)
        if dest == "/app/mcp_config.json" and source_path.is_file():
            paths.append((source_path, True))
        elif dest == "/app/mcpo-configs-generated" and source_path.is_dir():
            paths.extend((path, False) for path in sorted(source_path.glob("*.json")) if not path.name.startswith(".tmp."))
    return paths


def audit_managed_node_config(container, mounts):
    name = container_name(container)
    store_mount = next((mount for mount in mounts if mount_dest(mount) == MANAGED_NODE_STORE_DEST), None)
    store_source = Path(mount_source(store_mount)) if store_mount and mount_source(store_mount) else None
    for config_path, enforce_runtime_store in managed_node_config_host_paths(mounts):
        try:
            data = json.loads(config_path.read_text(errors="ignore"))
        except Exception:
            continue
        servers = data.get("mcpServers") if isinstance(data, dict) else None
        if not isinstance(servers, dict):
            continue
        for server_id, server_config in sorted(servers.items()):
            if not isinstance(server_config, dict):
                continue
            command = str(server_config.get("command") or "")
            command_name = command_basename(command)
            if command_name in PACKAGE_MANAGER_COMMANDS:
                audit.report("RED", f"{name}: generated MCP config {config_path.name}:{server_id} uses raw package-manager command {command_name}")
                continue
            managed = server_config.get(MANAGED_NODE_PACKAGE_KEY)
            if command == MANAGED_NODE_SENTINEL_COMMAND and not isinstance(managed, dict):
                audit.report("RED", f"{name}: generated MCP config {config_path.name}:{server_id} uses managed Node sentinel without metadata")
                continue
            if not isinstance(managed, dict):
                continue
            if not enforce_runtime_store:
                continue
            if command != MANAGED_NODE_SENTINEL_COMMAND:
                audit.report("RED", f"{name}: generated MCP config {config_path.name}:{server_id} has managed Node metadata without sentinel command")
            if store_mount is None or store_source is None:
                audit.report("RED", f"{name}: managed Node MCP {server_id} is missing the managed package store mount")
                continue
            if mount_is_rw(store_mount):
                audit.report("RED", f"{name}: managed Node package store is writable at {MANAGED_NODE_STORE_DEST}")

            metadata_server_id = str(managed.get("server_id") or server_id)
            package_name = str(managed.get("package_name") or "")
            if not package_name:
                audit.report("RED", f"{name}: managed Node MCP {server_id} metadata is missing package_name")
                continue
            install_root = managed.get("install_dir")
            if install_root:
                mapped = mounted_path_for_container_path(mounts, str(install_root))
                host_install_root = mapped[1] if mapped else None
            else:
                host_install_root = store_source / sanitize_server_id(metadata_server_id) / "package"
            if host_install_root is None:
                audit.report("RED", f"{name}: managed Node MCP {server_id} install_dir is not backed by a mounted host path")
                continue
            package_json_path = package_dir(host_install_root, package_name) / "package.json"
            if not package_json_path.is_file():
                audit.report("RED", f"{name}: managed Node MCP {server_id} package is not prepared at {package_json_path}")
                continue
            try:
                package_json = json.loads(package_json_path.read_text(errors="ignore"))
            except Exception:
                audit.report("RED", f"{name}: managed Node MCP {server_id} package.json is not valid JSON")
                continue
            installed_name = package_json.get("name") if isinstance(package_json, dict) else None
            if installed_name and installed_name != package_name:
                audit.report("RED", f"{name}: managed Node MCP {server_id} package mismatch: expected {package_name}, got {installed_name}")
            package_lock_path = Path(host_install_root) / "package-lock.json"
            if package_lock_path.is_file():
                try:
                    package_lock = json.loads(package_lock_path.read_text(errors="ignore"))
                except Exception:
                    audit.report("RED", f"{name}: managed Node MCP {server_id} package-lock.json is not valid JSON")
                    continue
                unsafe_url = first_unsafe_lock_resolved_url(package_lock)
                if unsafe_url:
                    audit.report("RED", f"{name}: managed Node MCP {server_id} package-lock contains an insecure or credential-bearing resolved URL")
            audit.info(f"  managed Node audit: {name}: {server_id} uses prepared package {package_name}")


def container_has_public_port(container):
    for _, host_ip, host_port in iter_port_bindings(container):
        if host_port and not is_loopback_host(host_ip):
            return True
    return False


def container_has_broad_mount(container):
    for mount in mount_list(container):
        source = mount_source(mount)
        if not source:
            continue
        try:
            resolved = Path(source).resolve()
        except Exception:
            continue
        if resolved == Path("/") or resolved == HOME or resolved == PROJECT_ROOT:
            return True
        if any(part in {".ssh", ".aws", "Keychains"} for part in resolved.parts):
            return True
    return False


def sensitive_runtime_file_for_mount(source, dest, sensitive_runtime_files):
    for descriptor in sensitive_runtime_files:
        if dest == descriptor["target"]:
            return descriptor
    return None


def path_mentions_legacy_oauth_store(path):
    if not path:
        return False
    text = str(path)
    parts = set(Path(text).parts)
    return any(name in parts or name in text for name in LEGACY_OAUTH_STORE_NAMES)


def source_is_runtime_secret_cache_file(source):
    if not source:
        return False
    try:
        resolved = Path(source).resolve()
    except Exception:
        return False
    for cache_dir in runtime_secret_cache_dirs():
        try:
            cache_root = cache_dir.resolve()
        except Exception:
            cache_root = cache_dir
        if resolved == cache_root or cache_root in resolved.parents:
            return True
    return False


def audit_container(container, container_class, image_expected_env, sensitive_runtime_files):
    name = container_name(container)
    image = container_image(container)
    env_entries = list(((container.get("Config") or {}).get("Env") or []))
    env_keys = [parse_env_key(entry) for entry in env_entries]
    static_secret_targets, static_secret_token_envs = parse_static_secret_targets(env_entries)
    mounts = mount_list(container)
    secret_dests = {mount_dest(mount) for mount in mounts if mount_dest(mount).startswith("/run/secrets/")}
    public_port = container_has_public_port(container)
    broad_mount = container_has_broad_mount(container)

    port_rows = []
    for container_port, host_ip, host_port in iter_port_bindings(container):
        if host_port is None:
            port_rows.append(["-", "-", container_port, "container-only"])
            continue
        host = host_ip or "0.0.0.0"
        exposure = "loopback" if is_loopback_host(host_ip) else "public"
        port_rows.append([host, host_port, container_port, exposure])
        if not is_loopback_host(host_ip):
            audit.report("RED", f"{name}: public host port binding {host}:{host_port}->{container_port}")

    mount_rows = []
    secret_rows = []
    for mount in mounts:
        source = mount_source(mount)
        dest = mount_dest(mount)
        mode = str(mount.get("Mode") or ("rw" if mount_is_rw(mount) else "ro"))
        rw_label = "rw" if mount_is_rw(mount) else "ro"
        sensitive_runtime_file = sensitive_runtime_file_for_mount(source, dest, sensitive_runtime_files)
        is_secret_mount = dest.startswith("/run/secrets/") or sensitive_runtime_file is not None
        mount_rows.append([source or "<anonymous>", dest, rw_label, mode, "yes" if is_secret_mount else "no"])
        if dest in LEGACY_OAUTH_MOUNT_TARGETS or path_mentions_legacy_oauth_store(source) or path_mentions_legacy_oauth_store(dest):
            audit.report("RED", f"{name}: legacy OAuth token store mount at {dest}; migrate OAuth state to Electron safeStorage and remove .mcpo/mcpo-oauth-tokens mounts")
        if dest == MANAGED_NODE_STORE_DEST and mount_is_rw(mount):
            audit.report("RED", f"{name}: managed Node package store {dest} is writable")
        if MANAGED_NODE_ACQUISITION_FRAGMENT in source or MANAGED_NODE_ACQUISITION_FRAGMENT in dest:
            audit.report("RED", f"{name}: managed Node acquisition scratch/cache is mounted at {dest}")
        if is_secret_mount:
            secret_rows.append([source or "<anonymous>", dest, rw_label])
            if mount_is_rw(mount):
                audit.report("RED", f"{name}: secret mount {dest} is writable")
            if source == "/dev/null":
                audit.report("RED", f"{name}: secret mount {dest} is backed by /dev/null")
            if source and Path(source).exists() and Path(source).is_file() and is_group_or_world_accessible(Path(source)):
                audit.report("RED", f"{name}: secret source file for {dest} has overly broad permissions ({mode_string(Path(source))})")
            if sensitive_runtime_file is not None:
                if source and path_matches_mount(source, sensitive_runtime_file["source_path"]):
                    audit.report("RED", f"{name}: sensitive runtime file {dest} is mounted directly from {sensitive_runtime_file['source']}")
                elif source and source_is_runtime_secret_cache_file(source):
                    audit.report("RED", f"{name}: sensitive runtime file {dest} is still mounted from the host runtime secret cache; use scoped broker materialization into container-internal tmpfs")
                elif source and not source_is_runtime_secret_cache_file(source):
                    audit.report("RED", f"{name}: sensitive runtime file {dest} is not broker-materialized into container-internal tmpfs")
                elif source and Path(source).name != sensitive_runtime_file["secret_name"]:
                    audit.report("RED", f"{name}: sensitive runtime file {dest} uses unexpected secret source {Path(source).name}")
        if source:
            source_name = Path(source).name
            if source_name in SECRET_FILE_NAMES:
                audit.report("RED", f"{name}: project secret-like file {source_name} is mounted at {dest}")
            if source == "/var/run/docker.sock" or dest == "/var/run/docker.sock":
                if name != "docker-socket-proxy":
                    audit.report("RED", f"{name}: direct Docker socket mount is only allowed for docker-socket-proxy")

    for entry in env_entries:
        key = parse_env_key(entry)
        value = parse_env_value(entry)
        if is_forbidden_runtime_package_manager_env_key(key):
            audit.report("RED", f"{name}: package-manager credential/config env key {key} is present")
            continue
        if key.endswith("_FILE"):
            base_key = secret_base_from_file_key(key)
            if value.startswith("/run/secrets/") and value not in secret_dests:
                audit.report("RED", f"{name}: {key} points at {value}, but the matching secret mount is absent")
            elif is_sensitive_key(base_key) and value and not value.startswith("/run/secrets/"):
                if is_broker_materialized_file_pointer(value, static_secret_targets):
                    audit.info(f"  {name}: sensitive file pointer {key} uses scoped broker materialization at {value}")
                else:
                    audit.report("RED", f"{name}: sensitive file pointer {key} does not use /run/secrets or scoped broker materialization")
            continue
        if not value or not should_treat_env_key_as_sensitive(name, container_class, key):
            continue
        if is_scoped_broker_token_env_key(key, static_secret_token_envs):
            audit.info(f"  {name}: scoped broker token env key {key} is present")
            continue
        if key in LEGACY_SLACK_TOKEN_ENV_KEYS:
            audit.report("RED", f"{name}: legacy Slack OAuth token env key {key} is present")
            continue
        if container_class == "mcp-child":
            expected = image_expected_env.get(image, set())
            if key in expected and not public_port and not broad_mount:
                audit.info(f"  {name}: owning MCP child env key {key} is present for image {image}")
            else:
                audit.report("RED", f"{name}: raw sensitive env key {key} is present")
        else:
            audit.report("RED", f"{name}: raw sensitive env key {key} is present")

    if container_class == "mcp-child" and broad_mount:
        audit.report("RED", f"{name}: MCP child container has a broad host filesystem mount")

    lines = [
        f"Container: {name} [{container_class}]",
        f"  Image: {image}",
    ]
    append_section(lines, "Ports", ["Host", "Host port", "Container port", "Exposure"], port_rows)
    append_section(lines, "Mounts", ["Host source", "Container target", "Access", "Mode", "Secret"], mount_rows)
    append_section(lines, "Secret Mounts", ["Host source", "Secret target", "Access"], secret_rows)
    append_section(lines, "Env Keys", ["Key", "Key", "Key", "Key"], env_key_rows(env_keys))
    audit.container_info(lines)
    audit_managed_node_config(container, mounts)


def npm_registry_for_container(container_id):
    result = run_cmd([DOCKER_BIN, "exec", container_id, "sh", "-lc", "command -v npm >/dev/null 2>&1"])
    if result.returncode != 0:
        return None, "missing-npm"
    registry = run_cmd([DOCKER_BIN, "exec", container_id, "sh", "-lc", "npm config get registry 2>/dev/null || true"])
    value = registry.stdout.strip().splitlines()[-1].strip() if registry.stdout.strip() else ""
    return value, ""


def audit_npm(container):
    name = container_name(container)
    cid = str(container.get("Id") or container.get("ID") or name)
    registry, reason = npm_registry_for_container(cid)
    if reason == "missing-npm":
        audit.info(f"  npm audit: {name}: npm is not installed, skipping install probe")
        return
    if not registry:
        audit.report("YELLOW", f"{name}: npm registry could not be resolved")
        return
    if not is_allowed_npm_registry(registry):
        audit.report("RED", f"{name}: npm registry must use HTTPS without embedded credentials ({registry})")
        return

    install_script = r'''
set -eu
tmp="$(mktemp -d /tmp/portico-npm-audit.XXXXXX)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
cd "$tmp"
printf '{}\n' > package.json
log="$tmp/npm-install.log"
npm_install_status=0
NPM_CONFIG_CACHE="$tmp/.npm" npm install --ignore-scripts --no-audit --no-fund --package-lock-only is-number@7.0.0 >"$log" 2>&1 || npm_install_status=$?
if [ "$npm_install_status" -eq 0 ]; then
  exit 40
fi
if grep -R -E '(E401|E403|401 Unauthorized|403 Forbidden|Incorrect or missing password)' "$tmp" >/dev/null 2>&1; then
  exit 43
fi
exit 41
'''
    result = run_cmd([DOCKER_BIN, "exec", cid, "sh", "-lc", install_script])
    if result.returncode == 40:
        audit.info(f"  npm audit: {name}: configured HTTPS registry is reachable ({registry}); managed package validation remains the acquisition control")
    elif result.returncode == 43:
        audit.info(f"  npm audit: {name}: runtime install denied by configured registry {registry} (no runtime npm credentials)")
    else:
        audit.report("YELLOW", f"{name}: runtime npm install probe was inconclusive against configured registry {registry}")


def default_runtime_secret_cache_dir():
    override = os.environ.get("PORTICO_RUNTIME_SECRET_CACHE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return HOME / "Library" / "Caches" / "portico" / "runtime-secrets"
    return Path(os.environ.get("XDG_STATE_HOME", str(HOME / ".local" / "state"))) / "portico" / "runtime-secrets"


def runtime_secret_cache_dirs():
    candidates = [
        default_runtime_secret_cache_dir(),
        PROJECT_ROOT / "open-webui-data" / "runtime-secrets",
    ]
    seen = set()
    unique = []
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def audit_runtime_secret_cache(has_first_party):
    default_cache_dir = default_runtime_secret_cache_dir()
    for cache_dir in runtime_secret_cache_dirs():
        if not cache_dir.exists():
            if has_first_party and cache_dir == default_cache_dir:
                audit.report("YELLOW", f"runtime secret cache directory is absent: {cache_dir}")
            continue
        if not cache_dir.is_dir():
            audit.report("RED", f"runtime secret cache path is not a directory: {cache_dir}")
            continue
        if is_group_or_world_accessible(cache_dir):
            audit.report("RED", f"runtime secret cache directory has overly broad permissions ({mode_string(cache_dir)}): {cache_dir}")
        for path in sorted(cache_dir.rglob("*")):
            if not path.is_file():
                continue
            if is_group_or_world_accessible(path):
                audit.report("RED", f"runtime secret cache file has overly broad permissions ({mode_string(path)}): {path}")
        audit.info(f"Runtime secret cache inspected: {cache_dir}")


def audit_oauth_token_stores(containers):
    candidates = {PROJECT_ROOT / "mcpo-oauth-tokens", PROJECT_ROOT / "mcpo-core-oauth-tokens"}
    for container in containers:
        for mount in mount_list(container):
            dest = mount_dest(mount)
            source = mount_source(mount)
            if source and (dest in LEGACY_OAUTH_MOUNT_TARGETS or path_mentions_legacy_oauth_store(source)):
                candidates.add(Path(source))
    for root in sorted(candidates):
        if not root.exists():
            continue
        audit.report("RED", f"legacy OAuth token store present; migrate OAuth state to Electron safeStorage and remove {root}")
        if root.is_dir() and is_group_or_world_accessible(root):
            audit.report("RED", f"OAuth token store directory has overly broad permissions ({mode_string(root)}): {root}")
        token_files = sorted(list(root.rglob("*_tokens.json")) + list(root.rglob("*_client.json")))
        for path in token_files:
            audit.report("RED", f"legacy OAuth token/client file present; migrate OAuth state to Electron safeStorage and remove {path}")
            if is_group_or_world_accessible(path):
                audit.report("RED", f"OAuth token file has overly broad permissions ({mode_string(path)}): {path}")
            try:
                json.loads(path.read_text())
            except Exception:
                audit.report("RED", f"OAuth token file is not valid JSON: {path}")


def parse_env_file_keys(path):
    keys = []
    for raw_line in path.read_text(errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not match:
            continue
        key, raw_value = match.groups()
        value = raw_value.strip().strip('"').strip("'")
        if value:
            keys.append(key)
    return keys


def env_files_to_scan():
    paths = set()
    for candidate in PROJECT_ROOT.glob(".env*"):
        if candidate.is_file():
            paths.add(candidate)
    for name in ["env.runtime", "runtime-secrets.env", "cloudsmith.env"]:
        candidate = PROJECT_ROOT / name
        if candidate.is_file():
            paths.add(candidate)
    for name in ["runtime-secrets.env", ".env", ".env.runtime", "env.runtime", "cloudsmith.env"]:
        candidate = APP_SUPPORT_DIR / name
        if candidate.is_file():
            paths.add(candidate)
    return sorted(paths)


def is_protected_repository_operator_key(path, key):
    """Allow the release API key only in a source checkout's root .env.

    Managed-root and Application Support copies remain audit findings. The
    .git check is the boundary between user-supplied release operator input
    and installed-app bootstrap/runtime state.
    """
    if key != "CLOUDSMITH_API_KEY" or path.name != ".env":
        return False
    try:
        return path.resolve() == (PROJECT_ROOT / ".env").resolve() and (PROJECT_ROOT / ".git").exists()
    except Exception:
        return False


def audit_env_files(containers, sensitive_keys):
    mounted_sources = []
    raw_env_keys = set()
    for container in containers:
        for mount in mount_list(container):
            if mount_source(mount):
                mounted_sources.append(mount_source(mount))
        for entry in ((container.get("Config") or {}).get("Env") or []):
            if parse_env_value(entry):
                raw_env_keys.add(parse_env_key(entry))
    for path in env_files_to_scan():
        parsed_keys = parse_env_file_keys(path)
        protected_operator_keys = [
            key for key in parsed_keys
            if is_protected_repository_operator_key(path, key)
        ]
        keys = [
            key for key in parsed_keys
            if (key in sensitive_keys or is_sensitive_key(key))
            and key not in protected_operator_keys
        ]
        if protected_operator_keys:
            audit.info(f"  protected repository operator input present: {path}: CLOUDSMITH_API_KEY")
        if not keys:
            continue
        key_list = ", ".join(sorted(set(keys)))
        mounted = any(path_matches_mount(source, path) for source in mounted_sources)
        delivered = any(key in raw_env_keys for key in keys)
        if path.name == "cloudsmith.env" and not mounted and not delivered:
            audit.report("YELLOW", f"{path}: dev-only/cloudsmith sensitive key names present: {key_list}")
        else:
            audit.report("RED", f"{path}: sensitive key names present: {key_list}")


def audit_stale_single_server_ssl(containers):
    ssl_dir = HOME / "Library" / "Caches" / "portico" / "single-server-ssl"
    key_path = ssl_dir / "oauth.key"
    if not key_path.exists():
        return
    mounted_sources = []
    for container in containers:
        for mount in mount_list(container):
            if mount_source(mount):
                mounted_sources.append(mount_source(mount))
    mounted = any(path_matches_mount(source, key_path) or path_matches_mount(source, ssl_dir) for source in mounted_sources)
    if mounted:
        audit.report("RED", f"obsolete single-server SSL private key material is mounted from {key_path}")
    else:
        audit.report("YELLOW", f"obsolete single-server SSL private key material remains on disk: {key_path}")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP_OPENER = urllib.request.build_opener(NoRedirectHandler)


def env_flag_enabled(name, default=True):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def enabled_probe_ids(env_name, known_ids):
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return set(known_ids)
    return {entry.strip() for entry in raw.split(",") if entry.strip()}


def redacted_url(url):
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return url
    port = f":{parsed.port}" if parsed.port else ""
    path = parsed.path or "/"
    return f"{parsed.scheme}://{parsed.hostname}{port}{path}"


def build_probe_request(probe, url):
    payload = None
    if "json" in probe:
        payload = json.dumps(probe["json"]).encode("utf-8")
    headers = {
        "User-Agent": "Portico-Security-Audit",
        **probe.get("headers", {}),
    }
    return urllib.request.Request(
        url,
        data=payload,
        headers=headers,
        method=probe.get("method", "GET"),
    )


def is_http_probe_disconnect(error):
    if isinstance(error, HTTP_PROBE_DISCONNECT_ERRORS):
        return True
    reason = getattr(error, "reason", None)
    return isinstance(reason, HTTP_PROBE_DISCONNECT_ERRORS)


def run_http_auth_probe(probe, timeout):
    url = os.environ.get(probe["url_env"], probe["default_url"]).strip()
    if not url:
        audit.info(f"  HTTP auth probe: {probe['label']}: disabled because {probe['url_env']} is empty")
        return
    try:
        request = build_probe_request(probe, url)
        with HTTP_OPENER.open(request, timeout=timeout) as response:
            status = int(response.getcode())
    except urllib.error.HTTPError as error:
        status = int(error.code)
    except urllib.error.URLError as error:
        if is_http_probe_disconnect(error):
            audit.info(f"  HTTP auth probe: {probe['label']}: connection closed without an unauthenticated HTTP response at {redacted_url(url)} ({error.reason})")
            return
        audit.info(f"  HTTP auth probe: {probe['label']}: not listening at {redacted_url(url)} ({error.reason})")
        return
    except TimeoutError:
        audit.report("YELLOW", f"{probe['label']}: HTTP auth probe timed out at {redacted_url(url)}")
        return
    except Exception as error:
        if is_http_probe_disconnect(error):
            audit.info(f"  HTTP auth probe: {probe['label']}: connection closed without an unauthenticated HTTP response at {redacted_url(url)} ({error})")
            return
        audit.report("YELLOW", f"{probe['label']}: HTTP auth probe failed at {redacted_url(url)}: {error}")
        return

    if probe.get("loopback_metadata"):
        parsed = urlparse(url)
        if not is_loopback_host(parsed.hostname or ""):
            audit.report("RED", f"{probe['label']}: unauthenticated metadata probe is configured for non-loopback URL {redacted_url(url)}")
            return
        if 200 <= status < 400:
            audit.info(f"  HTTP auth probe: {probe['label']}: loopback metadata endpoint reachable with HTTP {status}")
            return
        if status in HTTP_AUTH_REJECTION_STATUSES:
            audit.info(f"  HTTP auth probe: {probe['label']}: loopback metadata endpoint rejected unauthenticated request with HTTP {status}")
            return
        if status in {404, 405}:
            audit.info(f"  HTTP auth probe: {probe['label']}: loopback metadata endpoint returned HTTP {status}")
            return
        audit.report("YELLOW", f"{probe['label']}: loopback metadata probe returned inconclusive HTTP {status} at {redacted_url(url)}")
        return

    accepted = set(probe.get("accepted_statuses") or HTTP_AUTH_REJECTION_STATUSES)
    if probe.get("allow_auth_redirect"):
        accepted |= HTTP_AUTH_REDIRECT_STATUSES
    if status in accepted:
        audit.info(f"  HTTP auth probe: {probe['label']}: unauthenticated request rejected with HTTP {status}")
        return
    if 200 <= status < 400:
        audit.report("RED", f"{probe['label']}: unauthenticated HTTP probe reached {redacted_url(url)} with HTTP {status}; service must reject requests without an auth token")
        return
    if status in {404, 405}:
        audit.report("YELLOW", f"{probe['label']}: HTTP auth probe endpoint returned HTTP {status} at {redacted_url(url)}; audit could not prove an auth gate")
        return
    audit.report("YELLOW", f"{probe['label']}: HTTP auth probe returned inconclusive HTTP {status} at {redacted_url(url)}")


def audit_http_auth_probes():
    if not env_flag_enabled("portico_SECURITY_AUDIT_HTTP_PROBES", default=True):
        audit.info("HTTP auth probes disabled by portico_SECURITY_AUDIT_HTTP_PROBES=0")
        return
    enabled_ids = enabled_probe_ids("portico_SECURITY_AUDIT_HTTP_PROBE_IDS", [probe["id"] for probe in HTTP_AUTH_PROBES])
    try:
        timeout = max(0.1, float(os.environ.get("portico_SECURITY_AUDIT_HTTP_TIMEOUT_SECONDS", "1.5")))
    except ValueError:
        timeout = 1.5
    for probe in HTTP_AUTH_PROBES:
        if probe["id"] not in enabled_ids:
            continue
        run_http_auth_probe(probe, timeout)


def listener_host_is_public(host):
    normalized = str(host or "").strip().strip("[]")
    if normalized in {"*", "0.0.0.0", "::", ":::*"}:
        return True
    return not is_loopback_host(normalized)


def parse_lsof_listener(line):
    parts = line.split()
    if len(parts) < 2:
        return None
    if parts[-1] == "(LISTEN)" and len(parts) >= 2:
        name = parts[-2]
    else:
        name = parts[-1]
    if ":" not in name:
        return None
    host, port = name.rsplit(":", 1)
    if not port.isdigit():
        return None
    return host, int(port)


def audit_host_listener_bindings():
    if not env_flag_enabled("portico_SECURITY_AUDIT_SOCKET_BINDINGS", default=True):
        audit.info("Host listener binding probes disabled by portico_SECURITY_AUDIT_SOCKET_BINDINGS=0")
        return
    lsof_bin = shutil.which(os.environ.get("portico_SECURITY_AUDIT_LSOF_BIN", "lsof"))
    if not lsof_bin:
        audit.report("YELLOW", "lsof is unavailable; host listener binding audit could not run")
        return
    result = run_cmd([lsof_bin, "-nP", "-iTCP", "-sTCP:LISTEN"])
    if result.returncode != 0:
        audit.report("YELLOW", "lsof listener audit failed; host listener binding audit could not run")
        return
    targets = dict(HOST_LISTENER_TARGETS)
    seen = set()
    for line in result.stdout.splitlines()[1:]:
        parsed = parse_lsof_listener(line)
        if not parsed:
            continue
        host, port = parsed
        label = targets.get(port)
        if not label:
            continue
        seen.add(port)
        if listener_host_is_public(host):
            audit.report("RED", f"{label}: host listener is not loopback-only ({host}:{port})")
        else:
            audit.info(f"  host listener audit: {label}: loopback-only listener {host}:{port}")
    for label, port in HOST_LISTENER_TARGETS:
        if port not in seen:
            audit.info(f"  host listener audit: {label}: no listener found on port {port}")


def main():
    try:
        sensitive_required = discover_sensitive_required_env_vars()
        sensitive_runtime_files = discover_sensitive_runtime_files()
        sensitive_keys = set(RUNTIME_SECRET_KEYS) | sensitive_required
        child_images, image_expected_env, compat_plaintext_oauth = discover_mcp_child_config(sensitive_keys)
        all_containers = load_running_containers()
    except Exception as error:
        print("SECURITY AUDIT RESULT: RED")
        print(f"[RED] audit execution failure: {error}")
        return 3

    audited = []
    for container in all_containers:
        container_class = classify_container(container, child_images)
        if not container_class:
            continue
        audited.append((container, container_class))

    if not audited:
        audit.report("YELLOW", "no running Portico Docker containers were discovered")

    for fragment, env_name in compat_plaintext_oauth:
        audit.report("YELLOW", f"{fragment}: OAuth access token compatibility path uses child env key {env_name}")

    for container, container_class in audited:
        audit_container(container, container_class, image_expected_env, sensitive_runtime_files)

    for container, container_class in audited:
        name = container_name(container)
        if container_class == "mcp-child" or name == "mcpo" or name == "mcpo-core" or name.startswith("mcpo-"):
            audit_npm(container)

    audited_containers = [container for container, _ in audited]
    audit_runtime_secret_cache(any(container_class == "first-party" for _, container_class in audited))
    audit_oauth_token_stores(audited_containers)
    audit_env_files(audited_containers, set(RUNTIME_SECRET_KEYS) | sensitive_required)
    audit_stale_single_server_ssl(audited_containers)
    audit_http_auth_probes()
    audit_host_listener_bindings()

    result = "GREEN" if audit.max_severity == 0 else ("YELLOW" if audit.max_severity == 1 else "RED")
    print(f"SECURITY AUDIT RESULT: {result}")
    print()
    print("Audited containers:")
    if audit.container_sections:
        for index, section in enumerate(audit.container_sections):
            if index:
                print()
            for line in section:
                print(line)
    else:
        print("- none")
    print()
    print("Audit notes:")
    if audit.notes:
        for note in audit.notes:
            print(f"- {note}")
    else:
        print("- none")
    print()
    print("Findings:")
    if audit.findings:
        for severity, message in audit.findings:
            print(f"[{severity}] {message}")
    else:
        print("[GREEN] no leaks or posture regressions detected")
    return audit.exit_code()


if __name__ == "__main__":
    sys.exit(main())
PY
