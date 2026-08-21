#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
WHITESPACE_RE = re.compile(r"\s+")
FILE_LINE_RE = re.compile(r'^File:\s+"?(.*?)"?\s+\(ID:', re.DOTALL)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reduce Google Workspace document content or summary overflow payloads."
    )
    parser.add_argument("--input", required=True, help="Path to raw overflow JSON.")
    parser.add_argument("--output", help="Path to write compact JSON.")
    parser.add_argument(
        "--query",
        action="append",
        default=[],
        help="Keyword to match against headings, outline text, or content. May be repeated.",
    )
    parser.add_argument("--max-sections", type=int, default=8)
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


def load_result(path: Path) -> str:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        result = payload.get("result")
        if isinstance(result, str):
            return result
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, ensure_ascii=True)


def queries(args: argparse.Namespace) -> list[str]:
    return [query.lower().strip() for query in args.query if query.strip()]


def matches(text: str, lowered_queries: list[str]) -> bool:
    if not lowered_queries:
        return True
    haystack = text.lower()
    return any(query in haystack for query in lowered_queries)


def parse_summary_payload(text: str, lowered_queries: list[str], args: argparse.Namespace) -> dict:
    data = json.loads(text)

    def walk(nodes, output):
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            label = collapse(str(node.get("text") or "Untitled"))
            preview = collapse(str(node.get("preview") or ""))
            combined = f"{label}\n{preview}"
            if matches(combined, lowered_queries):
                output.append(
                    {
                        "level": node.get("level"),
                        "heading": label,
                        "preview": trim(preview, args.content_chars),
                    }
                )
            if len(output) >= args.max_sections:
                return
            walk(node.get("children") or [], output)
            if len(output) >= args.max_sections:
                return

    outline_matches: list[dict] = []
    walk(data.get("outline") or [], outline_matches)
    if not outline_matches and not lowered_queries:
        walk(data.get("outline") or [], outline_matches)

    return {
        "kind": "google_workspace_extract_document_summary",
        "title": data.get("title"),
        "total_characters": data.get("total_characters"),
        "total_headings": data.get("total_headings"),
        "total_paragraphs": data.get("total_paragraphs"),
        "total_tables": data.get("total_tables"),
        "total_lists": data.get("total_lists"),
        "queries": lowered_queries,
        "sections": outline_matches[: args.max_sections],
    }


def parse_sections(markdown: str) -> list[dict]:
    sections = []
    current = {"heading": "Document Start", "level": 0, "lines": []}
    for raw_line in markdown.splitlines():
        match = HEADING_RE.match(raw_line)
        if match:
            if current["lines"]:
                sections.append(current)
            current = {
                "heading": collapse(match.group(2)) or "Untitled",
                "level": len(match.group(1)),
                "lines": [],
            }
        elif raw_line.strip():
            current["lines"].append(raw_line.rstrip())
    if current["lines"]:
        sections.append(current)
    return sections


def parse_doc_content_payload(text: str, lowered_queries: list[str], args: argparse.Namespace) -> dict:
    if "\\n" in text and "\n" not in text:
        text = text.replace("\\r\\n", "\n").replace("\\n", "\n")
    title = None
    link = None
    content = text
    if "--- CONTENT ---" in text:
        preface, content = text.split("--- CONTENT ---", 1)
        for line in preface.splitlines():
            stripped = line.strip()
            if stripped.startswith("File:"):
                match = FILE_LINE_RE.match(stripped)
                if match:
                    title = collapse(match.group(1))
                else:
                    title = stripped[5:].strip().strip('"')
            elif stripped.startswith("Link:"):
                link = stripped[5:].strip()
    content = content.strip()

    compact_sections = []
    for section in parse_sections(content):
        combined = "\n".join([section["heading"], *section["lines"]])
        if not matches(combined, lowered_queries):
            continue
        compact_sections.append(
            {
                "heading": section["heading"],
                "level": section["level"],
                "content": trim(collapse("\n".join(section["lines"])), args.content_chars),
            }
        )
        if len(compact_sections) >= args.max_sections:
            break

    if not compact_sections and not lowered_queries:
        for section in parse_sections(content)[: args.max_sections]:
            compact_sections.append(
                {
                    "heading": section["heading"],
                    "level": section["level"],
                    "content": trim(collapse("\n".join(section["lines"])), args.content_chars),
                }
            )

    return {
        "kind": "google_workspace_get_doc_content",
        "title": title,
        "link": link,
        "queries": lowered_queries,
        "section_count": len(compact_sections),
        "sections": compact_sections,
    }


def compact_payload(text: str, args: argparse.Namespace) -> dict:
    lowered_queries = queries(args)
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return parse_summary_payload(text, lowered_queries, args)
    return parse_doc_content_payload(text, lowered_queries, args)


def build_stdout_summary(result: dict, output_path: Path | None) -> str:
    lines = []
    if output_path:
        lines.append(f"Wrote compact Google Workspace payload to {output_path}")
    lines.append(f"Summary: {result.get('kind')}")
    if result.get("title"):
        lines.append(f"Title: {trim(str(result['title']), 140)}")
    if result.get("link"):
        lines.append(f"Link: {trim(str(result['link']), 140)}")
    for section in (result.get("sections") or [])[:6]:
        lines.append(f"- {trim(str(section.get('heading') or 'Untitled'), 140)}")
        preview = section.get("preview") or section.get("content")
        if preview:
            lines.append(f"  {trim(collapse(str(preview)), 240)}")
    lines.append(
        "Use this reduced summary first. It already contains the matched sections."
    )
    lines.append(
        "If a specific fact is still missing, rerun compact_google_workspace_payload.py with narrower --query terms before reading any file."
    )
    lines.append(
        "Do not read the compact JSON unless a specific missing fact remains, and do not chunk-walk the raw Google Workspace overflow file."
    )
    return trim("\n".join(lines).strip(), 2400)


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    result = compact_payload(load_result(input_path), args)
    result["source_path"] = str(input_path)
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
