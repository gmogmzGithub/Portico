// PORTICO-443: behavioural coverage for address-space telemetry.
//
// The crash this guards was an Electron main-process abort: V8's mark-compact
// collector tried to allocate during page evacuation, the kernel answered ENOMEM,
// and V8 called FatalProcessOutOfMemory. The process was not short of memory in
// the usual sense -- its malloc heap was 53.8 MB. It was short of MAPPINGS:
// 27,599 VM regions against ~1,887 in a healthy process of the same build, with
// one VM tag going from 25 regions to 15,969.
//
// The numbers below are the real measured ones, so a regression that stops
// recording the growth signal fails against the case it exists for.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseVmRegionSummary,
  sampleProcessMemory,
  createAddressSpaceMonitor,
  createVmmapRegionReader,
  formatAddressSpaceReport,
} = require("./address-space-telemetry");

// Captured verbatim from `vmmap --summary` against a live Electron main process.
const LIVE_VMMAP = [
  "Process:         Portico [47746]",
  "Path:            /Users/USER/*/node",
  "Parent Process:  node [47674]",
  "Report Version:  7",
  "Analysis Tool:   /usr/bin/vmmap",
  "",
  "                                VIRTUAL   REGION",
  "REGION TYPE                        SIZE    COUNT (non-coalesced)",
  "===========                     =======  =======",
  "Memory Tag 255                   261.7M       0K       0K    4816K       0K       0K       0K       25 ",
  "MALLOC_SMALL                      12.0M       0K       0K    3104K       0K       0K       0K        3         see MALLOC ZONE table below",
  "__TEXT                           348.0M       0K       0K       0K       0K       0K       0K      348 ",
  "TOTAL                              1.5G   228.6M    1202K    10.7M       0K       0K       0K     1887 ",
].join("\n");

// Captured verbatim from the PORTICO-443 crash report's vmSummary block.
const CRASH_VMSUMMARY = [
  "                                VIRTUAL   REGION",
  "REGION TYPE                        SIZE    COUNT (non-coalesced)",
  "===========                     =======  =======",
  "Memory Tag 253                    32.0G     5348 ",
  "Memory Tag 255                     1.3T    15969 ",
  "__TEXT                             1.4G     1100 ",
  "TOTAL                              1.4T    27599 ",
].join("\n");

test("parses live vmmap output, and TOTAL is the total rather than a region type", () => {
  const parsed = parseVmRegionSummary(LIVE_VMMAP);
  assert.equal(parsed.totalRegions, 1887);
  assert.equal(
    parsed.byTag.some((t) => /^TOTAL/i.test(t.label)),
    false,
    "TOTAL must not appear as a region type",
  );
  const tag255 = parsed.byTag.find((t) => t.label === "Memory Tag 255");
  assert.equal(tag255.regions, 25, "healthy baseline for the tag that exploded");
});

test("parses the PORTICO-443 crash report and recovers the numbers that diagnose it", () => {
  const parsed = parseVmRegionSummary(CRASH_VMSUMMARY);
  assert.equal(parsed.totalRegions, 27599);
  assert.equal(parsed.byTag[0].label, "Memory Tag 255");
  assert.equal(parsed.byTag[0].regions, 15969);
  assert.equal(parsed.byTag[1].regions, 5348, "sorted by regions, descending");
});

test("trailing prose on a row does not corrupt its region count", () => {
  const parsed = parseVmRegionSummary(LIVE_VMMAP);
  const small = parsed.byTag.find((t) => t.label === "MALLOC_SMALL");
  assert.equal(small.regions, 3, "'see MALLOC ZONE table below' must be ignored");
});

test("nothing above the region table reaches the output", () => {
  // This lands in user-submitted debug bundles. The preamble carries the process
  // name, the parent process and the executable path.
  const serialized = JSON.stringify(parseVmRegionSummary(LIVE_VMMAP));
  [
    "/Users/",
    "Path:",
    "Report Version",
    "Analysis Tool",
    "Parent Process",
    "Portico",
    "47746",
  ].forEach((needle) => {
    assert.equal(
      serialized.includes(needle),
      false,
      `preamble content leaked into the parsed output: ${needle}`,
    );
  });
});

test("a path smuggled into the region table is still dropped", () => {
  const withPath = [
    "REGION TYPE                        SIZE    COUNT",
    "mapped file  /Users/zacdavies/secret.db       12.0M        4 ",
    "TOTAL                                          1.5G     1887 ",
  ].join("\n");
  const serialized = JSON.stringify(parseVmRegionSummary(withPath));
  assert.equal(serialized.includes("zacdavies"), false);
  assert.equal(serialized.includes("secret.db"), false);
});

