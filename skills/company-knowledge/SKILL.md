---
name: company-knowledge
description: Search Portico's internal knowledge base using Glean. Use when user needs company documentation, policies, internal search, or knowledge base access.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "1.5"
  priority: high
  triggers:
    - "company docs"
    - "company documentation"
    - "policies"
    - "internal search"
    - "glean"
    - "knowledge base"
    - "company knowledge"
    - "portico docs"
    - "glassdoor docs"
    - "find documentation"
    - "search internal"
    - "internal wiki"
    - "confluence"
    - "company policy"
    - "our documentation"
    - "internal docs"
    - "this week at portico"
    - "what's going on at portico this week"
    - "what is going on at portico this week"
    - "what's happening at portico this week"
    - "what is happening at portico this week"
    - "what's new at portico"
    - "what is new at portico"
required_mcp_servers:
  - "server:glean"
available_references:
  - "references/routing-and-examples.md"
---

# Company Knowledge Skill

Search and retrieve information from Portico's internal knowledge base using Glean.

## Operating Rules

1. **Use `glean_search` by default** — it is the primary tool.
2. Use `glean_chat` only as a last resort when search results are insufficient. For delegated multi-project subagent reports, prefer `glean_search` + compaction and use `glean_chat` to close specific named gaps when search evidence still is not enough.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads START -->
3. Prefer native integrations over Glean when the user is explicitly asking for live Slack or Google Workspace data: Slack MCP for Slack content, Google Workspace for Gmail/Calendar/Docs/Drive. For company-knowledge synthesis, stay in the compact Glean workflow unless one specific source document clearly needs direct follow-up.
   For specific Google Docs discovered through Glean, it is acceptable to enable/auth/activate Google Workspace in the parent chat before asking for a narrower rerun.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads END -->
4. If Slack is DISABLED, fall back to Glean silently — do NOT push Slack setup from this skill.
<!-- OPT_FLAG:subagent_integration_activation_restriction START -->
5. Do not activate a new integration or skill from inside a delegated subagent just because a search result points at it. Do not call `skills_activate_skill`, `mcp_assistant_toggle_integration`, `mcp_assistant_authorize_integration`, `mcp_assistant_activate_integration`, or `mcp_assistant_trigger_guided_setup` from a delegated subagent. Stay in the compact Glean workflow unless the integration is already attached to the current chat and one specific missing fact still requires it.
<!-- OPT_FLAG:subagent_integration_activation_restriction END -->
6. If a Glean result has `overflow_file: true`, compact it before reading (see below).

## Available Tools

- **glean_search** — Search knowledge base. Default choice. Use first.
- **glean_chat** — Conversational AI synthesis. Last resort only. If you use it, the JSON argument must be `{"message": "..."}`. Do not use `question` or `query`.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads START -->
- **glean_read_document** — Usually disabled by default. Prefer Google Workspace document tools for specific Google Docs/Drive files instead.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads END -->

<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads START -->
Avoid `glean_gmail_search`, `glean_meeting_lookup` when Google Workspace is available.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads END -->

## Glean Query Discipline

- One focused query at a time — short, discriminative terms (project name, acronym, doc title).
- Refine with exact titles, owners, or URLs from first results.
- Do not treat `glean_search` as bulk export.
- Treat the named projects, teams, and quarter in the task as hard scope boundaries. Do not broaden to adjacent initiatives unless one source-of-truth document clearly covers the named projects together.
- For a multi-project status report, prefer one current source-of-truth document that covers multiple named projects over separate deep dives into many nearby docs.

<!-- OPT_FLAG:company_knowledge_compact_glean_overflow_guidance START -->
## Handling Large Payloads

Treat overflow compaction as mandatory, not optional.

Use this workflow:

