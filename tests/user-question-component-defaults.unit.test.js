// Ask User Question picker prefills (option component_defaults + component
// default_selected), ported from the retired Electron modal onto the inline
// card. Behavioral home of the seven modal-suite scenarios: reveal rule,
// per-option seed precedence, catalog healing per component type, seed-pending
// Send gating, and the failed-catalog seeds-empty escape hatch. The svelte
// card itself only wires these rules (svelte compiles in the Docker frontend
// build), so the logic lives in the util under test here.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mod;
test.before(async () => {
  mod = await import(
    pathToFileURL(
      path.resolve(
        __dirname,
        "..",
        "src/patches/frontend/src/lib/utils/userQuestionComponentDefaults.js",
      ),
    ).href
  );
});

const q = (overrides = {}) => ({
  id: "q1",
  options: [],
  components: [],
  components_gated_by_option_id: null,
  ...overrides,
});

const capabilitiesQuestion = (overrides = {}) =>
  q({
    options: [
      {
        id: "recommended",
        component_defaults: { skills: ["company-knowledge"], servers: [] },
      },
      { id: "scratch" },
    ],
    components: [
      { id: "skills", type: "skill_picker", multiple: true, default_selected: ["web-search"] },
      { id: "servers", type: "mcp_server_picker", multiple: true, default_selected: null },
    ],
    components_gated_by_option_id: "scratch",
    ...overrides,
  });

test("reveal rule: gate or defaults-bearing option reveals, others hide, legacy stays visible", () => {
  const question = capabilitiesQuestion({
    options: [
      { id: "recommended", component_defaults: { skills: ["a"] } },
      { id: "scratch" },
      { id: "let_agent_decide" },
    ],
  });
  assert.equal(mod.isComponentRevealOptionDriven(question), true);
  assert.equal(mod.areComponentsActive(question, ""), false);
  assert.equal(mod.areComponentsActive(question, "recommended"), true, "defaults reveal");
  assert.equal(mod.areComponentsActive(question, "scratch"), true, "the gate reveals");
  assert.equal(mod.areComponentsActive(question, "let_agent_decide"), false, "others hide");

  // Neither gate nor defaults: components are always active (legacy), and all
  // selections live in the single ungated bucket.
  const legacy = q({
    options: [{ id: "yes" }, { id: "no" }],
    components: [{ id: "skills", type: "skill_picker" }],
  });
  assert.equal(mod.isComponentRevealOptionDriven(legacy), false);
  assert.equal(mod.areComponentsActive(legacy, ""), true);
  assert.equal(mod.areComponentsActive(legacy, "no"), true);
  assert.equal(mod.bucketKeyFor(legacy, "no"), mod.UNGATED_BUCKET);

  // Component-only questions (no options) stay active too.
  const componentOnly = q({ components: [{ id: "m", type: "model_picker" }] });
  assert.equal(mod.areComponentsActive(componentOnly, ""), true);
  assert.equal(mod.bucketKeyFor(componentOnly, ""), mod.UNGATED_BUCKET);

  // Option-driven questions bucket by the selected option, none selected -> no bucket.
  assert.equal(mod.bucketKeyFor(question, "recommended"), "recommended");
  assert.equal(mod.bucketKeyFor(question, ""), null);
});

test("seed precedence: option entry (including explicit []) beats default_selected, null means no seed", () => {
  const question = capabilitiesQuestion();
  // The revealing option's entries win; its explicit [] survives as
  // reveal-empty rather than falling back to default_selected.
  assert.deepEqual(mod.seedDefaultsFor(question, "recommended"), {
    skills: ["company-knowledge"],
    servers: [],
  });
  // A revealing option without entries falls back per component:
  // default_selected where declared, null (no seed) otherwise.
  assert.deepEqual(mod.seedDefaultsFor(question, "scratch"), {
    skills: ["web-search"],
    servers: null,
  });
  // The ungated bucket has no revealing option: default_selected or null.
  assert.deepEqual(mod.seedDefaultsFor(question, mod.UNGATED_BUCKET), {
    skills: ["web-search"],
    servers: null,
  });
});