test("garbage and empty input yield an empty result rather than throwing", () => {
  [undefined, null, "", "not a table at all", 42].forEach((value) => {
    const parsed = parseVmRegionSummary(value);
    assert.equal(parsed.totalRegions, null);
    assert.deepEqual(parsed.byTag, []);
  });
});

test("memory sampling records the fields that separate a JS leak from a native one", () => {
  const sample = sampleProcessMemory({
    now: () => 1000,
    processRef: {
      memoryUsage: () => ({
        rss: 40 * 1024 * 1024,
        heapTotal: 8 * 1024 * 1024,
        heapUsed: 4 * 1024 * 1024,
        external: 2 * 1024 * 1024,
        arrayBuffers: 1024,
      }),
    },
    v8Ref: {
      getHeapStatistics: () => ({
        heap_size_limit: 4096,
        total_heap_size: 8,
        used_heap_size: 4,
        malloced_memory: 16,
        number_of_native_contexts: 3,
        number_of_detached_contexts: 1,
      }),
    },
  });
  assert.equal(sample.t, 1000);
  assert.equal(sample.heapUsed, 4 * 1024 * 1024);
  assert.equal(sample.rss, 40 * 1024 * 1024);
  // The PORTICO-443 signature is a small heap beside a huge region count, so the heap
  // figure has to be present to make that call at all.
  assert.equal(sample.usedHeapSize, 4);
  assert.equal(sample.numberOfDetachedContexts, 1);
});

test("a throwing counter source still yields the other half of the sample", () => {
  const sample = sampleProcessMemory({
    now: () => 7,
    processRef: { memoryUsage: () => { throw new Error("nope"); } },
    v8Ref: { getHeapStatistics: () => ({ used_heap_size: 99 }) },
  });
  assert.equal(sample.t, 7);
  assert.equal(sample.rss, undefined);
  assert.equal(sample.usedHeapSize, 99);

  const other = sampleProcessMemory({
    now: () => 8,
    processRef: { memoryUsage: () => ({ rss: 5 }) },
    v8Ref: { getHeapStatistics: () => { throw new Error("nope"); } },
  });
  assert.equal(other.rss, 5);
  assert.equal(other.usedHeapSize, undefined);
});

function monitorWith(readings, overrides = {}) {
  const queue = [...readings];
  const errors = [];
  const monitor = createAddressSpaceMonitor({
    readRegionSummary: async () => {
      const next = queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next ?? "";
    },
    sampleMemory: () => ({ t: 1, rss: 1 }),
    schedule: () => 0,
    cancelSchedule: () => {},
    now: () => 100,
    onError: (e) => errors.push(e),
    ...overrides,
  });
  return { monitor, errors };
}

function summaryWith(total) {
  return [
    "REGION TYPE                        SIZE    COUNT",
    `Memory Tag 255                     1.3T    ${Math.floor(total / 2)} `,
    `TOTAL                              1.4T    ${total} `,
  ].join("\n");
}

test("baseline is the first reading and never moves; peak tracks the maximum", async () => {
  const { monitor } = monitorWith([
    summaryWith(1887),
    summaryWith(9000),
    summaryWith(4000),
  ]);
  await monitor.collectSlow();
  await monitor.collectSlow();
  await monitor.collectSlow();
  const snap = monitor.snapshot();
  assert.equal(snap.baselineRegions, 1887, "baseline pinned to the first reading");
  assert.equal(snap.peakRegions, 9000, "peak survives a later lower reading");
});

test("the real PORTICO-443 growth crosses the threshold and is captured once", async () => {
  const { monitor } = monitorWith([
    summaryWith(1887),   // healthy baseline, measured
    summaryWith(9000),   // crosses 3x
    summaryWith(27599),  // the actual crash figure, higher still
  ]);
  await monitor.collectSlow();
  await monitor.collectSlow();
  await monitor.collectSlow();
  const snap = monitor.snapshot();
  assert.ok(snap.growthSnapshot, "growth must be captured");
  assert.equal(snap.growthSnapshot.baselineRegions, 1887);
  assert.equal(
    snap.growthSnapshot.totalRegions,
    9000,
    "captured at the FIRST crossing, not overwritten by later readings",
  );
  assert.ok(
    snap.growthSnapshot.byTag.length > 0,
    "the crossing carries the per-tag breakdown that names the subsystem",
  );
});

