const test = require("node:test");
const assert = require("node:assert/strict");

const { generateReferenceId } = require("./diagnostic-id");

test("generateReferenceId matches the PORTICO-YYYYMMDD-xxxx format", () => {
  const id = generateReferenceId();
  assert.match(id, /^PORTICO-\d{8}-[0-9a-f]{4}$/);
});

test("generateReferenceId contains today's date", () => {
  const now = new Date();
  const dateStr = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const id = generateReferenceId();
  assert.match(id, new RegExp(`^PORTICO-${dateStr}-`));
});

test("generateReferenceId produces varying suffixes", () => {
  const ids = new Set(Array.from({ length: 20 }, () => generateReferenceId()));
  assert.ok(ids.size > 1);
});

test("generateReferenceId suffix uses lowercase hex", () => {
  const id = generateReferenceId();
  const suffix = id.split("-")[2];
  assert.match(suffix, /^[0-9a-f]{4}$/);
});
