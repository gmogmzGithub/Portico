const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DISK_FULL_APPLY_MESSAGE,
  DISK_FULL_PREPARE_MESSAGE,
  deriveUpdateFailureMessage,
  extractDiskFullMessage,
  extractUpdateFailureLine,
} = require("./update-failure-message");

test("deriveUpdateFailureMessage prefers stderr error lines", () => {
  const message = deriveUpdateFailureMessage({
    output: "Step 4b: Regenerating runtime compose artifacts...\n",
    errorOutput: "\u001b[0;31mError: failed to normalize generated host config output\u001b[0m\n",
    code: 1,
  });

  assert.equal(message, "Error: failed to normalize generated host config output");
});

test("deriveUpdateFailureMessage falls back to the last step when output only contains banners", () => {
  const message = deriveUpdateFailureMessage({
    output: [
      "Step 4b: Regenerating runtime compose artifacts...",
      "\u001b[0;34m═══════════════════════════════════════\u001b[0m",
      "\u001b[0;34m  Generating MCP Configurations\u001b[0m",
      "\u001b[0;34m═══════════════════════════════════════\u001b[0m",
    ].join("\n"),
    errorOutput: "",
    code: 1,
  });

  assert.equal(message, "Update failed during Step 4b: Regenerating runtime compose artifacts...");
});

test("deriveUpdateFailureMessage ignores READY_FOR_RESTART when deriving a failure", () => {
  const message = deriveUpdateFailureMessage({
    output: "READY_FOR_RESTART\n",
    errorOutput: "",
    code: 1,
  });

  assert.equal(message, "Update script exited with code 1");
});

test("extractUpdateFailureLine strips stderr prefixes and ANSI escapes", () => {
  const message = extractUpdateFailureLine(
    "[STDERR] \u001b[0;31mError: failed to read HOST_MODE from /tmp/HOST_MODE\u001b[0m\n",
  );

  assert.equal(message, "Error: failed to read HOST_MODE from /tmp/HOST_MODE");
});

// --- PORTICO-215 disk-full translation ---

test("deriveUpdateFailureMessage translates rsync ENOSPC stderr into the disk-full message", () => {
  // Real stderr shape from the PORTICO-215 incident: none of these lines match
  // the generic prioritized patterns, so before PORTICO-215 this fell through to
  // the useless step-line fallback.
  const message = deriveUpdateFailureMessage({
    output: "Step 3: Syncing prepared source payload into managed installation...\n",
    errorOutput: [
      "[STDERR] rsync(84957): 014d6a9d/node_modules/@img/sharp-wasm32/lib/.sharp-wasm32-0.35.2.node.wasm.ikVQkMDOLI: write: No space left on device",
      "rsync(84957): buf_copy",
      "[STDERR] rsync(84956): unexpected end of file",
    ].join("\n"),
    code: 1,
  });

  assert.equal(message, DISK_FULL_APPLY_MESSAGE);
});

test("deriveUpdateFailureMessage returns the preflight shortfall line verbatim with numbers", () => {
  // Fixture copied from the apply-prepared-update.sh preflight message.
  const message = deriveUpdateFailureMessage({
    output: "Preflight: checking free disk space for update apply...\n",
    errorOutput:
      "[STDERR] Error: Not enough free disk space to install the update. About 5.5 GB is needed, " +
      "but only 2.0 GB is free — free up at least 3.5 GB, then reopen Portico. " +
      "The update will resume automatically.\n",
    code: 1,
  });

  assert.equal(
    message,
    "Not enough free disk space to install the update. About 5.5 GB is needed, " +
      "but only 2.0 GB is free — free up at least 3.5 GB, then reopen Portico. " +
      "The update will resume automatically.",
  );
});

test("deriveUpdateFailureMessage prefers the disk-full translation over raw error lines", () => {
  const message = deriveUpdateFailureMessage({
    output: "",
    errorOutput: [
      "rsync: write failed: No space left on device (28)",
      "[error] Managed runtime reconcile failed",
    ].join("\n"),
    code: 1,
  });

  assert.equal(message, DISK_FULL_APPLY_MESSAGE);
});

test("deriveUpdateFailureMessage detects ENOSPC signatures that only appear in stdout", () => {
  const message = deriveUpdateFailureMessage({
    output: "Error: ENOSPC: no space left on device, write\n",
    errorOutput: "",
    code: 1,
  });

  assert.equal(message, DISK_FULL_APPLY_MESSAGE);
});

test("deriveUpdateFailureMessage does not treat preflight progress lines as failures", () => {
  const message = deriveUpdateFailureMessage({
    output: [
      "Preflight: checking free disk space for update apply...",
      "Preflight: disk space OK (need ~5.5 GB, 20.0 GB free)",
      "Step 3: Syncing prepared source payload into managed installation...",
    ].join("\n"),
    errorOutput: "",
    code: 1,
  });

  assert.equal(
    message,
    "Update failed during Step 3: Syncing prepared source payload into managed installation...",
  );
});

test("extractDiskFullMessage uses the caller-provided fallback message", () => {
  const message = extractDiskFullMessage(
    "zip I/O error: No space left on device",
    { fallbackMessage: DISK_FULL_PREPARE_MESSAGE },
  );

  assert.equal(message, DISK_FULL_PREPARE_MESSAGE);
});

test("extractDiskFullMessage returns empty for unrelated failures", () => {
  assert.equal(extractDiskFullMessage("Error: failed to fetch manifest"), "");
  assert.equal(
    extractDiskFullMessage("Preflight: skipping free disk space check (df/du unavailable)"),
    "",
  );
});
