---
name: code-execution
description: Execute Python scripts and bash commands in persistent Agent VMs. Use when user wants to run code, execute scripts, or perform computation.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "1.0"
  priority: high
  triggers:
    - "run python"
    - "execute code"
    - "run code"
    - "bash command"
    - "run script"
    - "execute script"
    - "run this"
    - "execute this"
    - "python script"
    - "shell command"
    - "terminal command"
    - "compute"
    - "calculate"
    - "data analysis"
    - "run the code"
    - "execute the code"
    - "create pdf"
    - "generate pdf"
    - "build pdf"
    - "pdf report"
    - "build me a pdf"
    - "generate a pdf"
required_mcp_servers:
  - "server:agent-vm"
---

# Code Execution Skill

Execute Python scripts, bash commands, and manage files in persistent Agent VMs.

## Overview

Agent VMs are persistent Docker containers that maintain state across tool calls. They're ideal for:
- Running Python scripts and data analysis
- Executing bash/shell commands
- Multi-step computational tasks
- File manipulation and processing
- Installing and using Python packages

## When to Use Code Execution

**USE Code Execution for:**
- Running Python scripts for data analysis
- Executing bash/shell commands
- File processing and manipulation
- Computational tasks (calculations, transformations)
- Installing and using Python packages
- Testing code snippets
- Creating downloadable deliverable files such as PDF reports in the chat workspace

**DO NOT use Code Execution for:**
- Web application previews with live UI (use artifacts skill instead)
- Simple questions that don't require computation
- When other specialized tools are more appropriate

## How VMs Work

1. **Automatic Creation**: A VM is automatically created for each chat session
2. **Persistence**: VMs persist for 4 hours by default
3. **Working Directory**: Files are created in `/work` by default. `/work` is the Agent VM's internal mount path for the chat's configured workspace; if the user selected a local folder, that folder is what `/work` points to inside the VM.
4. **State Preservation**: Installed packages and files persist across calls
5. **VM ID**: The VM ID is injected into your context automatically

## Getting Your VM ID

The VM ID is automatically injected into your context as:
```xml
<agent_vm id="your-vm-id-here">
```

Use this ID for all VM operations. **Do NOT call agent_vm_create** - VMs are auto-created.

## Sensitive Inputs

Never ask the user to paste API keys, tokens, passwords, private keys, or client secrets into chat. When code needs a secret, use `agent_vm_request_sensitive_information` if it is available. The tool stores the submitted value in a temporary `/work/.sensitive/...` file and returns only the file path. Use that path from code without reading, printing, echoing, summarizing, linking, or displaying the file contents.

## Available Tools

### agent_vm_bash
Execute bash commands in the VM.

**Parameters:**
- `vm_id` (required): VM GUID from your context
- `command` (required): Bash command to execute
- `working_directory`: Directory to run in (default: /work)

**Example:**
```
agent_vm_bash(
  vm_id="abc-123",
  command="pip install pandas && python --version"
)
```

### agent_vm_python
Execute Python scripts in the VM.

**Parameters:**
- `vm_id` (required): VM GUID
- `script` (required): Python code to execute
- `working_directory`: Directory to run in

**Example:**
```
agent_vm_python(
  vm_id="abc-123",
  script="""
import pandas as pd
data = {'name': ['Alice', 'Bob'], 'age': [30, 25]}
df = pd.DataFrame(data)
print(df.describe())
"""
)
```

### agent_vm_create_file / agent_vm_create_files
Create files in the VM.

**Parameters:**
- `vm_id` (required): VM GUID
- `path` or `files`: File path(s) and content

### agent_vm_read_file
Read file contents from the VM.

**Parameters:**
- `vm_id` (required): VM GUID
- `path` (required): File path to read

### agent_vm_list_files
List files in a VM directory.

**Parameters:**
- `vm_id` (required): VM GUID
- `path`: Directory path (default: /work)

### agent_vm_delete_file
Delete a file from the VM.

