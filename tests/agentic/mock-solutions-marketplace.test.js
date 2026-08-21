// Shape contract for the mock Solutions Marketplace (shared by the agentic
// harness AND the GUI mock mode): the envelope/bundle split documented in
// docs/agent_reference/api-attribution-and-bundles-spec.md. GET /:id answers
// metadata + has_bundle ONLY — a mock that inlined the bundle hid app-side
// context leaks from every harness run — and GET /:id/bundle is the single
// bundle source. Ephemeral port on purpose: never reaches for the live
// harness (18800) or GUI-mock (18808) processes.
//
// Run: node --test tests/agentic/mock-solutions-marketplace.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startMockSolutionsMarketplace } = require("./mock-solutions-marketplace");

async function startMock(t) {
  const mock = await startMockSolutionsMarketplace({ port: 0 });
  t.after(() => mock.close());
  return mock;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

const SKILL_BUNDLE = {
  type: "skills",
  payload: { name: "demo-skill", skill_md: "# Demo\n\nFull body." },
};

function createSkillInput(overrides = {}) {
  return {
    name: "demo-skill",
    description: "Seeded demo skill",
    author: "someone.else",
    submitted_by: "someone.else@example.invalid",
    type: "skills",
    bundle: SKILL_BUNDLE,
    ...overrides,
  };
}

test("solution envelope reads carry has_bundle but never the inline bundle", async (t) => {
  const mock = await startMock(t);

  const created = await postJson(`${mock.baseUrl}/api/solutions`, createSkillInput());
  assert.equal(created.status, 200);
  assert.equal(created.body.has_bundle, true);
  assert.ok(!("bundle" in created.body), "create response omits the bundle");

  const envelope = await getJson(`${mock.baseUrl}/api/solutions/${created.body.id}`);
  assert.equal(envelope.status, 200);
  assert.ok(!("bundle" in envelope.body), "GET-by-id envelope omits the bundle");
  assert.equal(envelope.body.has_bundle, true);
  // Metadata still reads back whole.
  assert.equal(envelope.body.id, created.body.id);
  assert.equal(envelope.body.name, "demo-skill");
  assert.equal(envelope.body.description, "Seeded demo skill");
  assert.equal(envelope.body.author, "someone.else");
  assert.equal(envelope.body.submitted_by, "someone.else@example.invalid");
  assert.equal(envelope.body.type, "skills");
  assert.equal(envelope.body.status, "active");

  // The bundle route is the one and only bundle source.
  const bundle = await getJson(
    `${mock.baseUrl}/api/solutions/${created.body.id}/bundle`,
  );
  assert.equal(bundle.status, 200);
  assert.deepEqual(bundle.body, SKILL_BUNDLE);
});

test("bundle-less listings answer has_bundle false and 404 on the bundle route", async (t) => {
  const mock = await startMock(t);

  const created = await postJson(
    `${mock.baseUrl}/api/solutions`,
    createSkillInput({ bundle: undefined, detail_url: "https://example.test/detail" }),
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.has_bundle, false);

  const envelope = await getJson(`${mock.baseUrl}/api/solutions/${created.body.id}`);
  assert.equal(envelope.body.has_bundle, false);
  assert.ok(!("bundle" in envelope.body));

  const bundle = await getJson(
    `${mock.baseUrl}/api/solutions/${created.body.id}/bundle`,
  );
  assert.equal(bundle.status, 404);
  assert.equal(bundle.body.code, "no_bundle");
});

test("tombstones stay readable with no bundle anywhere", async (t) => {
  const mock = await startMock(t);

  const created = await postJson(`${mock.baseUrl}/api/solutions`, createSkillInput());
  const deleted = await fetch(
    `${mock.baseUrl}/api/solutions/${created.body.id}`,
    { method: "DELETE", headers: { "x-remote-user": "someone.else@example.invalid" } },
  );
  assert.equal(deleted.status, 200);

  const envelope = await getJson(`${mock.baseUrl}/api/solutions/${created.body.id}`);
  assert.equal(envelope.status, 200, "tombstone envelopes stay readable");
  assert.equal(envelope.body.status, "deleted");
  assert.equal(envelope.body.has_bundle, false);
  assert.ok(!("bundle" in envelope.body));

  const bundle = await getJson(
    `${mock.baseUrl}/api/solutions/${created.body.id}/bundle`,
  );
  assert.equal(bundle.status, 404);
});

test("the contract beacon advertises the current public-API shape", async (t) => {
  const mock = await startMock(t);
  // install_v2.sh's reuse probe restarts any detached mock that does not
  // answer contract 2 (spec-parity envelopes).
  const contract = await getJson(`${mock.baseUrl}/__test/contract`);
  assert.equal(contract.status, 200);
  assert.deepEqual(contract.body, { contract: 2 });
});

test("search answers both dual-shape keys with bundle-free entries", async (t) => {
  const mock = await startMock(t);

  await postJson(`${mock.baseUrl}/api/solutions`, createSkillInput());
  const search = await postJson(`${mock.baseUrl}/api/solutions/search`, {
    query: "demo",
    filters: { type: ["skills"] },
  });
  assert.equal(search.status, 200);
  // Real-backend `results` + legacy `solutions` alias, same entries.
  assert.equal(search.body.results.length, 1);
  assert.deepEqual(search.body.results, search.body.solutions);
  assert.ok("facets" in search.body);
  const [entry] = search.body.results;
  assert.equal(entry.has_bundle, true);
  assert.ok(!("bundle" in entry), "search entries never inline the bundle");
});

test("allowed_emails gates reads per viewer exactly like the real backend", async (t) => {
  const mock = await startMock(t);
  const base = mock.baseUrl;
  const asViewer = (viewer) => ({
    headers: { "content-type": "application/json", "x-remote-user": viewer },
  });

  // Seed a restricted skill owned by zstevens, shared with cboyd only.
  const seedRes = await fetch(`${base}/__test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "gtm-brief-qa",
      description: "restricted",
      author: "zstevens",
      submitted_by: "zstevens",
      type: "skills",
      detail_url: "/x",
      allowed_emails: ["cboyd@example.invalid"],
    }),
  });
  const seeded = await seedRes.json();

  // Owner and listed viewer read it; everyone else gets the backend-shaped 404.
  for (const viewer of ["zstevens@example.invalid", "cboyd@example.invalid"]) {
    const res = await fetch(`${base}/api/solutions/${seeded.id}`, asViewer(viewer));
    assert.equal(res.status, 200, `${viewer} can read`);
  }
  const denied = await fetch(
    `${base}/api/solutions/${seeded.id}`,
    asViewer("dsantiago@example.invalid"),
  );
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), {
    error: "Solution not found",
    code: "not_found",
  });

  // Search hides it from denied viewers too.
  const searchFor = async (viewer) => {
    const res = await fetch(`${base}/api/solutions/search`, {
      method: "POST",
      ...asViewer(viewer),
      body: JSON.stringify({ query: "gtm" }),
    });
    return (await res.json()).results.length;
  };
  assert.equal(await searchFor("cboyd@example.invalid"), 1);
  assert.equal(await searchFor("dsantiago@example.invalid"), 0);

  // A PUT that omits allowed_emails preserves the list (backend semantics);
  // a PUT that carries it replaces it — widening unblocks the viewer.
  await fetch(`${base}/api/solutions/${seeded.id}`, {
    method: "PUT",
    ...asViewer("zstevens@example.invalid"),
    body: JSON.stringify({ description: "content update only" }),
  });
  assert.equal(
    (await fetch(`${base}/api/solutions/${seeded.id}`, asViewer("dsantiago@example.invalid"))).status,
    404,
    "content-only republish leaves the viewer blocked (the incident shape)",
  );
  await fetch(`${base}/api/solutions/${seeded.id}`, {
    method: "PUT",
    ...asViewer("zstevens@example.invalid"),
    body: JSON.stringify({
      allowed_emails: ["cboyd@example.invalid", "dsantiago@example.invalid"],
    }),
  });
  assert.equal(
    (await fetch(`${base}/api/solutions/${seeded.id}`, asViewer("dsantiago@example.invalid"))).status,
    200,
    "the visibility-only PUT unblocks the viewer",
  );

  // Empty list = public.
  await fetch(`${base}/api/solutions/${seeded.id}`, {
    method: "PUT",
    ...asViewer("zstevens@example.invalid"),
    body: JSON.stringify({ allowed_emails: [] }),
  });
  assert.equal(
    (await fetch(`${base}/api/solutions/${seeded.id}`, asViewer("someone-else@example.invalid"))).status,
    200,
  );
});
