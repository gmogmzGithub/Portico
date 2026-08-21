#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse


WHITESPACE_RE = re.compile(r"\s+")
NO_SNIPPET_MARKERS = (
    "we do not have snippets for this document",
    "no snippets for this document",
)
GOOGLE_HOSTS = {
    "calendar.google.com",
    "docs.google.com",
    "drive.google.com",
    "mail.google.com",
    "meet.google.com",
}
GOOGLE_DATASOURCES = {
    "gcal",
    "gdrive",
    "gmail",
    "gmailnative",
    "googlecalendar",
}
GOOGLE_DOC_RE = re.compile(r"/document/d/([A-Za-z0-9_-]+)")
GOOGLE_SHEET_RE = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]+)")
GOOGLE_SLIDES_RE = re.compile(r"/presentation/d/([A-Za-z0-9_-]+)")
GOOGLE_DRIVE_FILE_RE = re.compile(r"/file/d/([A-Za-z0-9_-]+)")
REPO_ROOT = Path(__file__).resolve().parents[3]
OPTIMIZATION_FLAG_ENV_PREFIX = "OWUI_OPT_"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compact raw Glean search/activity/read payloads into smaller normalized files."
    )
    parser.add_argument("--input", required=True, help="Path to the raw Glean JSON payload.")
    parser.add_argument("--output", help="Path to write the compacted JSON. Defaults to stdout.")
    parser.add_argument(
        "--mode",
        choices=("auto", "search", "activity", "read"),
        default="auto",
        help="Force payload interpretation mode. Default: auto-detect.",
    )
    parser.add_argument(
        "--max-items",
        type=int,
        default=10,
        help="Maximum number of documents/activities to keep in the compact output.",
    )
    parser.add_argument(
        "--snippet-chars",
        type=int,
        default=280,
        help="Maximum characters per retained snippet.",
    )
    parser.add_argument(
        "--max-snippets-per-item",
        type=int,
        default=2,
        help="Maximum number of cleaned snippets to keep per search/activity item.",
    )
    parser.add_argument(
        "--content-chars",
        type=int,
        default=5000,
        help="Maximum characters of extracted document content per read_document result.",
    )
    parser.add_argument(
        "--write-documents-dir",
        help="Optional directory where compact markdown documents will be written for read_document payloads.",
    )
    parser.add_argument(
        "--no-dedupe",
        action="store_true",
        help="Disable URL/title-level deduplication.",
    )
    return parser.parse_args()


