const { app } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const { promisify } = require("util");
const { calculatePromptCacheMetrics } = require("./model-pricing");

const REPORTING_VERSION = 2;
const EVENTS_DIRNAME = "events";
const SNAPSHOTS_DIRNAME = "snapshots";
const DASHBOARD_SNAPSHOT_FILENAME = "dashboard-latest.json";
const CHAT_DB_BACKFILL_THROTTLE_MS = 60000;
const execFileAsync = promisify(execFile);

let cacheState = {
  loaded: false,
  eventsByDate: new Map(),
  allEvents: [],
  summarySnapshot: null,
  lastChatDbBackfillAt: 0,
  loadedFiles: new Map(),
};

let writeQueue = Promise.resolve();

function getLegacyReportingRoot() {
  return path.join(app.getPath("userData"), "reporting");
}

function getProjectRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function getExternalReportingRoot() {
  const configuredRoot = String(process.env.PORTICO_REPORTING_DIR || "").trim();
  if (configuredRoot) {
    return configuredRoot;
  }

  return path.join(getProjectRoot(), "open-webui-data", "reporting");
}

function reportingRootHasData(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return false;
  }

  return (
    fs.existsSync(path.join(rootPath, EVENTS_DIRNAME)) ||
    fs.existsSync(path.join(rootPath, SNAPSHOTS_DIRNAME))
  );
}

function getReportingRoot() {
  const externalRoot = getExternalReportingRoot();
  if (
    String(process.env.PORTICO_REPORTING_DIR || "").trim() ||
    reportingRootHasData(externalRoot)
  ) {
    return externalRoot;
  }

  return getLegacyReportingRoot();
}

function getReadableReportingRoots() {
  const roots = [];
  const seen = new Set();

  for (const candidate of [getReportingRoot(), getExternalReportingRoot(), getLegacyReportingRoot()]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (fs.existsSync(candidate)) {
      roots.push(candidate);
    }
  }

  if (roots.length === 0) {
    roots.push(getReportingRoot());
  }

  return roots;
}

function getDefaultChatDbPath() {
  return path.join(getProjectRoot(), "open-webui-data", "webui.db");
}

function getEventsDir() {
  return path.join(getReportingRoot(), EVENTS_DIRNAME);
}

function getSnapshotsDir() {
  return path.join(getReportingRoot(), SNAPSHOTS_DIRNAME);
}

function getDashboardSnapshotPath() {
  return path.join(getSnapshotsDir(), DASHBOARD_SNAPSHOT_FILENAME);
}

async function ensureReportingDirs() {
  await fsPromises.mkdir(getEventsDir(), { recursive: true });
  await fsPromises.mkdir(getSnapshotsDir(), { recursive: true });
}

function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function toInteger(value, fallback = 0) {
  return Math.max(0, Math.floor(toFiniteNumber(value, fallback)));
}

