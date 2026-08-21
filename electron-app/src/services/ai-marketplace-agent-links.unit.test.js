const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  clearLink,
  readStateStrict,
  setLink,
  setPublishedLink,
} = require("./ai-marketplace-agent-links");

async function makeTempUserData() {
  return await fs.mkdtemp(
    path.join(os.tmpdir(), "portico-agent-links-"),
  );
}

test("setLink validates inputs", async () => {
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  await assert.rejects(() => setLink("", "sol-1", deps));
  await assert.rejects(() => setLink("agent", "", deps));
});

test("PORTICO-317: concurrent setLinks never corrupt the registry and never lose updates", async () => {
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  const N = 40;
  // Without a unique temp name + serialization, these interleave: the shared
  // pid-only temp file is clobbered mid-write (corrupt JSON that fails
  // readStateStrict on the next publish) and updates are lost.
  await Promise.all(
    Array.from({ length: N }, (_unused, i) =>
      setLink(`agent-${i}`, `sol-${i}`, deps),
    ),
  );

  const state = await readStateStrict(deps); // must not throw
  assert.equal(Object.keys(state.links).length, N);
  for (let i = 0; i < N; i += 1) {
    assert.equal(state.links[`agent-${i}`].solutionId, `sol-${i}`);
  }
});

test("PORTICO-317: concurrent published-link + clear leave a consistent, valid registry", async () => {
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  for (let i = 0; i < 10; i += 1) {
    await setPublishedLink(`keep-${i}`, `sol-${i}`, "publisher@example.com", deps);
  }
  await Promise.all([
    ...Array.from({ length: 10 }, (_u, i) =>
      setPublishedLink(`add-${i}`, `new-${i}`, "publisher@example.com", deps),
    ),
    ...Array.from({ length: 10 }, (_u, i) => clearLink(`keep-${i}`, deps)),
  ]);

  const state = await readStateStrict(deps); // must not throw
  assert.equal(Object.keys(state.links).length, 10);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(state.links[`add-${i}`].solutionId, `new-${i}`);
    assert.equal(state.links[`add-${i}`].relationship, "published");
    assert.equal(state.links[`keep-${i}`], undefined);
  }
});

test("remoteUpdatedAt baselines persist, survive relationship writes, and never mark dirty", async () => {
  const {
    setInstalledLink,
    setLinkRemoteUpdatedAt,
    markLinkDirty,
  } = require("./ai-marketplace-agent-links");
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };

  // No-op for unlinked agents.
  assert.equal(await setLinkRemoteUpdatedAt("ghost", "2026-07-28T01:00:00Z", deps), null);

  await setInstalledLink("copy", "sol-1", "author", { ...deps, attributionPending: false });
  let state = await readStateStrict(deps);
  assert.equal(state.links.copy.remoteUpdatedAt, null);

  const updated = await setLinkRemoteUpdatedAt("copy", "2026-07-28T01:00:00Z", deps);
  assert.equal(updated.remoteUpdatedAt, "2026-07-28T01:00:00Z");
  assert.equal(updated.hasLocalChanges, false);

  // Observation writes never touch the dirty flag; dirty writes never touch
  // the baseline; relationship rewrites preserve the baseline.
  await markLinkDirty("copy", deps);
  await setLinkRemoteUpdatedAt("copy", 1785200000, deps);
  state = await readStateStrict(deps);
  assert.equal(state.links.copy.remoteUpdatedAt, 1785200000);
  assert.equal(state.links.copy.hasLocalChanges, true);

  await setInstalledLink("copy", "sol-1", "author", { ...deps, attributionPending: false });
  state = await readStateStrict(deps);
  assert.equal(state.links.copy.remoteUpdatedAt, 1785200000);
  assert.equal(state.links.copy.hasLocalChanges, false);

  await setLink("copy", "sol-1", deps);
  state = await readStateStrict(deps);
  assert.equal(state.links.copy.remoteUpdatedAt, 1785200000);
});

