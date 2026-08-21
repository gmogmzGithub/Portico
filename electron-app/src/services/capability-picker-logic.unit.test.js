const test = require("node:test");
const assert = require("node:assert/strict");

const { skillInitials } = require("./skill-initials");
const {
  deriveMcpSource,
  visibleCapabilityIds,
} = require("./capability-picker-logic");

// --- skillInitials (mirrors the OWUI utils/skillInitials.ts implementation) ---

test("skillInitials uses first + last word initials for multi-word names", () => {
  assert.equal(skillInitials("MCP Bridge Setup"), "MS");
  assert.equal(skillInitials("Algorithmic Art"), "AA");
});

test("skillInitials uses the first two letters for single-word names", () => {
  assert.equal(skillInitials("Artifacts"), "AR");
});

test("skillInitials strips a marketplace path prefix before deriving", () => {
  assert.equal(skillInitials("Anthropic Agent Skills/Algorithmic Art"), "AA");
});

test("skillInitials treats hyphen/underscore as word separators", () => {
  assert.equal(skillInitials("mcp-bridge-setup"), "MS");
  assert.equal(skillInitials("web_search"), "WS");
});

test("skillInitials falls back to 'S' for an empty name", () => {
  assert.equal(skillInitials(""), "S");
  assert.equal(skillInitials(null), "S");
});

// --- deriveMcpSource: host wins, then core, then user ---

test("deriveMcpSource returns host when deployment_type is host", () => {
  assert.equal(
    deriveMcpSource({ deployment_type: "host", is_core: true, user_installed: true }),
    "host",
  );
});

test("deriveMcpSource returns core for a built-in docker server", () => {
  assert.equal(
    deriveMcpSource({ deployment_type: "docker", is_core: true }),
    "core",
  );
});

test("deriveMcpSource returns user for a user-installed server", () => {
  assert.equal(
    deriveMcpSource({ deployment_type: "docker", user_installed: true }),
    "user",
  );
});

test("deriveMcpSource returns '' when no category applies", () => {
  assert.equal(deriveMcpSource({ deployment_type: "docker" }), "");
  assert.equal(deriveMcpSource(null), "");
});

// --- visibleCapabilityIds: the "Select all" target set ---

const OPTIONS = [
  { id: "server:host-fs", display_name: "Host Files", source: "host" },
  { id: "server:core-web", display_name: "Web Search", source: "core" },
  { id: "server:user-notes", display_name: "My Notes", source: "user" },
];

test("visibleCapabilityIds returns every id when no filter or query", () => {
  assert.deepEqual(visibleCapabilityIds(OPTIONS), [
    "server:host-fs",
    "server:core-web",
    "server:user-notes",
  ]);
});

test("visibleCapabilityIds respects the active source filter", () => {
  assert.deepEqual(visibleCapabilityIds(OPTIONS, { activeFilter: "host" }), [
    "server:host-fs",
  ]);
  assert.deepEqual(visibleCapabilityIds(OPTIONS, { activeFilter: "user" }), [
    "server:user-notes",
  ]);
});

test("visibleCapabilityIds matches the search query across fields", () => {
  assert.deepEqual(visibleCapabilityIds(OPTIONS, { query: "notes" }), [
    "server:user-notes",
  ]);
  // matches on id substring too
  assert.deepEqual(visibleCapabilityIds(OPTIONS, { query: "core-web" }), [
    "server:core-web",
  ]);
});

test("visibleCapabilityIds intersects filter AND query", () => {
  // query matches host + core by name fragment, filter narrows to core
  assert.deepEqual(
    visibleCapabilityIds(OPTIONS, { activeFilter: "core", query: "e" }),
    ["server:core-web"],
  );
});

test("visibleCapabilityIds derives source for RAW mcp options (no source field)", () => {
  // The OWUI picker feeds raw MCP options with deployment_type/is_core/
  // user_installed and NO `source` — filtering must still work via derivation.
  const rawMcp = [
    { id: "server:host-fs", deployment_type: "host" },
    { id: "server:core-web", is_core: true, deployment_type: "docker" },
    { id: "server:user-notes", user_installed: true, deployment_type: "docker" },
  ];
  assert.deepEqual(visibleCapabilityIds(rawMcp, { activeFilter: "core" }), [
    "server:core-web",
  ]);
  assert.deepEqual(visibleCapabilityIds(rawMcp, { activeFilter: "host" }), [
    "server:host-fs",
  ]);
  // "Select all" with no filter/query returns every raw option.
  assert.equal(visibleCapabilityIds(rawMcp).length, 3);
});

test("skill filter key 'system' matches skill source 'system'", () => {
  const skills = [
    { id: "web", display_name: "Web", source: "system" },
    { id: "mine", display_name: "Mine", source: "user" },
  ];
  assert.deepEqual(visibleCapabilityIds(skills, { activeFilter: "system" }), [
    "web",
  ]);
});
