#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
WHITESPACE_RE = re.compile(r"\s+")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract and compact relevant sections from a markdown document."
    )
    parser.add_argument("--input", required=True, help="Markdown file path.")
    parser.add_argument("--output", help="Path to write compact JSON.")
    parser.add_argument(
        "--query",
        action="append",
        default=[],
        help="Keyword to match against headings or section content. May be repeated.",
    )
    parser.add_argument("--max-sections", type=int, default=6)
    parser.add_argument("--content-chars", type=int, default=900)
    return parser.parse_args()


def collapse(text: str) -> str:
    return WHITESPACE_RE.sub(" ", text).strip()


def trim(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3].rstrip() + "..."


def parse_sections(text: str) -> list[dict]:
    sections = []
    current = {"heading": "Document Start", "level": 0, "lines": []}
    for raw_line in text.splitlines():
        match = HEADING_RE.match(raw_line)
        if match:
            if current["lines"]:
                sections.append(current)
            current = {
                "heading": collapse(match.group(2)) or "Untitled",
                "level": len(match.group(1)),
                "lines": [],
            }
        else:
            if raw_line.strip():
                current["lines"].append(raw_line.rstrip())
    if current["lines"]:
        sections.append(current)
    return sections


def matches(section: dict, queries: list[str]) -> bool:
    if not queries:
        return True
    haystack = " ".join([section.get("heading", ""), "\n".join(section.get("lines", []))]).lower()
    return any(query in haystack for query in queries)


def compact_sections(text: str, args: argparse.Namespace) -> dict:
    queries = [query.lower().strip() for query in args.query if query.strip()]
    sections = []
    for section in parse_sections(text):
        if not matches(section, queries):
            continue
        sections.append(
            {
                "heading": section["heading"],
                "level": section["level"],
                "content": trim(collapse("\n".join(section["lines"])), args.content_chars),
            }
        )
        if len(sections) >= args.max_sections:
            break
    return {
        "kind": "markdown_section_extract",
        "queries": queries,
        "section_count": len(sections),
        "sections": sections,
    }


def build_stdout_summary(result: dict, output_path: Path | None) -> str:
    lines = []
    if output_path:
        lines.append(f"Wrote compact markdown sections to {output_path}")
    lines.append(f"Summary: kept {result.get('section_count')} matching sections")
    for section in (result.get("sections") or [])[:5]:
        lines.append(f"- {section['heading']}")
        lines.append(f"  {trim(section['content'], 160)}")
    lines.append("Use this summary first. Only read the compact JSON if a specific section still needs more detail.")
    return trim("\n".join(lines).strip(), 1800)


def main() -> int:
    args = parse_args()
    text = Path(args.input).read_text(encoding="utf-8")
    result = compact_sections(text, args)
    result["source_path"] = args.input
    serialized = json.dumps(result, ensure_ascii=True, indent=2) + "\n"
    output_path = Path(args.output) if args.output else None
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(serialized, encoding="utf-8")
        sys.stdout.write(build_stdout_summary(result, output_path) + "\n")
    else:
        sys.stdout.write(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
