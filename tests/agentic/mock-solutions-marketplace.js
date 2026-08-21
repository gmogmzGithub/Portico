// Standalone in-memory mock of the Solutions Marketplace REST service
// (docs/agent_reference/api-attribution-and-bundles-spec.md). Point the app at
// it with AI_MARKETPLACE_BASE_URL. State lives in memory only; test hooks
// under /__test/* let scenarios act "behind the scenes" (seed listings from
// other authors, bump/delete listings, inspect state) without going through
// the PORTICO tools.
//
// This mirrors the documented backend contract the client depends on:
//   - GET /api/solutions/:id returns the envelope as metadata + has_bundle
//     ONLY — the bundle is never inlined (spec: "Read the solution
//     envelope"). Bundle content is served exclusively by
//     GET /api/solutions/:id/bundle; ai-marketplace-client.getSolutionBundle
//     falls back to that route when an envelope carries no inline bundle.
//     (Some sandbox deployments inline the bundle; the app-side agent
//     surface must strip it either way, and a mock that inlined it hid
//     exactly that class of context leak from the harness.)
//   - create/PUT responses omit the raw bundle payload (has_bundle only).
//   - DELETE is a soft delete: the envelope survives as a tombstone with
//     status "deleted" and no bundle.
//   - PUT/DELETE enforce an ownership guard: when the stored submitted_by and
//     the viewer identity (x-remote-user) disagree (local-part comparison,
//     matching normalizeMarketplaceOwnerIdentity), the service answers
//     403 { code: "not_owner" }.
//   - Search responses carry BOTH the real backend's `results` key (renderer
//     Discover + freshness sweep are results-strict) and the legacy
//     `solutions` alias (operations layer + agentic scenarios), plus an empty
//     `facets` object for shape parity.

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

// Public-API shape contract advertised via GET /__test/contract — the
// version-skew beacon install_v2.sh's reuse probe checks before adopting an
// already-running detached mock. Bump whenever the public surface changes
// shape (v2: spec-parity envelopes — GET /:id never inlines the bundle;
// v1/absent also predates the search `results` key).
const MOCK_CONTRACT_VERSION = 2;

function normalizeOwnerIdentity(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return "";
  const at = text.indexOf("@");
  return at === -1 ? text : text.slice(0, at);
}

function nowIso() {
  return new Date().toISOString();
}

