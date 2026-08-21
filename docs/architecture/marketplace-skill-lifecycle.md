# Marketplace Skill Lifecycle: seedMigrations, Mirror-Truth Sync, Agent Flags

**Layers:** State & Persistence (registry + OOTB seeding), Chat UI (Updates tab,
sync consent modal, agent warning surfaces), MCP Orchestration (skills-server
tools, subagents transport), Update & Distribution (the OOTB bundle and its
mirror script).

This document is the contract for how installed marketplace skills are born,
move, and die — written after the 2026-08-11 `ux-quality-beta → ux-quality`
incident, in which an upstream plugin rename left every beta user with a
permanently stuck "Updates available" row that Sync All could never resolve
(and falsely reported as success). Read the **Decision log** before proposing
changes: several "obvious improvements" here were considered and rejected on
purpose.

---

## 1. The two provenances

| | OOTB-seeded skills | User-installed skills |
|---|---|---|
| Origin | Shipped in the app bundle (`marketplaces-ootb/`), auto-installed for every user | Installed by the user from a marketplace |
| Identity authority | **The bundle.** Renames arrive as `seedMigrations` entries and heal silently | **Upstream + the user.** No relinking, ever — a vanished source is resolved through consent |
| Removable? | No (`ootb_skill_immutable`); they stop shipping via a bundle that no longer lists them | Yes — by the user, or by the destructive sync when the source vanished |
| Who fixes a rename | The operator's mirror run + the next app update; zero user interaction | The user (reinstall the successor, re-attach agents) |

Everything below follows from keeping those columns separate.

## 2. Bundle anatomy (`marketplaces-ootb/marketplaces.json`)

```jsonc
{
  "version": "1.0",
  "marketplaces": [ /* entries, each stamped ootb:true, carrying lastSynced */ ],
  "installedSkills": [ /* full seed records: identity + localPath + baseline */ ],
  "seedMigrations": [           // OPTIONAL — the alias map
    {
      "from": { "marketplaceId": "…", "pluginName": "…", "skillId": "…",
                 "skillPath": "…" /* optional discriminator, same-triple path moves only */ },
      "to":   { "marketplaceId": "…", "pluginName": "…", "skillId": "…" }
    }
  ]
}
```

`seedMigrations` is a **flat alias map**: every historical identity points at
the CURRENT identity. Flatness is maintained at build time (see §3) so a
client jumping several app versions heals in one lookup — no chain walking.
There are **no tombstones**: a seed that stops shipping simply disappears from
`installedSkills`, and nothing else is recorded (see Decision log #1).

## 3. The mirror script (`sync_ootb_marketplaces.sh`) — operator runbook

The script mirrors the **operator machine's live state** (`./marketplaces.json`
+ `./skills-marketplace/`) into `marketplaces-ootb/`, and is the single human
control point for seed lifecycle bookkeeping. On every run it diffs the
previous committed bundle against the new snapshot by seed key
`(marketplaceId, skillId)`:

- **Same key, moved identity** (pluginName or skillPath changed): an alias is
  generated **automatically** and printed. This is the plugin-rename case —
  the key survives, so no human pairing is needed.
- **Vanished key + appeared key**: a leaf rename candidate. Interactive runs
  propose pairings from baseline sha256 overlap (≥50% of the smaller file
  set) and ask per key (`y / r=type identity / d=deliberate removal / a=abort`).
  `--yes` runs **hard-fail** unless every vanished key is covered by
  `--rename mp/plugin/skill=mp/plugin/skill` or
  `--acknowledge-removal mp/skill`.
- **Removal acknowledgment is one-time**: diffs are bundle-to-bundle, so once
  a removal ships, later runs never re-prompt. No persistent ledger exists or
  is needed.
- **Roll-forward**: prior aliases are carried; every alias targeting a
  renamed-away identity is repointed to the new one (flatness); aliases whose
  `from` reappears as a live seed are **retired** (printed as a warning — a
  previously renamed/removed identity came back); aliases whose target stopped
  shipping are pruned.
- **Preflights**: duplicate `(marketplaceId, skillId)` across plugins fails
  the run (the seed join and the alias map key on that pair); the emitted
  bundle self-checks that the alias map is flat, every target is a live seed,
  and no plain-triple `from` shadows a live seed identity.

Release sequencing for a rename incident (the chicken-and-egg): land the app
code → heal the operator machine through the ordinary user-grade flow
(destructive sync resolves the dead records, then install the successor
plugin) → run the mirror (it detects the old-bundle→new-state diff and emits
the aliases) → commit + ship. Fleet machines heal silently at their first
config load on the new build.

