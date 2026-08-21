// address-space-telemetry.js - PORTICO-443
//
// The PORTICO-443 crash was an Electron main-process abort: V8's mark-compact
// collector tried to allocate a page during evacuation, the kernel answered
// ENOMEM, and V8 called FatalProcessOutOfMemory. What made it hard to see coming
// is that the process was NOT short of memory in the usual sense -- its malloc
// heap was 53.8 MB. It was short of MAPPINGS: 27,599 VM regions against ~1,900 in
// a healthy process of the same build on the same machine, and 15,969 regions
// under a single VM tag where a healthy process has 25.
//
// So RSS is the wrong thing to watch. A process can look perfectly healthy on an
// RSS graph while being one mmap away from a fatal abort. This module records the
// numbers that would actually have predicted it:
//
//   - cheap tier  (frequent): in-process JS/heap counters. Microseconds.
//   - costly tier (rare):     per-tag VM region counts via `vmmap --summary`,
//                             measured at ~560 ms on a healthy process and slower
//                             on a degenerate one, so it cannot be frequent.
//
// Everything recorded is numeric. Nothing here captures a path, a URL, a chat id
// or any free-form text, because this lands in user-submitted debug bundles.

// Region growth is the signal; these bound how closely we watch it.
const DEFAULT_FAST_INTERVAL_MS = 60_000;
const DEFAULT_SLOW_INTERVAL_MS = 10 * 60_000;
// Ring capacity. At the default cadences this is ~8h of fast samples and ~8h of
// slow ones -- long enough to cover the 5h47m session that produced PORTICO-443.
const DEFAULT_MAX_FAST_SAMPLES = 480;
const DEFAULT_MAX_SLOW_SAMPLES = 48;
// A healthy main process sat at ~1,900 regions; the crashed one reached 27,599.
// Three times the first observed reading is well clear of normal drift and well
// under the failure point, so the snapshot lands while the process is still alive.
const DEFAULT_REGION_GROWTH_FACTOR = 3;

/**
 * Parse the region table of a `vmmap --summary` report, or the `vmSummary` block
 * of a macOS .ips crash report -- the two share a shape: a region-type label,
 * some size columns, and a trailing region count.
 *
 * Returns numbers only. Any line carrying a path is dropped rather than
 * sanitized, so a parser change cannot start leaking one.
 *
 * @param {string} text
 * @returns {{ totalRegions: number|null, byTag: Array<{label: string, regions: number}> }}
 */
function parseVmRegionSummary(text) {
  const result = { totalRegions: null, byTag: [] };
  if (typeof text !== "string" || !text) {
    return result;
  }

  // Only the region table is parsed. Everything above the "REGION TYPE" header is
  // vmmap's preamble -- process name, parent, executable path, timestamps -- and
  // none of it belongs in a bundle. Dropping path-bearing lines alone was not a
  // strong enough boundary: a smoke run against a live process pulled
  // "Report Version:  7" through as if it were a region type, which showed the
  // preamble was reachable at all. A positional boundary closes the whole class
  // rather than the one line that happened to be noticed.
  let inRegionTable = !/^\s*REGION TYPE\b/m.test(text);

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!inRegionTable) {
      if (/^\s*REGION TYPE\b/.test(line)) {
        inRegionTable = true;
      }
      continue;
    }
    if (!line || line.includes("/") || line.includes("=")) {
      // Belt and braces: paths and separator rows never reach the output.
      continue;
    }
    if (/:$/.test(line.split(/\s{2,}/)[0].trim())) {
      // "Key:   value" shapes are preamble, not region types.
      continue;
    }
    // Label, then columns. The region count is the last bare integer on the line;
    // trailing prose ("see MALLOC ZONE table below") is ignored by construction.
    const match = line.match(/^(\S.*?)\s{2,}(.+)$/);
    if (!match) {
      continue;
    }
    const label = match[1].trim();
    const tokens = match[2].trim().split(/\s+/);
    let regions = null;
    for (const token of tokens) {
      if (/^\d+$/.test(token)) {
        regions = Number(token);
      }
    }
    if (regions === null || !Number.isFinite(regions)) {
      continue;
    }
    if (/^TOTAL\b/i.test(label)) {
      if (result.totalRegions === null) {
        result.totalRegions = regions;
      }
      continue;
    }
    if (/^(REGION TYPE|===)/i.test(label)) {
      continue;
    }
    result.byTag.push({ label, regions });
  }

  result.byTag.sort((a, b) => b.regions - a.regions);
  return result;
}

