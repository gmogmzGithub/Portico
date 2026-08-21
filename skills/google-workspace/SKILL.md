---
name: google-workspace
description: Interact with Google Workspace services including Gmail, Google Drive, Docs, Sheets, Slides, and Calendar. Use when user needs to access, create, or manage Google Workspace content.
license: Proprietary
compatibility: Portico
metadata:
  author: Portico Team
  version: "1.4"
  priority: high
  triggers:
    - "google"
    - "calendar"
    - "meeting"
    - "meetings"
    - "agenda"
    - "invite"
    - "invites"
    - "drive"
    - "docs"
    - "document"
    - "documents"
    - "sheet"
    - "sheets"
    - "spreadsheet"
    - "spreadsheets"
    - "slide"
    - "slides"
    - "google drive"
    - "google docs"
    - "google sheets"
    - "google slides"
    - "google calendar"
    - "gmail"
    - "google workspace"
    - "list my files"
    - "list my docs"
    - "my drive"
    - "my documents"
    - "my spreadsheets"
    - "my presentations"
    - "my calendar"
    - "my emails"
    - "send email"
    - "create doc"
    - "create document"
    - "create spreadsheet"
    - "create presentation"
    - "create event"
    - "calendar event"
    - "schedule meeting"
    - "read email"
    - "check email"
    - "check calendar"
    - "drive files"
    - "shared drive"
    - "edit document"
    - "edit spreadsheet"
required_mcp_servers:
  - "server:google_workspace"
---

# Google Workspace Skill

Access and manage Google Workspace services: Gmail, Google Drive, Docs, Sheets, Slides, and Calendar.

## When to Use Google Workspace

**USE Google Workspace for:**
- Listing, searching, and managing Google Drive files
- Reading and creating Google Docs, Sheets, and Slides
- Sending, reading, and searching Gmail messages
- Creating and managing Google Calendar events
- Searching across Google Workspace content
- Uploading, opening, sharing, and linking Office artifacts that another workflow created for Google Docs, Slides, or Sheets delivery

**DO NOT use Google Workspace for:**
- Web searches (use web-search skill instead)
- Company knowledge base queries (use company-knowledge skill/Glean instead)
- Non-Google file management

### New Polished Google Deliverables

For new polished document, presentation, or spreadsheet deliverables, including requests like "Create a beautiful google doc", "make a Google Slides deck", or "create a Google Sheets workbook", follow `office-artifact-workflow` when it is available. Google Workspace is the upload/open/share step after that workflow creates the local Office file:

1. `office-artifact-workflow` creates the `.docx`, `.pptx`, or `.xlsx` artifact locally with the matching Office skill.
2. The local file is linked from the chat workspace.
3. Use Google Workspace to upload the workspace file to Drive, then return or open the Google Docs, Slides, or Sheets editor/view link.

Direct Google-native creation and editing remain appropriate for existing Google Docs, Slides, or Sheets links and simple native Workspace operations that do not require a polished Office-style artifact.

## Available Tools

Once this skill is activated, the following tool categories become available:

### Google Drive
- **google_workspace_list_drive_items** - List files in Drive
- **google_workspace_search_drive_files** - Search Drive files
- **google_workspace_get_drive_file_content** - Read Drive file content
- **google_workspace_get_drive_file_download_url** - Get a direct download URL
- **google_workspace_create_drive_file** - Upload a file to Drive from text content or a URL
- **google_workspace_share_drive_file** - Share a Drive file with users, groups, domains, or anyone
- **google_workspace_get_drive_shareable_link** - Fetch the Drive share/view link for an item

### Google Docs
- **google_workspace_get_doc_content** - Read document content
- **google_workspace_extract_document_summary** - Get a structured outline and section summary before reading/exporting full document text
- **google_workspace_export_doc_as_markdown** - Export a document to local markdown when you need one reduced local artifact for deeper analysis
- **google_workspace_create_doc** - Create a new document
- **google_workspace_modify_doc_text** - Edit document text
- **google_workspace_search_docs** - Search for documents
- **google_workspace_list_docs_in_folder** - List documents in a folder
- **google_workspace_find_and_replace_doc** - Find and replace in documents
- **google_workspace_batch_edit_doc** - Batch edit operations