**Parameters:**
- `vm_id` (required): VM GUID
- `path` (required): File path to delete

### agent_vm_get_workspace_file_link
Create a local download URL for an existing file under `/work`. This tool is link-only: it does not display image previews and does not give the model image pixels.

Write deliverables directly under `/work`, then link the completed file.

**Parameters:**
- `vm_id` (required): VM GUID
- `file_path` (required): Existing file path under `/work` (e.g., `/work/chart.png`)

**Returns:**
- `markdown_link`: Markdown link for downloads
- `is_image`: Boolean indicating if file is displayable
- `visual_analysis_requires_image_input`: For displayable images, a reminder that model/subagent visual QA needs a multimodal image input, not just this markdown link

**Example:**
```
agent_vm_get_workspace_file_link(
  vm_id="abc-123",
  file_path="/work/chart.png"
)
# Returns: {"markdown_link": "[Download chart.png](http://...)", "is_image": true, ...}
```

### agent_vm_display_files
Display one or more existing `/work` files inline in the chat for the user. Use this for generated charts, preview images, screenshots, and other deliverables the user should see immediately.

**Parameters:**
- `vm_id` (required): VM GUID
- `file_paths` (required): Array of 1-20 existing file paths under `/work`

### agent_vm_request_images
Request one or more existing `/work` image files as actual image inputs for the immediate next model request. Use this when this main model must visually inspect a chart, screenshot, rendered page, or preview. It does not display files to the user.

**Parameters:**
- `vm_id` (required): VM GUID
- `file_paths` (required): Array of 1-20 existing image file paths under `/work`; each image must fit the inline image size limit

## Example Workflows

### Data Analysis with Visualization
```
User: "Analyze this data: [1, 4, 9, 16, 25]"

1. Skill auto-activates (triggers: "data analysis")
2. Read VM ID from <agent_vm> context
3. agent_vm_python(vm_id="abc-123", script="""
   import statistics
   import matplotlib.pyplot as plt

   data = [1, 4, 9, 16, 25]
   print(f"Mean: {statistics.mean(data)}")
   print(f"Median: {statistics.median(data)}")
   print(f"Std Dev: {statistics.stdev(data)}")

   # Generate visualization
   plt.figure(figsize=(8, 5))
   plt.bar(range(len(data)), data)
   plt.title('Data Visualization')
   plt.xlabel('Index')
   plt.ylabel('Value')
   plt.savefig('/work/analysis.png', dpi=100, bbox_inches='tight')
   """)
4. agent_vm_display_files(vm_id="abc-123", file_paths=["/work/analysis.png"])
5. Return statistics and a concise note about the visualization
```

### Installing Packages
```
User: "I need to use numpy for some calculations"

1. Skill auto-activates
2. agent_vm_bash(vm_id="abc-123", command="pip install numpy")
3. Confirm installation
4. agent_vm_python with numpy code
```

### File Processing
```
User: "Create a Python script that processes CSV files"

1. Skill auto-activates (triggers: "python script")
2. agent_vm_create_file(vm_id="abc-123", path="process_csv.py", content="...")
3. agent_vm_bash(vm_id="abc-123", command="python process_csv.py")
4. Return output
```

## Displaying Generated Images (IMPORTANT)

When code generates images (matplotlib plots, charts, visualizations, etc.), you **MUST**:

1. **Save the image to a file** in the VM
2. **Display it inline** using `agent_vm_display_files`
3. Use `agent_vm_get_workspace_file_link` only when you also need a download link.

**NEVER make users ask to see generated images.** Always display them automatically.

For visual QA or image analysis by this main model, call `agent_vm_request_images` with the workspace image path before describing visual details. For delegated visual QA, pass the workspace image URL as an actual image input via `subagents_run_subagent(image_urls=[...])`.