test("growth under the factor produces no snapshot", async () => {
  const { monitor } = monitorWith([summaryWith(1000), summaryWith(2500)]);
  await monitor.collectSlow();
  await monitor.collectSlow();
  assert.equal(monitor.snapshot().growthSnapshot, null);
});

test("a failing region read is reported and leaves recorded state intact", async () => {
  const { monitor, errors } = monitorWith([
    summaryWith(1887),
    new Error("vmmap timed out"),
  ]);
  await monitor.collectSlow();
  await monitor.collectSlow();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /vmmap timed out/);
  const snap = monitor.snapshot();
  assert.equal(snap.slow.length, 1, "the failed read adds no entry");
  assert.equal(snap.baselineRegions, 1887, "and does not disturb the baseline");
});

test("a reading with no TOTAL row is ignored rather than recorded as zero", async () => {
  const { monitor } = monitorWith(["REGION TYPE  SIZE COUNT\nMemory Tag 255  1.3T  25 "]);
  await monitor.collectSlow();
  const snap = monitor.snapshot();
  assert.equal(snap.slow.length, 0);
  assert.equal(snap.baselineRegions, null);
});

test("ring buffers are bounded and drop the oldest entries", async () => {
  const { monitor } = monitorWith(
    [summaryWith(10), summaryWith(20), summaryWith(30)],
    { maxSlowSamples: 2, maxFastSamples: 2 },
  );
  await monitor.collectSlow();
  await monitor.collectSlow();
  await monitor.collectSlow();
  monitor.collectFast();
  monitor.collectFast();
  monitor.collectFast();
  const snap = monitor.snapshot();
  assert.equal(snap.slow.length, 2);
  assert.deepEqual(
    snap.slow.map((s) => s.totalRegions),
    [20, 30],
    "oldest dropped, newest kept",
  );
  assert.equal(snap.fast.length, 2);
});

test("collectSlow is a no-op when no region reader was supplied", async () => {
  const monitor = createAddressSpaceMonitor({
    sampleMemory: () => ({ t: 1 }),
    schedule: () => 0,
    cancelSchedule: () => {},
  });
  await monitor.collectSlow();
  assert.deepEqual(monitor.snapshot().slow, []);
});

test("start is idempotent and stop cancels every timer it created", () => {
  const scheduled = [];
  const cancelled = [];
  let id = 0;
  const monitor = createAddressSpaceMonitor({
    sampleMemory: () => ({ t: 1 }),
    schedule: () => { id += 1; scheduled.push(id); return id; },
    cancelSchedule: (t) => cancelled.push(t),
  });
  monitor.start();
  monitor.start();
  assert.equal(scheduled.length, 2, "one fast timer and one slow timer, once");
  monitor.stop();
  assert.deepEqual(cancelled.sort(), scheduled.sort());
  monitor.start();
  assert.equal(scheduled.length, 4, "restartable after stop");
  monitor.stop();
});

test("the vmmap reader is bounded and targets the pid it was given", async () => {
  const calls = [];
  const read = createVmmapRegionReader({
    pid: 4242,
    runProcess: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { stdout: LIVE_VMMAP };
    },
  });
  const out = await read();
  if (process.platform === "darwin") {
    assert.equal(calls[0].cmd, "vmmap");
    assert.deepEqual(calls[0].args, ["--summary", "4242"]);
    assert.ok(
      calls[0].opts.timeoutMs > 0,
      "must be bounded: vmmap slows down exactly when the process is unhealthy",
    );
    assert.equal(out, LIVE_VMMAP);
  } else {
    assert.equal(out, "");
  }
});

test("the vmmap reader refuses to be built without a bounded runner", () => {
  assert.throws(() => createVmmapRegionReader({}), /runProcess/);
});

test("the report states the crossing with both region counts", () => {
  const text = formatAddressSpaceReport({
    baselineRegions: 1887,
    peakRegions: 27599,
    fast: [],
    slow: [],
    growthSnapshot: {
      t: 1,
      baselineRegions: 1887,
      totalRegions: 27599,
      byTag: [{ label: "Memory Tag 255", regions: 15969 }],
    },
  });
  assert.match(text, /1887/);
  assert.match(text, /27599/);
  assert.match(text, /15969/);
});

test("the report is honest when nothing was collected", () => {
  assert.match(formatAddressSpaceReport(null), /not collected/i);
  const quiet = formatAddressSpaceReport({
    baselineRegions: 1887,
    peakRegions: 1900,
    fast: [],
    slow: [],
    growthSnapshot: null,
  });
  assert.match(quiet, /not crossed/i);
});
