#!/usr/bin/env python3
import argparse
import json
import shutil
from pathlib import Path


def ensure_oauth_symlink(home_dir: Path, oauth_storage_dir: Path) -> None:
    home_dir.mkdir(parents=True, exist_ok=True)
    oauth_storage_dir.mkdir(parents=True, exist_ok=True)
    target = home_dir / ".mcpo"

    if target.is_symlink() or target.exists():
        if target.is_symlink() and target.resolve() == oauth_storage_dir.resolve():
            return
        if target.is_dir() and target.resolve() == oauth_storage_dir.resolve():
            return
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink(missing_ok=True)

    target.symlink_to(oauth_storage_dir)


def supervisor_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def render_program(index: int, server: dict, home_root: Path) -> str:
    server_id = str(server["id"])
    port = int(server["port"])
    config_file = str(server["config_file"])
    oauth_storage_dir = Path(str(server["oauth_storage_dir"]))
    home_dir = home_root / server_id
    ensure_oauth_symlink(home_dir, oauth_storage_dir)

    env_parts = [
        f'CONFIG_FILE="{supervisor_escape(config_file)}"',
        f'MCPO_PORT="{port}"',
        f'HOME="{supervisor_escape(str(home_dir))}"',
    ]

    return f"""[program:mcpo_{server_id.replace('-', '_')}]
command=/app/start-mcpo.sh
directory=/app
autostart=true
autorestart=true
startsecs=2
startretries=10
stopsignal=TERM
stopasgroup=true
killasgroup=true
priority={10 + index}
environment={",".join(env_parts)}
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--home-root", required=True)
    args = parser.parse_args()

    targets_path = Path(args.targets)
    output_path = Path(args.output)
    home_root = Path(args.home_root)
    home_root.mkdir(parents=True, exist_ok=True)

    data = json.loads(targets_path.read_text())
    servers = data.get("servers") or []
    if not servers:
        raise SystemExit(f"No servers defined in {targets_path}")

    header = """[unix_http_server]
file=/tmp/supervisor-mcpo-multi.sock
chmod=0700

[supervisord]
nodaemon=true
logfile=/dev/null
pidfile=/tmp/supervisord-mcpo-multi.pid
childlogdir=/tmp

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///tmp/supervisor-mcpo-multi.sock

"""

    programs = [render_program(index, server, home_root) for index, server in enumerate(servers)]
    output_path.write_text(header + "\n".join(programs))


if __name__ == "__main__":
    main()
