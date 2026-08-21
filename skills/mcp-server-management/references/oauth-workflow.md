# Complete OAuth Server Installation Workflow

When installing MCP servers that require OAuth authentication, you **MUST** follow this **EXACT 8-step workflow**.

## Quick Decision Tree

After first restart (Step 2), check the logs:
- **"needs_oauth" state** → Continue to Step 3 (mcp_assistant_authorize_integration)
- **"Registration failed: 403"** → Server requires manual registration (see Troubleshooting)

## Step-by-Step OAuth Server Installation

### Step 0: GET USER CONSENT FIRST

**MANDATORY**: Before creating the server, assess risk and get explicit consent!

For OAuth servers (typically MEDIUM-HIGH RISK):
- Explain what the server will access
- Explain authentication method: "Uses OAuth for secure authentication"
- For HIGH RISK: Recommend OAuth-based remote deployment
- Ask the user directly in chat for consent
- Wait for explicit user approval

**NEVER proceed to Step 1 without user consent!**

### Step 1: Create the MCP Server

```
mcp_assistant_create_user_mcp_server({
  server_id: "glean-oauth",
  yaml_config: {
    name: "Glean OAuth MCP Server",
    id: "glean-oauth",
    display_name: "Glean OAuth",  // REQUIRED: NO emojis, NO parentheses!
    deployment_type: "docker",
    description: "Glean search and knowledge base integration with OAuth",
    user_installed: true,
    is_core: false,
    required_env_vars: []
  },
  fragment: {
    type: "streamable-http",
    url: "https://portico-be.glean.com/mcp/default",
    oauth: {
      server_url: "https://portico-be.glean.com"
    }
  }
})
```

### Step 2: Restart MCP Infrastructure (AUTOMATIC)

```
Inform user: "Server created! Restarting MCP infrastructure to load it... (~1 minute)"

mcp_assistant_restart_mcp_infrastructure()
```

Server loads in "needs_oauth" state after this restart.

### Step 3: Trigger OAuth Flow (BLOCKING)

```
Inform user: "Opening OAuth authorization dialog. You'll see a modal with an 'Authorize Access' button. Click it to complete authorization."

mcp_assistant_authorize_integration({server_id: "glean-oauth"})
```

**What the User Will See:**
1. OAuth modal appears in Electron window
2. Shows server name, icon, and description
3. Two buttons: "Authorize Access" (blue) and "Skip All" (grey)
4. User clicks "Authorize Access" → Browser opens to OAuth provider
5. User completes authorization in browser
6. Modal shows checkmark → "Authorization successful!"
7. Modal closes automatically after 1.5 seconds

**Possible Results:**
- `{success: true, completed: true}` → **OAuth SUCCESS! Continue to Step 4**
- `{success: false, dismissed: true}` → **User clicked "Skip All"**
- `{success: false, completed: false}` → **OAuth failed in browser**
- `{success: false, error: "OAuth flow timed out"}` → **Timeout (10 minutes)**

### Step 4: Restart Infrastructure Again (CRITICAL)

**Why This Second Restart is Required:**
- First restart: Server loads in "needs_oauth" state
- OAuth flow: User authorizes, MCPO stores OAuth tokens
- **Second restart**: MCPO reconnects using stored tokens → server becomes "healthy"

```
Inform user: "OAuth tokens saved! Restarting to connect with credentials... (~1 minute)"

mcp_assistant_restart_mcp_infrastructure()
```

### Step 5: Discover the New Tool Server ID

```
mcp_assistant_list_mcp_servers()
```

Find your server in the response:
```json
{
  "tools": [
    {"name": "Glean OAuth", "id": "server:glean-oauth"}
  ]
}
```

### Step 6: Enable Tool Server for Current Chat

```
Extract chat_id from system prompt: Look for "Chat ID: abc-123-xyz"

mcp_assistant_activate_integration({
  chat_id: "abc-123-xyz",
  tool_server_ids: ["server:glean-oauth"]
})
```

### Step 7: Test the Tool (WITH PERMISSION)

```
Ask user: "Would you like me to test the Glean connection by searching for..."

[WAIT FOR USER APPROVAL]

[Use the newly enabled tool]

Report: "✅ Successfully searched Glean and found X results!"
```

## Critical Success Criteria

ALL 8 steps must complete successfully:
1. ✅ User consent obtained
2. ✅ Server created
3. ✅ Infrastructure restarted (~1 min) - server loads in "needs_oauth" state
4. ✅ OAuth completed (user authorized) - tokens stored
5. ✅ Infrastructure restarted AGAIN (~1 min) - server connects with tokens
6. ✅ Tool server ID discovered
7. ✅ Tool enabled for current chat
8. ✅ Tool tested and working (with user permission)

## If OAuth Fails

**If Step 3 fails (user dismisses or timeout):**
- Server exists but is NOT authorized
- Server shows "needs_oauth" status
- Tool will NOT be available until user completes OAuth
- **Do NOT proceed to Step 4**
- Inform user: "OAuth was not completed. The server exists but cannot be used until you authorize it."

**If Step 4 fails (restart after OAuth fails):**
- OAuth tokens are stored but server won't connect
- Check logs for errors
- User may need to retry the entire process

## Servers Requiring Manual Registration

Some OAuth providers advertise dynamic client registration but **block** it with `403 Forbidden`.

**How to Detect:**
- Logs show: "Registration failed: 403 Forbidden"
- Server appears in "failed" state with "OAuthRegistrationError"

**What to Tell the User:**
```
"This OAuth server doesn't support automatic client registration. Options:

1. Check for alternative endpoints (local servers, API key auth)
2. Manual registration required:
   - Register an OAuth app in the provider's developer portal
   - Obtain client_id and client_secret
   - Contact system administrator to add credentials
```

## Troubleshooting

**Problem**: OAuth returns "dismissed" immediately after clicking "Authorize Access"
**Cause**: Stale dismissal state from previous attempt
**Solution**: Fixed - dismissal state is cleared at start of each OAuth flow

**Problem**: "Registration failed: 403 Forbidden" during restart
**Cause**: Server doesn't support dynamic client registration
**Solution**: Check for alternative endpoint or inform user about manual registration

**Problem**: Server doesn't show in `/docs` after OAuth
**Cause**: FastAPI/Swagger UI caching
**Solution**: Server IS working - use `mcp_assistant_list_mcp_servers()` to verify

**Problem**: Server not found after OAuth
**Cause**: Forgot the second restart!
**Solution**: Call `mcp_assistant_restart_mcp_infrastructure()` again after OAuth success

**Problem**: Server still shows "needs_oauth" after OAuth completed
**Cause**: Forgot the second restart!
**Solution**: ALWAYS restart after `mcp_assistant_authorize_integration` returns success