function toIsoTimestamp(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const numericValue = toFiniteNumber(value, NaN);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    const parsed = new Date(numericValue);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function toMillisecondsTimestamp(value) {
  const numericValue = toFiniteNumber(value, NaN);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return Date.now();
  }

  // Chat/message timestamps are often stored in Unix seconds.
  if (numericValue < 1000000000000) {
    return Math.floor(numericValue * 1000);
  }

  return Math.floor(numericValue);
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map((part) => Number(part));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const parsed = new Date(year, month - 1, day);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfHour(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    0,
    0,
    0,
  );
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addHours(date, hours) {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function daysBetweenInclusive(start, end) {
  const startDay = startOfDay(start);
  const endDay = startOfDay(end);
  const deltaMs = endDay.getTime() - startDay.getTime();
  return Math.max(1, Math.floor(deltaMs / 86400000) + 1);
}

function getStartOfWeek(date) {
  const value = startOfDay(date);
  const day = value.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(value, offset);
}

function getStartOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getWeekKey(date) {
  return formatDateKey(getStartOfWeek(date));
}

function getMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getDateLabel(dateKey) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return dateKey;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function getHourKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}`;
}

function parseHourKey(hourKey) {
  const [datePart, hourPart] = String(hourKey || "").split("T");
  const parsedDate = parseDateKey(datePart);
  const hour = Number(hourPart);
  if (!parsedDate || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  return new Date(
    parsedDate.getFullYear(),
    parsedDate.getMonth(),
    parsedDate.getDate(),
    hour,
    0,
    0,
    0,
  );
}

function getHourLabel(hourKey) {
  const parsed = parseHourKey(hourKey);
  if (!parsed) return hourKey;
  return parsed.toLocaleTimeString(undefined, {
    hour: "numeric",
  });
}

function getHourTooltipLabel(hourKey) {
  const parsed = parseHourKey(hourKey);
  if (!parsed) return hourKey;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
}

function atomicWriteJson(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  return fsPromises
    .writeFile(tempPath, body, "utf8")
    .then(() => fsPromises.rename(tempPath, filePath))
    .catch(async (error) => {
      try {
        await fsPromises.unlink(tempPath);
      } catch (_cleanupError) {
        // Ignore cleanup failures.
      }
      throw error;
    });
}

function sortEvents(events) {
  return [...events].sort((left, right) => {
    const leftTime = new Date(left.timestamp).getTime();
    const rightTime = new Date(right.timestamp).getTime();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return String(left.eventId).localeCompare(String(right.eventId));
  });
}

function hasOwnKey(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function hasAnyOwnKey(object, keys) {
  return keys.some((key) => hasOwnKey(object, key));
}

function classifyUsageShape(input, usage) {
  const translated =
    hasAnyOwnKey(input, [
      "promptTokens",
      "prompt_tokens",
      "completionTokens",
      "completion_tokens",
      "totalTokens",
      "total_tokens",
      "responseCost",
      "cost",
    ]) ||
    hasAnyOwnKey(usage, [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "prompt_tokens_details",
      "cost",
    ]);

  if (translated) {
    return "translated";
  }

  const providerRaw =
    hasAnyOwnKey(input, ["inputTokens", "input_tokens", "outputTokens", "output_tokens"]) ||
    hasAnyOwnKey(usage, [
      "input_tokens",
      "inputTokens",
      "output_tokens",
      "outputTokens",
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
    ]);

  return providerRaw ? "provider_raw" : "unknown";
}

function rebuildNormalizedEvent(baseEvent, overrides = {}) {
  const normalizedModelId = String(
    overrides?.modelId ?? baseEvent?.modelId ?? "unknown",
  ).trim() || "unknown";
  const normalizedModelName = String(
    overrides?.modelName ?? baseEvent?.modelName ?? normalizedModelId,
  ).trim() || normalizedModelId;

  return normalizeEvent({
    ...baseEvent,
    ...overrides,
    completedAt: overrides?.completedAt ?? baseEvent?.timestamp ?? baseEvent?.completedAt,
    timestamp: overrides?.timestamp ?? baseEvent?.timestamp ?? baseEvent?.completedAt,
    turnId: String(overrides?.turnId ?? baseEvent?.turnId ?? "").trim(),
    callId: String(overrides?.callId ?? baseEvent?.callId ?? "").trim(),
    debugRequestId: String(
      overrides?.debugRequestId ?? baseEvent?.debugRequestId ?? "",
    ).trim(),
    upstreamRequestId: String(
      overrides?.upstreamRequestId ?? baseEvent?.upstreamRequestId ?? "",
    ).trim(),
    modelId: normalizedModelId,
    modelName: normalizedModelName,
    source: String(overrides?.source ?? baseEvent?.source ?? "chat-completion").trim(),
    promptTokens: toInteger(overrides?.promptTokens ?? baseEvent?.promptTokens),
    completionTokens: toInteger(overrides?.completionTokens ?? baseEvent?.completionTokens),
    totalTokens: toInteger(overrides?.totalTokens ?? baseEvent?.totalTokens),
    cachedTokens: toInteger(overrides?.cachedTokens ?? baseEvent?.cachedTokens),
    cacheReadInputTokens: toInteger(
      overrides?.cacheReadInputTokens ?? baseEvent?.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: toInteger(
      overrides?.cacheCreationInputTokens ?? baseEvent?.cacheCreationInputTokens,
    ),
    cacheWriteInputTokens: toInteger(
      overrides?.cacheWriteInputTokens ?? baseEvent?.cacheWriteInputTokens,
    ),
    cost: toFiniteNumber(
      overrides?.reportedCost ??
        overrides?.cost ??
        baseEvent?.reportedCost ??
        baseEvent?.cost,
      0,
    ),
  });
}

function repairTranslatedBifrostEvent(translatedEvent, providerRawEvent) {
  const repairedCacheReadTokens = Math.max(
    0,
    toInteger(providerRawEvent?.cacheReadInputTokens),
  );
  const repairedCacheWriteTokens = Math.max(
    0,
    toInteger(providerRawEvent?.cacheWriteInputTokens),
    toInteger(providerRawEvent?.cacheCreationInputTokens),
  );

  return rebuildNormalizedEvent(translatedEvent, {
    cachedTokens: repairedCacheReadTokens,
    cacheReadInputTokens: repairedCacheReadTokens,
    cacheCreationInputTokens: repairedCacheWriteTokens,
    cacheWriteInputTokens: repairedCacheWriteTokens,
  });
}

function collapseDuplicateBifrostEvents(events) {
  const groupedEvents = new Map();
  const passthrough = [];

  for (const event of events) {
    const upstreamRequestId = String(event?.upstreamRequestId || "").trim();
    if (
      event?.source === "bifrost-bridge" &&
      upstreamRequestId &&
      String(event?.chatId || "").trim()
    ) {
      const key = `${String(event.chatId).trim()}:${upstreamRequestId}`;
      const group = groupedEvents.get(key) || [];
      group.push(event);
      groupedEvents.set(key, group);
      continue;
    }

    passthrough.push(event);
  }

  for (const group of groupedEvents.values()) {
    const sortedGroup = sortEvents(group);
    const translatedEvents = sortedGroup.filter((event) => event.usageShape === "translated");
    const providerRawEvents = sortedGroup.filter((event) => event.usageShape === "provider_raw");

    if (translatedEvents.length > 0 && providerRawEvents.length > 0) {
      passthrough.push(
        repairTranslatedBifrostEvent(
          translatedEvents[translatedEvents.length - 1],
          providerRawEvents[providerRawEvents.length - 1],
        ),
      );
      continue;
    }

    passthrough.push(...sortedGroup);
  }

  return sortEvents(passthrough);
}

function rebuildAllEvents() {
  cacheState.allEvents = sortEvents(
    Array.from(cacheState.eventsByDate.values()).flatMap((dayEvents) => dayEvents),
  );
}

function normalizeEvent(input) {
  const timestamp = toIsoTimestamp(
    input?.completedAt ??
      input?.timestamp ??
      input?.createdAt ??
      input?.messageTimestamp ??
      Date.now(),
  );
  const completedDate = new Date(timestamp);
  const dateKey = formatDateKey(completedDate);
  const usage = input?.usage && typeof input.usage === "object" ? input.usage : {};

  const chatId = String(input?.chatId || input?.chat_id || "").trim();
  const messageId = String(
    input?.messageId || input?.message_id || input?.responseMessageId || "",
  ).trim();
  const modelId = String(
    input?.modelId || input?.model_id || input?.selectedModelId || input?.model || "unknown",
  ).trim() || "unknown";
  const modelName = String(
    input?.modelName || input?.model_name || input?.modelDisplayName || modelId,
  ).trim() || modelId;
  const eventId = String(
    input?.eventId || (chatId && messageId ? `${chatId}:${messageId}` : `${modelId}:${messageId}`),
  ).trim();
  const turnId = String(
    input?.turnId || input?.turn_id || (chatId && messageId ? `${chatId}:${messageId}` : eventId),
  ).trim() || eventId;
  const callId = String(input?.callId || input?.call_id || "").trim();
  const debugRequestId = String(
    input?.debugRequestId || input?.debug_request_id || "",
  ).trim();
  const upstreamRequestId = String(
    input?.upstreamRequestId || input?.upstream_request_id || "",
  ).trim();
  const usageShape = classifyUsageShape(input, usage);

  const promptTokens = toInteger(
    input?.promptTokens ??
      input?.prompt_tokens ??
      usage?.prompt_tokens ??
      usage?.input_tokens ??
      usage?.inputTokens,
  );
  const completionTokens = toInteger(
    input?.completionTokens ??
      input?.completion_tokens ??
      usage?.completion_tokens ??
      usage?.output_tokens ??
      usage?.outputTokens,
  );
  const totalTokens = toInteger(
    input?.totalTokens ??
      input?.total_tokens ??
      usage?.total_tokens ??
      usage?.totalTokens ??
      promptTokens + completionTokens,
  );
  const promptTokensDetails =
    usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? usage.prompt_tokens_details
      : {};
  const cachedTokens = toInteger(
    input?.cachedTokens ??
      input?.cached_tokens ??
      usage?.cached_tokens ??
      usage?.cachedTokens ??
      usage?.cachedContentTokenCount ??
      usage?.cached_content_token_count ??
      usage?.cache_read_input_tokens ??
      promptTokensDetails?.cached_tokens ??
      promptTokensDetails?.cachedContentTokenCount ??
      promptTokensDetails?.cached_content_token_count ??
      promptTokensDetails?.cached_read_tokens ??
      promptTokensDetails?.cache_read_tokens,
  );
  const cacheReadInputTokens = toInteger(
    input?.cacheReadInputTokens ??
      input?.cache_read_input_tokens ??
      usage?.cache_read_input_tokens ??
      usage?.cacheReadInputTokens ??
      usage?.cachedContentTokenCount ??
      usage?.cached_content_token_count ??
      promptTokensDetails?.cached_read_tokens ??
      promptTokensDetails?.cache_read_tokens ??
      promptTokensDetails?.cachedContentTokenCount ??
      promptTokensDetails?.cached_content_token_count ??
      promptTokensDetails?.cached_tokens,
  );
  const cacheCreationInputTokens = toInteger(
    input?.cacheCreationInputTokens ??
      input?.cache_creation_input_tokens ??
      usage?.cache_creation_input_tokens ??
      usage?.cacheCreationInputTokens ??
      promptTokensDetails?.cached_write_tokens ??
      promptTokensDetails?.cache_write_tokens ??
      promptTokensDetails?.cache_creation_tokens,
  );
  const cacheWriteInputTokens = toInteger(
    input?.cacheWriteInputTokens ??
      input?.cache_write_input_tokens ??
      usage?.cache_write_input_tokens ??
      usage?.cacheWriteInputTokens ??
      promptTokensDetails?.cached_write_tokens ??
      promptTokensDetails?.cache_write_tokens ??
      promptTokensDetails?.cache_creation_tokens,
  );
  const contextTokensEstimate = toInteger(
    input?.contextTokensEstimate ?? input?.context_tokens_estimate,
  );
  const reportedCost = Math.max(
    0,
    toFiniteNumber(input?.cost ?? usage?.cost ?? input?.responseCost ?? 0, 0),
  );
  const pricingMetrics = calculatePromptCacheMetrics({
    modelId,
    modelName,
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheWriteInputTokens,
    actualCost: reportedCost,
  });

  return {
    version: REPORTING_VERSION,
    eventId,
    turnId,
    callId,
    chatId,
    messageId,
    debugRequestId,
    upstreamRequestId,
    usageShape,
    modelId,
    modelName,
    timestamp,
    dateKey,
    weekKey: getWeekKey(completedDate),
    monthKey: getMonthKey(completedDate),
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheWriteInputTokens,
    contextTokensEstimate,
    reportedCost,
    cost: pricingMetrics.effectiveActualCost,
    estimatedActualCost: pricingMetrics.estimatedActualCost,
    estimatedCostWithoutCache: pricingMetrics.estimatedCostWithoutCache,
    netCacheSavings: pricingMetrics.netCacheSavings,
    savingsRate: pricingMetrics.savingsRate,
    cacheReadTokens: pricingMetrics.cacheReadTokens,
    cacheWriteTokens: pricingMetrics.cacheWriteTokens,
    grossCacheReadSavings: pricingMetrics.grossCacheReadSavings,
    cacheWritePremium: pricingMetrics.cacheWritePremium,
    pricingModelKey: pricingMetrics.modelKey,
    pricingModelName: pricingMetrics.modelName,
    supportsPricing: pricingMetrics.supportsPricing,
    supportsCacheSavings: pricingMetrics.supportsCacheSavings,
    source: String(input?.source || input?.eventSource || "chat-completion").trim() || "chat-completion",
  };
}

function mergeEvents(existingEvent, nextEvent) {
  const latestTimestamp = Math.max(
    new Date(existingEvent?.timestamp || 0).getTime() || 0,
    new Date(nextEvent?.timestamp || 0).getTime() || 0,
  );

  return normalizeEvent({
    ...existingEvent,
    ...nextEvent,
    timestamp: new Date(latestTimestamp || Date.now()).toISOString(),
    turnId: String(nextEvent?.turnId || existingEvent?.turnId || "").trim(),
    callId: String(nextEvent?.callId || existingEvent?.callId || "").trim(),
    debugRequestId: String(
      nextEvent?.debugRequestId || existingEvent?.debugRequestId || "",
    ).trim(),
    upstreamRequestId: String(
      nextEvent?.upstreamRequestId || existingEvent?.upstreamRequestId || "",
    ).trim(),
    usageShape: String(
      nextEvent?.usageShape || existingEvent?.usageShape || "unknown",
    ).trim() || "unknown",
    source: String(nextEvent?.source || existingEvent?.source || "chat-completion").trim(),
    promptTokens: Math.max(
      toInteger(existingEvent?.promptTokens),
      toInteger(nextEvent?.promptTokens),
    ),
    completionTokens: Math.max(
      toInteger(existingEvent?.completionTokens),
      toInteger(nextEvent?.completionTokens),
    ),
    totalTokens: Math.max(
      toInteger(existingEvent?.totalTokens),
      toInteger(nextEvent?.totalTokens),
    ),
    cachedTokens: Math.max(
      toInteger(existingEvent?.cachedTokens),
      toInteger(nextEvent?.cachedTokens),
    ),
    cacheReadInputTokens: Math.max(
      toInteger(existingEvent?.cacheReadInputTokens),
      toInteger(nextEvent?.cacheReadInputTokens),
    ),
    cacheCreationInputTokens: Math.max(
      toInteger(existingEvent?.cacheCreationInputTokens),
      toInteger(nextEvent?.cacheCreationInputTokens),
    ),
    cacheWriteInputTokens: Math.max(
      toInteger(existingEvent?.cacheWriteInputTokens),
      toInteger(nextEvent?.cacheWriteInputTokens),
    ),
    // Same eventId means the same request, so max == latest; max also keeps
    // a bridge-reported estimate from being wiped by a later field-less
    // duplicate (e.g. a chat-DB backfill merge).
    contextTokensEstimate: Math.max(
      toInteger(existingEvent?.contextTokensEstimate),
      toInteger(nextEvent?.contextTokensEstimate),
    ),
    cost: Math.max(
      toFiniteNumber(existingEvent?.reportedCost ?? existingEvent?.cost, 0),
      toFiniteNumber(nextEvent?.reportedCost ?? nextEvent?.cost, 0),
    ),
  });
}

function isMeaningfulEvent(event) {
  if (!event?.eventId || !event?.messageId) {
    return false;
  }

  return (
    event.totalTokens > 0 ||
    event.promptTokens > 0 ||
    event.completionTokens > 0 ||
    event.cachedTokens > 0 ||
    event.cacheReadInputTokens > 0 ||
    event.cacheCreationInputTokens > 0 ||
    event.cacheWriteInputTokens > 0 ||
    event.cost > 0
  );
}

async function collectJsonFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    const dirEntries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function normalizeLoadedEvents(parsed) {
  if (Array.isArray(parsed?.events)) {
    return parsed.events;
  }
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    return [parsed];
  }
  return [];
}

async function loadEventsFile(filePath) {
  const raw = await fsPromises.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return sortEvents(
    normalizeLoadedEvents(parsed)
      .map((event) => normalizeEvent(event))
      .filter((event) => isMeaningfulEvent(event)),
  );
}

async function loadEventsFileSnapshot(filePath) {
  const [stats, events] = await Promise.all([
    fsPromises.stat(filePath),
    loadEventsFile(filePath),
  ]);

  return {
    filePath,
    mtimeMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : 0,
    size: Number.isFinite(stats.size) ? stats.size : 0,
    events,
  };
}

function rebuildCacheFromLoadedFiles() {
  const eventMap = new Map();

  for (const snapshot of cacheState.loadedFiles.values()) {
    for (const event of snapshot.events || []) {
      const existing = eventMap.get(event.eventId);
      eventMap.set(event.eventId, existing ? mergeEvents(existing, event) : event);
    }
  }

  cacheState.allEvents = collapseDuplicateBifrostEvents(Array.from(eventMap.values()));
  cacheState.eventsByDate = rebuildEventsByDate(cacheState.allEvents);
}

async function ensureCacheLoaded(forceReload = false) {
  if (forceReload) {
    cacheState = {
      ...cacheState,
      loaded: false,
      eventsByDate: new Map(),
      allEvents: [],
      summarySnapshot: null,
      loadedFiles: new Map(),
    };
  }

  if (cacheState.loaded) {
    return cacheState;
  }

  await ensureReportingDirs();

  const loadedFiles = new Map();
  for (const reportingRoot of getReadableReportingRoots()) {
    const eventsDir = path.join(reportingRoot, EVENTS_DIRNAME);
    const files = await collectJsonFiles(eventsDir);
    for (const fullPath of files) {
      try {
        const snapshot = await loadEventsFileSnapshot(fullPath);
        loadedFiles.set(fullPath, snapshot);
      } catch (error) {
        console.warn("[CostReporting] Failed to load reporting file:", fullPath, error.message);
      }
    }
  }

  cacheState = {
    loaded: true,
    eventsByDate: new Map(),
    allEvents: [],
    summarySnapshot: null,
    loadedFiles,
  };
  rebuildCacheFromLoadedFiles();

  return cacheState;
}

async function loadNewEventFiles() {
  if (!cacheState.loaded) {
    return ensureCacheLoaded();
  }

  let changed = false;
  const currentFilePaths = new Set();
  for (const reportingRoot of getReadableReportingRoots()) {
    const eventsDir = path.join(reportingRoot, EVENTS_DIRNAME);
    let files;
    try {
      files = await collectJsonFiles(eventsDir);
    } catch (_err) {
      continue;
    }
    for (const fullPath of files) {
      currentFilePaths.add(fullPath);
      try {
        const existing = cacheState.loadedFiles.get(fullPath);
        const stats = await fsPromises.stat(fullPath);
        const mtimeMs = Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : 0;
        const size = Number.isFinite(stats.size) ? stats.size : 0;

        if (existing && existing.mtimeMs === mtimeMs && existing.size === size) {
          continue;
        }

        const snapshot = await loadEventsFileSnapshot(fullPath);
        cacheState.loadedFiles.set(fullPath, snapshot);
        changed = true;
      } catch (error) {
        console.warn("[CostReporting] Failed to reload reporting file:", fullPath, error.message);
      }
    }
  }

  for (const loadedPath of Array.from(cacheState.loadedFiles.keys())) {
    if (currentFilePaths.has(loadedPath)) {
      continue;
    }
    cacheState.loadedFiles.delete(loadedPath);
    changed = true;
  }

  if (changed) {
    rebuildCacheFromLoadedFiles();
  }

  return cacheState;
}

function rebuildEventsByDate(events) {
  const nextEventsByDate = new Map();
  for (const event of sortEvents(events)) {
    if (!nextEventsByDate.has(event.dateKey)) {
      nextEventsByDate.set(event.dateKey, []);
    }
    nextEventsByDate.get(event.dateKey).push(event);
  }
  return nextEventsByDate;
}

function summarizeEvents(events, options = {}) {
  const sorted = events;
  const totalCost = sorted.reduce((sum, event) => sum + event.cost, 0);
  const reportedCost = sorted.reduce((sum, event) => sum + (event.reportedCost || 0), 0);
  const estimatedCostWithoutCache = sorted.reduce(
    (sum, event) => sum + (event.estimatedCostWithoutCache || event.cost || 0),
    0,
  );
  const netCacheSavings = sorted.reduce((sum, event) => sum + (event.netCacheSavings || 0), 0);
  const promptTokens = sorted.reduce((sum, event) => sum + event.promptTokens, 0);
  const completionTokens = sorted.reduce((sum, event) => sum + event.completionTokens, 0);
  const totalTokens = sorted.reduce((sum, event) => sum + event.totalTokens, 0);
  const cachedTokens = sorted.reduce((sum, event) => sum + event.cachedTokens, 0);
  const cacheReadTokens = sorted.reduce((sum, event) => sum + (event.cacheReadTokens || 0), 0);
  const cacheWriteTokens = sorted.reduce((sum, event) => sum + (event.cacheWriteTokens || 0), 0);
  const responses = sorted.length;
  const modelCount = new Set(sorted.map((event) => event.modelId)).size;

  let coveredDays = 0;
  if (Number.isFinite(Number(options.coveredDaysOverride))) {
    coveredDays = Math.max(1, Math.floor(Number(options.coveredDaysOverride)));
  } else if (options.startDate && options.endDate) {
    coveredDays = daysBetweenInclusive(options.startDate, options.endDate);
  } else if (sorted.length > 0) {
    const first = new Date(sorted[0].timestamp);
    const last = new Date(sorted[sorted.length - 1].timestamp);
    coveredDays = daysBetweenInclusive(first, last);
  }

  const uniqueWeeks = new Set(sorted.map((event) => event.weekKey));

  return {
    totalCost,
    reportedCost,
    estimatedCostWithoutCache,
    netCacheSavings,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheReadTokens,
    cacheWriteTokens,
    responses,
    modelCount,
    coveredDays,
    coveredWeeks: uniqueWeeks.size,
    savingsRate: estimatedCostWithoutCache > 0 ? netCacheSavings / estimatedCostWithoutCache : 0,
    averageCostPerResponse: responses > 0 ? totalCost / responses : 0,
    averageCostPerDay: coveredDays > 0 ? totalCost / coveredDays : 0,
    averageCostPerWeek: uniqueWeeks.size > 0 ? totalCost / uniqueWeeks.size : 0,
    averageSavingsPerResponse: responses > 0 ? netCacheSavings / responses : 0,
    averageSavingsPerDay: coveredDays > 0 ? netCacheSavings / coveredDays : 0,
    averageTokensPerResponse: responses > 0 ? totalTokens / responses : 0,
  };
}

function summarizeTurnEvents(events) {
  const sorted = sortEvents(events);
  const promptTokens = sorted.reduce(
    (maxPromptTokens, event) => Math.max(maxPromptTokens, toInteger(event?.promptTokens)),
    0,
  );

  // Context occupancy: the LATEST round-trip's bridge-reported estimate.
  // Billed promptTokens cannot stand in for occupancy on pro-mode reasoning
  // models (they aggregate hidden internal passes), and a max-reduce would
  // latch a turn's transient peak. Fall back to the legacy max only for
  // events that predate the estimate field.
  let contextTokens = 0;
  for (const event of sorted) {
    const estimate = toInteger(event?.contextTokensEstimate);
    if (estimate > 0) {
      contextTokens = estimate;
    }
  }
  if (contextTokens <= 0) {
    contextTokens = promptTokens;
  } else if (promptTokens > 0 && contextTokens > promptTokens) {
    // Occupancy can never exceed the turn's peak billed prompt. Events
    // written before the bridge priced base64 payloads correctly carry
    // chars/4-inflated estimates (one screenshot ≈ +286k tokens); clamping
    // at read time corrects already-persisted history without rewriting
    // the events store.
    contextTokens = promptTokens;
  }

  return {
    promptTokens,
    contextTokens,
    requestCount: sorted.length,
  };
}

function buildDailySeries(events, rangeStart, rangeEnd) {
  if (!rangeStart || !rangeEnd) {
    return [];
  }

  const buckets = new Map();
  for (
    let cursor = startOfDay(rangeStart);
    cursor.getTime() <= startOfDay(rangeEnd).getTime();
    cursor = addDays(cursor, 1)
  ) {
    const key = formatDateKey(cursor);
    buckets.set(key, {
      date: key,
      label: getDateLabel(key),
      cost: 0,
      estimatedCostWithoutCache: 0,
      netCacheSavings: 0,
      responses: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }

  for (const event of events) {
    const bucket = buckets.get(event.dateKey);
    if (!bucket) continue;
    bucket.cost += event.cost;
    bucket.estimatedCostWithoutCache += event.estimatedCostWithoutCache || event.cost;
    bucket.netCacheSavings += event.netCacheSavings || 0;
    bucket.responses += 1;
    bucket.promptTokens += event.promptTokens;
    bucket.completionTokens += event.completionTokens;
    bucket.totalTokens += event.totalTokens;
    bucket.cachedTokens += event.cachedTokens;
    bucket.cacheReadTokens += event.cacheReadTokens || 0;
    bucket.cacheWriteTokens += event.cacheWriteTokens || 0;
  }

  return Array.from(buckets.values());
}

function buildHourlySeries(events, rangeStartAt, rangeEndAt) {
  if (!rangeStartAt || !rangeEndAt) {
    return [];
  }

  const buckets = new Map();
  for (
    let cursor = startOfHour(rangeStartAt);
    cursor.getTime() <= startOfHour(rangeEndAt).getTime();
    cursor = addHours(cursor, 1)
  ) {
    const key = getHourKey(cursor);
    buckets.set(key, {
      date: key,
      label: getHourLabel(key),
      tooltipLabel: getHourTooltipLabel(key),
      cost: 0,
      estimatedCostWithoutCache: 0,
      netCacheSavings: 0,
      responses: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }

  for (const event of events) {
    const bucket = buckets.get(getHourKey(new Date(event.timestamp)));
    if (!bucket) continue;
    bucket.cost += event.cost;
    bucket.estimatedCostWithoutCache += event.estimatedCostWithoutCache || event.cost;
    bucket.netCacheSavings += event.netCacheSavings || 0;
    bucket.responses += 1;
    bucket.promptTokens += event.promptTokens;
    bucket.completionTokens += event.completionTokens;
    bucket.totalTokens += event.totalTokens;
    bucket.cachedTokens += event.cachedTokens;
    bucket.cacheReadTokens += event.cacheReadTokens || 0;
    bucket.cacheWriteTokens += event.cacheWriteTokens || 0;
  }

  return Array.from(buckets.values());
}

function getChatTimeLabel(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function getChatTimeTooltipLabel(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function buildChatSeries(events) {
  const chatMap = new Map();
  const chatModels = new Map();

  for (const event of events) {
    const key = event.chatId || event.eventId;
    const existing = chatMap.get(key);
    if (!existing) {
      const ts = new Date(event.timestamp).getTime();
      chatMap.set(key, {
        date: key,
        chatId: key,
        label: getChatTimeLabel(ts),
        tooltipLabel: getChatTimeTooltipLabel(ts),
        cost: event.cost,
        estimatedCostWithoutCache: event.estimatedCostWithoutCache || event.cost,
        netCacheSavings: event.netCacheSavings || 0,
        responses: 1,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        cachedTokens: event.cachedTokens,
        cacheReadTokens: event.cacheReadTokens || 0,
        cacheWriteTokens: event.cacheWriteTokens || 0,
        firstTimestamp: new Date(event.timestamp).getTime(),
      });
      chatModels.set(key, new Set([event.modelName || event.modelId || ""]));
    } else {
      existing.cost += event.cost;
      existing.estimatedCostWithoutCache += event.estimatedCostWithoutCache || event.cost;
      existing.netCacheSavings += event.netCacheSavings || 0;
      existing.responses += 1;
      existing.promptTokens += event.promptTokens;
      existing.completionTokens += event.completionTokens;
      existing.totalTokens += event.totalTokens;
      existing.cachedTokens += event.cachedTokens;
      existing.cacheReadTokens += event.cacheReadTokens || 0;
      existing.cacheWriteTokens += event.cacheWriteTokens || 0;
      const modelSet = chatModels.get(key);
      const modelLabel = event.modelName || event.modelId || "";
      if (modelLabel) modelSet.add(modelLabel);
    }
  }

  const result = Array.from(chatMap.values());
  for (const entry of result) {
    const models = chatModels.get(entry.date);
    entry.modelName = models ? Array.from(models).filter(Boolean).join(", ") : "";
  }

  return result.sort((a, b) => a.firstTimestamp - b.firstTimestamp);
}

function buildTrendSeries(events, range, options = {}) {
  if (options.pivot === "chat") {
    return buildChatSeries(events);
  }

  if (range?.seriesGranularity === "hour") {
    return buildHourlySeries(events, range.startAt, range.endAt);
  }

  return buildDailySeries(events, range?.startDate, range?.endDate);
}

function normalizeModelFilterValue(value) {
  const normalized = String(value || "all").trim();
  return normalized || "all";
}

function getEventModelFamily(event) {
  const modelLookup = `${event?.modelName || ""} ${event?.modelId || ""}`.toLowerCase();
  if (modelLookup.includes("atlas")) {
    return "atlas";
  }
  if (modelLookup.includes("gpt")) {
    return "gpt";
  }
  if (modelLookup.includes("gemini") || modelLookup.includes("google")) {
    return "gemini";
  }
  return null;
}

function eventMatchesModelFilter(event, modelFilter) {
  if (!modelFilter || modelFilter === "all") {
    return true;
  }

  if (modelFilter === "group:atlas") {
    return getEventModelFamily(event) === "atlas";
  }

  if (modelFilter === "group:gpt") {
    return getEventModelFamily(event) === "gpt";
  }

  if (modelFilter === "group:gemini") {
    return getEventModelFamily(event) === "gemini";
  }

  return event.modelId === modelFilter;
}

function compareModelItemsAlphabetically(left, right) {
  const leftLabel = String(left.modelName || left.modelId || "");
  const rightLabel = String(right.modelName || right.modelId || "");
  const byName = leftLabel.localeCompare(rightLabel, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (byName !== 0) {
    return byName;
  }

  return String(left.modelId || "").localeCompare(String(right.modelId || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sortModelItemsAlphabetically(items) {
  return [...items].sort(compareModelItemsAlphabetically);
}

function buildModelBreakdown(events) {
  const models = new Map();

  for (const event of events) {
    const current =
      models.get(event.modelId) || {
        modelId: event.modelId,
        modelName: event.modelName,
        totalCost: 0,
        estimatedCostWithoutCache: 0,
        netCacheSavings: 0,
        responses: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };

    current.totalCost += event.cost;
    current.estimatedCostWithoutCache += event.estimatedCostWithoutCache || event.cost;
    current.netCacheSavings += event.netCacheSavings || 0;
    current.responses += 1;
    current.promptTokens += event.promptTokens;
    current.completionTokens += event.completionTokens;
    current.totalTokens += event.totalTokens;
    current.cachedTokens += event.cachedTokens;
    current.cacheReadTokens += event.cacheReadTokens || 0;
    current.cacheWriteTokens += event.cacheWriteTokens || 0;
    current.modelName = event.modelName || current.modelName;

    models.set(event.modelId, current);
  }

  const totalCost = Array.from(models.values()).reduce((sum, item) => sum + item.totalCost, 0);

  return Array.from(models.values())
    .map((item) => ({
      ...item,
      averageCostPerResponse: item.responses > 0 ? item.totalCost / item.responses : 0,
      averageSavingsPerResponse: item.responses > 0 ? item.netCacheSavings / item.responses : 0,
      savingsRate:
        item.estimatedCostWithoutCache > 0
          ? item.netCacheSavings / item.estimatedCostWithoutCache
          : 0,
      shareOfCost: totalCost > 0 ? item.totalCost / totalCost : 0,
    }))
    .sort(compareModelItemsAlphabetically);
}

function buildAvailableModels(events) {
  return buildModelBreakdown(events).map((item) => ({
    modelId: item.modelId,
    modelName: item.modelName,
    totalCost: item.totalCost,
    estimatedCostWithoutCache: item.estimatedCostWithoutCache,
    netCacheSavings: item.netCacheSavings,
    responses: item.responses,
  }));
}

function resolveRange(options, events) {
  const now = new Date();
  const mode = String(options?.range || "1d").toLowerCase();
  const firstEventDate = events.length > 0 ? new Date(events[0].timestamp) : now;
  const lastEventDate = events.length > 0 ? new Date(events[events.length - 1].timestamp) : now;

  if (mode === "1h") {
    const endAt = new Date(now);
    const startAt = startOfHour(addHours(endAt, -1));
    return {
      range: mode,
      startDate: startOfDay(startAt),
      endDate: startOfDay(endAt),
      startAt,
      endAt,
      label: "Last 1 Hour",
      coveredDays: 1,
      seriesGranularity: "hour",
    };
  }

  if (mode === "4h") {
    const endAt = new Date(now);
    const startAt = startOfHour(addHours(endAt, -4));
    return {
      range: mode,
      startDate: startOfDay(startAt),
      endDate: startOfDay(endAt),
      startAt,
      endAt,
      label: "Last 4 Hours",
      coveredDays: 1,
      seriesGranularity: "hour",
    };
  }

  if (mode === "1d") {
    const endAt = new Date(now);
    const startAt = startOfHour(addHours(endAt, -23));
    return {
      range: mode,
      startDate: startOfDay(startAt),
      endDate: startOfDay(endAt),
      startAt,
      endAt,
      label: "Last 24 Hours",
      coveredDays: 1,
      seriesGranularity: "hour",
    };
  }

  if (mode === "today") {
    const today = startOfDay(now);
    return {
      range: mode,
      startDate: today,
      endDate: today,
      startAt: today,
      endAt: addDays(today, 1),
      label: "Today",
      coveredDays: 1,
      seriesGranularity: "day",
    };
  }

  if (mode === "custom") {
    const startDate = parseDateKey(options?.startDate);
    const endDate = parseDateKey(options?.endDate);
    if (startDate && endDate && startDate.getTime() <= endDate.getTime()) {
      return {
        range: mode,
        startDate,
        endDate,
        startAt: startOfDay(startDate),
        endAt: addDays(startOfDay(endDate), 1),
        label: `${formatDateKey(startDate)} to ${formatDateKey(endDate)}`,
        coveredDays: daysBetweenInclusive(startDate, endDate),
        seriesGranularity: "day",
      };
    }
  }

  if (mode === "7d" || mode === "30d" || mode === "90d") {
    const days = Number(mode.replace("d", ""));
    const endDate = startOfDay(now);
    const startDate = addDays(endDate, -(days - 1));
    return {
      range: mode,
      startDate,
      endDate,
      startAt: startOfDay(startDate),
      endAt: addDays(endDate, 1),
      label: `Last ${days} Days`,
      coveredDays: days,
      seriesGranularity: "day",
    };
  }

  const startDate = startOfDay(firstEventDate);
  const endDate = startOfDay(lastEventDate);
  return {
    range: "all",
    startDate,
    endDate,
    startAt: startDate,
    endAt: addDays(endDate, 1),
    label: "All Time",
    coveredDays: daysBetweenInclusive(startDate, endDate),
    seriesGranularity: "day",
  };
}

function filterEvents(events, options = {}) {
  const range =
    options?.startAt instanceof Date && options?.endAt instanceof Date
      ? options
      : resolveRange(options, events);
  const startMs = range.startAt.getTime();
  const endMs = range.endAt.getTime();
  const selectedModelFilter = normalizeModelFilterValue(options?.modelId);

  return events.filter((event) => {
    const eventMs = new Date(event.timestamp).getTime();
    if (eventMs < startMs || eventMs >= endMs) {
      return false;
    }
    if (!eventMatchesModelFilter(event, selectedModelFilter)) {
      return false;
    }
    return true;
  });
}

function buildOverview(events) {
  const now = new Date();
  const today = startOfDay(now);
  const weekStart = getStartOfWeek(now);
  const monthStart = getStartOfMonth(now);
  const last7Start = addDays(today, -6);
  const last30Start = addDays(today, -29);

  const allTimeSummary = summarizeEvents(events);

  return {
    allTime: allTimeSummary,
    today: summarizeEvents(filterEvents(events, { range: "custom", startDate: formatDateKey(today), endDate: formatDateKey(today) }), {
      startDate: today,
      endDate: today,
    }),
    currentWeek: summarizeEvents(
      filterEvents(events, {
        range: "custom",
        startDate: formatDateKey(weekStart),
        endDate: formatDateKey(today),
      }),
      { startDate: weekStart, endDate: today },
    ),
    currentMonth: summarizeEvents(
      filterEvents(events, {
        range: "custom",
        startDate: formatDateKey(monthStart),
        endDate: formatDateKey(today),
      }),
      { startDate: monthStart, endDate: today },
    ),
    last7Days: summarizeEvents(
      filterEvents(events, {
        range: "custom",
        startDate: formatDateKey(last7Start),
        endDate: formatDateKey(today),
      }),
      { startDate: last7Start, endDate: today },
    ),
    last30Days: summarizeEvents(
      filterEvents(events, {
        range: "custom",
        startDate: formatDateKey(last30Start),
        endDate: formatDateKey(today),
      }),
      { startDate: last30Start, endDate: today },
    ),
    averages: {
      dailyAllTime: allTimeSummary.averageCostPerDay,
      weeklyAllTime: allTimeSummary.averageCostPerWeek,
      savingsDailyAllTime: allTimeSummary.averageSavingsPerDay,
    },
  };
}

function buildDashboardData(events, options = {}) {
  const range = resolveRange(options, events);
  const selectedModelFilter = normalizeModelFilterValue(options?.modelId);
  const scopedEvents =
    selectedModelFilter === "all"
      ? events
      : events.filter((event) => eventMatchesModelFilter(event, selectedModelFilter));
  const filteredEvents = filterEvents(events, options);

  const filteredSummary = summarizeEvents(filteredEvents, {
    startDate: range.startDate,
    endDate: range.endDate,
    coveredDaysOverride: range.coveredDays,
  });

  return {
    version: REPORTING_VERSION,
    generatedAt: new Date().toISOString(),
    reportingPath: getReportingRoot(),
    filters: {
      range: range.range,
      label: range.label,
      startDate: formatDateKey(range.startDate),
      endDate: formatDateKey(range.endDate),
      modelId: selectedModelFilter,
      granularity: range.seriesGranularity,
      pivot: options.pivot || "time",
    },
    overview: null,
    scopedOverview: null,
    filtered: {
      summary: filteredSummary,
      series: {
        trend: buildTrendSeries(filteredEvents, range, { pivot: options.pivot }),
        granularity: range.seriesGranularity,
      },
      models: buildModelBreakdown(filteredEvents),
      eventCount: filteredEvents.length,
    },
    availableModels: buildAvailableModels(events),
  };
}

async function persistDayEvents(dateKey, events) {
  const filePath = path.join(getEventsDir(), `${dateKey}.json`);
  await atomicWriteJson(filePath, {
    version: REPORTING_VERSION,
    date: dateKey,
    updatedAt: new Date().toISOString(),
    eventCount: events.length,
    events,
  });
}

async function persistSummarySnapshot() {
  const snapshot = buildDashboardData(cacheState.allEvents, { range: "all" });
  cacheState.summarySnapshot = snapshot;
  await atomicWriteJson(getDashboardSnapshotPath(), snapshot);
}

async function persistEventsByDate(eventsByDate, previousDayKeys = []) {
  await ensureReportingDirs();

  const nextDayKeys = new Set(eventsByDate.keys());
  for (const dayKey of nextDayKeys) {
    await persistDayEvents(dayKey, eventsByDate.get(dayKey) || []);
  }

  for (const dayKey of previousDayKeys) {
    if (!nextDayKeys.has(dayKey)) {
      await fsPromises
        .unlink(path.join(getEventsDir(), `${dayKey}.json`))
        .catch(() => undefined);
    }
  }
}

async function readChatsFromDb({ chatDbPath, sinceHours = 48 }) {
  const resolvedChatDbPath =
    chatDbPath || process.env.PORTICO_COST_DB_PATH || getDefaultChatDbPath();

  if (!fs.existsSync(resolvedChatDbPath)) {
    return {
      success: true,
      skipped: true,
      reason: `Chat DB not found at ${resolvedChatDbPath}`,
      chatDbPath: resolvedChatDbPath,
      rows: [],
    };
  }

  const cutoffSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) - Math.max(1, Math.floor(toFiniteNumber(sinceHours, 48))) * 3600,
  );
  const sql = [
    "SELECT",
    "  c.id AS chat_id,",
    "  json_extract(m.value, '$.id') AS message_id,",
    "  json_extract(m.value, '$.timestamp') AS message_timestamp,",
    "  json_extract(m.value, '$.selectedModelId') AS selected_model_id,",
    "  json_extract(m.value, '$.model') AS model_id,",
    "  json_extract(m.value, '$.modelName') AS model_name,",
    "  json_extract(m.value, '$.usage.prompt_tokens') AS prompt_tokens,",
    "  json_extract(m.value, '$.usage.input_tokens') AS input_tokens,",
    "  json_extract(m.value, '$.usage.inputTokens') AS input_tokens_camel,",
    "  json_extract(m.value, '$.usage.completion_tokens') AS completion_tokens,",
    "  json_extract(m.value, '$.usage.output_tokens') AS output_tokens,",
    "  json_extract(m.value, '$.usage.outputTokens') AS output_tokens_camel,",
    "  json_extract(m.value, '$.usage.total_tokens') AS total_tokens,",
    "  json_extract(m.value, '$.usage.totalTokens') AS total_tokens_camel,",
    "  json_extract(m.value, '$.usage.cached_tokens') AS cached_tokens,",
    "  json_extract(m.value, '$.usage.cachedContentTokenCount') AS cached_content_token_count,",
    "  json_extract(m.value, '$.usage.cache_read_input_tokens') AS cache_read_input_tokens,",
    "  json_extract(m.value, '$.usage.cache_creation_input_tokens') AS cache_creation_input_tokens,",
    "  json_extract(m.value, '$.usage.cache_write_input_tokens') AS cache_write_input_tokens,",
    "  json_extract(m.value, '$.usage.cost') AS cost",
    "FROM chat c, json_each(c.chat, '$.history.messages') m",
    `WHERE c.updated_at >= ${cutoffSeconds}`,
    "  AND json_extract(m.value, '$.role') = 'assistant'",
    "  AND json_type(m.value, '$.usage') = 'object'",
    "ORDER BY c.updated_at ASC",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-json", resolvedChatDbPath, sql],
      { maxBuffer: 1024 * 1024 * 512 },
    );
    return {
      success: true,
      chatDbPath: resolvedChatDbPath,
      rows: JSON.parse(stdout || "[]"),
    };
  } catch (error) {
    return {
      success: false,
      chatDbPath: resolvedChatDbPath,
      error: error?.message || String(error),
      rows: [],
    };
  }
}

async function backfillPromptCostsFromChatDb(options = {}) {
  const sinceHours = Math.max(1, Math.floor(toFiniteNumber(options?.sinceHours, 48)));
  const force = options?.force === true;
  if (!force && cacheState.lastChatDbBackfillAt > 0) {
    const elapsed = Date.now() - cacheState.lastChatDbBackfillAt;
    if (elapsed < CHAT_DB_BACKFILL_THROTTLE_MS) {
      return {
        success: true,
        skipped: true,
        reason: "recent-backfill",
        lastBackfillAt: cacheState.lastChatDbBackfillAt,
      };
    }
  }

  return enqueueWrite(async () => {
    await ensureCacheLoaded(true);

    const queryResult = await readChatsFromDb({
      chatDbPath: options?.chatDbPath,
      sinceHours,
    });

    if (!queryResult.success) {
      throw new Error(
        `Failed to read chat usage from ${queryResult.chatDbPath}: ${queryResult.error}`,
      );
    }

    if (queryResult.skipped) {
      cacheState.lastChatDbBackfillAt = Date.now();
      return queryResult;
    }

    const currentEvents = new Map(
      cacheState.allEvents.map((event) => [event.eventId, event]),
    );
    const existingBridgeTurnIds = new Set(
      cacheState.allEvents
        .filter((event) => event?.source === "bifrost-bridge" && event?.turnId)
        .map((event) => event.turnId),
    );
    const previousDayKeys = Array.from(cacheState.eventsByDate.keys());
    let candidateEvents = 0;
    let inserted = 0;
      let updated = 0;
    let skipped = 0;

    for (const row of queryResult.rows) {
      const payload = {
        eventId: `${String(row?.chat_id || "").trim()}:${String(row?.message_id || "").trim()}`,
        chatId: row?.chat_id,
        messageId: row?.message_id,
        modelId: row?.selected_model_id || row?.model_id || row?.model_name || "unknown",
        modelName: row?.model_name || row?.selected_model_id || row?.model_id || "unknown",
        completedAt: toMillisecondsTimestamp(row?.message_timestamp),
        promptTokens: row?.prompt_tokens ?? row?.input_tokens ?? row?.input_tokens_camel,
        completionTokens:
          row?.completion_tokens ?? row?.output_tokens ?? row?.output_tokens_camel,
        totalTokens: row?.total_tokens ?? row?.total_tokens_camel,
        cachedTokens:
          row?.cached_tokens ??
          row?.cached_content_token_count ??
          row?.cache_read_input_tokens,
        cacheReadInputTokens: row?.cache_read_input_tokens,
        cacheCreationInputTokens: row?.cache_creation_input_tokens,
        cacheWriteInputTokens: row?.cache_write_input_tokens,
        cost: row?.cost,
      };

      candidateEvents += 1;
      const normalized = normalizeEvent(payload);
      if (!isMeaningfulEvent(normalized)) {
        continue;
      }
      if (existingBridgeTurnIds.has(normalized.turnId)) {
        skipped += 1;
        continue;
      }

      const existing = currentEvents.get(normalized.eventId);
      if (existing) {
        const merged = mergeEvents(existing, normalized);
        if (JSON.stringify(existing) !== JSON.stringify(merged)) {
          updated += 1;
        }
        currentEvents.set(normalized.eventId, merged);
      } else {
        inserted += 1;
        currentEvents.set(normalized.eventId, normalized);
      }
    }

    cacheState.allEvents = sortEvents(Array.from(currentEvents.values()));
    cacheState.eventsByDate = rebuildEventsByDate(cacheState.allEvents);
    cacheState.summarySnapshot = null;
    cacheState.lastChatDbBackfillAt = Date.now();

    await persistEventsByDate(cacheState.eventsByDate, previousDayKeys);
    await persistSummarySnapshot();

    return {
      success: true,
      reportingPath: getReportingRoot(),
      chatDbPath: queryResult.chatDbPath,
      chatRows: queryResult.rows.length,
      candidateEvents,
      inserted,
      updated,
      skipped,
      totalEvents: cacheState.allEvents.length,
    };
  });
}

function enqueueWrite(task) {
  const result = writeQueue.then(task);
  writeQueue = result.catch(() => undefined);
  return result;
}

async function recordPromptCost(input) {
  return enqueueWrite(async () => {
    await ensureCacheLoaded();

    const event = normalizeEvent(input);
    if (!isMeaningfulEvent(event)) {
      return {
        success: true,
        ignored: true,
        reason: "Event does not contain cost or usage data",
      };
    }

    const dayKeys = Array.from(cacheState.eventsByDate.keys());
    for (const dayKey of dayKeys) {
      if (dayKey === event.dateKey) {
        continue;
      }

      const dayEvents = cacheState.eventsByDate.get(dayKey) || [];
      const filteredDayEvents = dayEvents.filter((item) => item.eventId !== event.eventId);
      if (filteredDayEvents.length !== dayEvents.length) {
        if (filteredDayEvents.length > 0) {
          cacheState.eventsByDate.set(dayKey, filteredDayEvents);
          await persistDayEvents(dayKey, filteredDayEvents);
        } else {
          cacheState.eventsByDate.delete(dayKey);
          await fsPromises.unlink(path.join(getEventsDir(), `${dayKey}.json`)).catch(() => undefined);
        }
      }
    }

    const existingDayEvents = cacheState.eventsByDate.get(event.dateKey) || [];
    const nextDayEvents = [...existingDayEvents];
    const existingIndex = nextDayEvents.findIndex((item) => item.eventId === event.eventId);

    if (existingIndex >= 0) {
      nextDayEvents[existingIndex] = mergeEvents(nextDayEvents[existingIndex], event);
    } else {
      nextDayEvents.push(event);
    }

    const sortedDayEvents = sortEvents(nextDayEvents);
    cacheState.eventsByDate.set(event.dateKey, sortedDayEvents);
    rebuildAllEvents();

    await persistDayEvents(event.dateKey, sortedDayEvents);
    await persistSummarySnapshot();

    return {
      success: true,
      eventId: event.eventId,
      event,
      reportingPath: getReportingRoot(),
    };
  });
}

async function getDashboard(options = {}) {
  await writeQueue.catch(() => undefined);
  await loadNewEventFiles();

  return {
    success: true,
    data: buildDashboardData(cacheState.allEvents, options),
  };
}

async function getChatCostSummary(options = {}) {
  await writeQueue.catch(() => undefined);
  await loadNewEventFiles();

  const requestedChatIds = Array.isArray(options?.chatIds) ? options.chatIds : [];
  const chatIds = Array.from(
    new Set(
      requestedChatIds
        .map((chatId) => String(chatId || "").trim())
        .filter((chatId) => chatId.length > 0),
    ),
  );
  const chatIdSet = new Set(chatIds);
  const filteredEvents =
    chatIds.length > 0
      ? cacheState.allEvents.filter((event) => chatIdSet.has(String(event.chatId || "").trim()))
      : [];
  const summary = summarizeEvents(filteredEvents);

  return {
    success: true,
    data: {
      chatIds,
      eventCount: filteredEvents.length,
      generatedAt: new Date().toISOString(),
      reportingPath: getReportingRoot(),
      summary,
    },
  };
}

async function getChatTurnSummary(options = {}) {
  await writeQueue.catch(() => undefined);
  await loadNewEventFiles();

  const chatId = String(options?.chatId || "").trim();
  const messageId = String(options?.messageId || "").trim();
  const filteredEvents =
    chatId && messageId
      ? cacheState.allEvents.filter(
          (event) =>
            String(event.chatId || "").trim() === chatId &&
            String(event.messageId || "").trim() === messageId,
        )
      : [];

  return {
    success: true,
    data: {
      chatId,
      messageId,
      eventCount: filteredEvents.length,
      generatedAt: new Date().toISOString(),
      reportingPath: getReportingRoot(),
      summary: summarizeTurnEvents(filteredEvents),
    },
  };
}

function watchReportingEvents(onChange) {
  if (typeof onChange !== "function") {
    return () => {};
  }

  const watchers = [];
  const seenDirs = new Set();

  for (const reportingRoot of getReadableReportingRoots()) {
    const eventsDir = path.join(reportingRoot, EVENTS_DIRNAME);
    if (seenDirs.has(eventsDir)) {
      continue;
    }
    seenDirs.add(eventsDir);

    try {
      fs.mkdirSync(eventsDir, { recursive: true });
      const watcher = fs.watch(eventsDir, { persistent: false }, (eventType, filename) => {
        if (filename && !String(filename).endsWith(".json")) {
          return;
        }
        onChange({
          eventType,
          filename: filename ? String(filename) : "",
          directory: eventsDir,
        });
      });
      watcher.on("error", (error) => {
        console.warn("[CostReporting] Watcher error for", eventsDir, error.message);
      });
      watchers.push(watcher);
    } catch (error) {
      console.warn("[CostReporting] Failed to watch reporting events:", eventsDir, error.message);
    }
  }

  return () => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch (_error) {
        // Ignore watcher close failures.
      }
    }
  };
}

async function revealReportingFolder() {
  await ensureReportingDirs();
  return {
    success: true,
    path: getReportingRoot(),
  };
}

module.exports = {
  getReportingRoot,
  getDashboardSnapshotPath,
  recordPromptCost,
  backfillPromptCostsFromChatDb,
  getDashboard,
  getChatCostSummary,
  getChatTurnSummary,
  revealReportingFolder,
  watchReportingEvents,
};
