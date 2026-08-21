const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const flags = require("./agent-local-flags");

function withTempStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-flags-test-"));
  const deps = { userDataPath: dir };
  return Promise.resolve(fn(deps, dir)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("setSkillsNotFoundFlags creates, unions, and stamps first/last seen", async () => {
  await withTempStore(async (deps) => {
    await flags.setSkillsNotFoundFlags(
      [{ agentId: "agent-1", agentName: "Agent One", skills: ["gone-a"] }],
      deps,
    );
    const first = (await flags.getAgentFlags("agent-1", deps))[0];
    assert.equal(first.type, flags.FLAG_SKILLS_NOT_FOUND);
    assert.deepEqual(first.skills, ["gone-a"]);
    assert.equal(typeof first.firstSeen, "number");
    assert.equal(first.firstSeen, first.lastSeen);

    await flags.setSkillsNotFoundFlags(
      [{ agentId: "agent-1", skills: ["gone-a", "gone-b"] }],
      deps,
    );
    const merged = (await flags.getAgentFlags("agent-1", deps))[0];
    assert.deepEqual(merged.skills.sort(), ["gone-a", "gone-b"]);
    assert.equal(merged.firstSeen, first.firstSeen, "firstSeen survives merges");
    assert.ok(merged.lastSeen >= first.lastSeen);
  });
});

test("reconcile clears flags when the condition stops holding, keeps them while it does", async () => {
  await withTempStore(async (deps) => {
    await flags.setSkillsNotFoundFlags(
      [
        { agentId: "agent-gone", skills: ["dead-skill"] },
        { agentId: "agent-fixed", skills: ["dead-skill"] },
        { agentId: "agent-still-broken", skills: ["dead-skill", "revived-skill"] },
      ],
      deps,
    );

    const result = await flags.reconcileSkillsNotFoundFlags(
      {
        agents: [
          // agent-gone: absent from live inventory → flag dropped.
          // agent-fixed: no longer references the skill → flag dropped.
          { id: "agent-fixed", skillIds: ["other-skill"] },
          // agent-still-broken: still references both; one skill came back.
          {
            id: "agent-still-broken",
            skillIds: ["dead-skill", "mp/plugin/revived-skill"],
          },
        ],
        skillLeafExists: (leaf) => leaf === "revived-skill",
      },
      deps,
    );

    assert.deepEqual(Object.keys(result), ["agent-still-broken"]);
    assert.deepEqual(result["agent-still-broken"][0].skills, ["dead-skill"]);

    // Fully resolved on the next pass → store empties.
    const cleared = await flags.reconcileSkillsNotFoundFlags(
      {
        agents: [{ id: "agent-still-broken", skillIds: ["dead-skill"] }],
        skillLeafExists: () => true,
      },
      deps,
    );
    assert.deepEqual(cleared, {});
  });
});

test("reconcile matches references across all id shapes and preserves unknown flag types", async () => {
  await withTempStore(async (deps, dir) => {
    fs.writeFileSync(
      path.join(dir, "agent-local-flags.json"),
      JSON.stringify({
        schemaVersion: 1,
        flags: {
          "agent-1": [
            {
              type: "SKILLS_NOT_FOUND",
              skills: ["mp/plugin/gone-a"],
              firstSeen: 1,
              lastSeen: 1,
            },
            { type: "FUTURE_FLAG_TYPE", skills: [], firstSeen: 1, lastSeen: 1 },
          ],
        },
      }),
    );

    const result = await flags.reconcileSkillsNotFoundFlags(
      {
        // The agent references the same skill by bare leaf: still a match.
        agents: [{ id: "agent-1", skillIds: ["gone-a"] }],
        skillLeafExists: () => false,
      },
      deps,
    );
    assert.equal(result["agent-1"].length, 2);
    assert.deepEqual(result["agent-1"][0].skills, ["mp/plugin/gone-a"]);
    assert.equal(result["agent-1"][1].type, "FUTURE_FLAG_TYPE");
  });
});

test("a corrupt sidecar degrades to empty instead of failing reads", async () => {
  await withTempStore(async (deps, dir) => {
    fs.writeFileSync(path.join(dir, "agent-local-flags.json"), "not-json{{{");
    assert.deepEqual(await flags.listFlags(deps), {});
    // And it self-heals on the next write.
    await flags.setSkillsNotFoundFlags([{ agentId: "a", skills: ["s"] }], deps);
    assert.equal((await flags.getAgentFlags("a", deps)).length, 1);
  });
});

test("clearAgentFlags drops one agent's flags only", async () => {
  await withTempStore(async (deps) => {
    await flags.setSkillsNotFoundFlags(
      [
        { agentId: "agent-1", skills: ["x"] },
        { agentId: "agent-2", skills: ["y"] },
      ],
      deps,
    );
    await flags.clearAgentFlags("agent-1", deps);
    const state = await flags.listFlags(deps);
    assert.deepEqual(Object.keys(state), ["agent-2"]);
  });
});