### Google Sheets
- **google_workspace_create_table_with_data** - Create tables with data
- **google_workspace_modify_table** - Modify table content

### Gmail
- **google_workspace_search_gmail_messages** - Search emails
- **google_workspace_get_gmail_message_content** - Read a Gmail message
- **google_workspace_get_gmail_messages_content_batch** - Read multiple Gmail messages
- **google_workspace_get_gmail_attachment_content** - Download an attachment from a received Gmail message
- **google_workspace_send_gmail_message** - Send emails
- **google_workspace_draft_gmail_message** - Create Gmail drafts

### Google Calendar
- **google_workspace_list_calendars** - List calendars
- **google_workspace_get_events** - Get calendar events. For event listings and date-range queries, explicitly pass `max_results=300` unless the user asks for fewer.
- **google_workspace_create_event** - Create calendar events
- **google_workspace_modify_event** - Modify events
- **google_workspace_delete_event** - Delete events

## Emailing Images

Use this playbook when the user wants a generated image emailed as a link, rendered inline, or both.

### Current Gmail Limitation

Gmail inline images are now supported via the `inline_images` parameter on the send and draft tools, but the current Gmail tools still do not accept true file attachment inputs.

- If the user wants an image visible in the email body, prefer the MIME inline image pattern below.
- If the user asks for a downloadable attachment, do not pretend the tool can attach a file directly.
- For non-image files, use Drive upload plus a Drive view or download link.
- If the user wants both an inline image and a Drive link, send one HTML email with the inline image plus the Drive link.

### Approach 1 (Preferred): MIME Inline Images

Use MIME inline images for images that should render directly in the email body. This works on desktop and mobile Gmail, including iOS and Android Gmail.

- Generate the image under `/work` in Agent VM, then get a link with `agent_vm_get_workspace_file_link`.
- Pass the workspace file URL via `inline_images`; the Google Workspace MCP server fetches the image bytes server-side and builds a MIME `multipart/related` message with `Content-ID` references.
- The LLM never handles binary image data directly.
- No Drive upload, sharing, or auth workaround is needed for the inline image itself.

`inline_images` parameter:

```text
inline_images (Optional[List[Dict[str, str]]]): List of inline image specs. Each dict:
    - url (str, required): URL to fetch the image from (e.g., workspace file server URL)
    - content_id (str, required): ID to reference in HTML body via <img src="cid:<content_id>">
    - filename (str, optional): Filename. Defaults to "image.png"
    - mime_type (str, optional): MIME type. Auto-detected if not provided.
```

MIME usage rules:

- When `inline_images` is provided, `body_format` should be `"html"`.
- The HTML body should contain matching `<img src="cid:CONTENT_ID" />` tags.
- For workspace file URLs, use `http://host.docker.internal:9876/workspace/...`, not `http://localhost:9876/workspace/...`.

Inline HTML pattern:

```html
<h2>Normal Distribution Histogram</h2>
<p>Here's a histogram of a normal distribution (mu=0, sigma=1) generated from 10,000 samples:</p>
<img src="cid:chart1" alt="Normal Distribution Histogram" style="max-width:600px; width:100%;" />
<p><em>Generated via Portico.</em></p>
```

Send example:

Tool ID: `google_workspace_send_gmail_message`

```json
{
  "to": "dsantiago@example.invalid",
  "subject": "Normal Distribution Histogram",
  "body": "<h2>Normal Distribution Histogram</h2>\n<p>Here's a histogram of a normal distribution (mu=0, sigma=1) generated from 10,000 samples:</p>\n<img src=\"cid:chart1\" alt=\"Normal Distribution Histogram\" style=\"max-width:600px; width:100%;\" />\n<p><em>Generated via Portico.</em></p>",
  "body_format": "html",
  "inline_images": [
    {
      "url": "http://host.docker.internal:9876/workspace/CHAT_ID/histogram.png",
      "content_id": "chart1",
      "filename": "normal_distribution_histogram.png"
    }
  ]
}
```

### Approach 2 (Fallback): Drive-Hosted Images

