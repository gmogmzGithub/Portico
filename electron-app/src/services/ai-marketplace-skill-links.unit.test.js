const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  canonicalSkillName,
  clearLink,
  getLink,
  listLinks,
  normalizeState,
  readStateStrict,
  setLink,
  validateStrictState,
} = require("./ai-marketplace-skill-links");

async function makeTempUserData() {
  return await fs.mkdtemp(
    path.join(os.tmpdir(), "portico-skill-links-"),
  );
}

test("normalizeState drops malformed entries", () => {
  const state = normalizeState({
    links: {
      good: { solutionId: "sol-1", publishedAt: 1 },
      missingSolution: { publishedAt: 2 },
      notObject: "nope",
    },
  });
  assert.deepEqual(Object.keys(state.links), ["good"]);
  assert.equal(state.links.good.solutionId, "sol-1");
});

test("canonicalSkillName returns the final skill slug", () => {
  assert.equal(
    canonicalSkillName("portico-ai-marketplace/using-deepsearch"),
    "using-deepsearch",
  );
  assert.equal(canonicalSkillName("ai-marketplace/using-deepsearch"), "using-deepsearch");
  assert.equal(canonicalSkillName("using-deepsearch"), "using-deepsearch");
});

test("set/get/clear round-trips a skill link", async () => {
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };

  assert.equal(await getLink("incident-review", deps), null);

  const saved = await setLink("incident-review", "sol-123", deps);
  assert.equal(saved.solutionId, "sol-123");

  const fetched = await getLink("incident-review", deps);
  assert.equal(fetched.solutionId, "sol-123");

  const links = await listLinks(deps);
  assert.equal(links["incident-review"].solutionId, "sol-123");

  // Updating preserves publishedAt while advancing lastUpdatedAt.
  const updated = await setLink("incident-review", "sol-456", deps);
  assert.equal(updated.solutionId, "sol-456");
  assert.equal(updated.publishedAt, saved.publishedAt);

  assert.equal(await clearLink("incident-review", deps), true);
  assert.equal(await getLink("incident-review", deps), null);
  assert.equal(await clearLink("incident-review", deps), false);
});

test("prefixed skill names share one stored link", async () => {
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };

  const saved = await setLink("ai-marketplace/using-deepsearch", "sol-123", deps);
  assert.equal(saved.solutionId, "sol-123");
  assert.equal(
    (await getLink("using-deepsearch", deps)).solutionId,
    "sol-123",
  );

  const updated = await setLink(
    "portico-ai-marketplace/using-deepsearch",
    "sol-456",
    deps,
  );
  assert.equal(updated.solutionId, "sol-456");
  assert.equal(updated.publishedAt, saved.publishedAt);

  const links = await listLinks(deps);
  assert.deepEqual(Object.keys(links), ["using-deepsearch"]);
  assert.equal(links["using-deepsearch"].solutionId, "sol-456");

  assert.equal(await clearLink("portico-ai-marketplace/using-deepsearch", deps), true);
  assert.equal(await getLink("using-deepsearch", deps), null);
});

test("normalizeState collapses legacy prefixed link keys", () => {
  const state = normalizeState({
    links: {
      "ai-marketplace/using-deepsearch": {
        solutionId: "sol-123",
        publishedAt: 1,
        lastUpdatedAt: 2,
      },
      "portico-ai-marketplace/using-deepsearch": {
        solutionId: "sol-456",
        publishedAt: 3,
        lastUpdatedAt: 4,
      },
    },
  });

  assert.deepEqual(Object.keys(state.links), ["using-deepsearch"]);
  assert.equal(state.links["using-deepsearch"].solutionId, "sol-456");
});

test("strict state validation rejects canonical key collisions", () => {
  const ambiguous = {
    links: {
      "ai-marketplace/using-deepsearch": { solutionId: "sol-123" },
      "portico-ai-marketplace/using-deepsearch": { solutionId: "sol-456" },
    },
  };

  assert.throws(
    () => validateStrictState(ambiguous),
    /ambiguous keys for using-deepsearch/,
  );
});