function startMockSolutionsMarketplace({
  port = 0,
  host = "127.0.0.1",
  apiKey = null, // when set, requests must present it
  enforceOwnership = true,
  log = () => {},
} = {}) {
  const solutions = new Map(); // id -> stored record (bundle kept on it; public envelopes omit it)
  const requestLog = [];
  let ownershipEnforced = enforceOwnership;

  const publicEnvelope = (sol, { includeBundle = false } = {}) => {
    const { bundle, ...rest } = sol;
    const envelope = { ...rest, has_bundle: Boolean(bundle) };
    if (includeBundle && bundle) envelope.bundle = bundle;
    return envelope;
  };

  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(undefined); // malformed
        }
      });
    });

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const applyWrite = (target, body, { isCreate }) => {
    const writable = [
      "name",
      "display_name",
      "description",
      "author",
      "submitted_by",
      "type",
      "detail_url",
      "comment",
      "bundle",
      "resolved_bundle_cache",
      // Backend-faithful visibility: stored verbatim on write, PRESERVED when
      // a PUT omits the field (solutionService.ts:1048-1050 semantics).
      "allowed_emails",
    ];
    for (const field of writable) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        target[field] = body[field];
      }
    }
    if (isCreate) {
      // Field names mirror the LIVE backend schema (created_timestamp /
      // updated_timestamp) — emitting only the legacy *_at names is exactly
      // how the mock masked the dead update-detection bug (2026-08-04).
      target.created_timestamp = nowIso();
      target.status = "active";
      if (!Object.prototype.hasOwnProperty.call(target, "allowed_emails")) {
        target.allowed_emails = [];
      }
    }
    target.updated_timestamp = nowIso();
    if (target.bundle && !target.detail_url) {
      target.detail_url = `/api/solutions/${target.id}/bundle`;
    }
    return target;
  };

  // Backend-faithful viewer gate (SolutionController.ts:103-107 →
  // solutionService.ts:530-539): a non-empty allowed_emails hides the doc —
  // as a 404 indistinguishable from missing — from every viewer whose
  // candidates (literal email, local part, localpart@example.invalid) miss the
  // list. Owners always pass; an empty list is public.
  const hiddenFromViewer = (sol, viewer) => {
    const emails = Array.isArray(sol?.allowed_emails) ? sol.allowed_emails : [];
    if (!emails.length) return false;
    const caller = String(viewer || "").trim().toLowerCase();
    const local = normalizeOwnerIdentity(caller);
    if (local && local === normalizeOwnerIdentity(sol.submitted_by)) return false;
    const candidates = new Set(
      [caller, local, local ? `${local}@example.invalid` : ""].filter(Boolean),
    );
    return !emails.some((entry) =>
      candidates.has(String(entry || "").trim().toLowerCase()),
    );
  };

  const validateCreate = (body) => {
    for (const field of ["name", "description", "author", "type"]) {
      if (typeof body[field] !== "string" || !body[field].trim()) {
        return `${field} is required`;
      }
    }
    if (!body.bundle && !body.detail_url) {
      return "detail_url is required unless bundle is present";
    }
    if (body.bundle && body.bundle.type !== body.type) {
      return "bundle.type must match the top-level type";
    }
    return null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const viewer = req.headers["x-remote-user"] || "";
    requestLog.push({
      method: req.method,
      path: url.pathname,
      viewer,
      at: nowIso(),
    });
    log(`[mock-marketplace] ${req.method} ${url.pathname} viewer=${viewer}`);

    // ------------------------------------------------------------------
    // Test hooks (never part of the real service)
    // ------------------------------------------------------------------
    if (parts[0] === "__test") {
      const body = await readJson(req);
      if (req.method === "POST" && parts[1] === "seed") {
        const id = body.id || crypto.randomUUID();
        const sol = applyWrite({ id }, body || {}, { isCreate: true });
        if (body && body.status) sol.status = body.status;
        solutions.set(id, sol);
        return send(res, 200, publicEnvelope(sol, { includeBundle: true }));
      }
      if (req.method === "POST" && parts[1] === "update" && parts[2]) {
        const sol = solutions.get(parts[2]);
        if (!sol) return send(res, 404, { error: "unknown solution" });
        Object.assign(sol, body || {});
        sol.updated_timestamp =
          body && body.updated_timestamp ? body.updated_timestamp : nowIso();
        return send(res, 200, publicEnvelope(sol, { includeBundle: true }));
      }
      if (req.method === "POST" && parts[1] === "delete" && parts[2]) {
        const sol = solutions.get(parts[2]);
        if (!sol) return send(res, 404, { error: "unknown solution" });
        sol.status = "deleted";
        delete sol.bundle;
        sol.updated_timestamp = nowIso();
        return send(res, 200, { id: sol.id, status: sol.status });
      }
      if (req.method === "POST" && parts[1] === "reset") {
        solutions.clear();
        requestLog.length = 0;
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && parts[1] === "ownership") {
        ownershipEnforced = Boolean(body && body.enforce);
        return send(res, 200, { enforce: ownershipEnforced });
      }
      if (req.method === "GET" && parts[1] === "contract") {
        return send(res, 200, { contract: MOCK_CONTRACT_VERSION });
      }
      if (req.method === "GET" && parts[1] === "state") {
        return send(res, 200, {
          solutions: [...solutions.values()].map((sol) =>
            publicEnvelope(sol, { includeBundle: true }),
          ),
        });
      }
      if (req.method === "GET" && parts[1] === "requests") {
        return send(res, 200, { requests: requestLog });
      }
      return send(res, 404, { error: "unknown test hook" });
    }

    // ------------------------------------------------------------------
    // Real API surface
    // ------------------------------------------------------------------
    if (parts[0] !== "api" || parts[1] !== "solutions") {
      return send(res, 404, { error: "not found" });
    }

    if (apiKey) {
      const presented =
        req.headers["x-api-key"] ||
        (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (presented !== apiKey) {
        return send(res, 401, { error: "invalid API key", code: "unauthorized" });
      }
    }

    const id = parts[2] ? decodeURIComponent(parts[2]) : null;

    // POST /api/solutions/search
    if (req.method === "POST" && id === "search") {
      const body = (await readJson(req)) || {};
      const query = String(body.query || "").toLowerCase();
      const types = Array.isArray(body.filters?.type)
        ? body.filters.type
        : typeof body.filters?.type === "string"
          ? [body.filters.type]
          : null;
      const page = Number.isInteger(body.page) && body.page > 0 ? body.page : 1;
      const pageSize =
        Number.isInteger(body.pageSize) && body.pageSize > 0 ? body.pageSize : 20;
      const matches = [...solutions.values()].filter((sol) => {
        if (sol.status !== "active") return false;
        if (hiddenFromViewer(sol, viewer)) return false;
        if (types && !types.includes(sol.type)) return false;
        if (!query) return true;
        const haystack = [sol.name, sol.description, sol.comment, sol.author]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        return haystack.includes(query);
      });
      const start = (page - 1) * pageSize;
      const pageItems = matches
        .slice(start, start + pageSize)
        .map((sol) => publicEnvelope(sol));
      // Real-backend search shape ({results, facets}) plus the legacy
      // `solutions` alias: ai-marketplace-operations and the agentic
      // scenarios read `solutions` first, while the renderer Discover
      // surfaces and the freshness sweep are `results`-strict. Both keys
      // reference the SAME array on purpose — the downstream normalizers
      // that walk both keys are idempotent.
      return send(res, 200, {
        results: pageItems,
        solutions: pageItems,
        total: matches.length,
        page,
        pageSize,
        facets: {},
      });
    }

    // POST /api/solutions/bulk
    if (req.method === "POST" && id === "bulk") {
      const body = (await readJson(req)) || {};
      const rows = Array.isArray(body.solutions) ? body.solutions : [];
      if (rows.length > 500) {
        return send(res, 400, { error: "maximum batch size is 500" });
      }
      const results = [];
      for (const row of rows) {
        const rowId = row.id && solutions.has(row.id) ? row.id : row.id || crypto.randomUUID();
        const existing = solutions.get(rowId);
        const sol = applyWrite(existing || { id: rowId }, row, {
          isCreate: !existing,
        });
        solutions.set(rowId, sol);
        results.push(publicEnvelope(sol));
      }
      return send(res, 200, { solutions: results });
    }

    // POST /api/solutions (create)
    if (req.method === "POST" && !id) {
      const body = await readJson(req);
      if (!body || typeof body !== "object") {
        return send(res, 400, { error: "invalid JSON body" });
      }
      const problem = validateCreate(body);
      if (problem) return send(res, 400, { error: problem, code: "invalid_argument" });
      const newId = crypto.randomUUID();
      const sol = applyWrite({ id: newId }, body, { isCreate: true });
      solutions.set(newId, sol);
      return send(res, 200, publicEnvelope(sol));
    }

    if (!id) return send(res, 404, { error: "not found" });
    const existing = solutions.get(id);

    // GET /api/solutions/:id/bundle
    if (req.method === "GET" && parts[3] === "bundle") {
      if (existing && hiddenFromViewer(existing, viewer)) {
        return send(res, 404, { error: "Solution not found", code: "not_found" });
      }
      if (!existing || existing.status !== "active" || !existing.bundle) {
        return send(res, 404, { error: "no bundle", code: "no_bundle" });
      }
      return send(res, 200, existing.bundle);
    }

    // GET /api/solutions/:id — tombstones stay readable (client projects them).
    // Metadata + has_bundle only; the /bundle route is the only bundle source.
    // Visibility-hidden docs 404 exactly like missing ones (backend contract).
    if (req.method === "GET" && !parts[3]) {
      if (!existing || hiddenFromViewer(existing, viewer)) {
        return send(res, 404, { error: "Solution not found", code: "not_found" });
      }
      return send(res, 200, publicEnvelope(existing));
    }

    const ownershipDenied = () => {
      if (!ownershipEnforced || !existing) return false;
      const owner = normalizeOwnerIdentity(existing.submitted_by);
      const caller = normalizeOwnerIdentity(viewer);
      return Boolean(owner) && Boolean(caller) && owner !== caller;
    };

    // PUT /api/solutions/:id
    if (req.method === "PUT" && !parts[3]) {
      if (!existing) {
        return send(res, 404, { error: "Solution not found", code: "not_found" });
      }
      if (existing.status !== "active") {
        return send(res, 404, { error: "Solution is deleted", code: "not_found" });
      }
      if (ownershipDenied()) {
        return send(res, 403, { error: "not the owner", code: "not_owner" });
      }
      const body = await readJson(req);
      if (!body || typeof body !== "object") {
        return send(res, 400, { error: "invalid JSON body" });
      }
      if (body.bundle && body.type && body.bundle.type !== body.type) {
        return send(res, 400, { error: "bundle.type must match the top-level type" });
      }
      applyWrite(existing, body, { isCreate: false });
      return send(res, 200, publicEnvelope(existing));
    }

    // DELETE /api/solutions/:id (soft delete)
    if (req.method === "DELETE" && !parts[3]) {
      if (!existing) {
        return send(res, 404, { error: "Solution not found", code: "not_found" });
      }
      if (ownershipDenied()) {
        return send(res, 403, { error: "not the owner", code: "not_owner" });
      }
      existing.status = "deleted";
      delete existing.bundle;
      existing.updated_timestamp = nowIso();
      return send(res, 200, { id, status: "deleted" });
    }

    return send(res, 405, { error: "method not allowed" });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const boundPort = server.address().port;
      resolve({
        baseUrl: `http://${host}:${boundPort}`,
        port: boundPort,
        solutions,
        requestLog,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startMockSolutionsMarketplace, normalizeOwnerIdentity };

if (require.main === module) {
  const port = Number(process.env.MOCK_MARKETPLACE_PORT || 0);
  const apiKey = process.env.MOCK_MARKETPLACE_API_KEY || null;
  startMockSolutionsMarketplace({
    port,
    apiKey,
    log: (line) => process.stderr.write(`${line}\n`),
  }).then((handle) => {
    // Parseable by the harness: single line with the resolved base URL.
    console.log(JSON.stringify({ baseUrl: handle.baseUrl }));
  });
}