### Complete Example: Data Visualization
```
User: "Create a bar chart of sales data"

1. agent_vm_python(vm_id="abc-123", script="""
   import matplotlib.pyplot as plt

   sales = {'Q1': 100, 'Q2': 150, 'Q3': 200, 'Q4': 180}
   plt.figure(figsize=(8, 5))
   plt.bar(sales.keys(), sales.values())
   plt.title('Quarterly Sales')
   plt.savefig('/work/sales_chart.png', dpi=100, bbox_inches='tight')
   print("Chart generated")
   """)

2. agent_vm_display_files(
     vm_id="abc-123",
     file_paths=["/work/sales_chart.png"]
   )
   # Renders the generated chart inline in the chat.

3. Summarize the chart without adding a separate Markdown image.
```

### Supported Image Formats
- PNG, JPG/JPEG, GIF, WebP, SVG, BMP
- Maximum size: 5MB for inline display
- Larger files receive download links instead

### Best Practice
Always chain these operations when generating visualizations:
1. Generate image → 2. Call `agent_vm_display_files` → 3. Optionally call `agent_vm_get_workspace_file_link` for a download link

**Do NOT wait for the user to ask to see results.**

## Deliverable Files (CRITICAL)

When a user asks you to create a downloadable file deliverable such as a PDF,
CSV, JSON, Markdown, or HTML report:

1. Prefer creating the file locally in Agent VM.
2. Save the file under `/work` in the VM.
3. Use `agent_vm_display_files` for files that should appear inline, and `agent_vm_get_workspace_file_link` for ordinary download links.

When you create a local artifact for your own drafting or synthesis:

1. Do **not** reread the full generated artifact back into chat with repeated `agent_vm_read_fragment` calls.
2. Validate it with file metadata, a tiny preview, or a targeted check only.
3. If you need confidence the file looks right, inspect at most `1-2` small chunks or run local code to verify headings/row counts/section presence.
4. Keep large intermediate data and long draft text in the VM whenever possible; do not pipe it back through the model unless the user explicitly needs that exact text in chat.

Examples:

- Good: generate `/work/report.md`, maybe inspect the first `800-1200` chars once, then return the workspace link or a concise summary.
- Bad: generate `/work/report.md` and then walk the entire file in `2k` chunks to reconstruct it in chat.

Do **not** default to remote file creation in services like Google Drive or
Google Docs unless the user explicitly asks for a cloud-hosted document.

For PDF deliverables, do not start with local `reportlab` generation when
`office-artifact-workflow` or `anthropic-agent-skills/pdf` is available. First
follow `office-artifact-workflow` and activate `anthropic-agent-skills/pdf`.
Use Agent VM or `reportlab` only as a fallback when the PDF marketplace skill is
unavailable, activation fails, or the activated PDF skill explicitly directs
local generation. In that fallback path, link the resulting `.pdf` from `/work`.

When generating PDFs:

- Keep the success path minimal. Print the output path and basic summary only.
- Do not add extra file-size or filesystem checks unless they are necessary.
- If you do reference modules like `os`, `pathlib`, or `glob`, import them
  explicitly before use.

## Pre-installed Packages

The Agent VM comes with common packages pre-installed:
- Python 3.x with pip
- Standard library (json, csv, os, sys, etc.)
- reportlab (PDF generation)
- Common utilities (curl, wget, git)

For other packages, use `pip install <package>` first.

## Important Notes

1. **VM ID is Required**: Always extract the vm_id from your `<agent_vm>` context
2. **Don't Create VMs**: VMs are auto-created; never call `agent_vm_create`
3. **For Web Apps**: Use the artifacts skill instead for live UI previews
4. **Persistence**: Files and packages persist for the session (4 hours)
5. **Resource Limits**: VMs have memory and CPU limits; be efficient
6. **No Network by Default**: VMs may have limited network access

## Code Execution vs Artifacts

| Need | Use This Skill | Use Artifacts Skill |
|------|---------------|---------------------|
| Run Python calculations | Yes | No |
| Data analysis | Yes | No |
| File processing | Yes | No |
| Live web app preview | No | Yes |
| Interactive UI | No | Yes |
| React/Vue/Vite apps | No | Yes |
