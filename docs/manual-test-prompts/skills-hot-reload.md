# Skills Hot-Reload Test Prompt

> A single prompt designed to verify the entire hot-reload system is functioning correctly.

## The Key Insight

When a skill is **activated** for a chat, its content is automatically injected into the system prompt by `unified_context.py`. The LLM should NOT need to call `read_skill` - the content should just **be there** in its context.

If the LLM has to explicitly read the skill to know its contents, that means the automatic injection failed - which means hot-reload isn't working.

---

## The Test Prompt

```
I'm testing our skill hot-reload system. Please do these steps IN ORDER:

1. Generate a random 6-digit number (e.g., 847293) - remember this number!

2. Create a skill with these EXACT specifications:
   - Skill name: "hotreload-test-[YOUR-NUMBER]" (e.g., "hotreload-test-847293")
   - SKILL.md content:
     ---
     name: hotreload-test-[YOUR-NUMBER]
     description: Hot-reload verification skill
     priority: 100
     auto_trigger: []
     required_mcp_servers: []
     ---

     # Hot-Reload Verification

     SECRET CODE: PHOENIX-[YOUR-NUMBER]-RISING

     If you can read this, hot-reload is working.

3. Activate the skill for this chat

4. STOP. Do NOT use read_skill or any other tool to read the skill content.
   Simply confirm you've created and activated the skill, then tell me you're ready.

After you confirm, I will type "VERIFY" in my next message. At that point:
- The skill content should be AUTOMATICALLY INJECTED into your system prompt
- You should see the SECRET CODE without calling any tools
- Tell me the code you see

If you can tell me "PHOENIX-[number]-RISING" on the VERIFY step WITHOUT using any tools,
then the hot-reload system is working correctly.

IMPORTANT: If you cannot see the secret code after I say VERIFY, tell me honestly -
that means hot-reload failed and the skill wasn't injected into your context.
```

---

## Why This Prompt Is Better

### The Old Prompt's Flaw

The old prompt asked the LLM to:
1. Create skill → 2. Activate skill → 3. **Read skill** → 4. Report code

Step 3 (`read_skill`) runs in the **same container** that created the skill. That container just called `reload_skills()`, so of course it has fresh data. This tests nothing.

### The New Prompt's Strength

The new prompt asks the LLM to:
1. Create skill → 2. Activate skill → 3. **STOP** → 4. Wait for "VERIFY" → 5. Report code **without tools**

The "VERIFY" step is the real test:
- A new request comes in
- `unified_context.py` runs in the **open-webui container**
- It looks up activated skills and injects their content
- If hot-reload works, the content is fresh
- If hot-reload fails, the content is missing or stale

### The Honest Failure Mode

By explicitly saying "if you cannot see the code, tell me honestly", we prevent the LLM from hallucinating or trying to be helpful by guessing. A clear "I don't see any secret code in my context" is the definitive failure signal.

---

## Expected Outputs

### Success (Hot-Reload Working)

**Turn 1 Response:**
```
I'll test the hot-reload system.

1. Generated random number: 847293

2. Creating skill...
   [create_skill tool call - success]

3. Activating skill...
   [activate_skill tool call - success]

4. Done! I've created and activated skill "hotreload-test-847293".
   I have NOT read the skill content.

Ready for Part 2. Type "VERIFY" and I'll tell you the secret code
from my automatically-injected system context.
```

**Turn 2 (after user types "VERIFY"):**
```
Looking at my system context...

I can see the activated skill content! The SECRET CODE is:

**PHOENIX-847293-RISING**

Hot-reload is working correctly - the skill content was automatically
injected into my system prompt without me needing to call any tools.
```

### Failure (Hot-Reload Broken)

**Turn 2 (after user types "VERIFY"):**
```
Looking at my system context...

I don't see any skill content with a secret code in my context.
The skill "hotreload-test-847293" that I created and activated is
not appearing in my injected system prompt.

This indicates hot-reload is NOT working - the open-webui container
didn't pick up the new skill that was created in the skills container.
```

---

## The Technical Flow

### Turn 1: Create and Activate

```
User sends prompt
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  open-webui: unified_context.py inlet()                      │
│  - No skills activated yet                                   │
│  - System prompt has no skill content                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
                    Atlas processes
                           │
       ┌───────────────────┴────────────────────┐
       │                                        │
       ▼                                        ▼
┌──────────────────┐                  ┌──────────────────┐
│ create_skill()   │                  │ activate_skill() │
│ in mcpo-skills   │                  │ in mcpo-skills   │
│                  │                  │                  │
│ - Write file     │                  │ - Store in Redis │
│ - reload_skills  │                  │   chat_skills:X  │
│ - publish_inval  │──► Redis ──►     │                  │
└──────────────────┘    pub/sub       └──────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │ open-webui container   │
              │ (background thread)    │
              │                        │
              │ _cache_invalidated     │
              │      = True            │
              └────────────────────────┘

Atlas responds: "Ready! Type VERIFY."
```

### Turn 2: The Real Test

```
User sends "VERIFY"
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  open-webui: unified_context.py inlet()                      │
│                                                              │
│  1. Get activated skills from Redis                          │
│     → ["hotreload-test-847293"]                              │
│                                                              │
│  2. For each skill, call get_skill_content()                 │
│           │                                                  │
│           ▼                                                  │
│     _is_cache_stale() → True (Redis flag was set!)          │
│           │                                                  │
│           ▼                                                  │
│     discover_skills(force_refresh=True)                      │
│           │                                                  │
│           ▼                                                  │
│     Load fresh skill from filesystem                         │
│     "SECRET CODE: PHOENIX-847293-RISING"                     │
│                                                              │
│  3. Inject into system prompt:                               │
│     <activated-skill name="hotreload-test-847293">           │
│       # Hot-Reload Verification                              │
│       SECRET CODE: PHOENIX-847293-RISING                     │
│     </activated-skill>                                       │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
                    Atlas processes

Atlas sees "PHOENIX-847293-RISING" in system prompt
Atlas responds with the code (NO TOOLS NEEDED)
```

---

## Why The Two-Turn Design Is Necessary

The skill injection happens in `inlet()` which runs **before** the LLM processes the message. This means:

- **Turn 1**: When Atlas creates the skill, `inlet()` already ran. The skill didn't exist yet when the system prompt was built.
- **Turn 2**: Now `inlet()` runs again with the skill activated. This is when injection happens.

There's no way to test cross-container hot-reload in a single turn because the injection happens at request start, before any tools run.

The two-turn design isn't a weakness - it's testing exactly what matters: **does a skill created in Turn N appear in Turn N+1's system prompt?**

---

## Cleanup

After testing, delete the test skill:

```
Delete the skill "hotreload-test-[NUMBER]" that we created for testing.
```

---

## Summary

| Aspect | Old Prompt | New Prompt |
|--------|-----------|------------|
| Uses `read_skill` | Yes (same container) | No |
| Tests cross-container | Not really | Yes |
| Clear failure signal | Ambiguous | Explicit |
| Tests automatic injection | No | Yes |
| What it actually validates | MCP server can read its own writes | Full hot-reload pipeline |

The new prompt tests what users actually care about: **when I create a skill, it should just work in my next message without me having to do anything special.**
