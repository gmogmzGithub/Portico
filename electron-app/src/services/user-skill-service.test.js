const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createUserSkillService,
  splitSkillMarkdown,
} = require("./user-skill-service");

const CURRENT_IDENTITY = {
  email: "dsantiago@example.invalid",
  ldap: "dsantiago",
};

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-skill-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createUserSkillService({
    projectRoot: root,
    resolveIdentity:
      options.resolveIdentity || (async () => CURRENT_IDENTITY),
    markSkillLinkDirty: options.markSkillLinkDirty,
    // Registry deps default to inert stubs so plain-node tests never touch
    // the electron-backed skill-links module.
    getSkillLink: options.getSkillLink || (async () => null),
    clearSkillLink: options.clearSkillLink || (async () => true),
  });
  return { root, service };
}

function skillPath(root, skillName) {
  return path.join(root, "skills-user", skillName, "SKILL.md");
}

function writeSkill(root, skillName, content) {
  const target = skillPath(root, skillName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test("plain-Markdown creation is canonical and caller metadata cannot spoof creator identity", async (t) => {
  const { root, service } = fixture(t);
  const result = await service.createSkill({
    skillName: "release-notes-writer",
    skillContent: "# Release Notes Writer\n\nCreate clear release notes.\n",
  });

  assert.equal(result.created_by_email, CURRENT_IDENTITY.email);
  const saved = fs.readFileSync(skillPath(root, "release-notes-writer"), "utf8");
  const parsed = splitSkillMarkdown(saved);
  assert.equal(parsed.metadata.name, "release-notes-writer");
  assert.equal(parsed.metadata.description, "Create clear release notes.");
  assert.equal(parsed.metadata.created_by_email, CURRENT_IDENTITY.email);
  assert.equal(parsed.body, "# Release Notes Writer\n\nCreate clear release notes.\n");

  await service.createSkill({
    skillName: "descriptive-author",
    skillContent: `---
name: attacker-name
description: Descriptive metadata remains content metadata.
created_by_email: attacker@example.com
author: Dionny Santiago
custom_field: retained
---
# Body
`,
  });
  const descriptive = splitSkillMarkdown(
    fs.readFileSync(skillPath(root, "descriptive-author"), "utf8"),
  );
  assert.equal(descriptive.metadata.name, "descriptive-author");
  assert.equal(descriptive.metadata.created_by_email, CURRENT_IDENTITY.email);
  assert.equal(descriptive.metadata.author, "Dionny Santiago");
  assert.equal(descriptive.metadata.custom_field, "retained");
});

test("missing authenticated identity fails before filesystem mutation", async (t) => {
  const { root, service } = fixture(t, {
    resolveIdentity: async () => {
      const error = new Error("not signed in");
      error.code = "missing_user_identity";
      throw error;
    },
  });

  await assert.rejects(
    () =>
      service.createSkill({
        skillName: "must-not-exist",
        skillContent: "# No identity\n",
      }),
    (error) => error?.code === "missing_user_identity",
  );
  assert.equal(fs.existsSync(path.join(root, "skills-user")), false);
});

test("updates reject incomplete frontmatter without mutating the prior revision", async (t) => {
  const { root, service } = fixture(t);
  const target = writeSkill(
    root,
    "existing-skill",
    `---
name: old-name
description: Original description
created_by_email: original.creator@example.org
author: Employer Job Search (EJS)
custom_field:
  nested: true
---
# Original body
`,
  );
  const original = fs.readFileSync(target, "utf8");
  const expectedMessage =
    "SKILL.md updates require YAML frontmatter with nonblank string " +
    "'name' and 'description' fields. Missing or invalid: name, description. " +
    "Required fields are not copied from the previous revision.";

  await assert.rejects(
    () =>
      service.updateSkill({
        skillName: "existing-skill",
        skillContent: "# Replacement body\n",
      }),
    (error) => {
      assert.equal(error?.code, "malformed_skill_frontmatter");
      assert.equal(error?.message, expectedMessage);
      return true;
    },
  );
  assert.equal(fs.readFileSync(target, "utf8"), original);

  const invalidUpdates = [
    ["description only", "---\ndescription: Replacement\n---\n# Body\n"],
    ["name only", "---\nname: existing-skill\n---\n# Body\n"],
    ["blank name", "---\nname: ''\ndescription: Replacement\n---\n# Body\n"],
    ["blank description", "---\nname: existing-skill\ndescription: '   '\n---\n# Body\n"],
    ["non-string name", "---\nname: [existing-skill]\ndescription: Replacement\n---\n# Body\n"],
    ["non-string description", "---\nname: existing-skill\ndescription: { text: Replacement }\n---\n# Body\n"],
    ["empty mapping", "---\n{}\n---\n# Body\n"],
    ["empty document", "---\n\n---\n# Body\n"],
    ["non-mapping frontmatter", "---\n- name\n- description\n---\n# Body\n"],
    [
      "nested-only required fields",
      "---\nmetadata:\n  name: existing-skill\n  description: Replacement\n---\n# Body\n",
    ],
  ];

  for (const [label, skillContent] of invalidUpdates) {
    await assert.rejects(
      () => service.updateSkill({ skillName: "existing-skill", skillContent }),
      (error) => error?.code === "malformed_skill_frontmatter",
      label,
    );
    assert.equal(fs.readFileSync(target, "utf8"), original, label);
  }

  await service.updateSkill({
    skillName: "existing-skill",
    skillContent: `---
name: spoofed
description: Updated description
created_by_email: attacker@example.com
author: Dionny Santiago
---
# Updated
`,
  });
  const updated = splitSkillMarkdown(fs.readFileSync(target, "utf8"));
  assert.equal(updated.metadata.name, "existing-skill");
  assert.equal(updated.metadata.description, "Updated description");
  assert.equal(updated.metadata.created_by_email, "original.creator@example.org");
  assert.equal(updated.metadata.author, "Dionny Santiago");
  assert.deepEqual(updated.metadata.custom_field, { nested: true });
  assert.equal(updated.body, "# Updated\n");
});

test("update validation preserves missing and unsafe target error precedence", async (t) => {
  const { root, service } = fixture(t);

  await assert.rejects(
    () =>
      service.updateSkill({
        skillName: "missing-skill",
        skillContent: "# Invalid update\n",
      }),
    (error) => error?.code === "skill_not_found",
  );

  const outside = path.join(root, "outside-skill");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(outside, "SKILL.md"),
    "---\nname: outside\ndescription: Outside\n---\n# Outside\n",
  );
  fs.mkdirSync(path.join(root, "skills-user"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "skills-user", "unsafe-link"));

  await assert.rejects(
    () =>
      service.updateSkill({
        skillName: "unsafe-link",
        skillContent: "# Invalid update\n",
      }),
    (error) => error?.code === "unsafe_skill_path",
  );
});

test("app-created copies receive the current creator and retain descriptive author", async (t) => {
  const { root, service } = fixture(t);
  const source = path.join(root, "skills-marketplace", "catalog", "source-skill");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(source, "SKILL.md"),
    `---
name: source-skill
description: Marketplace source
created_by_email: publisher@example.org
author: Data Platform Team
---
# Source
`,
  );

  await service.copySkillToUser({
    sourcePath: source,
    skillName: "copied-skill",
  });
  const parsed = splitSkillMarkdown(
    fs.readFileSync(skillPath(root, "copied-skill"), "utf8"),
  );
  assert.equal(parsed.metadata.name, "copied-skill");
  assert.equal(parsed.metadata.created_by_email, CURRENT_IDENTITY.email);
  assert.equal(parsed.metadata.author, "Data Platform Team");
});

