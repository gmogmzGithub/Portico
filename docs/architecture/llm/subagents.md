# Sub-Agent MCP Server - Implementation Documentation

## Overview

The Run Sub-Agent MCP server enables hierarchical agent orchestration by allowing MCP clients to invoke any Open WebUI model as a sub-agent. This creates powerful workflows where one agent can delegate specialized tasks to domain-specific models.

**Key Design**: The tool exposes only `model` and `prompt` parameters. System prompts are configured in Open WebUI per-model settings, and max_tokens are enforced by Bifrost bridge via `model_catalog.yaml`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Docker Network                              │
│                                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ health_check │───▶│    Redis     │◀───│ run-sub-agent│      │
│  │  (Playwright)│    │   (KV Store) │    │  MCP Server  │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
│         │                                         │              │
│         │ Store token                             │              │
│         ▼                                         │              │
│  ┌──────────────┐                                 │              │
│  │  Open WebUI  │◀────────────────────────────────┘              │
│  │ (Port 8080)  │      POST /api/chat/completions               │
│  └──────────────┘                                                │
│                                                                   │
│  ┌──────────────┐                                                │
│  │     mcpo     │                                                │
│  │  (contains   │  Exposes run-sub-agent via stdio              │
│  │  run-sub-    │                                                │
│  │   agent)     │                                                │
│  └──────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
         │
         │ MCP Protocol
         ▼
   ┌──────────────┐
   │ Electron App │
   │ (or any MCP  │
   │   client)    │
   └──────────────┘
```

---

## Components

### 1. Redis (Token Storage)

**Purpose**: Shared KV store for Open WebUI API token

**Configuration**:
- Image: `redis:7-alpine` (~40MB)
- Port: 6379 (internal only)
- Memory: 128MB limit with LRU eviction
- No persistence (ephemeral)

**Key**: `openwebui:api_token`
**Value**: JWT token extracted from localStorage

### 2. Health Check Integration

**Updates**:
- Added `redis-py` dependency
- Connect to Redis with retry logic (5 attempts)
- Extract token from localStorage after login
- Store token in Redis with preview logging

**Token Extraction**:
```python
token_result = await page.evaluate("() => localStorage.getItem('token')")
redis_client.set('openwebui:api_token', token_result)
```

### 3. Run Sub-Agent MCP Server

**Location**: `src/core-mcp-rust/run-sub-agent/`

**Dependencies**:
- `mcp`: MCP SDK
- `httpx`: Async HTTP client
- `redis`: Redis client

**Tool Schema** (Simplified):
```python
{
    "name": "run_subagent",
    "inputSchema": {
        "type": "object",
        "properties": {
            "model": {
                "type": "string",
                "enum": [...],  # Auto-populated from /api/v1/models/base
            },
            "prompt": {"type": "string"}
        },
        "required": ["model", "prompt"]
    }
}
```

**Workflow**:
1. Connect to Redis → Retrieve token
2. Fetch available models from Open WebUI API
3. On tool call:
   - Validate model exists
   - Build minimal payload: `{"model": ..., "messages": [{"role": "user", "content": prompt}]}`
   - POST to `/api/chat/completions`
   - Retry 3 times with exponential backoff on failure
   - Return response with usage stats

**Error Handling**:
- Token missing → Clear error with recovery instructions
- Invalid model → List available models
- API timeout → Retry with backoff
- Network error → Descriptive error message

### 4. MCP Configuration (Auto-Generated)

**Files Created**:
- `mcp-configs/run-sub-agent/run-sub-agent.yaml` - Metadata
- `mcp-configs/run-sub-agent/run-sub-agent.fragment` - Command config
- `mcp-configs/run-sub-agent/run-sub-agent.md` - User documentation
- `mcp-configs/run-sub-agent/run-sub-agent.png` - Icon

**Auto-Discovery**: The `src/scripts/mcp-orc-cli.sh generate-mcp-config` script automatically:
- Scans `mcp-configs/` for `.yaml` files
- Checks if required env vars are set (none for run-sub-agent)
- Assembles fragments into `mcp_config_advanced.json`
- **No manual JSON editing required!**

---

## Implementation Details

### Docker Compose Changes

**Added Redis Service**:
```yaml
redis:
  image: redis:7-alpine
  container_name: portico-redis
  expose:
    - "6379"
  command: redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 3s
    retries: 5
