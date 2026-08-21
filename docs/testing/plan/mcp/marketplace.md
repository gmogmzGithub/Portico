# G.2 — Marketplace

Five scenarios for the marketplace feature: OOTB content, custom marketplace URL, sync error isolation, disablement, and skill installation.

- Up: [`docs/testing/plan/mcp/README.md`](README.md).

---

## Scenarios

### G-10 — Default OOTB marketplace lists expected core servers

**Coverage:** Auto — [`marketplace-ootb.test.js`](../../../../electron-app/src/services/marketplace-ootb.test.js)
**Type:** MCP
**Preconditions:** Fresh install or no custom marketplace URLs added.

**Steps (regression-investigation only):**
1. Open Settings → Marketplaces → confirm only the OOTB marketplace is listed.
2. Inspect the listed servers — should match the canonical OOTB set.

**Expected:**
- Default OOTB marketplace lists the expected core server set (Slack, Google Workspace, Glean, GitLab, etc.).

**Fail indicators:**
- A core server is missing.
- An unexpected server appears.

<!-- @portico:test-status:begin id=G-10 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:15.060Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/marketplace-ootb.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-11 — Add a custom GitLab marketplace URL → server list refreshes; auth (Private-Token) used

**Coverage:** Auto — [`gitlab-marketplace-auth.test.js`](../../../../electron-app/src/services/gitlab-marketplace-auth.test.js)
**Type:** MCP
**Preconditions:** A GitLab Personal Access Token that can read the marketplace project.

**Steps:**
1. Open Settings → Marketplaces → Add → enter the GitLab marketplace URL and PAT.
2. Save.
3. Inspect the server list refresh.

**Expected:**
- New servers from the GitLab marketplace appear within ~10s.
- Network requests use `Private-Token` header with the PAT.

**Fail indicators:**
- 401 / sync error.
- Marketplace URL persisted but server list never refreshes.

<!-- @portico:test-status:begin id=G-11 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:19.640Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/gitlab-marketplace-auth.test.js -- 4s
<!-- @portico:test-status:end -->

---

### G-12 — `syncAllMarketplaces` reports per-marketplace failures without aborting healthy ones

**Coverage:** Auto — [`marketplace-service.test.js`](../../../../electron-app/src/services/marketplace-service.test.js)
**Type:** MCP
**Preconditions:** Two marketplaces configured: one healthy and one with a bogus URL.

**Steps:**
1. Trigger marketplace sync (Settings → Marketplaces → Refresh).

**Expected:**
- Healthy marketplace's servers refresh successfully.
- Failing marketplace shows a per-marketplace error message.
- The healthy sync is NOT aborted because of the failing one.

**Fail indicators:**
- Single failure aborts the whole sync.
- Failing marketplace silently disappears.

<!-- @portico:test-status:begin id=G-12 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:20.770Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/marketplace-service.test.js -- 1s
<!-- @portico:test-status:end -->

---

### G-13 — Disable a marketplace → its servers are unlisted

**Coverage:** Partial — [`marketplace-reconciliation-wiring.test.js`](../../../../electron-app/src/services/marketplace-reconciliation-wiring.test.js)
**Type:** MCP
**Preconditions:** A custom marketplace enabled with at least one server visible.

**Steps:**
1. Settings → Marketplaces → toggle the custom marketplace off.
2. Inspect the integration list.

**Expected:**
- Servers contributed by that marketplace disappear from the list.
- Already-enabled servers from that marketplace are preserved (not toggled off — but no longer appear in the marketplace UI).

**Fail indicators:**
- Servers still appear after disable.
- Servers remain enabled but cannot resolve marketplace metadata.

<!-- @portico:test-status:begin id=G-13 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-14 — Install a marketplace skill → it appears in the skill manager

**Coverage:** Partial — [`skill-frontmatter.test.js`](../../../../electron-app/src/services/skill-frontmatter.test.js)
**Type:** MCP / Skills
**Preconditions:** A marketplace with at least one skill (not just a server).

**Steps:**
1. Open the marketplace UI; install a listed skill.
2. Open the skill manager.

**Expected:**
- The newly installed skill appears in the skill manager.
- Skill metadata (name, description, version) is parsed from front-matter.

**Fail indicators:**
- Install completes but skill is missing from the manager.
- Front-matter parse error throws and breaks UI.

<!-- @portico:test-status:begin id=G-14 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:44.017Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/skill-frontmatter.test.js -- 0s
<!-- @portico:test-status:end -->
