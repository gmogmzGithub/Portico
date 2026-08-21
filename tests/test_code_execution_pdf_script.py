from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "skills" / "code-execution" / "scripts" / "render_markdown_to_pdf.py"

pytest.importorskip("reportlab")


def test_render_markdown_to_pdf_generates_readable_pdf(tmp_path: Path) -> None:
    input_path = tmp_path / "report.md"
    output_path = tmp_path / "report.pdf"
    input_path.write_text(
        "\n".join(
            [
                "# Quarterly Report",
                "",
                "## Highlights",
                "",
                "- Basic Screening reached full ramp.",
                "- AI Job Management needs more staffing.",
                "",
                "| Project | Status |",
                "| --- | --- |",
                "| Advanced Screening | Strong |",
                "| AI Job Management | Needs Attention |",
            ]
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--title",
            "Quarterly Report",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert output_path.exists()
    assert "generated_pdf=" in completed.stdout

    reader = PdfReader(str(output_path))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert "Quarterly Report" in text
    assert "Basic Screening reached full ramp." in text
    assert "AI Job Management" in text


def test_render_markdown_to_pdf_handles_inline_code_without_font_parse_failure(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "report.md"
    output_path = tmp_path / "report.pdf"
    input_path.write_text(
        "\n".join(
            [
                "# Q1 Status",
                "",
                "> Leonardo Camacho announced that **EJS and EJG have completed the AND/OR requirements for Smart Screening**, including end-to-end testing and bug bash. Implementation uses new `userFilterGroups` architecture. *(Source: #ejp-nexus)*",
            ]
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--title",
            "Q1 Status",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert output_path.exists()
    assert "generated_pdf=" in completed.stdout

    reader = PdfReader(str(output_path))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    normalized = " ".join(text.split())
    assert "userFilterGroups" in text
    assert "AND/OR requirements for Smart Screening" in normalized
