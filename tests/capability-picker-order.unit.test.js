// Selected-first row order for the OWUI CapabilityPicker popover (ported from
// the Electron-side agents.js picker — see agents-picker-open-order.unit.test.js
// for the shell twin). The freeze-per-open behavior itself is svelte wiring in
// CapabilityPicker.svelte (selectionAtOpen is captured in setOpen); this suite
// pins the ordering rule those callers rely on.

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
        "src/patches/frontend/src/lib/utils/capabilityPickerOrder.js",
      ),
    ).href
  );
});

const catalog = () => [
  { id: "a11y", display_name: "A11y" },
  { id: "account-research", display_name: "Account Research" },
  { id: "agent-builder", display_name: "Agent Builder" },
  { id: "company-knowledge", display_name: "Company Knowledge" },
  { id: "slack", display_name: "Slack" },
];

test("selected rows float to the top, keeping catalog order within each group", () => {
  const ordered = mod.orderCapabilityOptionsForOpen(catalog(), ["slack", "company-knowledge"]);
  assert.deepEqual(
    ordered.map((option) => option.id),
    ["company-knowledge", "slack", "a11y", "account-research", "agent-builder"],
    "selected keep their relative catalog order (not the selection order), rest follow in catalog order",
  );
});

test("no selections or no matching selections leave the list untouched (same identity)", () => {
  const options = catalog();
  assert.equal(mod.orderCapabilityOptionsForOpen(options, []), options);
  assert.equal(mod.orderCapabilityOptionsForOpen(options, [null, "", undefined]), options);
  assert.equal(
    mod.orderCapabilityOptionsForOpen(options, ["ghost-1", "ghost-2"]),
    options,
    "selected ids that match no row are a no-op",
  );
});

test("unknown selected ids are ignored while known ones still float", () => {
  const ordered = mod.orderCapabilityOptionsForOpen(catalog(), ["ghost", "slack"]);
  assert.deepEqual(
    ordered.map((option) => option.id),
    ["slack", "a11y", "account-research", "agent-builder", "company-knowledge"],
  );
});

test("the partition is stable for a fixed selection", () => {
  const options = catalog();
  const first = mod.orderCapabilityOptionsForOpen(options, ["agent-builder"]);
  const second = mod.orderCapabilityOptionsForOpen(options, ["agent-builder"]);
  assert.deepEqual(
    first.map((option) => option.id),
    second.map((option) => option.id),
  );
  assert.deepEqual(
    first.map((option) => option.id),
    ["agent-builder", "a11y", "account-research", "company-knowledge", "slack"],
  );
});

test("degrades safely on malformed input", () => {
  assert.deepEqual(mod.orderCapabilityOptionsForOpen(null, ["x"]), []);
  assert.deepEqual(mod.orderCapabilityOptionsForOpen(undefined, null), []);
  const holey = [{ id: "a" }, null, { id: "b" }];
  assert.deepEqual(
    mod.orderCapabilityOptionsForOpen(holey, ["b"]).map((option) => option?.id ?? null),
    ["b", "a", null],
    "rows without a matching id (incl. null rows) keep their relative order in the rest group",
  );
});