Use this only when the user also wants a Drive-hosted copy or link, or when you specifically need the existing Drive-hosted inline pattern. This inline rendering pattern works in desktop Gmail, but it does not work reliably in iOS/Android Gmail because the mobile Gmail image proxy cannot authenticate to the Drive-hosted image.

#### Workspace Artifact To Drive Upload

When `google_workspace_create_drive_file(fileUrl=...)` needs to fetch a file from the chat workspace server, do not use `localhost:9876`. That URL works for user-facing browser links, but it does not work from the containerized Google Workspace MCP server.

- Bad for Drive upload from the MCP container: `http://localhost:9876/workspace/...`
- Good for Drive upload from the MCP container: `http://host.docker.internal:9876/workspace/...`

Bad:

Tool ID: `google_workspace_create_drive_file`

```json
{
  "file_name": "normal_distribution_histogram.png",
  "mime_type": "image/png",
  "fileUrl": "http://localhost:9876/workspace/6e47fd47-b879-4390-aa53-a12ec4c52ef1/histogram.png"
}
```

```json
{
  "is_error": true,
  "message": "Error calling tool 'create_drive_file': An unexpected error occurred in create_drive_file: All connection attempts failed",
  "content": "Error calling tool 'create_drive_file': An unexpected error occurred in create_drive_file: All connection attempts failed"
}
```

Good:

Tool ID: `google_workspace_create_drive_file`

```json
{
  "fileUrl": "http://host.docker.internal:9876/workspace/6e47fd47-b879-4390-aa53-a12ec4c52ef1/histogram.png",
  "file_name": "normal_distribution_histogram.png",
  "mime_type": "image/png"
}
```

```json
{
  "result": "Successfully created file 'normal_distribution_histogram.png' (ID: 1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG) in folder 'root' for dsantiago@example.invalid. Link: https://drive.google.com/file/d/1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG/view?usp=drivesdk"
}
```

Retry rule:

- If `create_drive_file` fails with `All connection attempts failed` and the `fileUrl` points at the workspace server on `localhost:9876`, retry with the same path on `host.docker.internal:9876`.
- `file://` only works when the file path exists inside the Google Workspace MCP container or a mounted host path. Agent VM paths like `/work/...` are not directly visible there.

#### Sharing For Inline Image Rendering

Inline image rendering depends on the Drive file being readable by the recipient's mail client. For Portico-managed accounts, public sharing may be blocked by org policy.

Bad:

Tool ID: `google_workspace_share_drive_file`

```json
{
  "file_id": "1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG",
  "share_type": "anyone",
  "role": "reader",
  "send_notification": false
}
```

```json
{
  "is_error": true,
  "message": "Error calling tool 'share_drive_file': API error in share_drive_file: <HttpError 400 when requesting https://www.googleapis.com/drive/v3/files/1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG/permissions?supportsAllDrives=true&fields=id%2C+type%2C+role%2C+emailAddress%2C+domain%2C+expirationTime&alt=json returned \"Bad Request. User message: \\\"\\\"\". Details: \"[{'message': 'Bad Request. User message: \\\"\\\"', 'domain': 'global', 'reason': 'publishOutNotPermitted'}]\">",
  "content": "Error calling tool 'share_drive_file': API error in share_drive_file: <HttpError 400 when requesting https://www.googleapis.com/drive/v3/files/1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG/permissions?supportsAllDrives=true&fields=id%2C+type%2C+role%2C+emailAddress%2C+domain%2C+expirationTime&alt=json returned \"Bad Request. User message: \\\"\\\"\". Details: \"[{'message': 'Bad Request. User message: \\\"\\\"', 'domain': 'global', 'reason': 'publishOutNotPermitted'}]\">"
}
```

Good:

Tool ID: `google_workspace_share_drive_file`

```json
{
  "file_id": "1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG",
  "role": "reader",
  "share_type": "domain",
  "share_with": "example.invalid",
  "send_notification": false
}
```

```json
{
  "result": "Successfully shared 'normal_distribution_histogram.png'\n\nPermission created:\n  - Domain: example.invalid (reader) [id: 18427185724170032413]\n\nView link: https://drive.google.com/file/d/1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG/view?usp=drivesdk"
}
```

