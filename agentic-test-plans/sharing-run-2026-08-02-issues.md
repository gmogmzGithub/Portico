# Agentic sharing battery — run 2026-08-02 (post-fix re-run of the 2026-08-01 plan)

Harness: tests/agentic on /tmp/portico-agentic-r2 (fresh fixture), real skills/subagents servers,
headless real api.js, mock marketplace 18800, mock OWUI 18801, redis 16390. All 22 sharing.md
scenarios executed agentically in 12 batches. ~450 MCP tool calls total.

# ROUND 1 RESULTS — 22/22 scenarios PASS; 5 new issues found (fix pass below)

All 13 fixes from the 2026-08-01 run STAYED FIXED (regression watchpoints verified):
- ISSUE-1 republish-without-id adoption: held on 5 skill republishes + agent-side symmetry (11.5/11.6).
- ISSUE-2 reference/script CRUD marks dirty: held (S7 reference-only leg).
- ISSUE-3/4 collision guard + rename_skill remediation: held (S9; full rename contract S22 a-h all green).
- ISSUE-5 update_marketplace_skill ai-marketplace refresh-in-place: held (S10, byte-verified).
- ISSUE-6 hasUpdate survives sync_all/sync until real refresh: held (S10).
- ISSUE-7 update_agent marks link dirty: held (11.5) — but see NEW R2-2 bypass edge on the same route.
- ISSUE-8 agent_updates/has_update remote-flag pipeline: held (11.10, S17).
- ISSUE-9 read-only installed agents + verified marketplace_refresh + spoof block: held (11.10).
- ISSUE-10 existence gate before provenance gate: held (S15, all 6 sources).
- ISSUE-11 fail-closed add-gate (revised S16): held — NVIDIA/skills rejected with approved-sources
  message, registry byte-untouched; team-skills passes policy, blocked only by headless OAuth
  (auth_storage_unavailable); attach allowlist independently verified (skill_not_attachable).
- ISSUE-12 guard sweep finds marketplace agents (dual shape, fail-closed): held (S18.4/18.6, S20).
- ISSUE-13 server:agent-vm in core auto-activation: held (S19, all 5 subagent chats incl. bare run).
- Single-POST publish + PUT-only republish contract: held on every publish observed.
- Scenario 17 auto-add machinery: exercised END TO END headlessly by removing the GitHub OOTB
  knowledge-work-plugins from the fixture registry and letting install_agent restore it (real
  network); team-skills leg fails atomically with the documented auth class (rollback clean).

# NEW ISSUES FOUND (round 1) + FIX PASS

- R2-1 (contract, skills-server): references metadata under-reports. Enumeration in
  core-mcp-shared/skills_catalog.rs allowlists [md,txt,json,yaml] and walks only references/
  (plural), while create_skill_reference accepts any extension and get_skill_reference serves
  any UTF-8 file incl. reference/ (singular, shipped by real anthropic skills like mcp-builder).
  list_skills/read_skill/export references group silently omit .sql/.csv/reference/ files.
  FIX: enumerate all regular files under references/ + reference/ recursively, any extension.
- R2-2 (contract, subagents-server): update_agent {marketplace_refresh:true} on an EDITABLE
  PUBLISHED agent bypasses dirty-marking with zero verification — the bundle-verification gate
  (subagents.rs ~3262) only arms for read-only installed copies, but the mark-dirty skip
  (~3400) checks the raw boolean. Verified live: smuggled edit diverged from the listing while
  has_unpublished_changes stayed false. FIX: skip dirty-marking only when the VERIFIED read-only
  refresh path actually ran; editable agents treat the flag as a normal edit.
- R2-3 (hygiene, subagents-server): get_agent on unknown id returned an all-null envelope
  (is_read_only:true on a null object) instead of a not-found error. FIX: agent_not_found
  domain failure + list_agents remediation.
