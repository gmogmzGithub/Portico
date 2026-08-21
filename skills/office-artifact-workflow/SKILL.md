---
name: office-artifact-workflow
description: Route slides, slide decks, slidedecks, presentations, PowerPoint, PPTX, Word documents, DOCX, Google Docs, Google Doc, Google documents, spreadsheets, Excel, XLSX, Google Slides, Google Sheets, PDFs, and close variants to the correct Office artifact skill and Google Drive workflow. New Office deliverables always end with a Google Drive upload and an open-in-Google link as the final handoff.
metadata:
  priority: high
  triggers:
    - slides
    - deck
    - slide deck
    - slidedeck
    - presentation
    - powerpoint
    - PPT
    - pptx
    - Google Slides
    - doc
    - docx
    - Word
    - Word document
    - Word doc
    - Google Docs
    - Google Doc
    - google doc
    - Google document
    - google document
    - Create a beautiful google doc
    - new Google Doc
    - Google Slides deck
    - Google Sheets workbook
    - spreadsheet
    - spreadsheets
    - Excel
    - xls
    - xlsx
    - Google Sheets
    - Google Sheet
    - PDF
    - pdf
required_mcp_servers: []
---

# Office Artifact Workflow

Use this as a routing skill for Office-style deliverables. It does not replace the format-specific marketplace skills; it tells you which one to activate first, how to visually verify rendered artifacts, and how to hand new Google Docs, Slides, or Sheets-style deliverables to Google Drive.

This skill applies to prompts such as "Create a beautiful google doc", "make a new Google Doc", "create a Google document", "build a Google Slides deck", and "create a Google Sheets workbook".

## Format Routing

Before creating or editing an Office-style artifact, activate the matching installed Anthropic marketplace skill when it is available:

- Slides, slide decks, presentations, PowerPoint, PPT, or PPTX: `anthropic-agent-skills/pptx`
- Word documents, Word docs, DOC, or DOCX: `anthropic-agent-skills/docx`
- Spreadsheets, Excel, XLS, or XLSX: `anthropic-agent-skills/xlsx`
- PDFs or PDF forms/reports: `anthropic-agent-skills/pdf`

For any PDF task, including creating, editing, filling, analyzing, or generating
a PDF report, this route is mandatory when `anthropic-agent-skills/pdf` appears
in `<available_skills>`. Before doing PDF work, call
`skills_activate_skill(skill_name="anthropic-agent-skills/pdf", chat_id="<chat_id>")`
using the injected `Chat ID: {id}` value, then follow the activated PDF skill.

If the exact marketplace skill is not present in `<available_skills>` or cannot be activated, say that briefly and use the best available local fallback.

Agent VM or `reportlab` PDF generation is a fallback for PDF work only when
`anthropic-agent-skills/pdf` is unavailable, activation fails, or the activated
PDF skill explicitly directs you to generate locally.

## User Questions

If you have any question for the user before creating or editing an Office-style artifact, use `skills_ask_user_question` with `chat_id` from the injected `Chat ID: {id}` line. Do not ask a numbered inline clarification bundle in chat.

Compress questions into 1-5 single-choice modal questions with concrete, distinct options. Do not provide options whose only purpose is for the user to describe, specify, or customize the answer in notes; open-ended details belong in freeform notes through the built-in `Something else` choice.

## Mandatory Drive Handoff for New Office Deliverables

EVERY new Office-document deliverable — slide decks / presentations / PowerPoint / PPTX, Word documents / DOCX, and spreadsheets / Excel / XLSX — MUST end with a Google Drive upload, whether or not the user mentioned Google. This route is mandatory by default:

1. Generate the Office artifact locally first with the matching marketplace skill: `.docx`, `.pptx`, or `.xlsx`.
2. Copy the finished file to the chat workspace.
3. Upload it to Google Drive with `google_workspace_create_drive_file(fileUrl=...)`.
4. **The FINAL message to the user MUST hand off the Google Drive link that opens the file in Google Slides, Google Docs, or Google Sheets.** Never end a task by naming a workspace file or saying the file is "in the workspace" — users generally cannot navigate to workspace files. A deck that ends with "Final file: deck.pptx in the generated workspace" is an INCOMPLETE handoff; the same deck ending with a Google Slides link is complete.

This applies at the very end of multi-step flows too (e.g. after a reviewer workflow APPROVEs): produce, review, revise — and then upload and hand the Drive link to the user as the closing action.

Direct native Google creation/editing alone is incomplete for these new polished deliverables. For example, creating a blank Google Doc and batch-editing it directly does not satisfy a "create a beautiful Google Doc" request when the Office-file-to-Drive route is available.

A workspace download link alone is never a complete handoff for a new Office deliverable unless the user explicitly asked only for a local Office file or Google Workspace is unavailable. If Google Workspace auth, server availability, or upload tooling blocks the Drive upload, say that clearly and provide the workspace download link as a fallback instead of silently skipping the Drive step.

When the `fileUrl` points at a chat workspace file and the Google Workspace MCP server must fetch it from its container, use `http://host.docker.internal:9876/workspace/...`, not `http://localhost:9876/workspace/...`.

## Existing Google Links

Do not use the local-artifact upload route when the user provides an existing Google Docs, Slides, or Sheets link and asks for direct edits to that file. In that case, use Google Workspace directly on the existing file/link.

For an existing local or uploaded `.pptx`, `.docx`, `.xlsx`, or `.pdf`, use the matching marketplace skill directly. When the deliverable handed back is a new or modified Office file, finish with the same Drive upload + open-in-Google link handoff as above; skip the upload only when the user explicitly wants just the local file or when no file deliverable is produced (e.g. an analysis or extraction answer).

## Preview Freshness

When rendering previews for iterative visual QA, use a new unique filename or versioned output directory for every render pass. Do not overwrite and relink the same workspace preview URL, because browser caching can show stale pixels.

## Visual QA

Rendered slides, document pages, spreadsheet sheet previews, PDFs, screenshots, and other artifact images must be passed to a vision-capable model as actual image inputs before you claim visual QA findings. Downloading images, copying them to the workspace, inspecting file sizes, or putting markdown image links in a prompt does not give the model pixels to inspect.

Use `agent_vm_display_files(vm_id=..., file_paths=[...])` when the user should see rendered previews or completed artifacts inline in the chat. `agent_vm_get_workspace_file_link` is link-only and does not display previews.

Use `agent_vm_request_images(vm_id=..., file_paths=[...])` when this main model must inspect rendered artifact pixels directly. The tool does not display anything to the user; it asks the backend to attach the requested workspace images as actual image inputs on the immediate next model request.

Use `subagents_run_subagent(image_urls=[...])` when delegating visual QA. Put the rendered workspace image URLs in `image_urls`, and keep the text prompt focused on the exact layout defects to find and the required output format. If a workspace image URL will be fetched from a Docker/container-backed path, use `http://host.docker.internal:9876/workspace/...`.

If a visual QA subagent call fails, returns `is_error`, or reports that images were unreachable, do not treat that as visual QA. Fix the image URL/rendering problem and retry with actual image inputs, or report the image-input blocker clearly.

`subagents_run_subagent` accepts at most 20 images per call. For artifacts with more than 20 rendered images, split the work across multiple subagents in ordered batches such as slides/pages 1-20, 21-40, and 41-60. Require each subagent to report findings with stable slide/page/sheet numbers, then merge the batch reports, dedupe repeated issues, and preserve the original artifact order.