```

**Updated Dependencies**:
- `health-check` depends on `redis`
- `mcpo` depends on `redis`

### MCP Runtime Dockerfile Changes

**Added**:
```dockerfile
# Copy and install run-sub-agent MCP server
COPY src/core-mcp-rust/run-sub-agent /app/internal-mcp/run-sub-agent
RUN cd /app/internal-mcp/run-sub-agent && \
    uv sync --frozen
```

### File Structure

```
src/core-mcp-rust/run-sub-agent/
├── .python-version              # 3.11
├── pyproject.toml               # uv project config
├── README.md                    # Development docs
└── src/run_subagent_server/
    ├── __init__.py
    └── server.py                # Main MCP server

mcp-configs/run-sub-agent/
├── run-sub-agent.yaml           # Metadata (no env vars required)
├── run-sub-agent.fragment       # Command: uv run ...
├── run-sub-agent.md             # User-facing documentation
└── run-sub-agent.png            # Icon
```

---

## Usage Examples

### Example 1: Simple Sub-Agent Call

```json
{
  "model": "claude-sonnet-4-5-thinking",
  "prompt": "Analyze this code for security vulnerabilities"
}
```

**Response**:
```
**Model**: claude-sonnet-4-5-thinking
**Finish Reason**: stop
**Usage**: {
  "prompt_tokens": 120,
  "completion_tokens": 450,
  "total_tokens": 570
}

**Response**:
[Analysis from Claude Sonnet 4.5]
```

### Example 2: Hierarchical Workflow

```
Main Agent (GPT-5)
    │
    ├─> Sub-Agent 1 (Claude Sonnet 4.5): Code review
    │   └─> Response: "Found 3 security issues..."
    │
    ├─> Sub-Agent 2 (Haiku 3.5): Generate test cases
    │   └─> Response: "Here are 10 test cases..."
    │
    └─> Synthesis: Combine results and create final report
```

### Example 3: Parallel Execution

```python
# Main agent spawns multiple sub-agents in parallel
results = await asyncio.gather(
    run_subagent("claude-sonnet-4-5-thinking", "Analyze code"),
    run_subagent("gpt-5", "Generate documentation"),
    run_subagent("claude-haiku-3-5", "Create tests")
)
```

---

## Testing

### Verification Steps

1. **Redis Connection**:
   ```bash
   docker-compose up redis -d
   docker-compose logs redis
   # Should see: "Ready to accept connections"
   ```

2. **Health Check Token Storage**:
   ```bash
   docker-compose up health-check
   docker-compose logs health-check | grep "Stored Open WebUI API token"
   # Should see: "✅ Stored Open WebUI API token in Redis (ending: ...XXXXXX)"
   ```

3. **Token Verification**:
   ```bash
   docker exec portico-redis redis-cli GET openwebui:api_token
   # Should return JWT token
   ```

4. **MCP Server Startup**:
   ```bash
   docker-compose up mcpo
   docker-compose logs mcpo | grep "run-sub-agent"
   # Should see no errors about missing Redis or token
   ```

5. **MCP Config Generation**:
   ```bash
   ./src/scripts/mcp-orc-cli.sh generate-mcp-config
   # Should see: "✓ run-sub-agent is configured and enabled"

   cat mcp_config_advanced.json | jq '.mcpServers["run-sub-agent"]'
   # Should show the fragment content
   ```

6. **Electron App Integration**:
   - Open Portico electron app
   - Navigate to MCP server settings
   - Verify "Run Sub-Agent" appears in the list
   - Enable the server
   - Test tool invocation with a simple prompt

### Manual Testing Checklist

- [ ] Redis starts successfully
- [ ] Health check connects to Redis
- [ ] Token stored in Redis (verify with redis-cli)
- [ ] MCP server starts without errors
- [ ] Server appears in electron app
- [ ] Tool schema shows model enum
- [ ] Valid model call returns response
- [ ] Invalid model shows error with available models
- [ ] Token missing shows clear error message
- [ ] API timeout retries correctly
- [ ] Response includes usage statistics

---

## Error Scenarios & Recovery

### Scenario 1: Token Unavailable

**Error**:
```
RuntimeError: Open WebUI API token not available in Redis.
Ensure health check has run successfully.
Check logs: docker-compose logs health-check
```

**Recovery**:
```bash
docker-compose restart health-check
docker-compose logs -f health-check
# Wait for "✅ Health check passed!"
```

### Scenario 2: Redis Connection Failed

**Error**:
```
❌ Failed to connect to Redis after 5 attempts
```

**Recovery**:
```bash
docker-compose ps redis
# Check if redis is running