- R2-4 (harness bridge, FIXED MID-RUN): tests/agentic/electron-api-host.js dropped the `skills`
  rows (per-dependent solution ids), `repaired` counter, and `message` from publish_agent
  completions — production (agents.js ~7131) forwards them. Scenarios 17/18 depend on the rows.
  Fixed + verified live (bridge now mirrors the production result shape exactly).
- K1 (contract/hardening, two layers): solution/agent envelope reads leaked full inline bundles
  (skill_md bodies / system prompts) into LLM context. (a) mock GET /api/solutions/:id inlined
  `bundle`, diverging from docs/agent_reference/api-attribution-and-bundles-spec.md (envelope =
  metadata + has_bundle; content only via /:id/bundle) — mock fixed to spec; (b) api.js
  stripSolutionBodyFieldsForAgentSurface was a blocklist that never stripped `bundle`, so the
  documented omission depended on the remote's shape — hardened app-side.
- K2 (contract, state/persistence): OOTB-SEEDED installed skills resurrect after
  uninstall_marketplace_skill (silent restore on next load) and after
  detach_marketplace_skill_to_user_skill (restore ⇒ SILENT DUPLICATE user+marketplace copies).
  Root cause: marketplace-ootb.js merge pass cannot distinguish first-run seeding from
  deliberate removal. FIX: mirror the codified marketplace posture (marketplace-service.js
  ~3996 "fail it clearly at the single chokepoint" / immutable_marketplace): fail uninstall +
  detach clearly for seed-listed records with copy_skill remediation; non-seeded installs
  (user-added git installs, ai-marketplace solutions) unchanged.

# ROUND 2 RESULTS (same day, post-fix full re-run on /tmp/portico-agentic-r3)
22/22 scenarios PASS again. All round-1 fixes verified live: R2-1 (references enumeration
complete on all four surfaces incl. marketplace reference/-singular skills, enumeration ⊆
servable, exclusions hold), R2-2 (editable-agent smuggle now marks dirty; read-only
spoof/verified-refresh semantics unchanged), R2-3 (agent_not_found envelope), R2-4 (publish
skills rows end-to-end incl. capture-reseed flows), K1 (envelope deep-scans clean on
own+foreign skills AND agents; content only via bundle routes; wire = envelope GET + /bundle
GET), K2 (seeded uninstall/detach -> ootb_skill_immutable 409 + copy_skill remediation,
registry byte-untouched, both flat and plugin-grouped; non-seeded uninstall/detach unchanged
incl. no-resurrect across sync/reload cycles). All 13 fixes from 2026-08-01 held again.

ONE new issue found in round 2:
- ISSUE-A (contract/hygiene, subagents-server): the R2-3 root cause (fetch_model_by_id
  "succeeds" with a null body for unknown ids; is_base_model(null) -> true) persists on 3
  sibling routes: get_agent_system_prompt (PHANTOM SUCCESS {system_prompt:""} for ghost ids —
  worst), copy_agent (misclassifies as base_model_not_copyable), delete_agent (protocol
  -32603 "Cannot delete base model"). All fail closed (zero state damage) — misclassification
  only. FIX: mirror the R2-3 per-route null-body filter -> agent_not_found envelopes.
  FIXED same day (test-first, red-checked): shared helpers model_body_has_real_id /
  fetch_existing_model_by_id / agent_not_found_envelope now back all four routes; delete keeps
  its pinned resilience contract via a three-way split (Ok(real id) -> gate+proceed;
  Ok(null-body) -> authoritative not-found fail-closed; Err -> legacy delete-anyway fallback).
  tool_spec descriptions updated on the three routes. cargo test -p subagents-server 131/131.