Sharing rule:

- If `share_type="anyone"` fails with `publishOutNotPermitted`, retry with `share_type="domain"`, `share_with="example.invalid"`, `role="reader"`, and `send_notification=false`.

#### Gmail-Safe Inline Image URL

Use this Drive-hosted inline pattern only as a fallback for desktop Gmail rendering.

Do not use the normal Drive `uc?id=` URL for Gmail inline images. Gmail's image proxy may fail on the redirect flow.

- Bad for inline Gmail rendering: `https://drive.google.com/uc?id=FILE_ID`
- Good for inline Gmail rendering: `https://lh3.googleusercontent.com/d/FILE_ID`

Inline HTML pattern:

```html
<h2>Normal Distribution Histogram</h2>
<p>Here's a histogram of a normal distribution (mu=0, sigma=1) generated from 10,000 samples:</p>
<img src="https://lh3.googleusercontent.com/d/FILE_ID" alt="Normal Distribution Histogram" style="max-width:600px; width:100%;" />
<p><strong>Google Drive link:</strong> <a href="https://drive.google.com/file/d/FILE_ID/view?usp=drivesdk">normal_distribution_histogram.png</a></p>
<p><em>Generated via Portico.</em></p>
```

Send example:

Tool ID: `google_workspace_send_gmail_message`

```json
{
  "to": "dsantiago@example.invalid",
  "subject": "Normal Distribution Histogram",
  "body": "<h2>Normal Distribution Histogram</h2>\n<p>Here's a histogram of a normal distribution (mu=0, sigma=1) generated from 10,000 samples:</p>\n<img src=\"https://lh3.googleusercontent.com/d/1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG\" alt=\"Normal Distribution Histogram\" style=\"max-width:600px; width:100%;\" />\n<p><strong>Google Drive link:</strong> <a href=\"https://drive.google.com/file/d/1iSSW0VsBEP5ied5AzQFCtU_oTKoAnKvG/view?usp=drivesdk\">normal_distribution_histogram.png</a></p>\n<p><em>Generated via Portico.</em></p>",
  "body_format": "html"
}
```

### Preferred Sequence For Emailing Generated Images

When the source image was created in Agent VM:

1. Generate the image under `/work`, then get a link with `agent_vm_get_workspace_file_link(vm_id="...", file_path="/work/...")`.
2. Send the email or draft with `inline_images` using `http://host.docker.internal:9876/workspace/...` URLs and matching `<img src="cid:CONTENT_ID" ...>` tags in the HTML body.
3. If the user also wants a Drive copy or link, upload the image to Drive and include the Drive link in the email body.

## Handling Large Calendar Responses

When retrieving many calendar events (e.g., `max_results=300`), the response may exceed inline limits and be saved to an overflow file.

### Overflow File Detection

When a response is too large, you'll receive:
```json
{
  "overflow_file": true,
  "path": "/work/.mcp-overflow/2026-03-12T16-10-19Z-google_workspace_get_events-4b50b912.json",
  "vm_id": "a6daff3d-f5c5-45d2-a4d0-c5cfc19a42a6",
  "tool_name": "google_workspace_get_events",
  "char_count": 214000
}
```

**Key indicators:**
- `overflow_file: true` 
- `path` points to `/work/.mcp-overflow/` directory
- `vm_id` indicates which Agent VM to use for parsing
- `char_count` shows total size of the data

### Parsing Large Responses

The overflow file contains a JSON structure with a `result` field containing formatted text output of all events. Use these approaches:

**Method 1: Quick Extract with grep (Fastest)**
```bash
# Extract all meeting titles and start times
cat /work/.mcp-overflow/FILE.json | jq -r '.result' | grep -E "^- \".*\" \(Starts:"

# Get first 50 meetings
cat /work/.mcp-overflow/FILE.json | jq -r '.result' | grep -E "^- \".*\" \(Starts:" | head -50

# Count total meetings
cat /work/.mcp-overflow/FILE.json | jq -r '.result' | grep -c "^- \""
```

