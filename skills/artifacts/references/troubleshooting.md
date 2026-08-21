# Artifact Troubleshooting Guide

## Common Issues and Solutions

### 1. Server Won't Start

**Symptoms:**
- Artifact status shows "error"
- Preview shows connection refused

**Solutions:**
1. **Check the start command:**
   ```bash
   # In the VM, try running the command manually
   agent_vm_bash(vm_id, "cd /work && npm run dev -- --host")
   ```

2. **Verify dependencies are installed:**
   ```bash
   agent_vm_bash(vm_id, "cd /work && npm install")
   ```

3. **Check for port binding:**
   - Many dev servers only bind to localhost by default
   - Add `--host` flag for Vite/Vue CLI
   - Add `--host 0.0.0.0` for Angular

### 2. Preview Shows Blank Page

**Possible Causes:**
- Server is still compiling
- JavaScript errors in the app
- Wrong port specified

**Solutions:**
1. Wait 5-10 seconds for initial compilation
2. Check browser console in detached window mode
3. Verify container_port matches what the server uses

### 3. Changes Not Appearing

**Solutions:**
1. Use the refresh button in the artifact panel
2. Verify files were saved correctly:
   ```bash
   agent_vm_bash(vm_id, "cat /work/src/App.jsx")
   ```
3. Check if hot reload is working in the server

### 4. Port Allocation Failures

**Symptoms:**
- artifacts_create_artifact returns "No available ports"

**Solutions:**
1. Close unused artifacts to release ports
2. Check for stale port allocations:
   - The system auto-cleans ports not in use
   - If persistent, restart the MCP infrastructure

### 5. Version Restore Problems

**Note:** Snapshots exclude large directories to save space:
- `node_modules`
- `.git`
- `dist`/`build`
- `.next`/`.nuxt`

**After restoring a version:**
```bash
agent_vm_bash(vm_id, "cd /work && npm install")
```

### 6. Cannot Detach to Separate Window

**Solutions:**
1. Ensure Electron app has permission for multiple windows
2. Try closing and reopening the artifact
3. Check if webview is properly initialized

## Diagnostic Commands

### Check Artifact Status
```
artifacts_get_artifact_status(artifact_id="...")
```

Returns:
- Current status (stopped/starting/running/error)
- Preview URL if running
- Current version info
- Error messages if any

### List All Artifacts
```
artifacts_list_artifacts(chat_id="...", include_all_versions=true)
```

### Check Server Logs in VM
```bash
agent_vm_bash(vm_id, "cat /tmp/server.log")
```

## Network Considerations

### Port Range
- Artifacts use ports 10000-19999
- All ports are bound to 127.0.0.1 only (localhost)
- No external network access from artifact VMs

### Firewall
- Only localhost can access artifact previews
- This is by design for security

## Recovery Steps

### If artifact is stuck in "starting" state:
1. Close the artifact: `artifacts_close_artifact(artifact_id)`
2. Wait a moment
3. Reopen: `artifacts_open_artifact(artifact_id)`

### If artifact won't delete:
1. Stop the artifact first: `artifacts_close_artifact(artifact_id)`
2. Then delete: `artifacts_delete_artifact(artifact_id, chat_id, confirm=true)`

### If VM is unresponsive:
1. Destroy the VM: `agent_vm_destroy(vm_id, requester_chat_id)`
2. Create a new VM
3. Restore the artifact version to the new VM
