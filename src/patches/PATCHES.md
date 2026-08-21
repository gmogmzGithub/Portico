# Open WebUI Patches for Portico

This document describes all patches applied to Open WebUI for the Portico deployment.

## Patch 1: Markdown Extension (Frontend)

**File**: `frontend/src/lib/utils/marked/extension.ts`
**Purpose**: Custom markdown rendering extensions
**Marker**: `PATCHED_MARKER_v2`
**Status**: ✅ Active

## Patch 2: Tool Call History Preservation (Frontend + Backend)

### Problem
Phoenix observability platform could not track tool usage in follow-up chat requests because:
- Anthropic's structured content blocks (reasoning, toolUse, toolResult) were being flattened to plain text during database save
- Frontend was dropping contentBlocks field when sending requests to backend
- LLM received malformed chat history without proper tool_calls structure

### Solution
Store and preserve structured contentBlocks throughout the entire request/response cycle.

### Frontend Patch

**File**: `frontend/src/lib/components/chat/Chat.svelte`
**Location**: Line 1885
**Change**: Added `...(message.contentBlocks && { contentBlocks: message.contentBlocks }),`

**Before**:
```javascript
messages = messages.map((message) => ({
    role: message.role,
    ...((image content logic))
}))
```

**After**:
```javascript
messages = messages.map((message) => ({
    role: message.role,
    ...(message.contentBlocks && { contentBlocks: message.contentBlocks }),  // ← NEW
    ...((image content logic))
}))
```

**Why**: Ensures contentBlocks field is included in API requests to `/api/chat/completions`, enabling backend reconstruction.

### Backend Patches

**File**: `backend/open_webui/utils/middleware.py`

**Changes**:

1. **Added `reconstruct_anthropic_format()` function** (Line 1136-1178):
   - Reconstructs proper Anthropic message format from stored contentBlocks
   - Uses existing `convert_content_blocks_to_messages()` to build tool_calls, tool results
   - Backwards compatible - gracefully handles messages without contentBlocks

2. **Integrated reconstruction into `process_chat_payload()`** (Line 1189-1203):
   - Calls reconstruction FIRST before any middleware processing
   - Expands messages with contentBlocks into proper format
   - Logs reconstruction activity for debugging

3. **Modified message storage** (Lines 2858, 3402, 3440):
   - Saves BOTH `content` (HTML for UI) AND `contentBlocks` (structured data)
   - Three save locations: realtime save, completion save, cancellation save
   - Database stores:
     ```python
     {
         "content": serialize_content_blocks(content_blocks),  # UI display
         "contentBlocks": content_blocks  # API reconstruction
     }
     ```

### Custom Callbacks Enhancement

**File**: `src/bifrost-bridge-rust/`
**Location**: Line 306-316
**Change**: Added logging to track tool_calls in requests for debugging

## Data Flow

### Complete Request/Response Cycle

**Turn 1** (Initial tool call):
```
User message → Backend → LLM generates tool call
→ Streaming response builds content_blocks
→ Saved to DB: {content: "HTML", contentBlocks: [...]}
```

**Turn 2** (Follow-up message):
```
User message → Frontend retrieves chat from DB
→ Frontend sends request WITH contentBlocks ✅
→ Backend reconstruct_anthropic_format() ✅
→ Expands: 1 message → 3 messages (assistant + tool + assistant)
→ Proper Anthropic format sent to Bedrock ✅
→ Phoenix can track tool usage ✅
```

## Benefits

- ✅ Phoenix can track tool usage across entire conversations
- ✅ LLM receives proper context with structured tool calls, reasoning, results
- ✅ Follows Anthropic message format specification
- ✅ Enables full observability tracking
- ✅ Backwards compatible with existing chats
- ✅ No database schema migration required

## Build Integration

### Dockerfile Verification

**File**: `Dockerfile.open-webui-patched`

**Verification Steps** (Lines 27-33):
1. Checks extension.ts patch (PATCHED_MARKER_v2)
2. Checks Chat.svelte patch (contentBlocks preservation comment)
3. Build fails if patches are missing

### Directory Structure

```
src/patches/
├── frontend/
│   └── src/lib/
│       ├── components/chat/
│       │   └── Chat.svelte           # Tool call history patch
│       └── utils/marked/
│           └── extension.ts          # Markdown extension patch
└── backend/open_webui/utils/
    └── middleware.py                  # Backend reconstruction & storage
```

## Testing

### Verification Steps

1. **Build image**: `docker-compose build open-webui`
2. **Check logs**: Look for patch verification messages during build
3. **Runtime test**: Make tool call → send follow-up → check logs
4. **Phoenix**: Verify tool usage tracking in follow-up requests

### Expected Log Output

During build:
```
✓ extension.ts patch verified (PATCHED_MARKER_v2 found)
✓ Chat.svelte patch verified (contentBlocks preservation found)
```

