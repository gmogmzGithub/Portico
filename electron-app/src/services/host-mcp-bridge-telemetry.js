const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BRIDGE_LOGREPO_TYPE = "porticoAiChatBridgeEvent";
const BRIDGE_LOGREPO_SCHEMA_VERSION = "1";
const DEFAULT_LOGREPO_URL = "https://logrepo-clip.sandbox.example.invalid/logrepo";
const DEFAULT_LOGREPO_TIMEOUT_MS = 2000;
const MAX_LOGREPO_FIELD_LENGTH = 256;
const TOKEN_FIELD_NAMES = new Set([
  "arch",
  "build_channel",
  "caller",
  "client_id",
  "error_category",
  "event_name",
  "event_scope",
  "identity_source",
  "ldap",
  "mcp_server",
  "mcp_tool",
  "outcome",
  "platform",
  "request_source",
  "runtime_path",
  "script_action",
  "server_id",
  "stop_reason",
  "surface",
  "tool",
  "tool_call_id",
]);

let packageVersionCache;

function normalizeBoolean(value) {
  return value === true ? "true" : "false";
}

function hashString(value, length = 16) {
  const raw = String(value || "");
  if (!raw) {
    return "";
  }
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, length);
}

function normalizeBridgeTelemetryToken(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_\-.]+|[_\-.]+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function normalizeBridgeClientIds(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((entry) => entry.trim());
  const ids = [];
  const seen = new Set();
  for (const entry of source) {
    const id = normalizeBridgeTelemetryToken(entry, "");
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids.sort();
}

function isBlockedTelemetryFieldName(key) {
  const normalized = String(key || "").toLowerCase();
  if (normalized === "runtime_path") {
    return false;
  }
  return (
    normalized === "error" ||
    normalized === "raw_error" ||
    normalized === "authorization" ||
    normalized === "headers" ||
    normalized.endsWith("_url") ||
    normalized.endsWith("_path") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("bearer")
  );
}

function stringifyTelemetryValue(key, value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (TOKEN_FIELD_NAMES.has(String(key))) {
    return normalizeBridgeTelemetryToken(value, "");
  }
  if (String(key).endsWith("_ids")) {
    return normalizeBridgeClientIds(value).join(",");
  }
  if (typeof value === "boolean") {
    return normalizeBoolean(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.round(value)) : "";
  }
  if (Array.isArray(value)) {
    return normalizeBridgeClientIds(value).join(",");
  }
  if (typeof value === "object") {
    return "";
  }
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_LOGREPO_FIELD_LENGTH);
}

function resolvePackageVersion() {
  if (packageVersionCache !== undefined) {
    return packageVersionCache;
  }
  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageVersionCache = String(packageJson.version || "");
  } catch (_) {
    packageVersionCache = "";
  }
  return packageVersionCache;
}

function resolveLdap(env = process.env) {
  const candidates = [
    env.portico_LDAP,
    env.PORTICO_USER_ID,
    env.LDAP,
    env.USER,
    env.LOGNAME,
    env.USERNAME,
  ];
  try {
    candidates.push(os.userInfo().username);
  } catch (_) {
    // Ignore user lookup failures in packaged or sandboxed environments.
  }
  for (const candidate of candidates) {
    const value = normalizeBridgeTelemetryToken(candidate, "");
    if (value) {
      return value;
    }
  }
  return "unknown";
}

function resolveBuildChannel(env = process.env) {
  return normalizeBridgeTelemetryToken(
    env.portico_RELEASE_CHANNEL || env.RELEASE_CHANNEL || env.UPDATE_CHANNEL || "",
    "unknown",
  );
}

function resolveLogRepoUrl(options = {}) {
  const env = options.env || process.env;
  if (
    env.portico_MCP_BRIDGE_LOGREPO_DISABLED === "1" ||
    String(env.portico_MCP_BRIDGE_LOGREPO_DISABLED || "").toLowerCase() === "true"
  ) {
    return "";
  }
  return (
    options.logRepoUrl ||
    env.portico_MCP_BRIDGE_LOGREPO_URL ||
    env.portico_MCP_LOGREPO_URL ||
    DEFAULT_LOGREPO_URL
  );
}

function classifyBridgeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (!message) {
    return "unknown_error";
  }
  if (message.includes("no mcp clients") || message.includes("unsupported mcp client")) {
    return "client_selection_error";
  }
  if (message.includes("did not become healthy") || message.includes("timed out") || message.includes("timeout")) {
    return "bridge_health_timeout";
  }
  if (message.includes("eacces") || message.includes("eperm") || message.includes("permission")) {
    return "permission_denied";
  }
  if (message.includes("enoent") || message.includes("not found") || message.includes("does not exist")) {
    return "not_found";
  }
  if (message.includes("json") || message.includes("parse")) {
    return "config_parse_failed";
  }
  if (message.includes("oauth broker") || message.includes("host mcp bridge")) {
    return "bridge_start_error";
  }
  return "unknown_error";
}

function buildBridgeErrorTelemetry(error, category = "") {
  const message = String(error?.message || error || "");
  return {
    error_category: normalizeBridgeTelemetryToken(category || classifyBridgeError(error)),
    error_message_hash: hashString(message),
  };
}