test("hasRemoteUpdate: marked by the update sweep, cleared by sync writes (2026-08-01 sharing-run ISSUE-8)", async () => {
  const {
    markRemoteUpdate,
    setLinkRemoteUpdatedAt,
  } = require("./ai-marketplace-agent-links");
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };

  // Unlinked agents no-op.
  assert.equal(await markRemoteUpdate("ghost-agent", true, deps), null);

  await setLink("installed-agent", "sol-1", deps);
  const flagged = await markRemoteUpdate("installed-agent", true, deps);
  assert.equal(flagged.hasRemoteUpdate, true);
  let state = await readStateStrict(deps);
  assert.equal(state.links["installed-agent"].hasRemoteUpdate, true);

  // Advancing the observed remote baseline (refresh success) clears the flag.
  await setLinkRemoteUpdatedAt("installed-agent", "2026-08-01T21:00:00.000Z", deps);
  state = await readStateStrict(deps);
  assert.equal(state.links["installed-agent"].hasRemoteUpdate, false);

  // Re-flag, then a setLink (publish/install success) clears it too.
  await markRemoteUpdate("installed-agent", true, deps);
  await setLink("installed-agent", "sol-1", deps);
  state = await readStateStrict(deps);
  assert.equal(state.links["installed-agent"].hasRemoteUpdate, false);
});

// ---------------------------------------------------------------------------
// Sightings: soft-miss pruning policy (2026-08-08 access-flap incident — a
// single missed inventory read must flag, never delete; deletion requires
// spaced confirmation; reappearance heals).
// ---------------------------------------------------------------------------

test("sightings: first miss flags the link; reappearance heals it", async () => {
  const {
    applyLinkSightings,
    setInstalledLink,
  } = require("./ai-marketplace-agent-links");
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  await setInstalledLink("stable", "sol-a", "author@example.com", deps);
  await setInstalledLink("flappy", "sol-b", "author@example.com", deps);

  const t0 = Date.parse("2026-08-08T04:20:53Z");
  const first = await applyLinkSightings(
    { presentIds: ["stable"], absentIds: ["flappy"] },
    { ...deps, nowMs: t0 },
  );
  assert.deepEqual(first.flagged, ["flappy"]);
  assert.deepEqual(first.deleted, []);
  let state = await readStateStrict(deps);
  assert.equal(state.links.flappy.solutionId, "sol-b"); // NOT deleted
  assert.equal(state.links.flappy.missingSince, new Date(t0).toISOString());
  assert.equal(state.links.flappy.missCount, 1);
  assert.equal(state.links.stable.missingSince, null);

  const healed = await applyLinkSightings(
    { presentIds: ["stable", "flappy"], absentIds: [] },
    { ...deps, nowMs: t0 + 60_000 },
  );
  assert.deepEqual(healed.healed, ["flappy"]);
  state = await readStateStrict(deps);
  assert.equal(state.links.flappy.missingSince, null);
  assert.equal(state.links.flappy.missCount, 0);
});

test("sightings: repeat miss inside the spacing window neither increments nor deletes", async () => {
  const {
    applyLinkSightings,
    setInstalledLink,
    MISSING_CONFIRM_SPACING_MS,
  } = require("./ai-marketplace-agent-links");
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  await setInstalledLink("stable", "sol-a", "author@example.com", deps);
  await setInstalledLink("flappy", "sol-b", "author@example.com", deps);

  const t0 = Date.parse("2026-08-08T04:20:53Z");
  await applyLinkSightings(
    { presentIds: ["stable"], absentIds: ["flappy"] },
    { ...deps, nowMs: t0 },
  );
  const repeat = await applyLinkSightings(
    { presentIds: ["stable"], absentIds: ["flappy"] },
    { ...deps, nowMs: t0 + MISSING_CONFIRM_SPACING_MS - 1 },
  );
  assert.deepEqual(repeat.flagged, []);
  assert.deepEqual(repeat.deleted, []);
  const state = await readStateStrict(deps);
  assert.equal(state.links.flappy.missCount, 1);
  assert.equal(state.links.flappy.lastMissAt, new Date(t0).toISOString());
});