# ROUND 3 RESULTS (same day, post-ISSUE-A-fix full re-run on /tmp/portico-agentic-r4)
22/22 scenarios PASS with ZERO issues — the converged round. ISSUE-A verified fixed on all
four routes (ghost get_agent / get_agent_system_prompt / copy_agent / delete_agent all return
the shared agent_not_found envelope; real-base-model contracts unchanged, incl. the pinned
-32603 base-model delete refusal and base_model_not_copyable). All prior fixes re-verified:
R2-1 (all four surfaces + marketplace reference/-singular), R2-2 (editable dirty + read-only
spoof/verified-refresh), R2-4 skills rows, K1 deep-scans own+foreign on both tool families,
K2 seeded-immutable + non-seeded detach/uninstall + no-resurrect cycles, ISSUE-1..13 from
2026-08-01. Sim-recipe learnings for future rounds: seed plugin-grouped sims (or no manifest
plugin wrapper) to avoid the round-9 regroup; verify clean-slate FS-only before auto-add legs
(any registry READ triggers merge-on-load restore of manually-removed OOTB entries); an
installedSkills row is required for relationship:"installed" on sims; always pass
timeout_seconds:30 to headless ask_user_question probes (default is 3600).

# GUI ROUND (2026-08-02, real app + mock 18808 via install_v2.sh --mock-marketplace, CDP-driven)
Batch 1 (skills lifecycle S5/6/8/9 GUI equivalents): states CONSISTENT with the agentic
surface end-to-end (single-POST publish w/ real confirm modal, amber dirty badge, PUT-same-id
republish, Discover-counterpart unpublish w/ "Checking..." guard-sweep busy label, read-only
foreign installs w/ correct kebab affordances, fail-closed collision, GUI delete modal).
- GUI-1 (contract, Chat UI layer): marketplace FAILURE notifications are invisible —
  agent-skills.js installDiscoverSolution (and siblings) route errors to window.showNotification,
  but control-plane.js's showNotification is a console.log stub ("DOM toasts retired... native
  macOS path") and the error path never reaches the native notifier. Install failures leave the
  button flipping back with zero user-visible explanation (the error text itself is excellent).
  Investigate the native-notifier wiring before fixing (r19-20 history: DOM toasts retired
  deliberately after the off-screen clobber).
- GUI-2 (cosmetic, accepted for now): service-layer remediation strings name MCP tools
  (rename_skill etc.) — right for agentic callers, odd vocabulary in GUI toasts.
