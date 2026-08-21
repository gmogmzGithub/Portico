const fs = require("node:fs");
const path = require("node:path");

const PROTECTED_CLOUDSMITH_KEY = "CLOUDSMITH_API_KEY";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assignmentPattern(key) {
  return new RegExp(
    `^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=(.*)$`,
  );
}

function normalizeAssignmentValue(value) {
  let normalized = String(value || "").trim();
  const quote = normalized[0];
  if (quote === '"' || quote === "'") {
    const closingQuote = normalized.indexOf(quote, 1);
    return closingQuote >= 1
      ? normalized.slice(1, closingQuote).trim()
      : normalized.slice(1).trim();
  }
  return normalized.replace(/\s+#.*$/, "").trim();
}

function findNonEmptyAssignmentLine(content, key) {
  const pattern = assignmentPattern(key);
  let assignmentLine = null;
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match && normalizeAssignmentValue(match[1])) {
      assignmentLine = line;
    }
  }
  return assignmentLine;
}

function preserveCloudsmithApiKey(existingContent, proposedContent) {
  const existingAssignment = findNonEmptyAssignmentLine(
    existingContent,
    PROTECTED_CLOUDSMITH_KEY,
  );
  if (!existingAssignment) {
    return String(proposedContent || "");
  }

  const proposed = String(proposedContent || "");
  const pattern = assignmentPattern(PROTECTED_CLOUDSMITH_KEY);
  const retainedLines = proposed
    .split(/\r?\n/)
    .filter((line) => !pattern.test(line));
  while (retainedLines.length > 0 && retainedLines.at(-1) === "") {
    retainedLines.pop();
  }
  retainedLines.push(existingAssignment, "");
  return retainedLines.join("\n");
}

function protectedCloudsmithAssignment(existingContent, proposedContent) {
  return (
    findNonEmptyAssignmentLine(existingContent, PROTECTED_CLOUDSMITH_KEY) ||
    findNonEmptyAssignmentLine(proposedContent, PROTECTED_CLOUDSMITH_KEY)
  );
}

function forceCloudsmithAssignment(content, assignmentLine) {
  if (!assignmentLine) {
    return String(content || "");
  }

  return preserveCloudsmithApiKey(
    `${assignmentLine}\n`,
    String(content || ""),
  );
}

let atomicWriteSequence = 0;

function nextAtomicTempPath(envPath) {
  atomicWriteSequence = (atomicWriteSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${envPath}.${process.pid}.${Date.now()}.${atomicWriteSequence}.tmp`;
}

async function readEnvIfPresent(envPath, readFile) {
  try {
    return await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function readEnvIfPresentSync(envPath, readFileSync) {
  try {
    return readFileSync(envPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeProtectedRepositoryEnvAtomic(
  envPath,
  proposedContent,
  options = {},
) {
  const readFile = options.readFile || fs.promises.readFile.bind(fs.promises);
  const writeFile = options.writeFile || fs.promises.writeFile.bind(fs.promises);
  const rename = options.rename || fs.promises.rename.bind(fs.promises);
  const chmod = options.chmod || fs.promises.chmod.bind(fs.promises);
  const unlink = options.unlink || fs.promises.unlink.bind(fs.promises);
  const existingContent = await readEnvIfPresent(envPath, readFile);
  const protectedAssignment = protectedCloudsmithAssignment(
    existingContent,
    proposedContent,
  );
  const contentToWrite = forceCloudsmithAssignment(
    proposedContent,
    protectedAssignment,
  );
  const tempPath = nextAtomicTempPath(envPath);

  try {
    await writeFile(tempPath, contentToWrite, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, envPath);
    await chmod(envPath, 0o600);

    if (protectedAssignment) {
      const persistedContent = await readFile(envPath, "utf8");
      const persistedAssignment = findNonEmptyAssignmentLine(
        persistedContent,
        PROTECTED_CLOUDSMITH_KEY,
      );
      if (!persistedAssignment) {
        const error = new Error(
          "Protected repository Cloudsmith assignment was lost during .env write",
        );
        error.code = "PROTECTED_OPERATOR_ENV_WRITE_FAILED";
        throw error;
      }
    }

    return contentToWrite;
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (_cleanupError) {
      // Best effort only; preserve the original write error.
    }
    throw error;
  }
}

function writeProtectedRepositoryEnvAtomicSync(
  envPath,
  proposedContent,
  options = {},
) {
  const readFileSync = options.readFileSync || fs.readFileSync.bind(fs);
  const writeFileSync = options.writeFileSync || fs.writeFileSync.bind(fs);
  const renameSync = options.renameSync || fs.renameSync.bind(fs);
  const chmodSync = options.chmodSync || fs.chmodSync.bind(fs);
  const unlinkSync = options.unlinkSync || fs.unlinkSync.bind(fs);
  const existingContent = readEnvIfPresentSync(envPath, readFileSync);
  const protectedAssignment = protectedCloudsmithAssignment(
    existingContent,
    proposedContent,
  );
  const contentToWrite = forceCloudsmithAssignment(
    proposedContent,
    protectedAssignment,
  );
  const tempPath = nextAtomicTempPath(envPath);

  try {
    writeFileSync(tempPath, contentToWrite, { encoding: "utf8", mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, envPath);
    chmodSync(envPath, 0o600);

    if (protectedAssignment) {
      const persistedContent = readFileSync(envPath, "utf8");
      const persistedAssignment = findNonEmptyAssignmentLine(
        persistedContent,
        PROTECTED_CLOUDSMITH_KEY,
      );
      if (!persistedAssignment) {
        const error = new Error(
          "Protected repository Cloudsmith assignment was lost during .env write",
        );
        error.code = "PROTECTED_OPERATOR_ENV_WRITE_FAILED";
        throw error;
      }
    }

    return contentToWrite;
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch (_cleanupError) {
      // Best effort only; preserve the original write error.
    }
    throw error;
  }
}

function isProtectedRepositoryRoot(
  projectRoot,
  { isPackaged = false, existsSync = () => false } = {},
) {
  if (!isPackaged) {
    return true;
  }
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    return false;
  }
  return existsSync(path.join(projectRoot, ".git"));
}

module.exports = {
  PROTECTED_CLOUDSMITH_KEY,
  findNonEmptyAssignmentLine,
  isProtectedRepositoryRoot,
  preserveCloudsmithApiKey,
  writeProtectedRepositoryEnvAtomic,
  writeProtectedRepositoryEnvAtomicSync,
};
