// AI Marketplace REST client.
// Spans the IPC/Communication layer; called from ipc.js handlers.
// All operations are user-action-triggered, no polling.

const {
  DEFAULT_MANAGED_ROOT,
  resolveAiMarketplaceApiKey,
} = require("../config/runtime-secrets-config");
// Dependency-free by design (see its header) — safe to require from this
// module without dragging Electron into node-side probes and tests.
const { logMarketplaceDiag } = require("./marketplace-diagnostics");

const DEFAULT_BASE_URL = "https://solutionsapi.sandbox.example.invalid";
const DEFAULT_TIMEOUT_MS = 30_000;

// Transient-failure retry policy. Reads (GET) retry by default; non-GET
// callers must opt in per call site (`retryable: true`) so only idempotent
// writes (full-replace PUTs, read-only search POSTs) ever re-send — a
// createSolution POST re-sent after an ambiguous timeout could double-create.
const GET_RETRY_ATTEMPTS = 3;
const OPT_IN_RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = [1000, 3000];
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// AbortSignal.timeout() aborts with a DOMException named "TimeoutError"
// (legacy numeric code 23) — distinct from a user/controller abort.
function isTimeoutException(error) {
  return error?.name === "TimeoutError";
}

function isRetryableFailure(error) {
  if (!error) return false;
  if (error.code === "timeout" || error.code === "network_error") return true;
  return RETRYABLE_HTTP_STATUSES.has(error.status);
}

function normalizeBaseUrl(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.replace(/\/+$/, "");
}

function getBaseUrl(env = process.env) {
  const raw = typeof env.AI_MARKETPLACE_BASE_URL === "string"
    ? env.AI_MARKETPLACE_BASE_URL.trim()
    : "";
  return normalizeBaseUrl(raw) || DEFAULT_BASE_URL;
}