test("copy by skill id preserves the full bundle and resets Marketplace provenance", async (t) => {
  const { root, service } = fixture(t);
  const source = path.join(
    root,
    "skills-marketplace",
    "ai-marketplace",
    "installed-source",
  );
  fs.mkdirSync(path.join(source, "references", "nested"), { recursive: true });
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(source, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "SKILL.md"),
    `---
name: installed-source
description: Marketplace source
created_by_email: publisher@example.org
author: Data Platform Team
marketplace_relationship: installed
marketplace_solution_id: foreign-solution
---
# Source
`,
  );
  fs.writeFileSync(path.join(source, "references", "nested", "guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(source, "scripts", "run.py"), "print('source')\n");
  fs.writeFileSync(path.join(source, "assets", "fixture.bin"), Buffer.from([0, 1, 2, 255]));
  const originalSource = fs.readFileSync(path.join(source, "SKILL.md"), "utf8");

  const result = await service.copySkillById({
    sourceSkillId: "ai-marketplace/installed-source",
    newSkillName: "editable-copy",
  });

  assert.deepEqual(
    {
      success: result.success,
      source_skill_id: result.source_skill_id,
      skill_name: result.skill_name,
      source: result.source,
      created_by_email: result.created_by_email,
      marketplace_relationship: result.marketplace_relationship,
      marketplace_solution_id: result.marketplace_solution_id,
      is_read_only: result.is_read_only,
    },
    {
      success: true,
      source_skill_id: "ai-marketplace/installed-source",
      skill_name: "editable-copy",
      source: "user",
      created_by_email: CURRENT_IDENTITY.email,
      marketplace_relationship: null,
      marketplace_solution_id: null,
      is_read_only: false,
    },
  );
  const copiedRoot = path.join(root, "skills-user", "editable-copy");
  const copied = splitSkillMarkdown(
    fs.readFileSync(path.join(copiedRoot, "SKILL.md"), "utf8"),
  );
  assert.equal(copied.metadata.name, "editable-copy");
  assert.equal(copied.metadata.created_by_email, CURRENT_IDENTITY.email);
  assert.equal(copied.metadata.author, "Data Platform Team");
  assert.equal(copied.metadata.marketplace_relationship, undefined);
  assert.equal(copied.metadata.marketplace_solution_id, undefined);
  assert.equal(
    fs.readFileSync(path.join(copiedRoot, "references", "nested", "guide.md"), "utf8"),
    "# Guide\n",
  );
  assert.equal(
    fs.readFileSync(path.join(copiedRoot, "scripts", "run.py"), "utf8"),
    "print('source')\n",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(copiedRoot, "assets", "fixture.bin")),
    Buffer.from([0, 1, 2, 255]),
  );
  assert.equal(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"), originalSource);
});

test("copy by skill id rejects unsafe, ambiguous, missing, and colliding sources", async (t) => {
  const { root, service } = fixture(t);
  writeSkill(root, "shared-source", "# User source\n");
  fs.mkdirSync(path.join(root, "skills", "shared-source"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "shared-source", "SKILL.md"),
    "# System source\n",
  );
  fs.mkdirSync(path.join(root, "skills", "safe-source"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "safe-source", "SKILL.md"), "# Safe\n");
  fs.mkdirSync(path.join(root, "skills-user", "taken-name"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills-user", "taken-name", "SKILL.md"), "# Taken\n");

  await assert.rejects(
    () =>
      service.copySkillById({
        sourceSkillId: "../outside",
        newSkillName: "copy-one",
      }),
    (error) => error?.code === "invalid_skill_name",
  );
  await assert.rejects(
    () =>
      service.copySkillById({
        sourceSkillId: "missing",
        newSkillName: "copy-two",
      }),
    (error) => error?.code === "skill_not_found",
  );
  await assert.rejects(
    () =>
      service.copySkillById({
        sourceSkillId: "shared-source",
        newSkillName: "copy-three",
      }),
    (error) => error?.code === "ambiguous_skill_source",
  );
  await assert.rejects(
    () =>
      service.copySkillById({
        sourceSkillId: "safe-source",
        newSkillName: "taken-name",
      }),
    (error) => error?.code === "skill_already_exists",
  );

  const outside = path.join(root, "outside-marketplace");
  fs.mkdirSync(path.join(outside, "unsafe-source"), { recursive: true });
  fs.writeFileSync(
    path.join(outside, "unsafe-source", "SKILL.md"),
    "# Unsafe source\n",
  );
  fs.mkdirSync(path.join(root, "skills-marketplace"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "skills-marketplace", "unsafe-provider"));
  await assert.rejects(
    () =>
      service.copySkillById({
        sourceSkillId: "unsafe-provider/unsafe-source",
        newSkillName: "copy-four",
      }),
    (error) => error?.code === "unsafe_skill_path",
  );
  assert.equal(fs.existsSync(path.join(root, "skills-user", "copy-four")), false);
});

test("current-data migration makes all eleven User skills strict-catalog valid and is idempotent", async (t) => {
  const { root, service } = fixture(t);
  const validSkills = [
    ["architecture-diagrams", "Employer Job Search (EJS)"],
    ["calibration-host", ""],
    ["llm-proxy-analytics", ""],
    ["loupe-update-generator", "Dionny Santiago"],
    ["manager-review-writer", ""],
    ["peer-feedback-writer", ""],
    ["talent-review-host", "Dionny Santiago"],
  ];
  const plainSkills = [
    "incident-update-assistant",
    "pr-review-coach",
    "release-notes-writer",
    "weekly-team-update-generator",
  ];

  for (const [skillName, author] of validSkills) {
    writeSkill(
      root,
      skillName,
      `---
name: ${skillName}
description: Description for ${skillName}
${author ? `author: ${author}\n` : ""}---
# ${skillName}
`,
    );
  }
  for (const skillName of plainSkills) {
    writeSkill(
      root,
      skillName,
      `# ${skillName}\n\nDescription for ${skillName}.\n`,
    );
  }

  const first = await service.reconcileUserSkills();
  assert.equal(first.checked, 11);
  assert.deepEqual(first.repaired_ids.sort(), [...validSkills.map(([id]) => id), ...plainSkills].sort());
  assert.deepEqual(first.canonicalized_ids.sort(), plainSkills.sort());
  assert.deepEqual(first.creator_backfilled_ids.sort(), first.repaired_ids.sort());
  assert.deepEqual(first.failures, []);

  const contentsAfterFirst = new Map();
  for (const skillName of first.repaired_ids) {
    const content = fs.readFileSync(skillPath(root, skillName), "utf8");
    contentsAfterFirst.set(skillName, content);
    const parsed = splitSkillMarkdown(content);
    assert.equal(parsed.metadata.name, skillName);
    assert.ok(parsed.metadata.description);
    assert.equal(parsed.metadata.created_by_email, CURRENT_IDENTITY.email);
  }
  assert.equal(
    splitSkillMarkdown(contentsAfterFirst.get("architecture-diagrams")).metadata.author,
    "Employer Job Search (EJS)",
  );
  assert.equal(
    splitSkillMarkdown(contentsAfterFirst.get("loupe-update-generator")).metadata.author,
    "Dionny Santiago",
  );

  const second = await service.reconcileUserSkills();
  assert.deepEqual(second.repaired_ids, []);
  assert.equal(second.skipped_ids.length, 11);
  for (const [skillName, content] of contentsAfterFirst) {
    assert.equal(fs.readFileSync(skillPath(root, skillName), "utf8"), content);
  }
});

test("malformed entries are byte-preserved, isolated, and repaired on a later retry", async (t) => {
  const { root, service } = fixture(t);
  const malformed = `---
name: malformed
description: [unterminated
---
# Body
`;
  writeSkill(root, "malformed", malformed);
  writeSkill(root, "healthy", "# Healthy\n\nHealthy description.\n");

  const first = await service.reconcileUserSkills();
  assert.deepEqual(first.repaired_ids, ["healthy"]);
  assert.equal(first.failures.length, 1);
  assert.equal(first.failures[0].id, "malformed");
  assert.equal(first.failures[0].code, "malformed_skill_frontmatter");
  assert.equal(fs.readFileSync(skillPath(root, "malformed"), "utf8"), malformed);

  fs.writeFileSync(skillPath(root, "malformed"), "# Repaired\n\nRetry description.\n");
  const second = await service.reconcileUserSkills();
  assert.deepEqual(second.repaired_ids, ["malformed"]);
  assert.deepEqual(second.failures, []);
  assert.equal(
    splitSkillMarkdown(fs.readFileSync(skillPath(root, "malformed"), "utf8"))
      .metadata.created_by_email,
    CURRENT_IDENTITY.email,
  );
});

test("unsafe symlink entries are reported without touching their targets", async (t) => {
  const { root, service } = fixture(t);
  const outside = path.join(root, "outside-skill");
  fs.mkdirSync(outside, { recursive: true });
  const outsideSkill = path.join(outside, "SKILL.md");
  const original = "# Outside\n\nMust remain unchanged.\n";
  fs.writeFileSync(outsideSkill, original);
  fs.mkdirSync(path.join(root, "skills-user"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "skills-user", "unsafe-link"));

  const result = await service.reconcileUserSkills();
  assert.deepEqual(result.repaired_ids, []);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(
    { id: result.failures[0].id, code: result.failures[0].code },
    { id: "unsafe-link", code: "unsafe_skill_path" },
  );
  assert.equal(fs.readFileSync(outsideSkill, "utf8"), original);
});

test("root documentation files are not treated as User skills", async (t) => {
  const { root, service } = fixture(t);
  const userRoot = path.join(root, "skills-user");
  fs.mkdirSync(userRoot, { recursive: true });
  fs.writeFileSync(path.join(userRoot, "README.md"), "# User skills\n");
  fs.writeFileSync(path.join(userRoot, "ANALYSIS.md"), "# Notes\n");
  writeSkill(root, "real-skill", "# Real skill\n\nA real skill.\n");

  const result = await service.reconcileUserSkills();
  assert.equal(result.checked, 1);
  assert.deepEqual(result.repaired_ids, ["real-skill"]);
  assert.deepEqual(result.failures, []);
  assert.equal(fs.readFileSync(path.join(userRoot, "README.md"), "utf8"), "# User skills\n");
  assert.equal(fs.readFileSync(path.join(userRoot, "ANALYSIS.md"), "utf8"), "# Notes\n");
});

test("atomic write failures preserve the original and clean temporary files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-skill-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "SKILL.md");
  fs.writeFileSync(target, "original");
  const failingFs = new Proxy(fsPromises, {
    get(targetFs, property) {
      if (property === "rename") {
        return async () => {
          throw new Error("simulated rename failure");
        };
      }
      return targetFs[property];
    },
  });
  const service = createUserSkillService({
    projectRoot: root,
    fsPromises: failingFs,
    randomUUID: () => "atomic-test",
    resolveIdentity: async () => CURRENT_IDENTITY,
  });

  await assert.rejects(
    () => service.writeTextAtomic(target, "replacement"),
    /simulated rename failure/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(
    fs.existsSync(path.join(root, ".SKILL.md." + process.pid + ".atomic-test.tmp")),
    false,
  );
});

test("failed copy canonicalization rolls back the incomplete destination", async (t) => {
  const { root, service } = fixture(t);
  const source = path.join(root, "skills", "malformed-source");
  await fsPromises.mkdir(source, { recursive: true });
  await fsPromises.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: malformed-source\ninvalid: [\n---\n",
  );

  await assert.rejects(
    () => service.copySkillToUser({ sourcePath: source, skillName: "failed-copy" }),
    (error) => error?.code === "malformed_skill_frontmatter",
  );
  assert.equal(fs.existsSync(path.join(root, "skills-user", "failed-copy")), false);
  const leftovers = fs
    .readdirSync(path.join(root, "skills-user"))
    .filter((entry) => entry.includes("failed-copy"));
  assert.deepEqual(leftovers, []);
});

test("updating a skill flags unpublished changes via the injected marker; creating does not", async (t) => {
  const marked = [];
  const { root, service } = fixture(t, {
    markSkillLinkDirty: async (skillName) => {
      marked.push(skillName);
    },
  });

  await service.createSkill({
    skillName: "flagged-skill",
    skillContent: "# Flagged Skill\n\nBody.\n",
  });
  assert.deepEqual(marked, [], "creation must not flag unpublished changes");

  await service.updateSkill({
    skillName: "flagged-skill",
    skillContent: `---
name: flagged-skill
description: Updated description
---
# Updated
`,
  });
  assert.deepEqual(marked, ["flagged-skill"]);

  // A failing marker must not fail the save itself.
  const failing = fixture(t, {
    markSkillLinkDirty: async () => {
      throw new Error("registry offline");
    },
  });
  writeSkill(
    failing.root,
    "resilient-skill",
    `---
name: resilient-skill
description: Original
created_by_email: dsantiago@example.invalid
---
# Body
`,
  );
  const result = await failing.service.updateSkill({
    skillName: "resilient-skill",
    skillContent: `---
name: resilient-skill
description: Updated anyway
---
# Body 2
`,
  });
  assert.equal(result.success, true);
});

test("skill envelopes carry a human display_name, authored titles win, kebab restatements derive", async (t) => {
  const { service } = fixture(t);

  const created = await service.createSkill({
    skillName: "epic-voice-booster",
    skillContent: "# Epic voice booster\n\nElevate text dramatically.\n",
  });
  assert.equal(created.display_name, "Epic Voice Booster");

  const authored = await service.createSkill({
    skillName: "mcp-log-reader",
    skillContent: `---
name: mcp-log-reader
description: Reads MCP logs.
display_name: Log Reader Pro
---
Body
`,
  });
  assert.equal(authored.display_name, "Log Reader Pro");

  // display_name that merely restates the kebab id falls back to derivation
  // (installed-copy sidecars carry the kebab solution name there).
  const restated = await service.createSkill({
    skillName: "plain-title",
    skillContent: `---
name: plain-title
description: Plain.
display_name: plain-title
---
Body
`,
  });
  assert.equal(restated.display_name, "Plain Title");

  // The authored title survives an update whose frontmatter omits it.
  const updated = await service.updateSkill({
    skillName: "mcp-log-reader",
    skillContent: `---
name: mcp-log-reader
description: Reads MCP logs better.
---
Body v2
`,
  });
  assert.equal(updated.display_name, "Log Reader Pro");

  const copied = await service.copySkillById({
    sourceSkillId: "mcp-log-reader",
    newSkillName: "mcp-log-reader-copy",
  });
  assert.equal(copied.display_name, "Log Reader Pro");
});

test("renameSkill moves the directory and rewrites the declared name (unpublished skills only)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-skill-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createUserSkillService({
    projectRoot: root,
    resolveIdentity: async () => CURRENT_IDENTITY,
    getSkillLink: async () => null, // unpublished
    clearSkillLink: async () => true,
  });
  await service.createSkill({
    skillName: "foo",
    skillContent: "---\nname: foo\ndescription: Local foo skill\n---\n\n# Mine\n",
  });
  fs.mkdirSync(path.join(root, "skills-user", "foo", "references"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills-user", "foo", "references", "notes.md"), "# notes\n");

  const result = await service.renameSkill({ skillName: "foo", newSkillName: "foo-local" });

  assert.equal(result.success, true);
  assert.equal(result.skill_name, "foo-local");
  assert.equal(result.previous_skill_name, "foo");

  assert.equal(fs.existsSync(path.join(root, "skills-user", "foo")), false);
  const renamed = splitSkillMarkdown(
    fs.readFileSync(skillPath(root, "foo-local"), "utf8"),
  );
  assert.equal(renamed.metadata.name, "foo-local");
  assert.equal(renamed.metadata.description, "Local foo skill");
  assert.equal(renamed.metadata.created_by_email, CURRENT_IDENTITY.email);
  // Body preserved verbatim (including the frontmatter separator blank line).
  assert.equal(renamed.body.trim(), "# Mine");
  // Bundle files travel with the directory.
  assert.equal(
    fs.readFileSync(path.join(root, "skills-user", "foo-local", "references", "notes.md"), "utf8"),
    "# notes\n",
  );
});
test("renameSkill fails closed on collisions, missing sources, same-name, and agent usage", async (t) => {
  const { root, service } = fixture(t, {
    moveSkillLink: async () => null,
  });
  await service.createSkill({
    skillName: "alpha",
    skillContent: "---\nname: alpha\ndescription: a\n---\n\n# a\n",
  });
  await service.createSkill({
    skillName: "beta",
    skillContent: "---\nname: beta\ndescription: b\n---\n\n# b\n",
  });
  // System-source collision counts too.
  fs.mkdirSync(path.join(root, "skills", "web-search"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "web-search", "SKILL.md"),
    "---\nname: web-search\ndescription: s\n---\n\n# s\n",
  );

  await assert.rejects(
    () => service.renameSkill({ skillName: "alpha", newSkillName: "beta" }),
    (error) => error.code === "skill_already_exists",
  );
  await assert.rejects(
    () => service.renameSkill({ skillName: "alpha", newSkillName: "web-search" }),
    (error) => error.code === "skill_already_exists",
  );
  await assert.rejects(
    () => service.renameSkill({ skillName: "missing", newSkillName: "whatever" }),
    (error) => error.code === "skill_not_found",
  );
  await assert.rejects(
    () => service.renameSkill({ skillName: "alpha", newSkillName: "alpha" }),
    (error) => error.code === "same_skill_name",
  );

  const guardError = Object.assign(new Error("attached to agent"), {
    code: "skill_in_use_by_agents",
  });
  await assert.rejects(
    () =>
      service.renameSkill({
        skillName: "alpha",
        newSkillName: "alpha-two",
        assertRenamable: async () => {
          throw guardError;
        },
      }),
    (error) => error.code === "skill_in_use_by_agents",
  );
  // Guard rejection left the skill untouched under its old name.
  const untouched = splitSkillMarkdown(fs.readFileSync(skillPath(root, "alpha"), "utf8"));
  assert.equal(untouched.metadata.name, "alpha");
  assert.equal(fs.existsSync(path.join(root, "skills-user", "alpha-two")), false);
});

test("rename/create collision gates cover plugin-grouped marketplace installs (review F3)", async (t) => {
  const { root, service } = fixture(t, { moveSkillLink: async () => null });
  await service.createSkill({
    skillName: "mine",
    skillContent: "---\nname: mine\ndescription: m\n---\n\n# m\n",
  });
  // Plugin-grouped layout: skills-marketplace/<mp>/<plugin>/<skill>/SKILL.md
  const pluginSkill = path.join(
    root, "skills-marketplace", "anthropic-agent-skills", "document-skills", "pdf",
  );
  fs.mkdirSync(pluginSkill, { recursive: true });
  fs.writeFileSync(path.join(pluginSkill, "SKILL.md"), "---\nname: pdf\ndescription: p\n---\n\n# p\n");

  await assert.rejects(
    () => service.renameSkill({ skillName: "mine", newSkillName: "pdf" }),
    (error) => error.code === "skill_already_exists",
  );
  await assert.rejects(
    () =>
      service.copySkillById({ sourceSkillId: "mine", newSkillName: "pdf" }),
    (error) => error.code === "skill_already_exists",
  );
  // A skill-with-nested-dirs must NOT false-positive: reference subdirs under
  // a skill that has its own SKILL.md are not skills (parent-guard).
  const skillWithRefs = path.join(root, "skills-marketplace", "mp2", "notes-skill");
  fs.mkdirSync(path.join(skillWithRefs, "guides"), { recursive: true });
  fs.writeFileSync(path.join(skillWithRefs, "SKILL.md"), "---\nname: notes-skill\ndescription: n\n---\n\n# n\n");
  fs.mkdirSync(path.join(skillWithRefs, "guides", "starter"), { recursive: true });
  fs.writeFileSync(path.join(skillWithRefs, "guides", "starter", "SKILL.md"), "nested reference\n");
  const renamed = await service.renameSkill({ skillName: "mine", newSkillName: "starter" });
  assert.equal(renamed.success, true, "reference material under a skill is not a collision");
});

test("rename is blocked for published skills and fails closed on stale destination links (review F2 + publish policy)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-skill-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Registry stub: 'victim' is PUBLISHED, 'occupied' carries a stale link.
  const links = {
    victim: { solutionId: "sol-published" },
    occupied: { solutionId: "sol-stale" },
  };
  const service = createUserSkillService({
    projectRoot: root,
    resolveIdentity: async () => CURRENT_IDENTITY,
    getSkillLink: async (name) => links[name] || null,
    clearSkillLink: async () => true,
  });
  await service.createSkill({
    skillName: "victim",
    skillContent: "---\nname: victim\ndescription: v\n---\n\n# v\n",
  });
  await service.createSkill({
    skillName: "free-agent",
    skillContent: "---\nname: free-agent\ndescription: f\n---\n\n# f\n",
  });

  // POLICY: published skills cannot be renamed — unpublish first.
  await assert.rejects(
    () => service.renameSkill({ skillName: "victim", newSkillName: "victim-two" }),
    (error) =>
      error.code === "published_skill_rename_blocked" &&
      /sol-published/.test(error.message) &&
      /unpublish_skill/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(root, "skills-user", "victim")), true);
  assert.equal(fs.existsSync(path.join(root, "skills-user", "victim-two")), false);

  // Stale link squatting on the DESTINATION name -> pre-mutation failure.
  await assert.rejects(
    () => service.renameSkill({ skillName: "free-agent", newSkillName: "occupied" }),
    (error) => error.code === "skill_link_conflict" && /sol-stale/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(root, "skills-user", "free-agent")), true);

  // Case-only renames report same_skill_name, not a bogus collision.
  await assert.rejects(
    () => service.renameSkill({ skillName: "free-agent", newSkillName: "Free-Agent" }),
    (error) => error.code === "same_skill_name",
  );

  // After the link is gone (unpublished), the rename proceeds.
  delete links.victim;
  const renamed = await service.renameSkill({ skillName: "victim", newSkillName: "victim-two" });
  assert.equal(renamed.skill_name, "victim-two");
});
test("createSkill clears a stale marketplace link left by an out-of-band delete (review F2b)", async (t) => {
  const cleared = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-skill-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createUserSkillService({
    projectRoot: root,
    resolveIdentity: async () => CURRENT_IDENTITY,
    clearSkillLink: async (name) => {
      cleared.push(name);
      return true;
    },
  });
  await service.createSkill({
    skillName: "reborn",
    skillContent: "---\nname: reborn\ndescription: r\n---\n\n# r\n",
  });
  assert.deepEqual(cleared, ["reborn"], "new skills never inherit a published badge");
});
