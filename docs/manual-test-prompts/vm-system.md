# Agent VM System Test Prompt

This document contains test prompts for validating the Agent VM system with GUID-based VM identification.

## Architecture Overview

- **VMs are identified by `vm_id` (GUID)**, not `chat_id`
- A single chat can create **multiple VMs**
- `create_agent_vm(chat_id)` returns a unique `vm_id`
- All subsequent VM operations require the `vm_id`
- `execute_skill_script` is **ephemeral** (uses `chat_id`, no persistent VM)

---

## Comprehensive Test Prompt

Copy and paste this into a chat to test all VM functionality:

```
I want to test the Agent VM system. Please perform the following tests in order:

### Test 1: Create Two VMs
Create two separate Agent VMs for this chat session. Note the vm_id GUIDs returned for each.

### Test 2: Verify VM Status
Check the status of both VMs using their vm_ids to confirm they're running.

### Test 3: Execute Commands in Each VM
In VM #1: Run `echo "Hello from VM1" > /work/vm1.txt && cat /work/vm1.txt`
In VM #2: Run `echo "Hello from VM2" > /work/vm2.txt && cat /work/vm2.txt`

### Test 4: Verify Isolation
List files in both VMs to confirm each has only its own file (vm1.txt vs vm2.txt).

### Test 5: Python Execution
In VM #1, execute this Python script:

import sys
print(f"Python version: {sys.version}")
print("VM1 Python test successful!")

### Test 6: File Operations
- Create a file in VM #2 at path "test/nested/file.txt" with content "Nested file test"
- Read the file back to verify
- List the directory structure

### Test 7: Ephemeral Script Execution (No VM Required)
If there's an activated skill with scripts, test execute_skill_script to confirm ephemeral execution still works with chat_id.

### Test 8: Destroy One VM
Destroy VM #1 and verify it's gone. Confirm VM #2 is still running.

### Test 9: Final Cleanup
Destroy VM #2.

Report the vm_id GUIDs used throughout and confirm each operation succeeded.
```

---

## Quick Smoke Test

A shorter test for basic validation:

```
Test the Agent VM system:

1. Create an Agent VM and note the vm_id GUID returned
2. Run `whoami && pwd && echo "Test successful"` in the VM using the vm_id
3. Check VM status using the vm_id
4. Destroy the VM using the vm_id

Report the vm_id and results of each step.
```

---

## Tool Reference

### Agent VM Server Tools (12 tools)

| Tool | Key Parameters | Description |
|------|----------------|-------------|
| `create_agent_vm` | `chat_id` | Creates VM, **returns vm_id GUID** |
| `destroy_agent_vm` | `vm_id`, `requester_chat_id` | Destroys VM with ownership check |
| `get_agent_vm_status` | `vm_id` | Returns VM status and time remaining |
| `vm_execute_bash` | `vm_id`, `command` | Run shell command |
| `vm_execute_python` | `vm_id`, `script` | Run Python script |
| `vm_create_file` | `vm_id`, `path`, `content` | Create/write file |
| `vm_read_file` | `vm_id`, `path` | Read file contents |
| `vm_delete_file` | `vm_id`, `path` | Delete file |
| `vm_list_files` | `vm_id`, `directory` | List directory |
| `vm_copy_from_workspace` | `vm_id`, `workspace_path`, `vm_path` | Copy into VM |
| `vm_copy_to_workspace` | `vm_id`, `vm_path`, `workspace_path` | Copy out of VM (returns download link) |
| `execute_skill_script` | `chat_id`, `skill_name`, `script_name` | **Ephemeral** (no vm_id) |

### Expected Results

| Test | Expected Result |
|------|-----------------|
| Create VM | Returns `vm_id: <GUID>` (e.g., `550e8400-e29b-41d4-a716-446655440000`) |
| Multiple VMs | Each gets unique GUID |
| VM isolation | Each VM has separate filesystem |
| Destroy | Requires matching `requester_chat_id` |
| Ephemeral script | Works with `chat_id` only |

---

## Troubleshooting

### Common Issues

1. **"No VM found with vm_id=..."**
   - Ensure you're using the exact GUID returned by `create_agent_vm`
   - VM may have timed out (default 4 hours)

2. **"Failed to destroy VM: unauthorized"**
   - The `requester_chat_id` must match the chat that created the VM

3. **"Docker image not found"**
   - Build the agent-vm image: `docker build -f Dockerfile.agent-vm -t agent-vm:latest .`

4. **Redis connection errors**
   - VM state is stored in Redis; ensure Redis is running

### Checking VM Containers

```bash
# List running agent-vm containers
docker ps | grep agent-vm

# Container naming pattern: agent-vm-<vm_id>
```

---

## Design Notes

### Why GUIDs?

- **Multiple VMs per chat**: A chat can spawn several VMs for different tasks
- **LLM manages lifecycle**: The LLM explicitly tracks vm_ids and decides when to destroy
- **Isolation**: Each VM is independent with its own filesystem state

### Persistent vs Ephemeral

| Type | Use Case | Identifier |
|------|----------|------------|
| **Persistent VM** | Long-horizon tasks, stateful work | `vm_id` (GUID) |
| **Ephemeral Script** | One-off skill script execution | `chat_id` |

---

## Example Session

```
User: Create an Agent VM for me

Assistant: I will create an Agent VM for you.

[Calls create_agent_vm with chat_id="abc-123-def"]

Agent VM created successfully.
vm_id: 7f3d2a1b-9c8e-4f5a-b6d7-8e9f0a1b2c3d
Container ID: a1b2c3d4e5f6
Status: running
Timeout: 4 hours
Working directory: /work

IMPORTANT: Use vm_id '7f3d2a1b-9c8e-4f5a-b6d7-8e9f0a1b2c3d' for all subsequent VM operations.

User: Run "ls -la" in the VM

Assistant: [Calls vm_execute_bash with vm_id="7f3d2a1b-9c8e-4f5a-b6d7-8e9f0a1b2c3d", command="ls -la"]

STDOUT:
total 8
drwxr-xr-x 4 root root 128 Dec 24 10:00 .
drwxr-xr-x 1 root root  64 Dec 24 10:00 ..
drwxr-xr-x 2 root root  64 Dec 24 10:00 input
drwxr-xr-x 2 root root  64 Dec 24 10:00 output

Exit Code: 0

User: Destroy the VM

Assistant: [Calls destroy_agent_vm with vm_id="7f3d2a1b-9c8e-4f5a-b6d7-8e9f0a1b2c3d", requester_chat_id="abc-123-def"]

Agent VM 7f3d2a1b-9c8e-4f5a-b6d7-8e9f0a1b2c3d destroyed successfully.
```