function normalizeViewerIdentity(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function buildHeaders({ apiKey, contentType = "application/json", viewerEmail = "" } = {}) {
  const headers = {
    Accept: "application/json",
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (apiKey) headers["X-API-Key"] = apiKey;
  const normalizedViewer = normalizeViewerIdentity(viewerEmail);
  if (normalizedViewer) headers["x-remote-user"] = normalizedViewer;
  return headers;
}

async function readBody(response) {
  const text = await response.text();
  // Decoded (post-gzip) body size: payload-bloat questions must be
  // answerable from the [Marketplace][http] diag without manual probes
  // (2026-08-14: a 27.6MB search response was only discovered via curl).
  const bodyBytes = Buffer.byteLength(text, "utf8");
  if (!text) return { parsed: null, bodyBytes };
  try {
    return { parsed: JSON.parse(text), bodyBytes };
  } catch {
    return { parsed: text, bodyBytes };
  }
}

function buildError(message, { status, body, code } = {}) {
  const error = new Error(message);
  if (typeof status === "number") error.status = status;
  if (body !== undefined) error.body = body;
  if (code) error.code = code;
  return error;
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function normalizeBundle(value) {
  const bundle =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : parseJsonObject(value);
  if (!bundle) return null;
  const nestedBundle = normalizeBundle(bundle.bundle);
  if (!bundle.payload && nestedBundle) return nestedBundle;
  const payload =
    bundle.payload && typeof bundle.payload === "object" && !Array.isArray(bundle.payload)
      ? bundle.payload
      : parseJsonObject(bundle.payload);
  return payload ? { ...bundle, payload } : bundle;
}

function normalizeResolvedBundleCache(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : parseJsonObject(value);
}

const UNAVAILABLE_SOLUTION_STRING_FIELDS = [
  "id",
  "solution_id",
  "uuid",
  "name",
  "description",
  "author",
  "author_display_name",
  "submitted_by",
  "submittedBy",
  "owner",
  "type",
  "detail_url",
];

const UNAVAILABLE_SOLUTION_TIME_FIELDS = ["created_at", "updated_at"];

function hasUnavailableSolutionStatus(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "status")) {
    return false;
  }
  return (
    typeof envelope.status !== "string" ||
    envelope.status.trim().toLowerCase() !== "active"
  );
}

function unavailableSolutionStatus(value) {
  if (typeof value !== "string") return "unavailable";
  const normalized = value.trim().toLowerCase();
  return normalized && normalized !== "active" ? normalized : "unavailable";
}

function projectUnavailableSolution(envelope) {
  const tombstone = {};
  for (const field of UNAVAILABLE_SOLUTION_STRING_FIELDS) {
    if (typeof envelope[field] === "string") {
      tombstone[field] = envelope[field];
    }
  }
  for (const field of UNAVAILABLE_SOLUTION_TIME_FIELDS) {
    const value = envelope[field];
    if (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      tombstone[field] = value;
    }
  }
  tombstone.status = unavailableSolutionStatus(envelope.status);
  tombstone.has_bundle = false;
  return tombstone;
}

function assertSolutionAvailable(envelope) {
  if (hasUnavailableSolutionStatus(envelope)) {
    throw buildError("Solution not found", {
      status: 404,
      code: "not_found",
    });
  }
}

function resolveRequestApiKey({
  apiKey = null,
  env = process.env,
  projectRoot = process.cwd(),
  resourcesPath = process.resourcesPath,
  managedRoot = env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT,
} = {}) {
  const explicitValue = typeof apiKey === "string" ? apiKey.trim() : "";
  if (explicitValue) {
    return explicitValue;
  }
  return resolveAiMarketplaceApiKey({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
}

async function request(
  path,
  {
    method = "GET",
    body = null,
    apiKey = null,
    baseUrl = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryable = undefined,
    retryAttempts = null,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    env = process.env,
    projectRoot = process.cwd(),
    resourcesPath = process.resourcesPath,
    managedRoot = env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT,
    viewerEmail = "",
  } = {},
) {
  const url = `${normalizeBaseUrl(baseUrl) || getBaseUrl(env)}${path}`;
  const resolvedApiKey = resolveRequestApiKey({
    apiKey,
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  const headers = buildHeaders({
    apiKey: resolvedApiKey,
    contentType: body ? "application/json" : null,
    viewerEmail,
  });
  const serializedBody =
    body !== null && body !== undefined
      ? typeof body === "string"
        ? body
        : JSON.stringify(body)
      : null;
  // Opt-in writes default to 2 attempts (a 60s PUT re-sent once is already a
  // 2-minute worst case); read-only opt-ins (search POSTs) pass retryAttempts
  // to get the full GET-grade 3. Clamped so no caller can loop.
  const maxAttempts =
    retryable === false
      ? 1
      : method === "GET"
        ? GET_RETRY_ATTEMPTS
        : retryable === true
          ? Math.max(
              1,
              Math.min(
                GET_RETRY_ATTEMPTS,
                Number(retryAttempts) || OPT_IN_RETRY_ATTEMPTS,
              ),
            )
          : 1;

  // Exactly one [Marketplace][http] line per ATTEMPT, on every exit path —
  // method/path/status/durationMs/bodyBytes/attempt only (bodyBytes is a
  // decoded LENGTH, never content), never bodies, headers, keys.
  const performAttempt = async (attempt) => {
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (serializedBody !== null) {
      init.body = serializedBody;
    }
    const startedAt = Date.now();
    const failDiag = (status, errorCode, bodyBytes = null) =>
      logMarketplaceDiag(
        "http",
        "failed",
        {
          method,
          path,
          status,
          durationMs: Date.now() - startedAt,
          ok: false,
          errorCode,
          bodyBytes,
          attempt,
        },
        "warn",
      );
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      const errorCode = isTimeoutException(error) ? "timeout" : "network_error";
      failDiag(null, errorCode);
      throw buildError(
        errorCode === "timeout"
          ? `AI Marketplace request failed (${method} ${path}): timed out after ${timeoutMs}ms`
          : `AI Marketplace request failed (${method} ${path}): ${error.message}`,
        { code: errorCode },
      );
    }

    let parsedBody;
    let bodyBytes = null;
    try {
      ({ parsed: parsedBody, bodyBytes } = await readBody(response));
    } catch (error) {
      // Headers arrived but the body stalled — AbortSignal.timeout covers the
      // body stream too, and an unwrapped DOMException here used to leak raw
      // "aborted due to timeout" (code 23) errors to callers.
      const errorCode = isTimeoutException(error) ? "timeout" : "network_error";
      failDiag(response.status, errorCode);
      throw buildError(
        errorCode === "timeout"
          ? `AI Marketplace request failed (${method} ${path}): response body timed out after ${timeoutMs}ms`
          : `AI Marketplace request failed (${method} ${path}): ${error.message}`,
        { code: errorCode },
      );
    }

    if (!response.ok) {
      const message =
        (parsedBody && typeof parsedBody === "object" && (parsedBody.error || parsedBody.message)) ||
        `${method} ${path} returned ${response.status}`;
      const bodyCode =
        parsedBody && typeof parsedBody === "object" && typeof parsedBody.code === "string"
          ? parsedBody.code
          : null;
      const errorCode = bodyCode || (response.status === 401 ? "unauthorized" : "http_error");
      failDiag(response.status, errorCode, bodyBytes);
      throw buildError(message, {
        status: response.status,
        body: parsedBody,
        // Prefer a server-supplied code (e.g. the marketplace ownership guard's
        // `not_owner`) so callers can branch on it; fall back to status-derived codes.
        code: errorCode,
      });
    }

    logMarketplaceDiag("http", "ok", {
      method,
      path,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ok: true,
      bodyBytes,
      attempt,
    });
    return parsedBody;
  };

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await performAttempt(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableFailure(error)) {
        if (attempt > 1 && error instanceof Error) {
          error.message = `${error.message} (after ${attempt} attempts)`;
        }
        throw error;
      }
      await sleepImpl(
        RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)],
      );
    }
  }
}