**Method 2: Filter by Keywords**
```bash
# Find leadership or important meetings
cat /work/.mcp-overflow/FILE.json | jq -r '.result' | grep -iE "leadership|calibration|executive|review"

# Extract meetings with attendee information
cat /work/.mcp-overflow/FILE.json | jq -r '.result' | grep -A3 "Starts:" | grep "Attendees:"
```

**Method 3: Read in Chunks (For Very Large Files)**
```python
# Read first chunk
result = read_fragment(
    path="/work/.mcp-overflow/FILE.json",
    vm_id="...",
    offset_chars=0,
    max_chars=1500
)

# Continue reading if truncated
if result['truncated']:
    next_chunk = read_fragment(
        path="/work/.mcp-overflow/FILE.json",
        vm_id="...",
        offset_chars=result['next_offset_chars'],
        max_chars=1500
    )
```

### Handling Large Docs And Drive Payloads

- If `google_workspace_get_doc_content` or `google_workspace_get_drive_file_content` overflows, do not dump the raw overflow file.
- Start with `google_workspace_extract_document_summary` before `google_workspace_get_doc_content` or `google_workspace_export_doc_as_markdown` when you only need headings, scope, and likely relevant sections.
- Prefer inspecting reduced artifacts or `read_fragment(..., max_chars<=2000)` slices over large raw reads.
- When a Google document is only supporting evidence for a larger company-knowledge task, summarize it into a reduced local artifact before continuing.

### Identifying Important Meetings

When analyzing meetings for importance, consider these indicators:

**🔴 Critical Meetings:**
1. **Performance/Calibration Sessions**
   - Keywords: "Calibration", "PE", "Performance Enablement", "Performance Review"
   - Often appear in series (e.g., "1 of 2", "2 of 2")
   - Multiple manager participants

2. **Executive/Leadership Reviews**
   - Keywords: "Executive", "Leadership", "Review", "Strategic"
   - High attendee counts (10+ people)
   - Senior leaders in attendee list

3. **1:1s with Direct Manager**
   - Manager's name in title (e.g., "dionny : heather")
   - Typically 30-minute recurring slots
   - Check organizer field

**🟡 Important Meetings:**
1. **Leadership Syncs**
   - Keywords: "Leadership Sync", "Leads Sync", "Directors Meeting"
   - Cross-functional coordination
   - Multiple senior team members

2. **Direct Reports 1:1s**
   - Your direct reports' names in title
   - Recurring weekly or bi-weekly
   - You as organizer

3. **Cross-Team Coordination**
   - Multiple team distribution lists
   - Project handoffs or reviews
   - Demo sessions with stakeholders

**🟢 Regular/Routine:**
1. **Daily Standups**
   - Keywords: "Standup", "Daily Sync", "Scrum"
   - 15-30 minute duration
   - Daily recurrence

2. **Focus Time**
   - Self-scheduled blocks
   - No attendees
   - Longer blocks (1-3 hours)

### Parsing Patterns for Analysis

```bash
# Extract critical meetings
cat overflow.json | jq -r '.result' | grep -iE "calibration|executive|leadership.*review|strategic"

# Find 1:1 meetings (pattern: "name : name" or "name / name")
cat overflow.json | jq -r '.result' | grep -E "\"[A-Z][a-z]+ [:/↔] [A-Z][a-z]+\""

# Find meetings with many attendees
cat overflow.json | jq -r '.result' | grep -B2 "Attendees:.*,.*,.*," | grep "^- \""

# Extract today's meetings
TODAY=$(date +%Y-%m-%d)
cat overflow.json | jq -r '.result' | grep "Starts: $TODAY"

# Find accepted meetings only
cat overflow.json | jq -r '.result' | grep -B10 "dsantiago@example.invalid: accepted" | grep "^- \""
```

## Example Workflows

### List Drive Files
```
User: "List my Google Drive files"

1. Skill auto-activates (triggers: "google drive", "list my files")
2. Use google_workspace_list_drive_items()
3. Return file listing
```

### Send Email
```
User: "Send an email to john@example.com about the meeting"

1. Skill auto-activates (triggers: "send email")
2. Use google_workspace_send_gmail_message(to="john@example.com", subject="Meeting", body="...")
3. Confirm sent
```

