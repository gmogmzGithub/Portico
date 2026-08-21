from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_compact_glean_payload_prints_summary_when_writing_output(tmp_path):
    input_path = tmp_path / "glean.json"
    output_path = tmp_path / "compact.json"
    input_path.write_text(
        json.dumps(
            {
                "documents": [
                    {
                        "title": "EJS & EJG Q1 2026 Status Report",
                        "url": "https://docs.google.com/document/d/example",
                        "datasource": "gdrive",
                        "owner": {"name": "Owner One"},
                        "updateTime": "2026-03-10",
                        "snippets": [
                            "AI Advanced Screening delivered phase 1 and plans phase 2 for this quarter."
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    script = REPO_ROOT / "skills" / "company-knowledge" / "scripts" / "compact_glean_payload.py"
    result = subprocess.run(
        [sys.executable, str(script), "--input", str(input_path), "--output", str(output_path)],
        check=True,
        capture_output=True,
        text=True,
    )

    assert output_path.exists()
    assert "Wrote compact Glean payload to" in result.stdout
    assert "Top documents:" in result.stdout
    assert "url: https://docs.google.com/document/d/example" in result.stdout
    assert 'follow-up: google_workspace_extract_document_summary (document_id="example")' in result.stdout
    assert "Use this summary first." in result.stdout


def test_compact_glean_payload_treats_read_document_overflow_as_read_mode(tmp_path):
    input_path = tmp_path / "2026-03-15T02-37-18Z-glean_read_document-443de15e.json"
    output_path = tmp_path / "compact-read.json"
    docs_dir = tmp_path / "docs"
    input_path.write_text(
        json.dumps(
            {
                "documents": [
                    {
                        "title": "EJS & EJG Q1 2026 Status Report - AI Initiatives",
                        "url": "https://docs.google.com/document/d/example-read-doc",
                        "datasource": "gdrive",
                        "docType": "Document",
                        "owner": {"name": "Owner One"},
                        "updateTime": "2026-03-14T20:32:12Z",
                        "percentRetrieved": 100,
                        "snippets": [
                            "# EJS & EJG Q1 2026 Status Report",
                            "## AI Advanced Screening",
                            "Delivered phase 1 and preparing Nexus scaling this quarter.",
                            "## Basic Screening",
                            "Ramp to 100% is complete and follow-up scale work is active.",
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    script = REPO_ROOT / "skills" / "company-knowledge" / "scripts" / "compact_glean_payload.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--write-documents-dir",
            str(docs_dir),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    compact = json.loads(output_path.read_text(encoding="utf-8"))
    assert compact["kind"] == "glean_read_document"
    assert compact["documents"][0]["content_text"]
    assert "AI Advanced Screening" in compact["documents"][0]["content_text"]
    assert compact["written_documents"]
    written_path = Path(compact["written_documents"][0]["path"])
    assert written_path.exists()
    written_text = written_path.read_text(encoding="utf-8")
    assert "Basic Screening" in written_text
    assert "Top document excerpts:" in result.stdout
    assert "local_artifact:" in result.stdout
    assert "Synthesize from this reduced read first." in result.stdout


def test_compact_slack_csv_writes_compact_summary_and_stdout_manifest(tmp_path):
    input_path = tmp_path / "slack.csv"
    output_path = tmp_path / "compact.json"
    input_path.write_text(
        "\n".join(
            [
                "UserID,UserName,RealName,Channel,ThreadTs,Text,Time,Cursor",
                "U1,alice,Alice,C123,1771.1,AI Job Management rollout is green in QA,1773520000,",
                "U2,bob,Bob,C123,1771.1,Need one follow-up for prod validation,1773520100,",
                "U3,carol,Carol,C999,,Basic Screening sync is blocked on schema changes,1773520200,",
            ]
        ),
        encoding="utf-8",
    )

    script = REPO_ROOT / "skills" / "slack" / "scripts" / "compact_slack_csv.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--keyword",
            "job management",
            "--keyword",
            "basic screening",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    compact = json.loads(output_path.read_text(encoding="utf-8"))
    assert compact["kind"] == "slack_csv_compact"
    assert compact["filtered_rows"] == 3
    assert compact["items"]
    assert "Wrote compact Slack summary to" in result.stdout
    assert "Top threads/messages:" in result.stdout
    assert "thread_ts=1771.1" in result.stdout
    assert "participants: Alice, Bob" in result.stdout
    assert "Use this summary first." in result.stdout


def test_extract_markdown_sections_writes_summary_and_compact_json(tmp_path):
    input_path = tmp_path / "doc.md"
    output_path = tmp_path / "sections.json"
    input_path.write_text(
        "# Intro\nGeneral context.\n\n## Requirements\nThe system must support quarterly planning and delivery tracking.\n\n## Risks\nSlack noise can hide important blockers.\n",
        encoding="utf-8",
    )

    script = (
        REPO_ROOT
        / "skills"
        / "company-knowledge"
        / "scripts"
        / "extract_markdown_sections.py"
    )
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--query",
            "requirements",
            "--query",
            "risks",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    compact = json.loads(output_path.read_text(encoding="utf-8"))
    assert compact["kind"] == "markdown_section_extract"
    assert compact["section_count"] == 2
    assert "Wrote compact markdown sections to" in result.stdout
    assert "Use this summary first." in result.stdout


def test_compact_google_workspace_payload_reduces_doc_content_overflow(tmp_path):
    input_path = tmp_path / "gw-doc.json"
    output_path = tmp_path / "gw-doc-compact.json"
    input_path.write_text(
        json.dumps(
            {
                "result": 'File: "Status Report"\\nLink: https://docs.google.com/document/d/example/edit\\n\\n--- CONTENT ---\\n# Status Report\\n## AI Advanced Screening\\nThe team delivered AND/OR requirements and is preparing the Nexus ramp.\\n\\n## Basic Screening\\nRamp to 100% is complete and follow-up scale work is in progress.\\n\\n## AI Job Management\\nRequirements are drafted and implementation work remains.\\n'
            }
        ),
        encoding="utf-8",
    )

    script = (
        REPO_ROOT
        / "skills"
        / "company-knowledge"
        / "scripts"
        / "compact_google_workspace_payload.py"
    )
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--query",
            "advanced screening",
            "--query",
            "ai job management",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    compact = json.loads(output_path.read_text(encoding="utf-8"))
    assert compact["kind"] == "google_workspace_get_doc_content"
    assert compact["title"] == "Status Report"
    assert compact["section_count"] == 2
    assert compact["sections"][0]["heading"] == "AI Advanced Screening"
    assert "Wrote compact Google Workspace payload to" in result.stdout
    assert "rerun compact_google_workspace_payload.py with narrower --query terms" in result.stdout
    assert "do not chunk-walk the raw google workspace overflow file" in result.stdout.lower()


def test_compact_google_workspace_payload_reduces_summary_overflow(tmp_path):
    input_path = tmp_path / "gw-summary.json"
    output_path = tmp_path / "gw-summary-compact.json"
    input_path.write_text(
        json.dumps(
            {
                "result": json.dumps(
                    {
                        "title": "EJP Basic Screening Ramp to 100%",
                        "total_characters": 20619,
                        "outline": [
                            {
                                "level": 1,
                                "text": "Executive Summary",
                                "preview": "Basic Screening hit 100% ramp and uncovered scale issues.",
                                "children": [],
                            },
                            {
                                "level": 1,
                                "text": "Challenges & Blockers",
                                "preview": "DocService and timeout issues required architecture changes.",
                                "children": [],
                            },
                        ],
                    }
                )
            }
        ),
        encoding="utf-8",
    )

    script = (
        REPO_ROOT
        / "skills"
        / "company-knowledge"
        / "scripts"
        / "compact_google_workspace_payload.py"
    )
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--query",
            "blocker",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    compact = json.loads(output_path.read_text(encoding="utf-8"))
    assert compact["kind"] == "google_workspace_extract_document_summary"
    assert compact["title"] == "EJP Basic Screening Ramp to 100%"
    assert compact["sections"][0]["heading"] == "Challenges & Blockers"
    assert "Summary: google_workspace_extract_document_summary" in result.stdout


def test_compact_jira_search_writes_summary_and_compact_json(tmp_path):
    input_path = tmp_path / "jira.json"
    output_path = tmp_path / "jira-compact.json"
    input_path.write_text(
        json.dumps(
            [
                "[IMPORTANT: notice]",
                {
                    "issues": [
                        {
                            "key": "EJGROUP-1234",
                            "fields": {
                                "summary": "Implement AI Job Management reporting",
                                "status": {"name": "In Progress"},
                                "updated": "2026-03-10",
                            },
                        },
                        {
                            "key": "EJSEARCH-5678",
                            "fields": {
                                "summary": "Basic Screening AND/OR support",
                                "status": {"name": "Closed"},
                                "resolved": "2026-03-08",
                            },
                        },
                    ]
                },
            ]
        ),
        encoding="utf-8",
    )

    script = REPO_ROOT / "skills" / "atlassian-portico" / "scripts" / "compact_jira_search.py"
    result = subprocess.run(
        [sys.executable, str(script), "--input", str(input_path), "--output", str(output_path)],
        check=True,
        capture_output=True,
        text=True,
    )

    compact = json.loads(output_path.read_text(encoding="utf-8"))
    assert compact["kind"] == "jira_search_compact"
    assert compact["returned_issues"] == 2
    assert compact["issues"][0]["key"] == "EJGROUP-1234"
    assert compact["project_counts"] == {"EJGROUP": 1, "EJSEARCH": 1}
    assert compact["status_counts"] == {"In Progress": 1, "Closed": 1}
    assert "Wrote compact JIRA summary to" in result.stdout
    assert "Projects: EJGROUP=1, EJSEARCH=1" in result.stdout
    assert "Statuses: Closed=1, In Progress=1" in result.stdout
    assert "Use this summary first." in result.stdout