1. Run `glean_search`.
2. If the result has `overflow_file: true`, immediately compact it with `agent_vm_execute_skill_script`.
3. Read the compaction script stdout summary first. It includes the top result URLs/doc IDs and preferred follow-up hints. Do not open the compact search artifact just to recover those.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads START -->
4. For a broad or multi-project report, start with the most current source-of-truth URLs rather than opening many overlapping artifacts at once.
5. If that source is a Google Doc/Drive file and Google Workspace is already attached to the chat, use `google_workspace_extract_document_summary` for that single document. Do not fall back to `glean_read_document`.
6. If Google Workspace is not already attached, synthesize from compact Glean evidence and explicitly note the remaining gap instead of trying to read the document via Glean.
7. Only if the Google Workspace summary still misses a critical detail, export that single doc as markdown and immediately reduce it with a skill script. For Google Workspace overflow payloads, use `compact_google_workspace_payload.py` first. For exported markdown, use `extract_markdown_sections.py`.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads END -->
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads START -->
8. Inspect the compact JSON or per-document artifacts with `read_fragment` only after the script stdout summary is insufficient.
9. Synthesize from the reduced artifacts.
10. For project-status requests, stop broadening the search once you already have current evidence for the named projects.
11. When the compact summary shows both a Google Doc and a PDF or slide deck for the same project, follow the Google Doc first. Treat PDFs and presentations as second-pass evidence only.
12. After `compact_google_workspace_payload.py`, prefer rerunning the reducer with narrower `--query` terms or a smaller single-doc follow-up over broad file reads.
13. For a broad project report, try to draft the synthesis from compact Glean summaries first. Escalate beyond Glean only when one specific named project still lacks requirements, delivered work, or quarterly plan evidence.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads END -->
Default compaction commands:

```text
agent_vm_execute_skill_script(
  skill_name="company-knowledge",
  script_name="scripts/compact_glean_payload.py",
  vm_id="<vm_id from Glean result>",
  args=["--input", "/work/.mcp-overflow/<file>.json", "--output", "/work/glean/compact.json", "--max-items", "6", "--snippet-chars", "220"]
)
```

For read-document-style overflow, compact again with:

```text
agent_vm_execute_skill_script(
  skill_name="company-knowledge",
  script_name="scripts/compact_glean_payload.py",
  vm_id="<vm_id from Glean result>",
  args=["--input", "/work/.mcp-overflow/<file>.json", "--output", "/work/glean/read-docs/compact.json", "--max-items", "4", "--snippet-chars", "180", "--content-chars", "2500", "--write-documents-dir", "/work/glean/read-docs"]
)
```

For Google Workspace summary/content overflow, reduce it immediately with:

```text
agent_vm_execute_skill_script(
  skill_name="company-knowledge",
  script_name="scripts/compact_google_workspace_payload.py",
  vm_id="<vm_id from Google Workspace result>",
  args=[
    "--input", "/work/.mcp-overflow/<file>.json",
    "--output", "/work/glean/google-doc-reduced.json",
    "--query", "advanced screening",
    "--query", "basic screening",
    "--query", "ai job management",
    "--query", "velocity",
    "--query", "blocker"
  ]
)
```

Hard rules:

- Never inline raw document bodies from `/work/.mcp-overflow/...`.
- Never paste large `cat` or `jq` dumps from overflow files back into the chat.
- Keep any single inline extract under `2,000` chars.
- For compact artifacts and reduced summaries, prefer `read_fragment(..., max_chars=1000-1500)` and never exceed `2000`.
- If repeated chunk reads start to pile up, create a smaller reduced artifact that isolates the relevant project instead of continuing to walk the larger file.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads START -->
- If you follow a Glean result into Google Workspace, start with `google_workspace_extract_document_summary`, not full doc content.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads END -->
<!-- OPT_FLAG:subagent_integration_activation_restriction START -->
- Do not activate Google Workspace or the `google-workspace` skill from inside a delegated subagent when it was not already attached by the parent task.
- Do not call `skills_activate_skill`, `mcp_assistant_toggle_integration`, `mcp_assistant_authorize_integration`, `mcp_assistant_activate_integration`, or `mcp_assistant_trigger_guided_setup` from a delegated subagent. If a Google Doc link appears in Glean results and Google Workspace is not already attached, cite the document and continue with compact Glean evidence instead.
<!-- OPT_FLAG:subagent_integration_activation_restriction END -->
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads START -->
- Do not call `google_workspace_get_doc_content` directly on planning, roadmap, or status docs discovered through Glean until both `google_workspace_extract_document_summary` and, if needed, `extract_markdown_sections.py` have failed to answer the question.
- Do not open PDFs or slide decks on the first pass when a current Google Doc source-of-truth is already available for that project.
- Avoid exporting full markdown content unless summary and reduced-artifact passes still miss a specific named fact.
- Never use raw bash section extraction on exported markdown. Use `extract_markdown_sections.py` instead.
- Never use raw bash or jq to unwrap a `google_workspace_extract_document_summary` or `google_workspace_get_doc_content` overflow file. Use reduced artifacts and skill scripts instead.
- Never convert a long Google Workspace overflow payload into `head`/`tail` text files and walk them in 2k chunks.
- For broad status docs, do one reduced Google Workspace pass with project keywords, then synthesize. Do not sequentially read the whole document.
- After `compact_google_workspace_payload.py`, only open the output JSON if you can name the exact missing fact the stdout summary did not provide.
- If the reduced summary is missing something, rerun `compact_google_workspace_payload.py` with narrower queries or a smaller content budget before any file read.
- Never use `agent_vm_bash` against `/work/.mcp-overflow/...` Google Workspace payloads when `compact_google_workspace_payload.py` is available.
<!-- OPT_FLAG:company_knowledge_prefer_google_workspace_doc_reads END -->
- If you need more detail, write a reduced artifact to disk and inspect that artifact in chunks.
- If `agent_vm_execute_skill_script` is unavailable, use small `agent_vm_bash` commands only to create a reduced artifact on disk. Do not print large filtered payloads to stdout.
- If you generate a local synthesis artifact such as `/work/report.md` or `/work/summary.json`, do not walk the whole file back into chat. Inspect only small chunks for sanity, then synthesize or return the artifact path directly.
- For multi-project reports, prefer returning the final synthesis directly from your reduced notes. Do not create a long draft file and then reconstruct that draft in chat via repeated `read_fragment` calls.
- If you wrote the report yourself in the current chat, you already know its contents. Do not reread it in chunks. Go straight to the final answer or straight to the PDF helper.
- When creating a local report file for the parent task, keep tool stdout to a one-line success message or output path. Do not print the full report body from bash or python.

Bad:

```text
agent_vm_bash("cat /work/.mcp-overflow/glean_read_document.json | jq -r '.documents[4].snippets[]'")
```

Good:

```text
agent_vm_execute_skill_script(... compact_glean_payload.py ...)
agent_vm_read_fragment(path="/work/glean/compact.json", offset=0, max_chars=1500)
```

For Google Docs discovered through Glean:

```text
google_workspace_extract_document_summary(document_id="...")
agent_vm_execute_skill_script(
  skill_name="company-knowledge",
  script_name="scripts/compact_google_workspace_payload.py",
  vm_id="<vm_id>",
  args=["--input", "/work/.mcp-overflow/<file>.json", "--query", "requirements", "--query", "quarter", "--query", "blocker", "--output", "/work/doc-summary.json"]
)
google_workspace_get_doc_content(document_id="...")
agent_vm_execute_skill_script(
  skill_name="company-knowledge",
  script_name="scripts/extract_markdown_sections.py",
  vm_id="<vm_id>",
  args=["--input", "/work/doc.md", "--query", "requirements", "--query", "quarter", "--output", "/work/doc-sections.json"]
)
```
<!-- OPT_FLAG:company_knowledge_compact_glean_overflow_guidance END -->

## Important Notes

1. Glean indexes content — no live system access
2. Read-only — cannot perform actions
3. Always share source links from Glean results
4. For live Slack messages or GitLab MRs, use those tools directly
5. For detailed routing rules and examples, load `references/routing-and-examples.md`