test("sightings: a spaced second miss confirms and deletes; store survives strict re-read", async () => {
  const {
    applyLinkSightings,
    setInstalledLink,
    MISSING_CONFIRM_SPACING_MS,
  } = require("./ai-marketplace-agent-links");
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  await setInstalledLink("stable", "sol-a", "author@example.com", deps);
  await setInstalledLink("gone", "sol-b", "author@example.com", deps);

  const t0 = Date.parse("2026-08-08T04:20:53Z");
  await applyLinkSightings(
    { presentIds: ["stable"], absentIds: ["gone"] },
    { ...deps, nowMs: t0 },
  );
  const confirmed = await applyLinkSightings(
    { presentIds: ["stable"], absentIds: ["gone"] },
    { ...deps, nowMs: t0 + MISSING_CONFIRM_SPACING_MS },
  );
  assert.deepEqual(confirmed.deleted, ["gone"]);
  const state = await readStateStrict(deps); // must not throw
  assert.equal(state.links.gone, undefined);
  assert.equal(state.links.stable.solutionId, "sol-a");
});

test("sightings: an absent-only report is treated as a broken read and skipped", async () => {
  const {
    applyLinkSightings,
    setInstalledLink,
  } = require("./ai-marketplace-agent-links");
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  await setInstalledLink("a", "sol-a", "author@example.com", deps);
  await setInstalledLink("b", "sol-b", "author@example.com", deps);

  const result = await applyLinkSightings(
    { presentIds: [], absentIds: ["a", "b"] },
    { ...deps, nowMs: Date.parse("2026-08-08T04:20:53Z") },
  );
  assert.equal(result.skipped, true);
  assert.deepEqual(result.flagged, []);
  const state = await readStateStrict(deps);
  assert.equal(state.links.a.missingSince, null);
  assert.equal(state.links.b.missingSince, null);
});

test("sightings: unreported links are untouched; miss fields survive unrelated writes", async () => {
  const {
    applyLinkSightings,
    setInstalledLink,
    setLink,
  } = require("./ai-marketplace-agent-links");
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  await setInstalledLink("seen", "sol-a", "author@example.com", deps);
  await setInstalledLink("flagged", "sol-b", "author@example.com", deps);
  await setInstalledLink("unreported", "sol-c", "author@example.com", deps);

  const t0 = Date.parse("2026-08-08T04:20:53Z");
  await applyLinkSightings(
    { presentIds: ["seen"], absentIds: ["flagged"] },
    { ...deps, nowMs: t0 },
  );
  // A write through an unrelated op must not drop the miss fields
  // (normalizeState whitelist regression guard).
  await setLink("another", "sol-d", deps);
  const state = await readStateStrict(deps);
  assert.equal(state.links.flagged.missCount, 1);
  assert.equal(state.links.flagged.missingSince, new Date(t0).toISOString());
  assert.equal(state.links.unreported.missingSince, null);
});

test("writeState keeps a .bak of prior content plus pruned daily snapshots", async () => {
  const {
    setLink,
    FILE_NAME,
  } = require("./ai-marketplace-agent-links");
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  const filePath = path.join(userDataPath, FILE_NAME);

  await setLink("agent-1", "sol-1", deps);
  const firstContent = await fs.readFile(filePath, "utf8");
  await setLink("agent-2", "sol-2", deps);

  const bak = await fs.readFile(`${filePath}.bak`, "utf8");
  assert.equal(bak, firstContent, ".bak preserves the pre-overwrite content");

  const day = new Date().toISOString().slice(0, 10);
  const snapshot = await fs.readFile(`${filePath}.${day}.json`, "utf8");
  assert.equal(snapshot, firstContent, "daily snapshot captures first pre-overwrite content of the day");

  // Snapshot is once-per-day: a third write must not clobber it.
  await setLink("agent-3", "sol-3", deps);
  assert.equal(await fs.readFile(`${filePath}.${day}.json`, "utf8"), firstContent);

  // Retention prunes to the newest 7 by name sort.
  for (let i = 1; i <= 9; i += 1) {
    await fs.writeFile(`${filePath}.2026-07-0${i}.json`, "{}", "utf8");
  }
  await fs.rm(`${filePath}.${day}.json`, { force: true });
  await setLink("agent-4", "sol-4", deps);
  const names = (await fs.readdir(userDataPath))
    .filter((name) => /\.\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  assert.equal(names.length, 7, "retention keeps the newest 7 snapshots");
  assert.ok(!names.includes(`${FILE_NAME}.2026-07-01.json`));
  assert.ok(names.includes(`${FILE_NAME}.${day}.json`));
});