docker-compose restart redis
docker-compose logs redis
# Should see "Ready to accept connections"
```

### Scenario 3: Invalid Model Name

**Error**:
```
ValueError: Model 'gpt-10' not found.
Available models are discovered dynamically. Current GPT entries include GPT-5.5, GPT-5.6 Sol, GPT-5.6 Sol Pro, GPT-5.6 Terra, and GPT-5.6 Luna.
```

**Recovery**: Use one of the listed models

### Scenario 4: Open WebUI Down

**Error**:
```
RuntimeError: Failed to reach Open WebUI after 3 attempts.
Check service status: docker-compose ps open-webui
```

**Recovery**:
```bash
docker-compose restart open-webui
docker-compose logs -f open-webui
# Wait for service to be ready
```

---

## Configuration Management

### Why System Prompts Are NOT in Tool Parameters

**Design Decision**: System prompts are configuration, not runtime parameters.

**Open WebUI Configuration**:
- Navigate to Settings → Models → [Select Model]
- Set "System Prompt" field
- Applies to all API calls for that model

**Benefits**:
- Centralized configuration
- Consistent behavior across all calls
- No duplication in tool invocations
- Easier to manage and update

### Why Max Tokens Are NOT in Tool Parameters

**Design Decision**: Token limits are infrastructure-level constraints.

**Bifrost bridge Configuration** (`model_catalog.yaml`):
```yaml
- model_name: claude-sonnet-4-5-thinking
  litellm_params:
    model: bedrock/converse_like/us.anthropic.claude-sonnet-4-5-20250929-v1:0
    api_base: https://api.anthropic.com/v1
  model_info:
    max_tokens: 64000
    max_output_tokens: 64000
```

**Benefits**:
- Enforced at proxy level
- Prevents runaway costs
- Consistent across all clients
- No need to specify per-request

---

## Security Considerations

### Token Storage

**Security Measures**:
- Redis exposed only on internal Docker network
- No external port binding (no `ports:` in compose)
- Token cleared on Redis restart (no persistence)
- Only last 8 characters logged

**Risk Mitigation**:
- Isolated network prevents external access
- Ephemeral storage limits exposure window
- Containerized Redis reduces attack surface

### API Key Management

**Best Practices**:
- Never log full tokens
- Use preview logging: `token[-8:]`
- Store in Redis, not environment variables
- Auto-refresh on health check restart

---

## Performance Characteristics

### Latency Breakdown

```
Total latency = Redis fetch + API call + Response parse
              = ~1ms      + (model dependent) + ~5ms
              ≈ Model latency + 10ms overhead
