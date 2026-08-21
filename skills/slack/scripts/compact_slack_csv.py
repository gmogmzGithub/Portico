#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path


WHITESPACE_RE = re.compile(r"\s+")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compact Slack CSV/text exports into a small JSON summary."
    )
    parser.add_argument("--input", required=True, help="Path to the raw Slack CSV/TXT payload.")
    parser.add_argument("--output", help="Path to write compact JSON.")
    parser.add_argument(
        "--max-items",
        type=int,
        default=8,
        help="Maximum number of compacted thread/message items to keep.",
    )
    parser.add_argument(
        "--text-chars",
        type=int,
        default=180,
        help="Maximum characters per retained sample message.",
    )
    parser.add_argument(
        "--max-samples",
        type=int,
        default=2,
        help="Maximum sample messages to retain per grouped item.",
    )
    parser.add_argument(
        "--keyword",
        action="append",
        default=[],
        help="Optional keyword filter. May be repeated.",
    )
    return parser.parse_args()


def collapse_whitespace(text: str) -> str:
    return WHITESPACE_RE.sub(" ", text).strip()


def trim(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3].rstrip() + "..."


def normalize_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return collapse_whitespace(value)
    return collapse_whitespace(str(value))


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = []
        for raw in reader:
            if not isinstance(raw, dict):
                continue
            row = {normalize_text(key): normalize_text(value) for key, value in raw.items()}
            if any(row.values()):
                rows.append(row)
        return rows


def row_matches_keywords(row: dict[str, str], keywords: list[str]) -> bool:
    if not keywords:
        return True
    haystack = " ".join(
        [
            row.get("Text", ""),
            row.get("Channel", ""),
            row.get("UserName", ""),
            row.get("RealName", ""),
        ]
    ).lower()
    return any(keyword in haystack for keyword in keywords)


def thread_key(row: dict[str, str], index: int) -> tuple[str, str]:
    channel = row.get("Channel") or "unknown-channel"
    thread_ts = row.get("ThreadTs")
    if thread_ts:
        return channel, thread_ts
    time_value = row.get("Time") or f"message-{index}"
    return channel, f"message:{time_value}"


def compact_rows(rows: list[dict[str, str]], args: argparse.Namespace) -> dict:
    lowered_keywords = [keyword.lower().strip() for keyword in args.keyword if keyword.strip()]
    filtered = rows
    if lowered_keywords:
        matching_keys = {
            thread_key(row, index)
            for index, row in enumerate(rows, start=1)
            if row_matches_keywords(row, lowered_keywords)
        }
        filtered = [
            row
            for index, row in enumerate(rows, start=1)
            if thread_key(row, index) in matching_keys
        ]
    grouped: dict[tuple[str, str], dict] = {}

    for index, row in enumerate(filtered, start=1):
        key = thread_key(row, index)
        bucket = grouped.setdefault(
            key,
            {
                "channel": row.get("Channel") or "unknown-channel",
                "thread_ts": row.get("ThreadTs") or None,
                "message_count": 0,
                "participants": [],
                "latest_time": row.get("Time") or None,
                "sample_messages": [],
            },
        )
        bucket["message_count"] += 1
        if row.get("Time"):
            bucket["latest_time"] = max(bucket.get("latest_time") or row["Time"], row["Time"])
        author = row.get("RealName") or row.get("UserName") or row.get("UserID")
        if author and author not in bucket["participants"]:
            bucket["participants"].append(author)
        text = normalize_text(row.get("Text"))
        if text and text not in bucket["sample_messages"]:
            bucket["sample_messages"].append(trim(text, args.text_chars))

    items = sorted(
        grouped.values(),
        key=lambda item: (
            item.get("message_count", 0),
            item.get("latest_time") or "",
        ),
        reverse=True,
    )[: args.max_items]

    for item in items:
        item["participants"] = item["participants"][:5]
        item["sample_messages"] = item["sample_messages"][: args.max_samples]

    channel_counts = Counter(row.get("Channel") or "unknown-channel" for row in filtered)
    channels = [
        {"channel": channel, "row_count": count}
        for channel, count in channel_counts.most_common()
    ]

    return {
        "kind": "slack_csv_compact",
        "total_rows": len(rows),
        "filtered_rows": len(filtered),
        "keyword_filters": lowered_keywords,
        "channels": channels,
        "items": items,
    }


def build_stdout_summary(result: dict, output_path: Path | None) -> str:
    lines = []
    if output_path:
        lines.append(f"Wrote compact Slack summary to {output_path}")
    lines.append(
        "Summary: "
        f"kept {len(result.get('items') or [])} grouped items from {result.get('filtered_rows')} matching rows"
    )
    channels = result.get("channels") or []
    if channels:
        top_channels = ", ".join(
            f"{entry['channel']} ({entry['row_count']})" for entry in channels[:4]
        )
        lines.append(f"Top channels: {top_channels}")
    lines.append("Top threads/messages:")
    for item in (result.get("items") or [])[:5]:
        label = f"- {item.get('channel')} | {item.get('message_count')} messages"
        if item.get("latest_time"):
            label += f" | {item['latest_time']}"
        if item.get("thread_ts"):
            label += f" | thread_ts={item['thread_ts']}"
        lines.append(trim(label, 160))
        participants = item.get("participants") or []
        if participants:
            lines.append(f"  participants: {trim(', '.join(participants[:5]), 160)}")
        for sample in item.get("sample_messages") or []:
            lines.append(f"  {trim(sample, 160)}")
    lines.append(
        "Use this summary first. Only read the compact JSON if a specific thread still needs deeper inspection."
    )
    lines.append(
        "The summary already includes thread_ts and participants. Go directly to slack_conversations_replies for chosen threads instead of opening the compact JSON."
    )
    return trim("\n".join(lines).strip(), 2200)


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    rows = read_rows(input_path)
    result = compact_rows(rows, args)
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
