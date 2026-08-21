"use strict";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;
const STDERR_PREFIX_PATTERN = /^\[STDERR\]\s*/i;
const BOX_DRAWING_ONLY_PATTERN = /^[\u2500-\u257f=\-_.+\s]+$/u;
const STEP_LINE_PATTERN = /^Step \d+[a-z]?:/i;

const prioritizedPatterns = [
  /^\[error\]/i,
  /^error[:\s]/i,
  /^❌/,
  /(failed|unable to|timed out|denied|not found|no such file|exit code|error)/i,
];

// PORTICO-215: disk-full failures need an actionable message, not raw rsync
// stderr (which matches none of the prioritized patterns above).
const DISK_FULL_PATTERN =
  /(no space left on device|enospc|not enough free disk space|disk full)/i;
// The apply/prepare preflights emit one line carrying exact GB numbers;
// keep this phrase in sync with apply-prepared-update.sh and disk-space.js.
const PREFLIGHT_DISK_LINE_PATTERN = /not enough free disk space/i;

const DISK_FULL_APPLY_MESSAGE =
  "Your disk is full, so the update could not be installed. Free up several GB of disk space, " +
  "then reopen Portico — the update will resume automatically. (No space left on device)";

const DISK_FULL_PREPARE_MESSAGE =
  "Your disk is full, so the update could not be prepared. Free up several GB of disk space, " +
  "then click Retry or relaunch Portico. (No space left on device)";

function normalizeOutputLine(line) {
  return String(line || "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(STDERR_PREFIX_PATTERN, "")
    .trim();
}

function isIgnorableLine(line) {
  return !line || line === "READY_FOR_RESTART" || BOX_DRAWING_ONLY_PATTERN.test(line);
}

function normalizedLines(text) {
  return String(text || "")
    .split("\n")
    .map(normalizeOutputLine)
    .filter((line) => !isIgnorableLine(line));
}

function extractUpdateFailureLine(text) {
  const lines = normalizedLines(text);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (prioritizedPatterns.some((pattern) => pattern.test(line))) {
      return line;
    }
  }
  return "";
}

function extractUpdateStepLine(text) {
  const lines = normalizedLines(text);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (STEP_LINE_PATTERN.test(line)) {
      return line;
    }
  }
  return "";
}

/**
 * Returns an actionable disk-full message when the text shows an ENOSPC /
 * disk-full failure, or "" otherwise. A preflight shortfall line (which
 * carries exact GB numbers) is returned verbatim, minus any leading
 * "Error:" prefix; any other disk-full signature returns fallbackMessage.
 */
function extractDiskFullMessage(text, { fallbackMessage = DISK_FULL_APPLY_MESSAGE } = {}) {
  const lines = normalizedLines(text);
  let sawDiskFull = false;
  for (const line of lines) {
    if (PREFLIGHT_DISK_LINE_PATTERN.test(line)) {
      return line.replace(/^error:?\s*/i, "").trim();
    }
    if (DISK_FULL_PATTERN.test(line)) {
      sawDiskFull = true;
    }
  }
  return sawDiskFull ? fallbackMessage : "";
}

function deriveUpdateFailureMessage({ output = "", errorOutput = "", code = null } = {}) {
  const diskFullMessage =
    extractDiskFullMessage(errorOutput) || extractDiskFullMessage(output);
  if (diskFullMessage) {
    return diskFullMessage;
  }

  const stderrLine = extractUpdateFailureLine(errorOutput);
  if (stderrLine) {
    return stderrLine;
  }

  const stdoutLine = extractUpdateFailureLine(output);
  if (stdoutLine) {
    return stdoutLine;
  }

  const stepLine = extractUpdateStepLine(output) || extractUpdateStepLine(errorOutput);
  if (stepLine) {
    return `Update failed during ${stepLine}`;
  }

  if (typeof code === "number") {
    return `Update script exited with code ${code}`;
  }

  return "Update script failed";
}

module.exports = {
  DISK_FULL_PATTERN,
  DISK_FULL_APPLY_MESSAGE,
  DISK_FULL_PREPARE_MESSAGE,
  deriveUpdateFailureMessage,
  extractDiskFullMessage,
  extractUpdateFailureLine,
  extractUpdateStepLine,
};