Batch 2 (updates/freshness S10 GUI equivalent): ALL PASS, zero issues. Sweep 729/674ms
(no MISC-34 regression; Sync All's 68.9s is real git pulls, solutions leg sub-second);
"Update available" badge exact; refresh-in-place via kebab "Update from marketplace"
(unconfirmed action — noted, reasonable); fail-safe 404 handling of real installs vs mock.
Batch 3 (agents lifecycle S11+S13 GUI equivalents): publish/dirty/republish/unpublish/foreign
install/read-only contracts ALL CONSISTENT with agentic (incl. bundle payload w/
tool_server_ids, two-stage delete modals, read-only Details page). TWO issues:
- GUI-3 (HIGH contract, Chat UI layer): ALL GUI agent delete/uninstall affordances fail —
  r26 delete_agent confirm gate demands confirm:true; renderer call sites performDeleteAgent
  (electron-app/src/renderer/components/agents.js:5544) and performUninstallSolution (:5749)
  do not pass it. GUI modals already capture intent → fix: pass confirm:true there.
- GUI-4 (LOW): both sites surface only .message from the failure envelope; the gate's reason
  lives in .error → generic "Failed to delete agent". Fold .error into the surfaced text.
GUI FIX PASS (same day): GUI-3 fixed (confirm:true at agents.js performDeleteAgent +
performUninstallSolution; audit also caught ai-marketplace-install.js rollbackFreshAgent
missing confirm — failed installs were silently orphaning the fresh agent; fixed). GUI-4
fixed (message || error || fallback at both throw sites). GUI-1 fixed: no generic native
path existed (chat-native-notifications is chatId+type-gated; bug-report Notification is
main-only) → added minimal show-native-notification ipc handler (ipc.js registerUtilityHandlers)
+ preload showNativeNotification + control-plane stub now forwards all severities verbatim
(console line kept; DOM toasts NOT resurrected; missing bridge degrades to console-warn).
Tests: agents-delete-confirm.unit.test.js (4 behavioral: confirm-arg capture, modal path,
message/error/fallback precedence, inline modal error) + notification-global-integrity 3 new
(bridge forward, marketplace flow reach, bridge-failure tolerance). All touched suites green;
2 pre-existing failures verified at pristine HEAD (tab-search source-pin, loading-overlay
retired toast). Main-process files changed → relaunch required to take effect.
OPERATIONAL (this machine): app relaunches MUST use --force-local-build — without it the
docker one-shot prep resolves harbor.example.invalid/portico/mcp-orc-rust:<build> which is
unpullable here → "[Init] Docker services failed to start properly", app stuck on loading.
Batch 4 (fix verification + attach guards S18/20): FV1-3 all PASS (delete works; bridge
{shown:true}; collision failure natively forwarded verbatim, local skill byte-untouched).
Guard lifecycle CONSISTENT: delete pre-blocked client-side (disabled + naming tooltip),
unpublish guards inline in confirm modal w/ exact service texts, reuse-not-dup on reinstall.
- GUI-5 (bug, fixed same day + live-verified): "Remove copy" dead-ended when the listing was
  already tombstoned — solution_not_found missing from performDeleteAgent's already-gone set
  (agents.js ~5523) + double-period composition. Fixed; 2 behavioral tests; sibling sites
  audited (unpublish paths correctly keep surfacing already-absent).
- GUI-6 = the accepted agentic limbo (installed-copy link retained post-unpublish), now
  harmless with GUI-5 fixed.
Batch 5 (add-marketplace policy + K2 via GUI): ALL PASS, zero mutations; strings byte-equal
to agentic; policy pre-network (33ms); K2 ootb_skill_immutable inline in confirm modal;
agent-reference pre-block layers IN FRONT of K2 for attached OOTB skills; OOTB marketplaces
expose no remove affordance. Low obs: Add-dialog cancel is dismissal-not-abort (in-flight add
continues, errors into hidden modal); GitLab interactive auth parks silently -> auth_timeout
3min with no login surface this session.
Batch 6 (git installs via GUI): CONSISTENT (registry shape, {mp}/{plugin}/{skill} layout,
1.5s cached installs, Details view w/ full reference tree read-only, GitLab auth_timeout
mode identical w/ visible spinner + error notification at timeout).
- GUI-7 (medium, Chat UI): git drill-in kebab Uninstall executes with NO confirm modal
  (marketplaces.js ~2232 wires .marketplace-skill-menu-uninstall-btn straight to
  uninstallSkill) while the Installed-facet kebab uses confirmUninstallMarketplaceSkill.
  Destructive-gating inconsistency -> route git surface through the same confirm flow.

# FINAL COMBINED PASS (2026-08-02) — CAMPAIGN CONVERGED
AGENTIC ROUND 4 (/tmp/portico-agentic-r5, post-GUI-fix code): 22/22 scenarios, 12/12 batches,
ZERO issues — second consecutive fully-clean agentic round. All watchpoints held again
(ISSUE-1..13, R2-1/2/3, ISSUE-A, K1, K2, skills rows, ISSUE-12/13, rename contract).
GUI VERIFICATION ROUND 2 (same running app, all fixes live): three batteries, ZERO new issues.
- v2a skills+updates: notification fix CONFIRMED (spy captured full duplicate-name text via
  the global + [Notification:error] + native forward); single-POST/PUT wire again exact;
  update badge/refresh pipeline exact; solutions sweep leg sub-second (search 1-2ms).
- v2b agents+guards: fixed-delete CONFIRMED, fixed-uninstall CONFIRMED, tombstone
  Remove-copy CONFIRMED (plain "Agent deleted."), error-surfacing CONFIRMED (exact guard
  texts inline); reuse-not-dup reinstall; ordered teardown clean.
- v2c policy+installs: 5/5 policy gates byte-identical; K2 xlsx guard inline fail-safe;
  GUI-7 confirm modal CONFIRMED (cancel strict no-op); GitLab install leg FULL PASS with
  fresh auth (1.5s, team-skills add leg deliberately skipped to avoid a real add).
NEW OBSERVATIONS from the final pass (accepted/triage):
- Sync All runs checkSkillUpdates with interactiveAuth:true; with an expired GitLab session
  it launched browser OAuth and HELD THE REGISTRY WRITE LOCK for the full wait (14m09s
  observed; all skill mutations queue; only feedback is the disabled "Syncing..." button).
  Hardening candidate: don't hold the sweep lock across interactive auth, or surface an
  "Opening GitLab in your browser" notification. (User re-authed mid-run; healthy after.)
- Installed-facet Details on a GIT-installed skill uses the generic "installed from the AI
  Solutions Marketplace" banner (agent-skills.js ~3305 static branch) while the drill-in
  surface names the marketplace — cosmetic, pre-existing.
- Harness runs publish skill listings with description:"fixture" (bridge stub catalog in
  ai-marketplace-integration-fixture.js) — harness-only, not app behavior.
- Attach gate rejects bare declared names of FQN-installed skills with
  skill_not_installed_locally (fail-closed; wording mildly misleading) — attach-gate flavor
  of the accepted bare-name papercut. Script tools' bare-name flavor: "Script not found".
- lastCheckedVersion advances to the bundle frontmatter version when one exists (the "stays
  1.0" note applies to version-less bundles only).
- One-off unreproduced: a single read_skill immediately after update_skill returned an
  unenriched provenance envelope (1/~10; exact-sequence replays clean) — watch item only.

# ROUND 5 (same day, post writer-lease fix — commit 1ea7a26b)
Full battery re-run on /tmp/portico-agentic-r7 including NEW scenario 23: 12/12 batches, ZERO
issues — third consecutive fully-clean agentic round. Scenario 23 inaugural: 5-parallel
update_agent burst 5/5 OK (last-writer-wins, wire showed exactly 1 OWUI POST per call —
mutex fully serialized, retry ladder never needed), mixed create/update/delete burst OK,
raw-overlap mock probe 200+409 (trap armed). Lease watch on reconcile/LM-studio paths: no
anomalies. rollbackFreshAgent confirm fix live-proven again (17.6: no orphaned agent).
Sim-recipe addenda: seed solutions type:"skills" w/ references[].content_b64; gitlab sim
sources need canonical {type,host,projectPath,repoUrl,ref} (missing projectPath →
invalid_gitlab_project_path inside dependency install — publish carries the local source
verbatim into bundle refs). Observation-class hardening candidates: install reference writer
reads content_b64 only (plain `content` entries write empty files — unreachable via canonical
publishers); update_skill_script absolute-path message oddity; update_skill silently
normalizes mismatched frontmatter name back to the dir id (rename_skill remains sole rename).

# ACCEPTED OBSERVATIONS (documented, deliberately NOT fixed this round)
Hygiene/cosmetic notes that are by-design or low-value to change; re-runs should NOT re-flag
these as issues:
- read_skill duplicates provenance fields top-level + metadata{} (~350B); publish responses
  carry data+publishStatus duplicates (legacy-superset shape per confirm-flows comment).
- copy_skill retains source display_name verbatim (contract says content preserved).
- Frontmatter YAML re-serialization may flip quote style ("1.0" -> '1.0') on attribution inject.
- get_skill_assets download_url hardcodes localhost:9876 (correct for packaged app; dead inside
  the harness — integrity verified via FS instead).
- No agentic write path for BINARY assets (all content params UTF-8 JSON); copy_skill is the
  only route for image-bearing skills; get_skill_reference on a binary file says "not found"
  (safe, slightly misleading). By design for now.
- Bare-name lookups of FQN-installed skills return plain not-found without hinting the FQN
  (read_skill/update_skill; rename_skill leaf-source likewise skill_not_found while leaf-target
  collides). LLM ergonomics papercut, deferred.
- list_marketplaces returns full installedSkills state blobs (~6.5KB and growing); list_skills
  marketplace filter ~22KB for 17 skills (absolute paths, null fields). Context-diet candidates,
  deferred.
- sync_marketplace "ai-marketplace" -> marketplace_not_found with no remediation pointer at
  check_marketplace_skill_updates/update_marketplace_skill.
- Mock dual-shape (results+solutions same array) doubles search payloads in harness context —
  mock parity artifact, real backend sends results+facets.
- metadata.author null for foreign installed copies (owner lives in install yaml sidecar).
- update_marketplace_skill version:null + refreshed:true on no-op; lastCheckedVersion stays
  "1.0" for solution-backed skills (watermark is remoteUpdatedAt).
- run_subagent response carries no chat_tools/activated-skills echo (lean by design; verify
  out-of-band via get_activated_skills).
- tool_server_ids is an unvalidated pass-through (typo'd server ids land in chat_tools).
- wait clamps out-of-schema seconds (301 -> real 300s sleep) instead of rejecting; LM Studio
  tools silently ignore invalid ports (>65535).
- configure_lm_studio persists config before probing (intent-recording; matches description).
- delete_skill_script leaves an empty scripts/ dir; skill_in_use_by_agents envelope has
  remediation:null (guidance in error text); create_skill_script rejects non-.py with a
  code-less envelope; identical-string rename returns skill_already_exists (self-referential
  message) vs case-variant same_skill_name; two message shapes for skill_already_exists
  (Rust pre-gate vs Electron layer).
- unpublish_agent dependent_skill_listings enumerates ALL solution-kind refs incl. foreign
  referenced ones (informational; nothing acts destructively on it).
- After unpublish_agent, a local installed copy stays linked to the tombstoned listing
  (reconcile-at-startup "limbo" shape, self-heals per 2026-07-27 design).
- Auto-add of a known-OOTB marketplace restores the full OOTB definition (desirable).
- duplicate_marketplace is 409 while other add-gate rejections are 400; duplicate check runs
  after the manifest fetch for GitHub sources (id only knowable post-fetch).

Added after round 2 (same acceptance rationale):
- reclaim_skill leaves the marketplace install yaml sidecar inside the converted skills-user
  dir (cosmetic residue; verified it never leaks into republish bundles).
- Missing-required-param validation surfaces as JSON-RPC -32603 rather than -32602 / domain
  envelopes (read_skill, unpublish_skill, get_agent model_id, reasoning_effort fail-closed).
- Verified exact-payload update_agent refresh does NOT advance the link watermark — has_update
  stays latched until the canonical install_agent {existing_agent_id} runs (fix scope was
  dirty-marking only; remediation text names the canonical route).
- get_marketplace_bundle solution_type_mismatch body echoes solution_id:null (siblings echo
  the id); agents have no agentic bundle-content route (envelope-only per K1, by design).
- Install de-conflict ladder suffix is "-marketplace" then "-2"; delete_agent confirm-gate
  refusal is a code-less envelope; wait clamps low-side (0 -> 1s) like the accepted high-side.
- scripts metadata group enumerates .py only (write path accepts only .py; upstream non-py
  files under scripts/ land on disk + baselines but not in the scripts group).
- Skills whose doc trees live OUTSIDE reference{,s}/ (e.g. claude-api shared/*.md) enumerate
  references:[] truthfully; files stay readable via get_skill_reference.
- Mock /__test/seed drops display_name (applyWrite allowlist) — mock-only cosmetic.
- Round-9 migration/repair normalizes hand-seeded plugin-wrapped sim records on first load
  (layout re-group; designed) — future sim recipes should seed plugin-grouped or omit the
  manifest plugin wrapper.
- failedSkills rows carry the auth-limitation class as message text only (no per-row code);
  agent_dependency_install_failed envelope has remediation:null.
- Installed foreign solution copies keep the bundle's original created_by_email in SKILL.md
  frontmatter (bundle bytes verbatim); ownership authority = listing/link (accepted with the
  existing author-surfacing note).
