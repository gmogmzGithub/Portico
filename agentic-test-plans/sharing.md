Important test cases for Marketplaces, Agents, Skills, Sharing

All of these must be done using our agentic tools exposed by core MCP servers only. For all tools exercised (e.g., for each and every tool call, and in between tool calls), ensure responses are perfectly as expected based on the context of the test scenario, and that responses don't return extraneous unnecessary information that clogs up the context window.

For any tests where we need to interact with the Solutions Marketplace, make it possible to use an environment variable to swap out the URL of the Solutions Marketplace so we can use a mock integration server. Create a Mock integration server that behaves like the real thing but keeps everything in memory and runs locally. And make all of our test scenarios interact with said mock integration server. If the mock integration server code does not exist yet, create it, and update this markdown file with the details for future invocations of this agentic test plan.

> **HARNESS (already built — reuse it):** everything above exists under
> `tests/agentic/` — see `tests/agentic/README.md` for the full topology.
> Quick start:
> 1. `cd src/core-mcp-rust && cargo build -p skills-server -p subagents-server`
> 2. `node tests/agentic/harness.js --dir /tmp/portico-agentic` (stays alive; prints/writes `endpoints.json`)
> 3. Invoke real MCP tools: `node tests/agentic/call.js /tmp/portico-agentic <skills|subagents> <tool> ['<json-args>']`
> 4. Teardown between scenarios: `node tests/agentic/reset-state.js /tmp/portico-agentic`
>
> The Solutions Marketplace URL swap is `AI_MARKETPLACE_BASE_URL` (read by
> `electron-app/src/services/ai-marketplace-client.js`); the harness points it
> at `tests/agentic/mock-solutions-marketplace.js` (in-memory, with
> `/__test/seed|update|delete|state|reset|ownership` hooks for
> behind-the-scenes acts like foreign-author listings). Open WebUI is mocked
> by `tests/agentic/mock-owui.js`; the REAL `api.js` service layer runs
> headless via `tests/agentic/electron-api-host.js`; a dedicated Redis
> container (`portico-agentic-redis`, port 16390) keeps activation state real.
> The fixture dir is disposable; the developer's real app/profile is never
> touched.

Some of these tools require approval from the user when they are actually run on the hot path (e.g., inside of a chat). That is disruptive for the purposes of running this test as a developer on the project. So, similarly, introduce a test hook perhaps driven by an environment variable that auto-approves the tool calls. The tool calls that require approval are ones that publish or unpublish agents / skills from the Solutions Marketplace.

> **AUTO-APPROVE (already built):** `portico_AGENTIC_AUTO_APPROVE=1` (the harness
> default) writes the shipped dev-build `marketplace-auto-approve.json`
> preference into the sandbox userData; the headless host then completes the
> real pending+poll confirm flow with `action:"approved"` exactly as the
> renderer would. Packaged builds clamp the preference to false, so this hook
> cannot leak into production behavior.

> **RENDERER-SURFACE MOCK MODE (already built, 2026-08-01):**
> `./install_v2.sh --force-local-build --node --mock-marketplace` starts (or
> reuses; auto-restarts on search-shape skew) `mock-solutions-marketplace.js`
> standalone on port 18808 (`portico_MOCK_MARKETPLACE_PORT` overrides; KEYLESS on
> purpose — never export `AI_MARKETPLACE_API_KEY`, the resolver persists env
> keys into the macOS Keychain) and exports `AI_MARKETPLACE_BASE_URL` so the
> REAL app GUI talks to the mock — zero app-code changes, same `/__test/*`
> hooks, coexists with this harness (fixed 18800). The mock outlives the
> installer (`lsof -ti tcp:18808 | xargs kill` to stop). GUI installs/publishes
> during a mock session reference mock-only solution ids — before returning to
> the real marketplace run `./install_v2.sh --unlink-mock-marketplace-entities`
> (dry-run report + confirm; unlinks published entities back to local-only,
> removes installed-from-mock copies; engine:
> `tests/agentic/purge-mock-artifacts.js`, refuses while the app is running).
> This mode exists so every scenario below can ALSO be exercised through the
> control-plane GUI (non-agentically): the renderer rides the same
> operations layer the tools use, and the `/__test/*` hooks still provide the
> behind-the-scenes acts (foreign authors, silent updates) for scenarios
> 8-10/17. GUI publish/unpublish keep their real confirm modals — no
> auto-approve in GUI mode.