/**
 * In-process counters. Cheap enough to sample often, and together they answer the
 * question the PORTICO-443 bundle could not: is growth on the JS side or the native
 * side? A large heap points at JS; a small heap beside a large region count -- the
 * PORTICO-443 shape -- points at native reservations.
 *
 * @param {{ processRef?: NodeJS.Process, v8Ref?: any, now?: Function }} [deps]
 */
function sampleProcessMemory(deps = {}) {
  const processRef = deps.processRef || process;
  const v8Ref = deps.v8Ref || require("v8");
  const now = deps.now || Date.now;

  const sample = { t: now() };
  try {
    const mem = processRef.memoryUsage();
    sample.rss = mem.rss;
    sample.heapTotal = mem.heapTotal;
    sample.heapUsed = mem.heapUsed;
    sample.external = mem.external;
    sample.arrayBuffers = mem.arrayBuffers;
  } catch (_) {
    /* counters are best-effort; a sample with fewer fields still plots */
  }
  try {
    const heap = v8Ref.getHeapStatistics();
    sample.heapSizeLimit = heap.heap_size_limit;
    sample.totalHeapSize = heap.total_heap_size;
    sample.usedHeapSize = heap.used_heap_size;
    sample.mallocedMemory = heap.malloced_memory;
    sample.numberOfNativeContexts = heap.number_of_native_contexts;
    sample.numberOfDetachedContexts = heap.number_of_detached_contexts;
  } catch (_) {
    /* as above */
  }
  return sample;
}

function pushBounded(list, item, max) {
  list.push(item);
  while (list.length > max) {
    list.shift();
  }
  return list;
}

/**
 * Records both tiers into bounded ring buffers and captures one region-table
 * snapshot when region count crosses a growth threshold.
 *
 * Time and subprocess execution are injected so the whole policy is testable
 * without waiting on real clocks or spawning `vmmap`.
 *
 * @param {Object} options
 * @param {Function} [options.readRegionSummary] async () => string (raw vmmap text)
 * @param {Function} [options.sampleMemory]      () => object
 * @param {Function} [options.schedule]          setInterval-alike
 * @param {Function} [options.cancelSchedule]    clearInterval-alike
 */
