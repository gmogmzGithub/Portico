from __future__ import annotations

import sys
from importlib import metadata
from pathlib import Path


FORBIDDEN_DISTRIBUTIONS = {
    "matplotlib",
    "numpy",
    "pandas",
    "regex",
    "scikit-learn",
    "scipy",
    "seaborn",
    "sympy",
    "tiktoken",
}

FORBIDDEN_FRONTEND_MARKERS = (
    "PyodideWorker",
    "executePythonAsWorker",
    "formatPythonCodePyodide",
    "pyodide.worker",
)

TEXT_FILE_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".json",
    ".map",
    ".mjs",
    ".txt",
}


def normalize_dist_name(name: str) -> str:
    return name.lower().replace("_", "-")


def find_forbidden_distributions() -> list[str]:
    installed = {
        normalize_dist_name(dist.metadata.get("Name", ""))
        for dist in metadata.distributions()
        if dist.metadata.get("Name")
    }
    return sorted(installed & FORBIDDEN_DISTRIBUTIONS)


def find_frontend_violations(build_root: Path) -> list[str]:
    violations: list[str] = []

    for path in sorted(build_root.rglob("*pyodide*")):
        if path.is_file():
            violations.append(f"forbidden pyodide asset: {path}")

    for path in sorted(build_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TEXT_FILE_SUFFIXES:
            continue

        text = path.read_text(errors="ignore")
        for marker in FORBIDDEN_FRONTEND_MARKERS:
            if marker in text:
                violations.append(f"forbidden frontend marker {marker!r} in {path}")

    return violations


def main() -> int:
    app_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/app")
    build_root = app_root / "build"

    errors: list[str] = []

    forbidden_distributions = find_forbidden_distributions()
    if forbidden_distributions:
        errors.append(
            "forbidden Python distributions installed: "
            + ", ".join(forbidden_distributions)
        )

    if build_root.exists():
        errors.extend(find_frontend_violations(build_root))

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    print("Open WebUI runtime guard passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