Ensure to tear down all test data in between each test scenario and then at the very end.

Finally, these scenarios will also mutate the local file system state, so in between each tool call I want you to also verify the local file system state is exactly what we expect it to be.

Test scenarios:

1) Create a skill w/ reference files locally, read the skill, read reference files.

2) Create multiple skills w/ varying realistic reference files locally, read the skills, read the reference files. Include reference files that are not plain text in nature, e.g., image assets. Test the Get Skill Assets tool.

3) Create a skill, update the skill, copy the skill.

4) Create a skill, delete the skill.

5) Create a skill, publish it, update it, ensure it is marked as 'dirty' aka there are local changes that haven't been published, republish, ensure dirty state clears.

6) Create a skill, publish it, delete the skill, ensure still remains on the solutions marketplace, then install from the marketplace and ensure it is once again available locally and has correct attribution to the local user as being the author, then ensure it is once again editable by the local user, becomes dirty after edits, and can be republished with the dirty state clearing at that point. Ensure no duplicate skill is ever created anywhere either locally or on the solutions marketplace.

7) Create multiple skills each with reference files. Publish them all. Update multiple skills, ensuring to choose one skill at random and for that skill only update a reference file, not the actual SKILL.md. Ensure THAT skill is marked as dirty. Ensure the other updated skills are also marked as dirty. Republish any skills that need republication. Ensure all skills are in sync and none are dirty any longer.

8) In our fake integration test marketplace, make some skills available from a different author than the current local user (Do this using a test hook made available to us from the fake solutions marketplace, not through a tool from the PORTICO core MCP tools). Ensure those skills can be installed, cannot be edited locally, cannot be unpublished because they don't belong to the current local user, and be deleted locally, then can be reinstalled locally. Ensure no duplicate skills are ever created either locally or on the marketplace.

9) Create a local skill with the name foo. Also create a skill on the fake solutions marketplace (through a test hook, not MCP tools) with the same name. Attempt to install the skill, ensure it fails and does not override the user's local skill or link the user's local skill to the marketplace local skill. Ensure the failure provides a human readable reason for why it failed (skill with duplicate name / id exists locally). Rename the local skill agentically with the `rename_skill` tool (added 2026-08-01; see scenario 22 for its full contract — note it only renames UNPUBLISHED user skills), then try re-installing the marketplace skill, ensuring it succeeds this time.

10) In our fake integration test marketplace, make a skill available from a different author. Install the skill locally. Make an update to the skill on the marketplace. Ensure our tools like "List Skills", "Read Skill" and any other relevant tools flag the local skill as needing an update since it is out of sync with the marketplace skill. There is a tool called "Update Skill" which does not mean 'sync from marketplace' it means making a local update to a skill. We may need a new tool for syncing a skill from its parent marketplace if it does not exist. Once it does exist, test that tool in this scenario. Then ensure after running said tool, the skill is no longer marked as needing an update and everything looks in order both locally and on the marketplace it came from. We have a tool named "Check Marketplace Skill Updates", that sounds relevant in this scenario. Make sure to test that it works correctly and returns the precise expected data. We also have these two tools: "Sync All Marketplaces" and "Sync Marketplace". These are relevant here as well. Use the tools as part of the testing here, identify any issues with these tools as well.

11 - Many scenarios) Run through a battery of test scenarios that are symmetric in nature to scenarios 1 through 10, but this time testing agent functionality, not skill functionality. For these scenarios, do not test anything that links skills or MCP servers to agents, we'll handle those cases later.

12) Install a skill from each different kind of marketplace (solutions marketplace, and all 4 git-based marketplaces our app ships with out of the box, using the real git-based marketplaces because those are read only, only use a fake marketplace for the solutions marketplace). Install a plugin from each marketplace (some of them don't have plugins, that's fine). Ensure everything installs perfectly as expected without any issues. Ensure all skill data can be read from each kind of marketplace (agentically), and skill reference files can be read from each kind of marketplace (agentically).

13) Create an agent, add MCP tools to it, publish the agent, ensure the solutions marketplace contains the correct data for the agent.