function createAddressSpaceMonitor(options = {}) {
  const {
    readRegionSummary = null,
    sampleMemory = sampleProcessMemory,
    schedule = setInterval,
    cancelSchedule = clearInterval,
    fastIntervalMs = DEFAULT_FAST_INTERVAL_MS,
    slowIntervalMs = DEFAULT_SLOW_INTERVAL_MS,
    maxFastSamples = DEFAULT_MAX_FAST_SAMPLES,
    maxSlowSamples = DEFAULT_MAX_SLOW_SAMPLES,
    regionGrowthFactor = DEFAULT_REGION_GROWTH_FACTOR,
    now = Date.now,
    onError = null,
  } = options;

  const state = {
    startedAt: null,
    fast: [],
    slow: [],
    baselineRegions: null,
    peakRegions: null,
    growthSnapshot: null,
    timers: [],
  };

  const reportError = (error) => {
    if (typeof onError === "function") {
      onError(error);
    }
  };

  const collectFast = () => {
    try {
      pushBounded(state.fast, sampleMemory(), maxFastSamples);
    } catch (error) {
      reportError(error);
    }
  };

  const collectSlow = async () => {
    if (typeof readRegionSummary !== "function") {
      return;
    }
    let parsed;
    try {
      parsed = parseVmRegionSummary(await readRegionSummary());
    } catch (error) {
      reportError(error);
      return;
    }
    const total = parsed.totalRegions;
    if (total === null) {
      return;
    }

    pushBounded(
      state.slow,
      { t: now(), totalRegions: total, byTag: parsed.byTag.slice(0, 12) },
      maxSlowSamples,
    );

    if (state.baselineRegions === null) {
      state.baselineRegions = total;
    }
    if (state.peakRegions === null || total > state.peakRegions) {
      state.peakRegions = total;
    }

    // One snapshot per session, taken the first time growth is unmistakable.
    // Capturing repeatedly would add cost exactly when the process is least
    // healthy, and the first crossing is the informative one.
    if (
      state.growthSnapshot === null &&
      state.baselineRegions > 0 &&
      total >= state.baselineRegions * regionGrowthFactor
    ) {
      state.growthSnapshot = {
        t: now(),
        baselineRegions: state.baselineRegions,
        totalRegions: total,
        byTag: parsed.byTag.slice(0, 25),
      };
    }
  };

  return {
    start() {
      if (state.startedAt !== null) {
        return;
      }
      state.startedAt = now();
      collectFast();
      void collectSlow();
      state.timers.push(schedule(collectFast, fastIntervalMs));
      state.timers.push(schedule(() => { void collectSlow(); }, slowIntervalMs));
    },
    stop() {
      state.timers.forEach((timer) => cancelSchedule(timer));
      state.timers = [];
      state.startedAt = null;
    },
    // Exposed for tests and for on-demand collection at bundle time.
    collectFast,
    collectSlow,
    snapshot() {
      return {
        startedAt: state.startedAt,
        fast: state.fast.slice(),
        slow: state.slow.slice(),
        baselineRegions: state.baselineRegions,
        peakRegions: state.peakRegions,
        growthSnapshot: state.growthSnapshot,
      };
    },
  };
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(value / (1024 * 1024))}MB`;
}

/**
 * Render a snapshot for the debug bundle. Numeric and tabular by design: a reader
 * should be able to see the curve, and the JS-versus-native split, at a glance.
 */
function formatAddressSpaceReport(snapshot) {
  if (!snapshot) {
    return "=== Address Space Telemetry ===\n(not collected)\n";
  }
  const lines = ["=== Address Space Telemetry (PORTICO-443) ==="];
  lines.push(
    `baselineRegions: ${snapshot.baselineRegions ?? "n/a"}  peakRegions: ${snapshot.peakRegions ?? "n/a"}`,
  );

  if (snapshot.growthSnapshot) {
    const g = snapshot.growthSnapshot;
    lines.push(
      `REGION GROWTH THRESHOLD CROSSED: ${g.baselineRegions} -> ${g.totalRegions} regions`,
    );
    lines.push("  top region types at crossing (label / regions):");
    g.byTag.forEach((tag) => {
      lines.push(`    ${tag.label} / ${tag.regions}`);
    });
  } else {
    lines.push("region growth threshold not crossed this session");
  }

  const fast = snapshot.fast || [];
  if (fast.length) {
    const first = fast[0];
    const last = fast[fast.length - 1];
    lines.push("", "memory counters (first -> last sample):");
    lines.push(
      `  rss        ${formatBytes(first.rss)} -> ${formatBytes(last.rss)}`,
    );
    lines.push(
      `  heapUsed   ${formatBytes(first.heapUsed)} -> ${formatBytes(last.heapUsed)}`,
    );
    lines.push(
      `  external   ${formatBytes(first.external)} -> ${formatBytes(last.external)}`,
    );
    lines.push(
      `  nativeCtx  ${first.numberOfNativeContexts ?? "n/a"} -> ${last.numberOfNativeContexts ?? "n/a"}`,
    );
    lines.push(
      `  detachedCtx ${first.numberOfDetachedContexts ?? "n/a"} -> ${last.numberOfDetachedContexts ?? "n/a"}`,
    );
    lines.push(`  samples: ${fast.length}`);
  }

  const slow = snapshot.slow || [];
  if (slow.length) {
    lines.push("", "region counts over time (t, totalRegions):");
    slow.forEach((entry) => {
      lines.push(`  ${entry.t} ${entry.totalRegions}`);
    });
    const latest = slow[slow.length - 1];
    lines.push("", "latest region breakdown (label / regions):");
    latest.byTag.forEach((tag) => {
      lines.push(`  ${tag.label} / ${tag.regions}`);
    });
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * A bounded reader for `vmmap --summary`.
 *
 * Measured at ~560 ms against a healthy main process and slower as the region
 * table grows -- which is precisely when we most want it and least want it to
 * hang. `runProcess` is injected (runManagedProcess in production) so the call
 * gets a real timeout and process-group termination rather than the ability to
 * wedge the collector, which is the failure PORTICO-373 was about.
 *
 * @param {{ pid?: number, runProcess: Function, timeoutMs?: number }} options
 * @returns {Function} async () => string
 */
function createVmmapRegionReader({ pid = process.pid, runProcess, timeoutMs = 20_000 } = {}) {
  if (typeof runProcess !== "function") {
    throw new TypeError("runProcess (function) is required");
  }
  return async () => {
    if (process.platform !== "darwin") {
      return "";
    }
    const result = await runProcess("vmmap", ["--summary", String(pid)], {
      timeoutMs,
      maxBufferBytes: 4 * 1024 * 1024,
    });
    return result?.stdout || "";
  };
}

module.exports = {
  DEFAULT_FAST_INTERVAL_MS,
  DEFAULT_SLOW_INTERVAL_MS,
  DEFAULT_REGION_GROWTH_FACTOR,
  parseVmRegionSummary,
  sampleProcessMemory,
  createAddressSpaceMonitor,
  createVmmapRegionReader,
  formatAddressSpaceReport,
};