test("skill ids heal: exact match, unique 2-segment expansion, ghosts dropped", () => {
  const catalog = [
    { id: "company-knowledge" },
    { id: "anthropic-agent-skills/document-skills/pdf" },
    { id: "amp/tooling/lint" },
    { id: "amp/quality/lint" },
  ];
  assert.deepEqual(
    mod.resolveSkillIds(
      [
        "company-knowledge",
        "anthropic-agent-skills/pdf", // 2-segment legacy form -> unique heal
        "amp/lint", // ambiguous (two plugin matches) -> dropped
        "ghost-skill",
        " company-knowledge ", // duplicate after trim -> deduped
      ],
      catalog,
    ),
    ["company-knowledge", "anthropic-agent-skills/document-skills/pdf"],
  );
});

test("server ids gain the server: prefix and validate against the catalog", () => {
  const catalog = [{ id: "glean" }, { id: "server:slack" }];
  assert.deepEqual(
    mod.resolveServerIds(["glean", "server:slack", "server:ghost", "ghost"], catalog),
    ["server:glean", "server:slack"],
  );
});

test("model and effort seeds resolve by id-or-name and against allowed efforts", () => {
  const models = [
    { id: "atlas-opus-5", name: "Atlas Opus 5" },
    { id: "gpt-5.5", name: "GPT 5.5" },
  ];
  assert.equal(mod.resolveModelId(["atlas-opus-5"], models), "atlas-opus-5");
  assert.equal(mod.resolveModelId(["Atlas Opus 5"], models), "atlas-opus-5", "display name");
  assert.equal(mod.resolveModelId(["nonexistent"], models), "");
  assert.equal(mod.resolveEffort(["high"], ["low", "high"]), "high");
  assert.equal(mod.resolveEffort(["max"], ["low", "high"]), "", "unsupported effort dropped");
});

test("buildBucketSlots seeds model before effort and falls back to chat defaults", () => {
  const models = [{ id: "atlas-opus-5", name: "Atlas Opus 5" }];
  const capabilityFor = (modelId) =>
    modelId === "atlas-opus-5" ? { reasoningEffortOptions: ["low", "high"] } : null;

  // Effort listed BEFORE the model in the components array: the seeded model
  // must still win the effort validation (models seed first).
  const question = q({
    components: [
      { id: "effort", type: "reasoning_effort_picker", default_selected: ["high"] },
      { id: "model", type: "model_picker", default_selected: ["Atlas Opus 5"] },
      { id: "skills", type: "skill_picker", default_selected: ["web-search"] },
    ],
  });
  const seeded = mod.buildBucketSlots(question, mod.UNGATED_BUCKET, {
    models,
    capabilityFor,
    chatDefaultModelId: "gpt-5.5",
    chatDefaultEffort: "low",
  });
  assert.deepEqual(seeded.slots.model, ["atlas-opus-5"]);
  assert.deepEqual(seeded.slots.effort, ["high"]);
  assert.deepEqual(seeded.slots.skills, [], "catalog seeds land in the async half");
  assert.equal(seeded.seededModelId, "atlas-opus-5");

  // No seeds at all: beta's stock behavior — the chat's model (['']-shaped
  // when absent) and the chat effort validated against that model.
  const stock = mod.buildBucketSlots(
    q({
      components: [
        { id: "model", type: "model_picker" },
        { id: "effort", type: "reasoning_effort_picker" },
      ],
    }),
    mod.UNGATED_BUCKET,
    {
      models,
      capabilityFor,
      chatDefaultModelId: "atlas-opus-5",
      chatDefaultEffort: "high",
    },
  );
  assert.deepEqual(stock.slots.model, ["atlas-opus-5"]);
  assert.deepEqual(stock.slots.effort, ["high"]);

  const empty = mod.buildBucketSlots(
    q({ components: [{ id: "model", type: "model_picker" }] }),
    mod.UNGATED_BUCKET,
    { models, capabilityFor, chatDefaultModelId: "", chatDefaultEffort: "" },
  );
  assert.deepEqual(empty.slots.model, [""], "ModelSelector's empty bind shape is ['']");

  // An unresolvable model seed leaves the mandate unmet (empty slot), and an
  // explicit [] seed reveals the picker empty instead of the chat default.
  const unresolvable = mod.buildBucketSlots(
    q({ components: [{ id: "model", type: "model_picker", default_selected: ["ghost"] }] }),
    mod.UNGATED_BUCKET,
    { models, capabilityFor, chatDefaultModelId: "atlas-opus-5", chatDefaultEffort: "" },
  );
  assert.deepEqual(unresolvable.slots.model, [""]);
  const revealEmpty = mod.buildBucketSlots(
    q({
      options: [{ id: "rec", component_defaults: { model: [] } }],
      components: [{ id: "model", type: "model_picker" }],
    }),
    "rec",
    { models, capabilityFor, chatDefaultModelId: "atlas-opus-5", chatDefaultEffort: "" },
  );
  assert.deepEqual(revealEmpty.slots.model, [""]);
});