14) Create an agent, link skills to it from each different kind of marketplace (all 4 git based + solutions marketplace + core skills that come out of the box with our app), publish the agent, ensuring no new skills are published to the marketplace because all the skills that were linked were pre-existing and came from marketplaces. Ensure skills that came from git-based marketplaces (or core skills) do not get duplicately published to the solutions marketplace. Precondition: install all skills you plan to link FIRST, they must exist locally.

15) As an extension of test case 13, ensure that a skill that is not installed locally cannot be linked to an agent. Test linking a skill that is not installed locally from each different marketplace and ensure this fails in all cases.

16) Agentically attempt to install two new marketplaces: git@example.invalid:portico/portico-team-skills.git and https://github.com/NVIDIA/skills.git.
   - portico-team-skills (internal example.invalid GitLab): the add is ALLOWED by policy. Ensure we can fetch plugins and skills, install skills, and link its skills to an agent (internal GitLab hosts are on the agent-attach allowlist). NOTE: in the headless harness the actual add/install requires interactive GitLab OAuth + safeStorage and cannot run; verify the policy legs via a simulated install record (registry + payload seeding) instead.
   - NVIDIA/skills (external GitHub): expectation REVISED 2026-08-01 (owner decision on the original run's ISSUE-11): the marketplace add-gate is deliberately fail-closed — `add_marketplace` MUST REJECT this source with the approved-sources error (`marketplace_source_not_allowed`-family: only internal Portico GitLab repos and the OOTB Anthropic marketplaces are approved). Ensure the rejection is human-readable and that nothing is written to marketplaces.json. Additionally verify the agent-attach allowlist independently (via a simulated installed record for a non-approved source): linking such a skill to an agent must fail with `skill_not_attachable`.

17) Create an agent on the fake marketplace that is set up exactly as Scenario 18 calls for, but make both the associated published skills on the solutions marketplace and the agent itself attributed to a different author. Then, starting from a clean slate on the local machine, without the git@example.invalid:portico/portico-team-skills.git marketplace installed locally, install the agent from the fake solutions marketplace (agentically). Ensure the missing marketplace is automatically added locally, the skill(s) from it are automatically installed locally, and the necessary skills from all other marketplaces are automatically installed locally and that skill provenance and referential integrity look exactly as expected. After doing this, make changes to the published skills on the marketplace and to the published agent (behind the scenes, not agentically through our tools), and ensure the local copies are flagged as needing an update. Ensure we can agentically update everything correctly. Ensure no duplicate marketplaces, skills, or agents are ever created.

18) Create an agent, create new skills, link the new skills plus link a variety of skills to it from all the different marketplaces, including git@example.invalid:portico/portico-team-skills.git (install the marketplace first, agentically), publish the agent, ensure the solutions marketplace entry looks exactly as expected. Ensure the newly created skills were also automatically published and that their solution IDs are tracked properly on the created agent. Then, ensure the skills cannot be deleted locally because there is an agent locally that uses them. Then ensure the skills cannot be unpublished because there is an agent on the marketplace that requires them. Then delete the agent locally. Ensure it still exists on the solutions marketplace. Then attempt to unpublish the skills, this should still fail because even though the agent no longer exists locally, the agent exists on the marketplace. Then delete the skills locally, this should work, but the skill should continue to exist on the marketplace. Then, install the agent from the marketplace and ensure everything comes back (including all necessary dependent skills and marketplaces, similar to scenario 18). Then unpublish the agent from the marketplace, ensuring the local copy exists. Then unpublish the dependent skills from the solutions marketplace (the ones that live there), and now it should actually work because the agent has been unpublished. Then delete the agent locally, then delete the skills locally. Then finally ensure the agent is no longer visible on the marketplace, neither the skills that once lived there associated with this agent.

19) Test the Subagents -> Run Subagents tool with a variety of different agents that each are linked to a variety of different skills from a variety of different marketplaces. Ensure in all cases that the subagent chat automatically activates all dependent skills at the beginning of the chat as per our unified context engineering strategy. Also associate MCP servers with agents (a variety of them across different agents), and ensure the appropriate MCP servers get auto activated as well. Note, these core MCP servers Agent VM, MCP Assistant, Skills, Subagents should always be auto-activated for every chat and subagent chat.