```

**Typical Response Times**:
- Claude Sonnet 4.5: 2-10 seconds
- GPT-5: 1-5 seconds
- Claude Haiku 3.5: 0.5-2 seconds

### Throughput

**Concurrent Requests**: Limited by Open WebUI
- Default: ~10 concurrent requests
- Configurable in Open WebUI settings

**Recommendation**: Use connection pooling for >5 QPS

### Resource Usage

- Redis: ~20MB memory (with 128MB limit)
- MCP Server: ~50MB memory
- Network: Minimal (JSON payloads)

---

## Monitoring & Logging

### Key Metrics

1. **Token Availability**: `redis-cli GET openwebui:api_token`
2. **MCP Server Health**: `docker-compose ps mcpo`
3. **API Success Rate**: Count successful vs failed calls
4. **Response Times**: Track P50, P95, P99 latencies

### Structured Logging

**Format**:
```json
{
  "timestamp": "2025-10-07T13:45:00Z",
  "level": "INFO",
  "component": "run-sub-agent",
  "event": "api_call",
  "model": "claude-sonnet-4-5-thinking",
  "prompt_length": 1024,
  "response_length": 2048,
  "latency_ms": 3250,
  "tokens_used": 4096
}
```

### Alerts

**Critical**:
- Redis unavailable for >1 minute
- API token missing after health check completes
- All API calls failing

**Warning**:
- API call latency >30 seconds
- Error rate >10%
- Redis memory >100MB

---

## Future Enhancements

### Phase 2 (Post-MVP)

1. **Streaming Support**
   - Return responses as Server-Sent Events
   - Update progress in real-time

2. **Conversation Context**
   - Support multi-turn conversations
   - Maintain conversation history per sub-agent

3. **Tool Calling**
   - Allow sub-agents to use tools
   - Propagate tool results back to caller

4. **Cost Tracking**
   - Track token usage per model
   - Expose usage statistics via MCP resources

### Phase 3 (Advanced)

1. **Response Caching**
   - Cache common prompt+response pairs in Redis
   - TTL-based expiration

2. **Rate Limiting**
   - Per-user limits
   - Per-model limits
   - Graceful degradation

3. **Orchestration Workflows**
   - Define multi-step workflows
   - Conditional branching
   - Result aggregation

---

## Troubleshooting Guide

### Problem: MCP server doesn't appear in electron app

**Check**:
1. `mcp-configs/run-sub-agent/` directory exists
2. All 4 files present (.yaml, .fragment, .md, .png)
3. Run `./src/scripts/mcp-orc-cli.sh generate-mcp-config`
4. Check `mcp_config_advanced.json` contains `run-sub-agent`
5. Restart electron app

### Problem: Tool call returns "token not available"

**Check**:
1. Health check ran: `docker-compose logs health-check`
2. Redis has token: `docker exec portico-redis redis-cli GET openwebui:api_token`
3. Token not empty
4. Restart health check if needed

### Problem: All models failing

**Check**:
1. Open WebUI is running: `docker-compose ps open-webui`
2. Bifrost bridge is healthy: `curl http://localhost:4583/health`
3. Network connectivity between containers
4. Check Open WebUI logs for errors

### Problem: Slow responses

**Possible Causes**:
- Model is reasoning-enabled (longer think time)
- Large prompt size
- Network latency to upstream LLM proxy
- Open WebUI under load

**Solutions**:
- Use faster models (Haiku, mini variants)
- Reduce prompt size
- Check upstream proxy latency
- Scale Open WebUI replicas

---

## Success Criteria

✅ **Infrastructure**:
- Redis service running in Docker Compose
- Health check stores token in Redis
- MCP server retrieves token from Redis

✅ **Functionality**:
- `run_subagent` tool accepts only `model` and `prompt`
- API calls succeed with valid models
- Response includes usage statistics

✅ **Integration**:
- MCP server appears in electron app
- Auto-generated MCP config includes run-sub-agent
- No manual JSON editing required

✅ **Error Handling**:
- Clear error messages for common failures
- Retry logic with exponential backoff
- Helpful recovery instructions

✅ **Documentation**:
- User-facing docs in run-sub-agent.md
- Technical docs in SUB_AGENTS.md
- README in MCP server directory

---

## Conclusion

The Run Sub-Agent MCP server provides a clean, simple interface for hierarchical agent orchestration. Key design decisions:

1. **Simplified Tool Schema**: Only `model` and `prompt` - configuration stays where it belongs
2. **Auto-Discovery**: No manual JSON editing required
3. **Secure Token Management**: Redis-based storage with ephemeral data
4. **Robust Error Handling**: Clear messages with recovery instructions
5. **Zero Configuration**: Works out of the box after health check

This architecture enables powerful multi-agent workflows while maintaining simplicity and security.