test("applyCatalogSeedsToSlots fills only seed-bearing picker slots once the catalog lands", () => {
  const question = capabilitiesQuestion();
  const base = { skills: [], servers: [] };
  const catalog = {
    skills: [{ id: "company-knowledge" }, { id: "web-search" }],
    toolServers: [{ id: "glean" }],
  };

  const recommended = mod.applyCatalogSeedsToSlots(question, "recommended", base, catalog);
  assert.deepEqual(recommended, { skills: ["company-knowledge"], servers: [] });

  // scratch: skills fall back to default_selected; servers have no seed at
  // all, so their slot is left untouched.
  const scratch = mod.applyCatalogSeedsToSlots(
    question,
    "scratch",
    { skills: [], servers: ["server:glean"] },
    catalog,
  );
  assert.deepEqual(scratch, { skills: ["web-search"], servers: ["server:glean"] });

  // A failed catalog load (null) seeds empty so Send cannot deadlock.
  const failed = mod.applyCatalogSeedsToSlots(question, "recommended", base, null);
  assert.deepEqual(failed, { skills: [], servers: [] });

  // multiple:false picker seeds truncate to their first resolved id.
  const single = mod.applyCatalogSeedsToSlots(
    q({
      components: [
        { id: "skills", type: "skill_picker", multiple: false, default_selected: ["company-knowledge", "web-search"] },
      ],
    }),
    mod.UNGATED_BUCKET,
    { skills: [] },
    catalog,
  );
  assert.deepEqual(single, { skills: ["company-knowledge"] });
});

test("seed-pending gates only unlanded catalog seeds on the active bucket", () => {
  const question = capabilitiesQuestion();
  const none = new Set();

  // recommended carries skill seeds -> pending until the marker lands.
  assert.equal(mod.isSeedPending(question, "recommended", none), true);
  const landed = new Set([mod.seededKeyFor("q1", "recommended")]);
  assert.equal(mod.isSeedPending(question, "recommended", landed), false);

  // scratch inherits default_selected skills -> also pending; a non-revealing
  // option (pickers hidden) never blocks.
  assert.equal(mod.isSeedPending(question, "scratch", none), true);
  const hidden = capabilitiesQuestion({
    options: [
      { id: "recommended", component_defaults: { skills: ["a"] } },
      { id: "scratch" },
      { id: "let_agent_decide" },
    ],
  });
  assert.equal(mod.isSeedPending(hidden, "let_agent_decide", none), false);
  assert.equal(mod.isSeedPending(question, "", none), false, "no option, no bucket");

  // Model/effort seeds resolve synchronously and never leave a bucket pending;
  // an explicit [] has nothing to fetch either.
  const modelOnly = q({
    components: [{ id: "m", type: "model_picker", default_selected: ["atlas"] }],
  });
  assert.equal(mod.isSeedPending(modelOnly, "", none), false);
  assert.equal(
    mod.bucketHasCatalogSeeds(
      capabilitiesQuestion({
        options: [{ id: "rec", component_defaults: { skills: [] } }],
        components: [{ id: "skills", type: "skill_picker" }],
        components_gated_by_option_id: null,
      }),
      "rec",
    ),
    false,
    "an explicit [] reveals empty and is never pending",
  );
});
