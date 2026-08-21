const fsPromises = require("node:fs").promises;

const IDENTITY_ENV_KEYS = Object.freeze([
  "PORTICO_USER_ID",
  "PORTICO_USER_NAME",
]);

const IDENTITY_ENV_KEY_SET = new Set(IDENTITY_ENV_KEYS);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseEnvAssignment(line) {
  const match = String(line || "").match(
    /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/,
  );
  if (!match) {
    return null;
  }

  let value = match[2];
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value
      .slice(1, -1)
      .split("'\\''")
      .join("'")
      .split("\\'")
      .join("'");
  } else if (
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"')
  ) {
    try {
      value = JSON.parse(value);
    } catch (_error) {
      value = value.slice(1, -1);
    }
  }

  return {
    key: match[1],
    value,
  };
}

function parseIdentityEnv(content) {
  const values = {
    PORTICO_USER_ID: null,
    PORTICO_USER_NAME: null,
  };

  for (const line of String(content || "").split(/\r?\n/)) {
    const assignment = parseEnvAssignment(line);
    if (!assignment || !IDENTITY_ENV_KEY_SET.has(assignment.key)) {
      continue;
    }
    values[assignment.key] = assignment.value.trim();
  }

  return {
    userId: values.PORTICO_USER_ID,
    userName: values.PORTICO_USER_NAME,
  };
}

function validateIdentityValue(key, value) {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (/[\r\n]/.test(normalized)) {
    throw new TypeError(`${key} must not contain a newline`);
  }
  return normalized;
}

function serializeIdentityValue(value) {
  // Compose dotenv single quotes keep whitespace, substitutions, comments,
  // backticks, and backslashes literal. Compose represents an apostrophe as
  // \'. Release tooling deliberately excludes these runtime identity mirror
  // lines before sourcing the protected operator environment as shell code.
  return `'${value.split("'").join("\\'")}'`;
}

function writeCanonicalIdentityEnv(content, identity = {}) {
  const userId = validateIdentityValue("PORTICO_USER_ID", identity.userId);
  const userName = validateIdentityValue(
    "PORTICO_USER_NAME",
    identity.userName,
  );
  const source = String(content || "");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(source);
  const lines = source.split(/\r?\n/);
  if (hadTrailingNewline) {
    lines.pop();
  }

  const retainedLines = [];
  let insertionIndex = null;
  for (const line of lines) {
    const assignment = parseEnvAssignment(line);
    if (assignment && IDENTITY_ENV_KEY_SET.has(assignment.key)) {
      if (insertionIndex === null) {
        insertionIndex = retainedLines.length;
      }
      continue;
    }
    retainedLines.push(line);
  }

  if (insertionIndex === null) {
    insertionIndex = retainedLines.length;
  }
  retainedLines.splice(
    insertionIndex,
    0,
    `PORTICO_USER_ID=${serializeIdentityValue(userId)}`,
    `PORTICO_USER_NAME=${serializeIdentityValue(userName)}`,
  );

  return `${retainedLines.join(newline)}${newline}`;
}

async function writeIdentityEnvAtomic(envPath, content, options = {}) {
  const writeFile = options.writeFile || fsPromises.writeFile.bind(fsPromises);
  const rename = options.rename || fsPromises.rename.bind(fsPromises);
  const chmod = options.chmod || fsPromises.chmod.bind(fsPromises);
  const unlink = options.unlink || fsPromises.unlink.bind(fsPromises);
  const tempPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, envPath);
    await chmod(envPath, 0o600);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (_cleanupError) {
      // Best effort only; keep the original atomic-write error.
    }
    throw error;
  }
}

module.exports = {
  IDENTITY_ENV_KEYS,
  parseEnvAssignment,
  parseIdentityEnv,
  writeCanonicalIdentityEnv,
  writeIdentityEnvAtomic,
};