20) Create a skill, then create an agent, then update the agent and attach the newly created skill. Publish the agent. Then try and delete the skill. It should fail because it is attached to an agent. Then try to unpublish the skill. It should also fail for the same reason. Then delete the agent locally. Then reinstall it from the marketplace. Then try to delete the skill and unpublish it again, it should fail both times. Then finally unpublish the agent. Then try to delete the skill, it should fail. Then unpublish the skill, it should work this time because we unpublished the agent already. Then delete the agent. Then delete the skill, which should finally succeed.

21) Get an inventory of all tools available across these core MCP servers: Skills, Subagents. For any tools that were not exercised during this testing, exercise them in the context of any scenarios you can think of that are realistic user scenarios, and flag any issues you find.

22) Rename Skill tool (`rename_skill`, added 2026-08-01). POLICY: renaming is constrained to editable user skills that are NOT published — a published listing's name is its marketplace identity, so the flow for a published skill is unpublish -> rename -> republish (which creates a fresh listing under the new name). Test all of the following agentically:
   a. Happy path: create a skill with a reference file and a script, rename it, and verify the skills-user directory moved, the SKILL.md frontmatter `name:` was rewritten (creator + body + custom metadata preserved verbatim), the reference/script files traveled with the directory, and list_skills/read_skill/get_skill_reference all work under the new name (the old name is gone).
   b. Collisions fail closed with `skill_already_exists` against EVERY local source: another user skill, a system skill, a flat marketplace install ({mp}/{skill}), and a plugin-grouped marketplace install ({mp}/{plugin}/{skill} — e.g. the preinstalled document-skills/pdf leaf). Reference material nested under a skill directory must NOT count as a collision.
   c. Published skills are rejected with `published_skill_rename_blocked`, naming the linked solution id and pointing at unpublish_skill. Then actually run the sanctioned flow: unpublish_skill -> rename_skill (succeeds; no marketplace link survives) -> publish_skill (creates a FRESH listing under the new name; the old listing stays gone; the fresh publish enforces marketplace-wide name uniqueness with `solution_name_conflict`). Ensure no duplicate listings exist at any point.
   d. Agent-attached skills are rejected with `skill_in_use_by_agents` (the agents are named); after detaching the skill from the agent, the rename succeeds.
   e. Read-only sources are rejected: installed marketplace copies (`installed_copy_read_only`) and system skills (`system_skill_read_only`).
   f. Case-only renames are rejected with `same_skill_name` (ids are ASCII kebab; case variants are not distinct names).
   g. A stale marketplace link squatting on the TARGET name (seed it behind the scenes by editing the userData ai-marketplace-skill-links.json for a name with no local skill) is rejected pre-mutation with `skill_link_conflict` — a renamed skill must never inherit an unrelated listing's Published state. Relatedly, create_skill of a name with a stale link must clear that link (a brand-new skill never shows as Published).
   h. Between every step, verify the local filesystem state (skills-user layout, frontmatter) and the link registry are exactly as expected, and tear down all test data afterwards.

23) Parallel tool-call bursts (added 2026-08-02 after a live chat regression the earlier
   sequential battery could not catch). LLMs routinely emit MULTIPLE tool calls in one turn
   and mcpo executes them concurrently; the OWUI fork serializes all model mutations behind a
   global writer lease and 409s overlapping ones ("Model reconciliation or another model
   mutation is in progress"). The subagents-server must cooperate: an in-process mutex
   serializes its own mutations and a bounded backoff retries cross-process conflicts; a
   persistent conflict must surface as a clear human-readable "Open WebUI is busy" error,
   NEVER a bare 409. The harness mock-owui now enforces the same lease (409 on overlap, 25ms
   hold). Test agentically:
   a. Create a scratch agent, then fire FIVE update_agent calls IN PARALLEL (concurrent
      call.js processes) with distinct descriptions — ALL five must succeed and the final
      agent state must equal one of the five writes (last-writer-wins is acceptable; errors
      are not). Verify via get_agent + the mock request log that no 409 reached a tool
      response.
   b. Mixed parallel burst: create_agent + update_agent (existing agent) + delete_agent
      (another scratch agent) concurrently — all succeed.
   c. Regression guard (mock-level): two overlapping RAW model/update POSTs directly against
      mock-owui (bypassing the rust client) must yield one 200 and one 409 — proving the
      lease simulation actually bites and the battery would catch a client that stopped
      serializing.
   d. Teardown: delete scratch agents; verify pristine.