### Email A Drive Link To An Image
```
User: "Email me the histogram as a Drive link"

1. Upload the workspace image with google_workspace_create_drive_file(
     fileUrl="http://host.docker.internal:9876/workspace/CHAT_ID/histogram.png",
     file_name="normal_distribution_histogram.png",
     mime_type="image/png"
   )
2. Extract FILE_ID from the upload result
3. Use google_workspace_send_gmail_message(
     to="user@example.com",
     subject="Normal Distribution Histogram",
     body="<p><strong>Google Drive link:</strong> <a href=\"https://drive.google.com/file/d/FILE_ID/view?usp=drivesdk\">normal_distribution_histogram.png</a></p>",
     body_format="html"
   )
4. Confirm sent
```

### Email An Inline Image (MIME - Works Everywhere)
```
User: "Email me the histogram"

1. agent_vm_get_workspace_file_link(
     vm_id="VM_ID",
     file_path="/work/histogram.png"
   )
2. google_workspace_send_gmail_message(
     to="user@example.com",
     subject="Histogram",
     body='<h2>Histogram</h2><img src="cid:chart1" style="max-width:600px; width:100%;" />',
     body_format="html",
     inline_images=[{"url": "http://host.docker.internal:9876/workspace/CHAT_ID/histogram.png", "content_id": "chart1", "filename": "histogram.png"}]
   )
3. Confirm sent
```

### Draft With Inline Image
```
User: "Draft an email with the chart"

1. Copy image to workspace
2. google_workspace_draft_gmail_message(
     body='<h2>Report</h2><img src="cid:mychart" />',
     body_format="html",
     inline_images=[{"url": "http://host.docker.internal:9876/workspace/.../chart.png", "content_id": "mychart", "filename": "chart.png"}]
   )
3. Confirm draft created
```

### Email Inline Image + Drive Link (both)
```
User: "Email me the histogram inline and include a Drive link"

1. Get a workspace file link + upload to Drive
2. Extract FILE_ID from the Drive upload result
3. google_workspace_send_gmail_message(
     to="user@example.com",
     subject="Histogram",
     body='<h2>Histogram</h2><img src="cid:chart1" style="max-width:600px; width:100%;" /><p><a href="https://drive.google.com/file/d/FILE_ID/view?usp=drivesdk">Open in Drive</a></p>',
     body_format="html",
     inline_images=[{"url": "http://host.docker.internal:9876/workspace/CHAT_ID/histogram.png", "content_id": "chart1", "filename": "histogram.png"}]
   )
4. Confirm sent
```

### Check Calendar with Large Response
```
User: "What meetings do I have this week?"

1. Skill auto-activates (triggers: "check calendar")
2. Calculate week range (Monday to Sunday)
3. Use google_workspace_get_events(
     max_results=300,
     time_min="2026-03-09T00:00:00-04:00",
     time_max="2026-03-15T23:59:59-04:00",
     detailed=True
   )
4. If overflow_file=true:
   - Parse with jq/bash in Agent VM
   - Extract key information
   - Format results
5. Present meeting listing
```

### Identify Important Meetings
```
User: "What are my most important meetings this week?"

1. Fetch events with max_results=300
2. Check for overflow_file=true
3. Parse overflow file:
   - Extract all meeting titles/times
   - Filter for leadership keywords
   - Identify 1:1s with manager
   - Find calibration sessions
   - Check attendee counts
4. Categorize by priority:
   - Critical: PE calibrations, exec reviews, manager 1:1
   - Important: Leadership syncs, direct report 1:1s, key projects
   - Regular: Standups, focus time
5. Present categorized results with context
```

### Complete Parsing Example
```python
# Step 1: Fetch events
result = google_workspace_get_events(
    calendar_id="primary",
    max_results=300,
    time_min="2026-03-09T00:00:00-04:00",
    time_max="2026-03-15T23:59:59-04:00",
    detailed=True
)

# Step 2: Check for overflow
if result.get('overflow_file'):
    overflow_path = result['path']
    vm_id = result['vm_id']
    
    # Step 3: Extract meeting titles
    bash(
        vm_id=vm_id,
        command=f"cat {overflow_path} | jq -r '.result' | grep -E '^- \".*\" \\(Starts:' | head -50"
    )
    
    # Step 4: Find important meetings
    bash(
        vm_id=vm_id,
        command=f"cat {overflow_path} | jq -r '.result' | grep -iE 'calibration|leadership|executive'"
    )
```