def optimization_flag_enabled(flag_name: str, default: bool = True) -> bool:
    env_name = OPTIMIZATION_FLAG_ENV_PREFIX + re.sub(r"[^A-Za-z0-9]+", "_", flag_name).upper()
    raw_env = os.getenv(env_name)
    if raw_env is not None:
        value = raw_env.strip().lower()
        if value in {"1", "true", "yes", "on"}:
            return True
        if value in {"0", "false", "no", "off"}:
            return False

    flags_path = REPO_ROOT / "optimization_flags.json"
    if flags_path.is_file():
        try:
            raw = json.loads(flags_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and flag_name in raw:
                return bool(raw[flag_name])
        except Exception:
            pass
    return default


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def collapse_whitespace(text: str) -> str:
    return WHITESPACE_RE.sub(" ", text).strip()


def trim(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3].rstrip() + "..."


def normalize_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return collapse_whitespace(value)
    if isinstance(value, (int, float, bool)):
        return str(value)
    return collapse_whitespace(json.dumps(value, ensure_ascii=True, sort_keys=True))


def looks_like_json_blob(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    if stripped.startswith("{") and stripped.endswith("}"):
        return True
    if stripped.startswith("[") and stripped.endswith("]") and "\"custom_facets\"" in stripped:
        return True
    if stripped.startswith('"{') or stripped.startswith("'{"):
        return True
    if '"custom_facets"' in stripped or '\\"custom_facets\\"' in stripped:
        return True
    return False


def is_noise_snippet(text: str) -> bool:
    lowered = text.lower()
    if any(marker in lowered for marker in NO_SNIPPET_MARKERS):
        return True
    return looks_like_json_blob(text)


def dedupe_preserve_order(values):
    seen = set()
    result = []
    for value in values:
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result


def search_doc_priority(doc: dict) -> tuple[int, int]:
    resource = doc.get("google_resource") or {}
    kind = resource.get("kind")
    title = normalize_text(doc.get("title")).lower()
    datasource = normalize_text(doc.get("datasource")).lower()
    if kind == "google_doc":
        return (0, doc.get("rank") or 9999)
    if datasource == "gdrive" and not title.endswith(".pdf"):
        return (1, doc.get("rank") or 9999)
    if kind == "google_drive_file" or title.endswith(".pdf"):
        return (3, doc.get("rank") or 9999)
    if kind == "google_slides":
        return (4, doc.get("rank") or 9999)
    if datasource == "slackentgrid":
        return (5, doc.get("rank") or 9999)
    return (2, doc.get("rank") or 9999)


def clean_snippets(raw_snippets, snippet_chars: int, max_snippets: int) -> list[str]:
    cleaned = []
    for raw in raw_snippets or []:
        text = normalize_text(raw)
        if not text or is_noise_snippet(text):
            continue
        cleaned.append(trim(text, snippet_chars))
    return dedupe_preserve_order(cleaned)[:max_snippets]


def first_non_empty(*values):
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
            continue
        if value:
            return value
    return None


def nested_get(obj, *path):
    current = obj
    for part in path:
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def owner_name(obj: dict) -> str | None:
    owner = obj.get("owner")
    if isinstance(owner, dict):
        name = owner.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    for value in (
        obj.get("AuthorName"),
        nested_get(obj, "ownedAndUpdatedBy", "name"),
        nested_get(obj, "author", "name"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def extract_doc_type(obj: dict) -> str | None:
    for value in (
        obj.get("docType"),
        obj.get("Doctype"),
        obj.get("DocumentType"),
        obj.get("Type"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    matching_filters = obj.get("matchingFilters")
    if isinstance(matching_filters, dict):
        type_values = matching_filters.get("type")
        if isinstance(type_values, list):
            for value in type_values:
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def extract_timestamp(obj: dict) -> str | None:
    for value in (
        obj.get("timestamp"),
        obj.get("updateTime"),
        obj.get("updated_at"),
        obj.get("createTime"),
        obj.get("created_at"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def host_from_url(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    return parsed.netloc.lower() or None


def extract_google_resource(url: str | None) -> dict | None:
    if not url:
        return None
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path

    for resource_kind, pattern in (
        ("google_doc", GOOGLE_DOC_RE),
        ("google_sheet", GOOGLE_SHEET_RE),
        ("google_slides", GOOGLE_SLIDES_RE),
        ("google_drive_file", GOOGLE_DRIVE_FILE_RE),
    ):
        match = pattern.search(path)
        if match:
            return {"kind": resource_kind, "id": match.group(1)}

    if host == "drive.google.com":
        query_id = parse_qs(parsed.query).get("id")
        if query_id:
            return {"kind": "google_drive_file", "id": query_id[0]}
    return None


def prefers_google_workspace(url: str | None, datasource: str | None) -> bool:
    host = host_from_url(url)
    if host in GOOGLE_HOSTS:
        return True
    if isinstance(datasource, str) and datasource.lower() in GOOGLE_DATASOURCES:
        return True
    return False


def doc_identity_key(obj: dict) -> str:
    url = normalize_text(obj.get("url"))
    if url:
        return f"url:{url.lower()}"
    title = normalize_text(obj.get("title") or obj.get("Title"))
    datasource = normalize_text(obj.get("datasource") or obj.get("Datasource"))
    return f"title:{title.lower()}|datasource:{datasource.lower()}"


def compact_search(data, args: argparse.Namespace) -> dict:
    raw_docs = data if isinstance(data, list) else data.get("documents", [])
    documents = []
    seen = set()
    dropped_duplicates = 0

    for idx, raw in enumerate(raw_docs, start=1):
        if not isinstance(raw, dict):
            continue
        key = doc_identity_key(raw)
        if not args.no_dedupe and key in seen:
            dropped_duplicates += 1
            continue
        seen.add(key)

        url = first_non_empty(raw.get("url"))
        datasource = first_non_empty(raw.get("datasource"))
        google_resource = extract_google_resource(url)
        snippets = clean_snippets(
            raw.get("snippets"), args.snippet_chars, args.max_snippets_per_item
        )
        documents.append(
            {
                "rank": idx,
                "title": first_non_empty(raw.get("title")) or "Untitled",
                "url": url,
                "datasource": datasource,
                "doc_type": extract_doc_type(raw),
                "owner": owner_name(raw),
                "updated_at": extract_timestamp(raw),
                "snippet": snippets[0] if snippets else None,
                "extra_snippets": snippets[1:],
                "snippet_available": bool(snippets),
                "matching_filter_keys": sorted(list((raw.get("matchingFilters") or {}).keys()))[:12]
                if isinstance(raw.get("matchingFilters"), dict)
                else [],
                "prefer_google_workspace": prefers_google_workspace(url, datasource),
                "google_resource": google_resource,
            }
        )
        if len(documents) >= args.max_items:
            break

    documents.sort(key=search_doc_priority)

    return {
        "kind": "glean_search",
        "total_items": len(raw_docs),
        "returned_items": len(documents),
        "truncated": len(raw_docs) > len(documents),
        "dropped_duplicates": dropped_duplicates,
        "documents": documents,
    }


def compact_activity(data, args: argparse.Namespace) -> dict:
    raw_activities = data.get("activities", []) if isinstance(data, dict) else []
    activities = []
    seen = set()
    dropped_duplicates = 0

    for idx, raw in enumerate(raw_activities, start=1):
        if not isinstance(raw, dict):
            continue
        doc = raw.get("documentSummary") if isinstance(raw.get("documentSummary"), dict) else {}
        key = doc_identity_key(doc)
        if not args.no_dedupe and key in seen:
            dropped_duplicates += 1
            continue
        seen.add(key)

        url = first_non_empty(doc.get("url"))
        datasource = first_non_empty(doc.get("datasource"))
        snippets = clean_snippets(
            doc.get("snippets"), args.snippet_chars, args.max_snippets_per_item
        )
        attachments = doc.get("attachments")
        activities.append(
            {
                "rank": idx,
                "activity": first_non_empty(raw.get("activity")),
                "timestamp": first_non_empty(
                    raw.get("updated_at"),
                    raw.get("created_at"),
                    doc.get("updateTime"),
                ),
                "title": first_non_empty(doc.get("title")) or "Untitled",
                "url": url,
                "datasource": datasource,
                "doc_type": extract_doc_type(doc),
                "owner": owner_name(doc),
                "snippet": snippets[0] if snippets else None,
                "extra_snippets": snippets[1:],
                "snippet_available": bool(snippets),
                "attachment_count": len(attachments) if isinstance(attachments, list) else 0,
                "prefer_google_workspace": prefers_google_workspace(url, datasource),
            }
        )
        if len(activities) >= args.max_items:
            break

    return {
        "kind": "glean_user_activity",
        "total_items": len(raw_activities),
        "returned_items": len(activities),
        "truncated": len(raw_activities) > len(activities),
        "dropped_duplicates": dropped_duplicates,
        "activities": activities,
    }


def iter_read_lines(doc: dict):
    top_level_snippets = first_non_empty(doc.get("Snippets"), doc.get("snippets")) or []
    if isinstance(top_level_snippets, list):
        for snippet in top_level_snippets:
            if isinstance(snippet, str):
                yield None, snippet
                continue
            if not isinstance(snippet, dict):
                continue
            text = first_non_empty(
                snippet.get("SnippetText"),
                snippet.get("snippetText"),
                snippet.get("text"),
            )
            if not isinstance(text, str):
                continue
            metadata = first_non_empty(snippet.get("Metadata"), snippet.get("metadata")) or {}
            header = metadata.get("closest_header") if isinstance(metadata, dict) else None
            yield header, text

    content_blocks = first_non_empty(doc.get("Content"), doc.get("content")) or []
    if isinstance(content_blocks, list):
        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            snippets = first_non_empty(block.get("Snippets"), block.get("snippets")) or []
            if not isinstance(snippets, list):
                continue
            for snippet in snippets:
                if not isinstance(snippet, dict):
                    continue
                text = first_non_empty(
                    snippet.get("SnippetText"),
                    snippet.get("snippetText"),
                    snippet.get("text"),
                )
                if not isinstance(text, str):
                    continue
                metadata = first_non_empty(snippet.get("Metadata"), snippet.get("metadata")) or {}
                header = metadata.get("closest_header") if isinstance(metadata, dict) else None
                yield header, text

    hit_lines = nested_get(doc, "Hit", "_source", "all_snippetable_text_2")
    if isinstance(hit_lines, list):
        for line in hit_lines:
            if isinstance(line, str):
                yield None, line


def build_compact_content(doc: dict, content_chars: int) -> tuple[str, bool]:
    pieces = []
    seen_lines = set()
    seen_headers = set()
    last_header = None

    for header, raw_line in iter_read_lines(doc):
        line = normalize_text(raw_line)
        if not line:
            continue
        line_key = line.lower()
        if line_key in seen_lines:
            continue
        seen_lines.add(line_key)

        clean_header = normalize_text(header) if isinstance(header, str) else ""
        if clean_header and clean_header.lower() not in seen_headers and clean_header != last_header:
            if pieces and pieces[-1] != "":
                pieces.append("")
            pieces.append(f"## {clean_header}")
            seen_headers.add(clean_header.lower())
            last_header = clean_header
            if line.lstrip("# ").lower() == clean_header.lower():
                continue

        pieces.append(line)

    content = "\n".join(pieces).strip()
    if not content:
        return "", False
    trimmed = len(content) > content_chars
    return trim(content, content_chars), trimmed


def safe_filename(value: str, fallback: str) -> str:
    text = normalize_text(value) or fallback
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-._")
    return text[:80] or fallback


def write_markdown_documents(documents: list[dict], directory: Path) -> list[dict]:
    directory.mkdir(parents=True, exist_ok=True)
    outputs = []
    for idx, doc in enumerate(documents, start=1):
        filename = f"{idx:02d}-{safe_filename(doc.get('title') or 'document', f'doc-{idx:02d}')}.md"
        path = directory / filename
        lines = [f"# {doc.get('title') or 'Untitled'}", ""]
        metadata_lines = [
            ("URL", doc.get("url")),
            ("Datasource", doc.get("datasource")),
            ("Doc Type", doc.get("doc_type")),
            ("Author", doc.get("author")),
            ("Updated At", doc.get("updated_at")),
        ]
        for label, value in metadata_lines:
            if value:
                lines.append(f"- {label}: {value}")
        if len(lines) > 2:
            lines.append("")
        if doc.get("content_text"):
            lines.append(doc["content_text"])
        path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
        outputs.append(
            {
                "title": doc.get("title"),
                "path": str(path),
            }
        )
    return outputs


def compact_read(data, args: argparse.Namespace) -> dict:
    raw_docs = []
    if isinstance(data, dict):
        raw_docs = data.get("Documents") or data.get("documents") or []
    elif isinstance(data, list):
        raw_docs = data

    documents = []
    seen = set()
    dropped_duplicates = 0

    for idx, raw in enumerate(raw_docs, start=1):
        if not isinstance(raw, dict):
            continue
        key = doc_identity_key(raw)
        if not args.no_dedupe and key in seen:
            dropped_duplicates += 1
            continue
        seen.add(key)

        url = first_non_empty(raw.get("Url"), raw.get("url"))
        datasource = first_non_empty(raw.get("Datasource"), raw.get("datasource"))
        google_resource = extract_google_resource(url)
        content_text, content_trimmed = build_compact_content(raw, args.content_chars)
        documents.append(
            {
                "rank": idx,
                "title": first_non_empty(raw.get("Title"), raw.get("title")) or "Untitled",
                "url": url,
                "datasource": datasource,
                "doc_type": extract_doc_type(raw),
                "author": owner_name(raw),
                "updated_at": extract_timestamp(raw),
                "content_text": content_text,
                "content_trimmed": content_trimmed,
                "prefer_google_workspace": prefers_google_workspace(url, datasource),
                "google_resource": google_resource,
            }
        )
        if len(documents) >= args.max_items:
            break

    output = {
        "kind": "glean_read_document",
        "total_items": len(raw_docs),
        "returned_items": len(documents),
        "truncated": len(raw_docs) > len(documents),
        "dropped_duplicates": dropped_duplicates,
        "documents": documents,
        "requested_url_count": len(data.get("RequestedURLs", [])) if isinstance(data, dict) else None,
        "successful_url_count": len(data.get("SuccessfulURLs", [])) if isinstance(data, dict) else None,
        "failed_url_count": len(data.get("FailedURLs", [])) if isinstance(data, dict) else None,
    }

    if args.write_documents_dir:
        doc_dir = Path(args.write_documents_dir)
        output["written_documents"] = write_markdown_documents(documents, doc_dir)

    return output


def detect_mode(data, forced_mode: str, input_name: str = "") -> str:
    if forced_mode != "auto":
        return forced_mode
    if input_name:
        lowered_name = input_name.lower()
        if "glean_read_document" in lowered_name or "read_document" in lowered_name:
            return "read"
        if "glean_user_activity" in lowered_name or "user_activity" in lowered_name:
            return "activity"
        if "glean_search" in lowered_name:
            return "search"
    if isinstance(data, dict):
        if "activities" in data:
            return "activity"
        if "Documents" in data or "Content" in data:
            return "read"
        documents = data.get("documents")
        if isinstance(documents, list) and documents:
            first = documents[0]
            if isinstance(first, dict):
                if any(
                    key in first
                    for key in (
                        "Content",
                        "content",
                        "Hit",
                        "hit",
                        "percentRetrieved",
                    )
                ):
                    return "read"
        if "documents" in data:
            return "search"
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            if "Content" in first or "Title" in first:
                return "read"
            if "activity" in first or "documentSummary" in first:
                return "activity"
            return "search"
    return "search"


def compact_payload(data, args: argparse.Namespace) -> dict:
    mode = detect_mode(data, args.mode, Path(args.input).name)
    if mode == "activity":
        return compact_activity(data, args)
    if mode == "read":
        return compact_read(data, args)
    return compact_search(data, args)


def build_stdout_summary(result: dict, output_path: Path | None) -> str:
    lines = []
    if output_path:
        lines.append(f"Wrote compact Glean payload to {output_path}")
    lines.append(
        "Summary: "
        f"{result.get('kind')} | kept {result.get('returned_items')} of {result.get('total_items')} items"
        + (" | truncated" if result.get("truncated") else "")
    )

    if result.get("kind") == "glean_search":
        documents = result.get("documents") or []
        lines.append("Top documents:")
        for doc in documents[:3]:
            metadata = ", ".join(
                value
                for value in [
                    doc.get("datasource"),
                    doc.get("owner"),
                    doc.get("updated_at"),
                ]
                if value
            )
            label = doc.get("title") or "Untitled"
            if metadata:
                label = f"{label} [{metadata}]"
            lines.append(f"- {trim(label, 140)}")
            doc_type = doc.get("doc_type")
            if doc_type:
                lines.append(f"  type: {trim(str(doc_type), 80)}")
            url = doc.get("url")
            if url:
                lines.append(f"  url: {trim(url, 120)}")
            google_resource = doc.get("google_resource") or {}
            if google_resource.get("kind") == "google_doc" and google_resource.get("id"):
                lines.append(
                    '  follow-up: google_workspace_extract_document_summary '
                    f'(document_id="{google_resource["id"]}")'
                )
            snippet = doc.get("snippet")
            if snippet:
                lines.append(f"  {trim(snippet, 160)}")
        lines.append(
            "For a broad multi-project report, follow at most one current source-of-truth URL first."
        )
        if optimization_flag_enabled("company_knowledge_prefer_google_workspace_doc_reads", True):
            lines.append(
                "If Google Workspace is already attached and the source is a Google Doc/Drive file, prefer google_workspace_extract_document_summary on that single URL instead of glean_read_document."
            )
        else:
            lines.append(
                "Prefer glean_read_document on that single URL before activating or using another integration."
            )
        if optimization_flag_enabled("subagent_integration_activation_restriction", True):
            lines.append(
                "Do not call mcp_assistant_toggle_integration, mcp_assistant_authorize_integration, or mcp_assistant_activate_integration from a delegated subagent. If Google Workspace is not already attached, continue with compact Glean evidence."
            )
    elif result.get("kind") == "glean_read_document":
        documents = result.get("documents") or []
        lines.append("Top document excerpts:")
        for doc in documents[:3]:
            label = doc.get("title") or "Untitled"
            if doc.get("updated_at"):
                label = f"{label} [{doc['updated_at']}]"
            lines.append(f"- {trim(label, 140)}")
            excerpt = doc.get("content_text")
            if excerpt:
                lines.append(f"  {trim(collapse_whitespace(excerpt), 180)}")
        for written in (result.get("written_documents") or [])[:3]:
            if written.get("path"):
                lines.append(f"  local_artifact: {trim(str(written['path']), 140)}")
        lines.append(
            "Synthesize from this reduced read first. Do not batch-read more documents unless one specific named project still lacks evidence."
        )
    elif result.get("kind") == "glean_user_activity":
        activities = result.get("activities") or []
        lines.append("Top activities:")
        for activity in activities[:4]:
            label = " | ".join(
                value
                for value in [
                    activity.get("activity"),
                    activity.get("title"),
                    activity.get("timestamp"),
                ]
                if value
            )
            lines.append(f"- {trim(label, 160)}")
            snippet = activity.get("snippet")
            if snippet:
                lines.append(f"  {trim(snippet, 160)}")

    lines.append(
        "Use this summary first. Only read the compact JSON if a specific detail is still missing."
    )
    return trim("\n".join(lines).strip(), 1800)


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    payload = load_json(input_path)
    result = compact_payload(payload, args)
    result["source_path"] = str(input_path)

    serialized = json.dumps(result, ensure_ascii=True, indent=2) + "\n"
    output_path = Path(args.output) if args.output else None
    if args.output:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(serialized, encoding="utf-8")
        sys.stdout.write(build_stdout_summary(result, output_path) + "\n")
    else:
        sys.stdout.write(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