function buildBridgeLogRepoPayload(eventName, fields = {}, options = {}) {
  const env = options.env || process.env;
  const now = options.now ? new Date(options.now) : new Date();
  const payload = {
    schema_version: BRIDGE_LOGREPO_SCHEMA_VERSION,
    event_name: normalizeBridgeTelemetryToken(eventName),
    outcome: normalizeBridgeTelemetryToken(fields.outcome, "unknown"),
    request_source: normalizeBridgeTelemetryToken(fields.request_source, "unknown"),
    caller: normalizeBridgeTelemetryToken(fields.caller, "unknown"),
    appinstance: "portico",
    app_version: stringifyTelemetryValue("app_version", fields.app_version || options.appVersion || resolvePackageVersion()),
    build_channel: resolveBuildChannel(env),
    platform: normalizeBridgeTelemetryToken(fields.platform || process.platform, "unknown"),
    arch: normalizeBridgeTelemetryToken(fields.arch || process.arch, "unknown"),
    ldap: resolveLdap(env),
    machine_hash: hashString(options.machineName || os.hostname()),
    ts: Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString(),
  };

  for (const [key, value] of Object.entries(fields || {})) {
    if (!/^[A-Za-z0-9_]+$/.test(key) || isBlockedTelemetryFieldName(key)) {
      continue;
    }
    const serialized = stringifyTelemetryValue(key, value);
    if (serialized) {
      payload[key] = serialized;
    }
  }

  return payload;
}

function buildClipFormBody(payload, type = BRIDGE_LOGREPO_TYPE) {
  const body = new URLSearchParams();
  body.append("type", type);
  for (const [key, value] of Object.entries(payload || {})) {
    if (key === "type") {
      continue;
    }
    const serialized = stringifyTelemetryValue(key, value);
    if (serialized) {
      body.append(key, serialized);
    }
  }
  return `${body.toString()}&&`;
}

async function emitBridgeLogRepoEvent(eventName, fields = {}, options = {}) {
  try {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const logRepoUrl = resolveLogRepoUrl(options);
    if (!logRepoUrl || typeof fetchImpl !== "function") {
      return { emitted: false, skipped: true };
    }

    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : DEFAULT_LOGREPO_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const payload = buildBridgeLogRepoPayload(eventName, fields, options);
    const body = buildClipFormBody(payload);

    try {
      const response = await fetchImpl(logRepoUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      });
      return {
        emitted: response?.ok === true,
        status: response?.status || 0,
        payload,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (process.env.portico_MCP_BRIDGE_LOGREPO_DEBUG === "true") {
      console.warn("[Host MCP Bridge] LogRepo telemetry failed:", error.message || error);
    }
    return { emitted: false, error: error?.message || String(error) };
  }
}

function summarizeBridgeClientResults(results = []) {
  const safeResults = Array.isArray(results) ? results : [];
  const successResults = safeResults.filter((result) => result?.success === true);
  const failedResults = safeResults.filter((result) => result?.success !== true);
  return {
    selected_client_ids: safeResults.map((result) => result?.clientId).filter(Boolean),
    succeeded_client_ids: successResults.map((result) => result?.clientId).filter(Boolean),
    failed_client_ids: failedResults.map((result) => result?.clientId).filter(Boolean),
    selected_client_count: safeResults.length,
    succeeded_client_count: successResults.length,
    failed_client_count: failedResults.length,
    restart_required_client_count: safeResults.filter((result) => result?.restartRequired === true).length,
    removed_client_count: safeResults.filter((result) => result?.removed === true).length,
    revoked_client_count: safeResults.filter((result) => result?.revoked === true).length,
  };
}

function summarizeBridgeClientInventory(clients = []) {
  const safeClients = Array.isArray(clients) ? clients : [];
  const detectedClients = safeClients
    .filter((client) => client?.detected === true)
    .map((client) => client.id)
    .filter(Boolean);
  const configuredClients = safeClients
    .filter((client) => client?.configured === true)
    .map((client) => client.id)
    .filter(Boolean);
  return {
    supported_client_count: safeClients.length,
    detected_client_count: detectedClients.length,
    configured_client_count: configuredClients.length,
    config_unreadable_client_count: safeClients.filter(
      (client) => client?.status === "config_unreadable" || client?.status === "config_error",
    ).length,
    detected_client_ids: detectedClients,
    configured_client_ids: configuredClients,
  };
}

function emitBridgeClientResultEvents(action, results = [], commonFields = {}, options = {}) {
  const safeAction = normalizeBridgeTelemetryToken(action, "client_action");
  const promises = [];
  for (const result of Array.isArray(results) ? results : []) {
    const success = result?.success === true;
    const fields = {
      ...commonFields,
      event_scope: "client",
      outcome: success ? "success" : "failed",
      client_id: result?.clientId || "unknown",
      restart_required: result?.restartRequired === true,
      removed: result?.removed === true,
      revoked: result?.revoked === true,
      ...(success ? {} : buildBridgeErrorTelemetry(result?.error || "client operation failed")),
    };
    promises.push(
      emitBridgeLogRepoEvent(
        `${safeAction}_${success ? "completed" : "failed"}`,
        fields,
        options,
      ),
    );
  }
  return Promise.all(promises);
}

module.exports = {
  BRIDGE_LOGREPO_TYPE,
  BRIDGE_LOGREPO_SCHEMA_VERSION,
  DEFAULT_LOGREPO_URL,
  buildBridgeErrorTelemetry,
  buildBridgeLogRepoPayload,
  buildClipFormBody,
  classifyBridgeError,
  emitBridgeClientResultEvents,
  emitBridgeLogRepoEvent,
  hashString,
  normalizeBridgeClientIds,
  normalizeBridgeTelemetryToken,
  summarizeBridgeClientInventory,
  summarizeBridgeClientResults,
};
