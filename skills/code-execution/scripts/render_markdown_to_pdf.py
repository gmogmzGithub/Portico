#!/usr/bin/env python3
"""Render a markdown/plaintext report into a readable PDF."""

from __future__ import annotations

import argparse
import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Path to markdown or text input file")
    parser.add_argument("--output", required=True, help="Path to output PDF")
    parser.add_argument("--title", default="", help="Optional document title override")
    parser.add_argument("--footer", default="", help="Optional footer text")
    return parser.parse_args()


def clean_inline(text: str) -> str:
    text = html.escape(text.strip(), quote=False)
    replacements = [
        (r"\*\*(.+?)\*\*", r"<b>\1</b>"),
        (r"__(.+?)__", r"<b>\1</b>"),
        (r"\*(.+?)\*", r"<i>\1</i>"),
        (r"_(.+?)_", r"<i>\1</i>"),
        (r"`(.+?)`", r'<font name="Courier">\1</font>'),
    ]
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)
    return text


def split_blocks(lines: list[str]) -> list[tuple[str, list[str]]]:
    blocks: list[tuple[str, list[str]]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue

        if stripped.startswith("|"):
            table_lines: list[str] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                table_lines.append(lines[i].strip())
                i += 1
            blocks.append(("table", table_lines))
            continue

        if stripped.startswith(("- ", "* ")):
            bullet_lines: list[str] = []
            while i < len(lines) and lines[i].strip().startswith(("- ", "* ")):
                bullet_lines.append(lines[i].strip())
                i += 1
            blocks.append(("bullets", bullet_lines))
            continue

        if re.match(r"^\d+\.\s+", stripped):
            numbered_lines: list[str] = []
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i].strip()):
                numbered_lines.append(lines[i].strip())
                i += 1
            blocks.append(("numbered", numbered_lines))
            continue

        paragraph_lines = [stripped]
        i += 1
        while i < len(lines):
            next_stripped = lines[i].strip()
            if not next_stripped:
                i += 1
                break
            if next_stripped.startswith("|") or next_stripped.startswith(("- ", "* ")) or re.match(
                r"^\d+\.\s+", next_stripped
            ):
                break
            if next_stripped.startswith("#"):
                break
            paragraph_lines.append(next_stripped)
            i += 1
        blocks.append(("paragraph", paragraph_lines))
    return blocks


def parse_table(table_lines: list[str]) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in table_lines:
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if cells and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
            continue
        rows.append([clean_inline(cell) for cell in cells])
    return rows


def build_story(text: str, title: str, footer: str) -> list:
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="ReportTitle",
            parent=styles["Title"],
            fontSize=22,
            leading=26,
            alignment=TA_CENTER,
            spaceAfter=18,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BodySmall",
            parent=styles["BodyText"],
            fontSize=10,
            leading=14,
            spaceAfter=8,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BulletBody",
            parent=styles["BodyText"],
            fontSize=10,
            leading=13,
            leftIndent=14,
            firstLineIndent=-8,
            bulletIndent=6,
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="FooterText",
            parent=styles["Normal"],
            fontSize=8,
            leading=10,
            textColor=colors.grey,
            alignment=TA_CENTER,
        )
    )

    story: list = []
    lines = text.splitlines()

    derived_title = title.strip()
    if not derived_title:
        for raw_line in lines:
            stripped = raw_line.strip()
            if stripped.startswith("# "):
                derived_title = stripped[2:].strip()
                break
        if not derived_title:
            derived_title = "Report"

    story.append(Paragraph(clean_inline(derived_title), styles["ReportTitle"]))

    blocks = split_blocks(lines)
    for block_type, block_lines in blocks:
        first = block_lines[0].strip()

        if block_type == "paragraph" and first.startswith("#"):
            level = len(first) - len(first.lstrip("#"))
            heading_text = clean_inline(first[level:].strip())
            style_name = "Heading1" if level <= 1 else "Heading2" if level == 2 else "Heading3"
            story.append(Paragraph(heading_text, styles[style_name]))
            rest = [line for line in block_lines[1:] if line.strip()]
            if rest:
                story.append(Paragraph(clean_inline(" ".join(rest)), styles["BodySmall"]))
            continue

        if block_type == "table":
            rows = parse_table(block_lines)
            if rows:
                normalized = max(len(row) for row in rows)
                padded = [row + [""] * (normalized - len(row)) for row in rows]
                table = Table(padded, repeatRows=1)
                table.setStyle(
                    TableStyle(
                        [
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
                            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
                            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f9fafb")]),
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("FONTSIZE", (0, 0), (-1, -1), 9),
                            ("LEADING", (0, 0), (-1, -1), 11),
                            ("LEFTPADDING", (0, 0), (-1, -1), 6),
                            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                            ("TOPPADDING", (0, 0), (-1, -1), 4),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                        ]
                    )
                )
                story.append(table)
                story.append(Spacer(1, 0.18 * inch))
            continue

        if block_type in {"bullets", "numbered"}:
            for index, bullet_line in enumerate(block_lines, start=1):
                if block_type == "numbered":
                    body = re.sub(r"^\d+\.\s+", "", bullet_line).strip()
                    bullet = f"{index}."
                else:
                    body = bullet_line[2:].strip()
                    bullet = u"\u2022"
                story.append(
                    Paragraph(
                        clean_inline(body),
                        styles["BulletBody"],
                        bulletText=bullet,
                    )
                )
            story.append(Spacer(1, 0.08 * inch))
            continue

        story.append(Paragraph(clean_inline(" ".join(block_lines)), styles["BodySmall"]))

    if footer.strip():
        story.append(Spacer(1, 0.2 * inch))
        story.append(Paragraph(clean_inline(footer), styles["FooterText"]))

    return story


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    text = input_path.read_text(encoding="utf-8")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title=args.title or input_path.stem,
    )
    story = build_story(text, args.title, args.footer)
    doc.build(story)

    print(f"generated_pdf={output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