test("strict state validation rejects dot path segments", () => {
  for (const key of [".", "..", "source/.."]) {
    assert.throws(
      () =>
        validateStrictState({
          links: { [key]: { solutionId: "sol-123" } },
        }),
      /invalid link record/,
    );
  }
});

test("readStateStrict rejects a symlinked registry", async () => {
  const userDataPath = await makeTempUserData();
  const targetPath = path.join(userDataPath, "skill-links-target.json");
  const registryPath = path.join(userDataPath, "ai-marketplace-skill-links.json");
  await fs.writeFile(
    targetPath,
    JSON.stringify({ links: { safe: { solutionId: "sol-123" } } }),
    "utf8",
  );
  await fs.symlink(targetPath, registryPath);

  await assert.rejects(
    () => readStateStrict({ userDataPath }),
    /must be a regular file/,
  );
});

test("readStateStrict normalizes valid state and fails closed on malformed state", async () => {
  const userDataPath = await makeTempUserData();
  const filePath = path.join(userDataPath, "ai-marketplace-skill-links.json");

  await fs.writeFile(
    filePath,
    JSON.stringify({
      links: {
        "ai-marketplace/using-deepsearch": {
          solutionId: " sol-123 ",
          publishedAt: 1,
          hasLocalChanges: false,
        },
      },
    }),
    "utf8",
  );
  assert.deepEqual(await readStateStrict({ userDataPath }), {
    links: {
      "using-deepsearch": {
        solutionId: "sol-123",
        publishedAt: 1,
        lastUpdatedAt: 1,
        hasLocalChanges: false,
      },
    },
  });

  await fs.writeFile(filePath, "{not-json", "utf8");
  await assert.rejects(() => readStateStrict({ userDataPath }), SyntaxError);
});

test("readStateStrict returns empty state only when the registry is absent", async () => {
  const userDataPath = await makeTempUserData();
  assert.deepEqual(await readStateStrict({ userDataPath }), { links: {} });
});

test("setLink validates inputs", async () => {
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  await assert.rejects(() => setLink("", "sol-1", deps));
  await assert.rejects(() => setLink("name", "", deps));
});

test("PORTICO-317: concurrent setLinks never corrupt the registry and never lose updates", async () => {
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  const N = 40;
  // Fire many read-modify-write cycles at once. Without a unique temp name and
  // serialization, these interleave: the shared pid-only temp file is clobbered
  // mid-write (corrupt JSON that fails readStateStrict on the next publish) and
  // updates are lost. The registry must survive both.
  await Promise.all(
    Array.from({ length: N }, (_unused, i) =>
      setLink(`skill-${i}`, `sol-${i}`, deps),
    ),
  );

  // Must parse under the strict reader (no corruption)...
  const state = await readStateStrict(deps);
  // ...and every update must have landed (no lost updates).
  assert.equal(Object.keys(state.links).length, N);
  for (let i = 0; i < N; i += 1) {
    assert.equal(state.links[`skill-${i}`].solutionId, `sol-${i}`);
  }
});

test("PORTICO-317: concurrent set + clear leave a consistent, valid registry", async () => {
  const userDataPath = await makeTempUserData();
  const deps = { userDataPath };
  for (let i = 0; i < 10; i += 1) {
    await setLink(`keep-${i}`, `sol-${i}`, deps);
  }
  await Promise.all([
    ...Array.from({ length: 10 }, (_u, i) => setLink(`add-${i}`, `new-${i}`, deps)),
    ...Array.from({ length: 10 }, (_u, i) => clearLink(`keep-${i}`, deps)),
  ]);

  const state = await readStateStrict(deps); // must not throw
  assert.equal(Object.keys(state.links).length, 10);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(state.links[`add-${i}`].solutionId, `new-${i}`);
    assert.equal(state.links[`keep-${i}`], undefined);
  }
});