## 4. Client-side seed identity migration (config load)

`marketplace-ootb.js#applySeedIdentityMigrations`, run inside
`ensureBundledMarketplaceDefaults` on **every registry load**, before the seed
merge (migrations can change record keys):

1. A live record is matched by its full identity triple
   `(marketplaceId, pluginName, skillId)` against a migration's `from` (plus
   the optional `skillPath` discriminator).
2. The migration applies **only when its target is a current bundle seed**
   with the declared identity. Dead or drifted targets skip with a diag.
3. Guards (skip + diag, never guess): target identity already held by another
   record; target payload dir occupied; copy failure (copy-then-delete with
   byte verification; emptied old parents pruned).
4. Identity fields (`marketplaceId`, `skillId`, `pluginName`, `skillPath`,
   `skillSource`, `localPath`) are rewritten **as a unit** from the seed.
   `baseline`, `contentHeadSha`, `hasUpdate`, versions, and timestamps are
   preserved — content reconciliation stays with sync/update, so a migrated
   skill with pending upstream changes still shows and applies them normally.

**Why explicit entries only:** a bare "record identity ≠ seed identity ⇒ adopt
the seed's" rule runs BACKWARDS on machines whose live state is fresher than a
stale bundle (exactly the post-heal state during a rollout or downgrade) and
re-wedges the records it exists to heal. Direction is encoded in the entries,
which only ever ship in bundles whose seeds ARE the target identity.

Two merge rules back this up (both in `marketplace-ootb.js`):

- `mergeInstalledSkillEntry`: the record's source-identity unit is
  **existing-wins** whenever the record has a `localPath` — a seed re-merge
  (which runs on every load) must never drag one identity field backwards.
  (The pre-fix behavior — seed `skillPath` wins — is what kept re-poisoning
  healed records during the incident.)
- `mergeMarketplaceEntry`: the cachedManifest **union gate** — bundled plugins
  are only unioned into the live manifest when the bundle's `lastSynced` is
  not older than the live entry's. A manifest the user synced yesterday is
  fresher truth than a three-week-old snapshot; without the gate, the bundle
  resurrected upstream-deleted plugins on every load.

## 5. Agent reference relinking (`agent-skill-relink.js`)

Agents reference skills in `subagent_skill_ids` as bare leaves, `mp/skill`, or
`mp/plugin/skill` — and every resolver in this system is **leaf-canonical**.
Consequences:

- **Plugin-folder renames break nothing** at runtime (the leaf survives). No
  agent writes happen for them.
- **Leaf renames** break all reference shapes. The relink sweep rewrites them
  from the bundle's alias map — **editable agents only**. Read-only installed
  copies are NEVER written (ownership boundary; see §7): they get a local
  `SKILLS_NOT_FOUND` flag instead.
- Hijack guard: a rename is only applied when the OLD leaf no longer names any
  installed skill (a same-leaf sibling means bare references currently resolve
  to it) and the NEW leaf exists locally.
- The sweep is **stateless and idempotent** — needs are recomputed from live
  agent data every run; no timers. Triggers: once per launch, armed by the
  first successful agent-inventory read (the subagents server is up only once
  the MCP stack is healthy), and at the start of every destructive sync
  (agents-first ordering). Its reconcile pass also retires stale flags (§8).

## 6. The destructive sync (mirror truth)

A marketplace sync's job is to make local state mirror the remote. Update All
and Sync All already run their **agents leg first** (installed-agent refreshes
before the skills legs), so a corrected agent republished by its owner drops
its bad references before skills are evaluated.

After the **fresh manifest fetch** (a failed fetch throws first — stale cached
manifests can never drive removals), records whose `(repo, skillPath)` no
longer exists in the manifest are classified:

| Missing record is… | Unused by any agent | Used by agents |
|---|---|---|
| Non-seeded | **Removed silently** (record, payload dir, emptied parents, publish sidecar link). No modal, no toast line — including locally-dirty copies (Decision log #3). | Kept + `sourceMissing`; reported as `pendingRemovals` (with the using agents, read-only marked). The sync hard-fails until resolved — **every** run, by design (the forcing function). Proceed = unlink + remove. |
| OOTB-seeded | Kept + `sourceMissing` marker, quietly. Bundle-managed: the additive seeder re-adds absent seeds, so removal can't stick; seedMigrations heal renames and true removals wait for the next bundle. | Kept + `sourceMissing` AND reported as `pendingRemovals` with `seeded:true` — the user still gets the stop-or-unlink decision, but **Proceed is unlink-only**: agents are unlinked (or flagged), the skill stays installed as the honest passive row until the next bundle resolves it (Decision log #7). |

Agent inventory unreachable → **fail closed** for every missing record: kept +
`sourceMissing` (non-seeded reported `agentsUnknown`; seeded reported
`seeded`). Nothing is removed and no consent is requested without a verified
usage read.

A path listed in the manifest whose download 404s stays an **error**
(`skill_path_not_found` in `skillSyncErrors`) — that is an upstream manifest
bug, not a removal.

**Consent (second phase).** The GUI shows one modal (an agents table per
skill; `marketplace-sync-removal-modal.js`) with exactly two exits: **Stop
sync** (nothing changes; it will ask again) or **Proceed** →
`applyMarketplaceSyncRemovals`: re-verify each target (still installed, still
`sourceMissing`), unlink editable agents FIRST across all three reference
shapes (a failed unlink keeps that skill installed — `unlink_failed`), flag
read-only agents, then remove non-seeded targets; seeded targets are kept in
place and reported via `keptSeeded`. Seeded rows carry an in-modal note and
the proceed button reads "Unlink from agents" when every row is seeded.
After an unlink-only proceed the skills become unused-seeded, so the next
sync keeps them quietly — the modal does not recur. Agent-driven callers use
the `skills_apply_marketplace_sync_removals` MCP tool, gated on
`confirm=true` after the model relays the pending list to the user
(approval-flow-registry mode C).

## 7. The ownership boundary (read-only installed agents)

An installed agent copy is the **publisher's** artifact. The local client
never edits it — not to unlink a dead skill, not to relink a renamed one (the
server-side `installed_copy_read_only` guard enforces this; the verified
marketplace-refresh payload path is reserved for actual listing refreshes).
Instead:

- The local breadcrumb is a `SKILLS_NOT_FOUND` flag (§8) with warning surfaces
  pointing at the resolution: *the owner republishes a corrected agent*.
- Because Sync All refreshes agents first, the owner's fix propagates on the
  user's next sync, and the flag retires automatically.

## 8. Agent local flags (`agent-local-flags.js`)

Sidecar `agent-local-flags.json` in userData:
`{ schemaVersion, flags: { <agentId>: [{ type, skills, firstSeen, lastSeen }] } }`.

- One type today: `SKILLS_NOT_FOUND` (the referenced skills are gone locally).
  The type registry is extensible; unknown types round-trip untouched.
- **Derived, recomputable state**: written by the sync-removal executor and
  the relink sweep; `reconcileSkillsNotFoundFlags` clears entries whenever the
  condition stops holding (agent gone, reference dropped, skill present
  again). A corrupt file degrades to empty and self-heals.
- **Never published, never logic-bearing**: flags must not feed stale/dirty/
  unpublished-changes/freshness computations. Display + support surfaces only:
  the ⚠ Warnings badge on agent cards, the pastel warning pane stacked under
  the blue read-only pane in the agent view, and per-row warning notes in the
  agent's skills table.

## 9. Updates-tab states (honesty contract)

- `hasUpdate` — a real update exists at the recorded path → "Updates
  available", Update All applies it.
- `sourceMissing` — the path is definitively gone at head (SKILL.md probe
  404s; transient failures never flip state in either direction) → **"No
  longer published"**, never "Updates available"; a deletion is not an update.
  Sync is the resolution path. The sweep stops fetching dead paths.
- **Missing-row drift = time since the upstream removal commit** (`now −
  sourceMissingSince`), unlike update rows whose drift is remote-stamp vs
  local baseline. `sourceMissingSince` is the committed date of the newest
  commit touching the dead path (for a deleted path that commit IS the
  deletion/rename — the desync moment), fetched by the sweep's one-shot
  commits-by-path lookup with the group head date as fallback. Contract:
  stamped once, never overwritten while present, cleared exactly where
  `sourceMissing` clears, and the destructive sync never stamps (it is
  manifest-driven and adds no network) — the next sweep backfills
  sync-flagged records even when the repo's sha gate holds. A row groups
  multiple missing skills under the **oldest** stamp; a group with no stamps
  renders "—".
- Bulk results are truthful: per-row `Failed` / `Partial` / `Needs decision` /
  `Kept` states with per-skill tooltips; toasts count real outcomes. A sync
  where every skill failed can never toast "Synced".

## 10. Invariants

1. **Seeding is additive and non-destructive.** A bundle update never removes,
   never overwrites differing live content, and never opens a modal.
2. **Identity changes happen only through declared `seedMigrations`** —
   atomically, whole-identity, target-must-be-a-current-seed. Never through
   field-level merges, never heuristically.
3. **Only the user-initiated destructive sync removes skills**, and never
   without either zero agent usage (verified) or explicit consent.
4. **Read-only installed agents are never written** by the local client.
5. **No auto-detach**: removed skill content is not rescued into
   `skills-user/`.
6. **Fail closed on unverifiable agent usage**; fail open (no-op) on
   unavailable inventory for the opportunistic relink sweep.
7. **No new timers/polling**: every pass is piggybacked on existing cycles
   (config loads, sync runs, first successful inventory read).

## 11. Decision log

1. **No grandfathering / tombstones** (considered, dropped). "Keeping deleted
   seeds" is what the additive seeder already does by default; a tombstone
   ledger added client complexity for one warning print. Reappearance needs no
   memory: the ordinary key join re-adopts or re-seeds.
2. **No relink suggestions in the consent modal.** Guessing a successor skill
   is human judgment; a wrong suggestion silently rewires agents. The modal
   shows facts and two exits.
3. **No dirty-content rescue on removal.** Marketplace installs are read-only
   through the app; drift is out-of-band (direct disk edits, container
   writes). Rescue-to-`skills-user/` was rejected: no marketplace skill may
   become a user skill implicitly.
4. **The recurring hard-fail is a feature.** A kept in-use missing skill
   re-prompts on every destructive sync until resolved — that is the forcing
   function; the only passive state between syncs is the honest
   "No longer published" row.
5. **Plugin renames don't touch agents.** Leaf-canonical resolution makes the
   plugin segment decorative at runtime; rewriting references for it would be
   churn with hijack risk and zero benefit.
6. **Missing-row drift anchors on the removal commit, not on cheaper stamps.**
   `lastSynced` re-stamps on every sync attempt (even failed ones) — a
   lastSynced-anchored number would read "<1 day" forever; a "first noticed"
   wall-clock stamp lies whenever the app was closed. The removal commit's
   committed date is ground truth both forges expose in one
   commits-by-path call.
7. **Seeded missing skills get the consent flow, but unlink-only.** The first
   cut short-circuited OOTB-seeded records past the usage check entirely —
   users with agents on seeded dead skills got an unresolvable loop instead
   of the stop-or-unlink decision (2026-08-12, ux-quality interim). Removal
   stays impossible (the additive seeder re-adds absent seeds; a local
   suppression ledger was rejected as tombstones-by-another-name), but the
   unlink decision never required removal: Proceed unlinks/flags the agents
   and keeps the skill as the passive honest row until the next bundle
   resolves it.

## 12. Edge cases (all covered by tests)

- Reappearance of a removed/renamed identity → mirror script retires the
  alias (with a warning print); clients re-adopt/re-seed through the normal
  join. `marketplace-ootb.test.js`, journey C.
- Multi-version jump (user skips builds) → flat alias map, one hop.
- Dead-target alias (A→B shipped, B later removed) → inert on clients
  (target-must-exist), pruned at the next mirror run.
- Occupied target record/dir, ambiguous matches, copy failures → skip + diag,
  clean retry next load.
- Downgrade to an older bundle → healed identities survive (existing-wins
  merge + no reverse migrations). Journey A regression guard.
- Same-leaf sibling skills → bare-reference rewrites and unlinks stay
  conservative (leaf-canonical guards).

## 13. Test map

| Seam | Suite |
|---|---|
| Seed migration, merge precedence, union gate | `electron-app/src/services/marketplace-ootb.test.js` |
| Sweep honesty (`sourceMissing`), missing classification, silent removal, executor | `electron-app/src/services/marketplace-service.test.js` |
| Relink sweep | `electron-app/src/services/agent-skill-relink.unit.test.js` |
| Flags store | `electron-app/src/services/agent-local-flags.unit.test.js` |
| Updates-tab rows, truthful toasts, consent flow | `electron-app/src/services/updates-view.unit.test.js` |
| Agent card/detail warning surfaces | `electron-app/src/services/agents-tab-overhaul.unit.test.js` |
| IPC delegation + envelope | `electron-app/src/services/marketplace-api-wiring.test.js` |
| MCP confirm gate + proxy | `src/core-mcp-rust/crates/skills-server/tests/stdio_marketplace_flow.rs` |
| Mirror script lifecycle | `tests/test_sync_ootb_marketplaces.py` |
| Cross-module journeys | `electron-app/src/services/marketplace-lifecycle.integration.test.js` |