During runtime (follow-up request):
```
INFO - Message reconstruction: 3 messages → 5 messages (expanded 2 from contentBlocks)
DEBUG - Reconstructing message from 3 content blocks
DEBUG - Messages: 5 total, 1 with tool_calls, 1 tool results
```

## Maintenance

### When Upgrading Open WebUI

1. Update `OPENWEBUI_VERSION` in Dockerfile
2. Re-apply patches to new version if needed
3. Run build and verify patch checks pass
4. Test tool call history functionality
5. Verify Phoenix tracking still works

### Known Compatibility

- **Tested with**: Open WebUI v0.6.41
- **Database**: SQLite/PostgreSQL (both supported)
- **Browsers**: All modern browsers
- **Backwards compatible**: Yes - old chats work unchanged

---

## Patch 3: Inline MCP Tool Images (Frontend)

**File**: `frontend/src/lib/components/chat/Messages/ResponseMessage.svelte`
**Purpose**: Render images from MCP tool results inline in the chat message
**Marker**: `PORTICO_PATCH_v1`
**Status**: ✅ Active

### Problem

When MCP tools (like `agent_vm_get_workspace_file_link`) return images, they only rendered inside the collapsible tool call details. Users wanted images to also render inline in the main chat message, similar to how assistant-generated images appear.

### Solution

Modified ResponseMessage.svelte to:
1. Remove the vanilla top-positioned image rendering (lines 668-690)
2. Add bottom-positioned image rendering after the message content
3. Support multiple MCP image formats:
   - `{type: "image", url: "..."}` - Standard MCP format
   - `{type: "data", content: "data:image/..."}` - Data URI format
   - String data URIs directly

### Changes

**Helper Functions Added** (lines 617-635):
```typescript
// Check if a file is a displayable image
function isDisplayableImage(file: any): boolean {
  if (typeof file === 'string') return file.startsWith('data:image/');
  if (typeof file === 'object' && file !== null) {
    if (file.type === 'image' && file.url) return true;
    if (file.type === 'data' && file.content?.startsWith('data:image/')) return true;
    if (file?.content_type?.startsWith('image/')) return true;
  }
  return false;
}

// Get the image source URL from various formats
function getImageSrc(file: any): string {
  if (typeof file === 'string') return file;
  if (file.type === 'image' && file.url) return file.url;
  if (file.type === 'data' && file.content) return file.content;
  if (file.url) return file.url;
  return '';
}
```

**Image Rendering Block** (after code_executions):
```svelte
{#if message?.files && message.files.length > 0}
  {@const imageFiles = getVisibleInlineImageFiles(message)}
  {#if imageFiles.length > 0}
    <div class="my-2 w-full flex overflow-x-auto gap-2 flex-wrap">
      {#each imageFiles as file}
        <div>
          <Image src={getImageSrc(file)} alt="Generated Image" />
        </div>
      {/each}
    </div>
  {/if}
{/if}
```

### Build Verification

The Dockerfile verifies this patch:
```bash
grep -q "PORTICO_PATCH" /build/src/lib/components/chat/Messages/ResponseMessage.svelte
```

### Rollback

Delete `src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte` and rebuild - the vanilla OWUI version will be used instead.

---

## Patch 4: Binary File Upload Warning Suppression (Backend)

**File**: `backend/open_webui/retrieval/loaders/main.py`
**Purpose**: Suppress "Could not detect encoding" warnings when uploading binary files (zip, etc.)
**Marker**: `PORTICO_PATCH`
**Status**: ✅ Active

### Problem

When users upload binary files like `.zip`, Open WebUI's fallback loader uses `TextLoader(file_path, autodetect_encoding=True)`. This causes the `chardet` library to log a warning: "Could not detect encoding for /app/backend/data/uploads/...zip" because it cannot detect text encoding in binary data.

### Solution

Added handling for known binary file types to return an empty document instead of attempting text extraction.

### Changes

1. **Added `known_binary_ext` list** - Extensions for archives, executables, images, audio, video, fonts, and generic binary files

2. **Added `BinaryFileLoader` class** - Returns an empty document for binary files:
   ```python
   class BinaryFileLoader:
       def __init__(self, file_path):
           self.file_path = file_path

       def load(self) -> list[Document]:
           return [Document(page_content="", metadata={"source": self.file_path})]
   ```

3. **Modified `_get_loader()` fallback chain** - Added check for binary extensions before the TextLoader fallback:
   ```python
   elif file_ext in known_binary_ext:
       loader = BinaryFileLoader(file_path)
   else:
       loader = TextLoader(file_path, autodetect_encoding=True)
   ```

### Rollback

Delete `src/patches/backend/open_webui/retrieval/loaders/main.py` and rebuild.