function normalizeSearchFilters(filters) {
  const normalized =
    filters && typeof filters === "object" && !Array.isArray(filters)
      ? { ...filters }
      : {};
  if (typeof normalized.type === "string") {
    normalized.type = [normalized.type];
  }
  return normalized;
}

async function search(
  { query = "", filters = {}, sort = "relevance", page = 1, pageSize = 20 } = {},
  options = {},
) {
  return request("/api/solutions/search", {
    method: "POST",
    body: {
      query,
      filters: normalizeSearchFilters(filters),
      sort,
      page,
      pageSize,
    },
    ...options,
  });
}

async function fetchSolutionEnvelope(id, options = {}) {
  return request(`/api/solutions/${encodeURIComponent(id)}`, options);
}

async function getSolution(id, options = {}) {
  if (!id) throw buildError("getSolution: id is required", { code: "invalid_argument" });
  const envelope = await fetchSolutionEnvelope(id, options);
  return hasUnavailableSolutionStatus(envelope)
    ? projectUnavailableSolution(envelope)
    : envelope;
}

async function getSolutionBundle(id, options = {}) {
  if (!id) throw buildError("getSolutionBundle: id is required", { code: "invalid_argument" });
  // The dedicated `/bundle` route is not reliably served on all marketplace
  // deployments (sandbox currently returns 404). The solution envelope, however,
  // includes the bundle inline, so prefer that and fall back to the dedicated
  // route for forward-compatibility.
  const envelope = await fetchSolutionEnvelope(id, options);
  assertSolutionAvailable(envelope);
  if (envelope && typeof envelope === "object") {
    // Git-backed solutions expose the fully resolved bundle (with inlined skill
    // content and references) under `resolved_bundle_cache.bundle`. The
    // top-level `bundle` may only carry the unresolved git source reference, so
    // prefer the resolved bundle whenever it is present.
    const resolvedCache = normalizeResolvedBundleCache(envelope.resolved_bundle_cache);
    const resolved = normalizeBundle(resolvedCache && (resolvedCache.bundle || resolvedCache));
    if (resolved && resolved.payload) {
      return resolved;
    }
    const bundled = normalizeBundle(envelope.bundle);
    if (bundled) {
      return bundled;
    }
  }
  try {
    return normalizeBundle(
      await request(`/api/solutions/${encodeURIComponent(id)}/bundle`, options),
    );
  } catch (error) {
    if (error && error.status === 404) {
      throw buildError(`Solution ${id} has no installable bundle attached.`, {
        status: 404,
        code: "no_bundle",
      });
    }
    throw error;
  }
}

async function createSolution(solution, { apiKey, ...options } = {}) {
  return request("/api/solutions", {
    method: "POST",
    body: solution,
    apiKey,
    ...options,
  });
}

async function updateSolution(id, patch, { apiKey, ...options } = {}) {
  if (!id) throw buildError("updateSolution: id is required", { code: "invalid_argument" });
  return request(`/api/solutions/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: patch,
    apiKey,
    ...options,
  });
}

async function deleteSolution(id, { apiKey, submittedBy = "", ...options } = {}) {
  if (!id) throw buildError("deleteSolution: id is required", { code: "invalid_argument" });
  return request(`/api/solutions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: submittedBy ? { submitted_by: submittedBy } : null,
    apiKey,
    ...options,
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  buildError,
  buildHeaders,
  createSolution,
  deleteSolution,
  getBaseUrl,
  getSolution,
  getSolutionBundle,
  normalizeBundle,
  normalizeViewerIdentity,
  request,
  resolveRequestApiKey,
  search,
  updateSolution,
};