## Important Notes

1. **OAuth Required** - Google Workspace requires OAuth authentication. If not configured, direct the user to Settings → MCP Integrations to enable and authenticate.

2. **Scope** - Only accesses content the authenticated user has permission to view/edit.

3. **Privacy** - Do not share or expose email content or private documents without explicit user consent.

4. **Email Attachments** - Inline images are supported via `inline_images`, but the current Gmail send and draft tools still do not accept true file attachments. When the user asks for a downloadable attachment, say that direct attachments are not currently supported. For inline email images, use `inline_images`. For non-image files, use a Drive link.

5. **Inline Images** - Prefer MIME inline images via `inline_images` over Drive-hosted inline images. MIME inline images work in desktop and mobile Gmail, including iOS and Android. Use matching `cid:` references in the HTML body.

6. **Workspace File Server Bridge** - For `google_workspace_create_drive_file(fileUrl=...)` or `inline_images[].url` against the workspace file server, rewrite `localhost:9876` to `host.docker.internal:9876` before calling the tool.

7. **Drive Sharing** - If public sharing fails with `publishOutNotPermitted`, retry with a domain share for `example.invalid`.

8. **Calendar Fetch Size** - For `google_workspace_get_events` list/range retrievals, do not rely on the tool default. Explicitly pass `max_results=300` unless the user requested a smaller number or you are retrieving a single event by `event_id`.

9. **Overflow Handling** - Large responses (>200KB) automatically save to overflow files. Always check for `overflow_file: true` in responses and use Agent VM tools (jq, bash, grep) to parse them efficiently.

10. **Date Ranges** - Use RFC3339 format for time_min/time_max (e.g., "2026-03-09T00:00:00-04:00"). Calculate week/month ranges based on current date.

11. **Performance** - Use grep and head to limit output. Extract only what you need. Don't process all 300 events if user only wants today's meetings.

12. **Meeting Analysis** - When identifying "important" meetings, consider: keywords, attendee counts, organizer seniority, meeting duration, and acceptance status.

## Common Patterns

### Weekly Calendar Summary
```bash
# Get this week's meetings
time_min="$(date -d 'last monday' '+%Y-%m-%dT00:00:00-04:00')"
time_max="$(date -d 'next sunday' '+%Y-%m-%dT23:59:59-04:00')"

# Fetch and parse
google_workspace_get_events(max_results=300, time_min=time_min, time_max=time_max)
# If overflow, parse with jq/grep
```

### Find Manager 1:1
```bash
# Pattern: lowercase manager name in title
cat overflow.json | jq -r '.result' | grep -i "heather" | grep "Starts:"
```

### Count Daily Meetings
```bash
# Group by date
cat overflow.json | jq -r '.result' | grep "Starts: 2026-03" | cut -d' ' -f3 | cut -dT -f1 | sort | uniq -c
```

### Extract Meeting URLs
```bash
# Get Zoom/Google Meet links
cat overflow.json | jq -r '.result' | grep -E "zoom.us|meet.google.com"
```

## Troubleshooting

### Overflow file not found
- Path is temporary and chat-specific
- Use exact path from response
- File expires with chat session

### Empty results from grep
- Verify you're reading `.result` field: `jq -r '.result'`
- Try case-insensitive: `grep -i`
- Check file was read: `cat overflow.json | head`

### jq errors
- Use `jq -r` for raw string output
- `.result` contains formatted text, not structured JSON
- Don't try to parse as JSON after extracting `.result`

## Performance Tips

1. **Filter early** - Use grep before processing to reduce data
2. **Limit output** - Use head/tail to get only what you need
3. **Reuse paths** - Cache overflow_path and vm_id for multiple queries
4. **Combine filters** - Chain grep pipes for complex searches
5. **Check size first** - Use char_count to estimate processing time
