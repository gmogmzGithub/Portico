const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

const DEFAULT_MANAGED_ROOT = path.join(
  os.homedir(),
  "portico",
  "portico-managed",
);
const RUNTIME_SECRETS_FILE_NAME = "runtime-secrets.env";
const MCP_SENSITIVE_ENV_KEYCHAIN_MIGRATION =
  "mcp-sensitive-env-keychain-v1";
const PORTICO_LLM_PLACEHOLDER_PATTERN = /(placeholder|example|your_|your-)/i;
const JWT_LIKE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KNOWN_INVALID_PORTICO_LLM_KEYS = new Set(["sk-portico-0001"]);
const MIN_PORTICO_LLM_API_KEY_LENGTH = 8;
const KEYCHAIN_ACCOUNT_PORTICO = "PORTICO_LLM_API_KEY";
const KEYCHAIN_ACCOUNT_AI_MARKETPLACE = "AI_MARKETPLACE_API_KEY";
const KEYCHAIN_ACCOUNT_LOCAL_STACK = "LOCAL_STACK_API_KEY";
const KEYCHAIN_ACCOUNT_BIFROST_LOCAL = "BIFROST_BRIDGE_LOCAL_API_KEY";
const KEYCHAIN_ACCOUNT_ULTRA_MULTI_AGENT = "ULTRA_MULTI_AGENT_SIGNING_SECRET";
const KEYCHAIN_ACCOUNT_OWUI_AUTH_BRIDGE = "OWUI_AUTH_BRIDGE_SECRET";
const KEYCHAIN_ACCOUNT_WEBUI_SECRET_KEY = "WEBUI_SECRET_KEY";
const KEYCHAIN_ACCOUNT_CLOUDSMITH_ENTITLEMENT = "CLOUDSMITH_ENTITLEMENT_TOKEN";
const KEYCHAIN_ACCOUNT_CLOUDSMITH_API_KEY = "CLOUDSMITH_API_KEY";
const LEGACY_KEYCHAIN_ACCOUNT_SLACK_OAUTH_CLIENT_ID = "SLACK_OAUTH_CLIENT_ID";
const LEGACY_KEYCHAIN_ACCOUNT_SLACK_OAUTH_CLIENT_SECRET =
  "SLACK_OAUTH_CLIENT_SECRET";
const LEGACY_KEYCHAIN_ACCOUNT_SLACK_OAUTH_CREDENTIALS_METADATA =
  "SLACK_OAUTH_CREDENTIALS_METADATA";
const KEYCHAIN_ACCOUNT_BY_RUNTIME_SECRET_KEY = Object.freeze({
  PORTICO_LLM_API_KEY: KEYCHAIN_ACCOUNT_PORTICO,
  AI_MARKETPLACE_API_KEY: KEYCHAIN_ACCOUNT_AI_MARKETPLACE,
  LOCAL_STACK_API_KEY: KEYCHAIN_ACCOUNT_LOCAL_STACK,
  BIFROST_BRIDGE_LOCAL_API_KEY: KEYCHAIN_ACCOUNT_BIFROST_LOCAL,
  ULTRA_MULTI_AGENT_SIGNING_SECRET: KEYCHAIN_ACCOUNT_ULTRA_MULTI_AGENT,
  OWUI_AUTH_BRIDGE_SECRET: KEYCHAIN_ACCOUNT_OWUI_AUTH_BRIDGE,
  WEBUI_SECRET_KEY: KEYCHAIN_ACCOUNT_WEBUI_SECRET_KEY,
  CLOUDSMITH_ENTITLEMENT_TOKEN: KEYCHAIN_ACCOUNT_CLOUDSMITH_ENTITLEMENT,
});
const LOCAL_STACK_FILE_KEYS = [
  "LOCAL_STACK_API_KEY",
  "INTERNAL_OPENAI_API_KEY",
  "OPENAI_API_KEY",
];
const RUNTIME_SECRET_SCOPE = Object.freeze({
  RUNTIME_SECURE: "runtime-secure",
  DEV_ONLY: "dev-only",
  NON_RUNTIME: "non-runtime",
});
const RUNTIME_SECRET_REGISTRY = Object.freeze({
  PORTICO_LLM_API_KEY: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.RUNTIME_SECURE,
    allowRuntimeWrites: true,
    requiredAtRuntime: true,
  }),
  AI_MARKETPLACE_API_KEY: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.RUNTIME_SECURE,
    allowRuntimeWrites: true,
    requiredAtRuntime: false,
  }),
  LOCAL_STACK_API_KEY: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.RUNTIME_SECURE,
    allowRuntimeWrites: true,
    requiredAtRuntime: true,
  }),
  BIFROST_BRIDGE_LOCAL_API_KEY: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.RUNTIME_SECURE,
    allowRuntimeWrites: true,
    requiredAtRuntime: true,
  }),
  ULTRA_MULTI_AGENT_SIGNING_SECRET: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.RUNTIME_SECURE,
    allowRuntimeWrites: true,
    requiredAtRuntime: true,
  }),
  OWUI_AUTH_BRIDGE_SECRET: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.RUNTIME_SECURE,
    allowRuntimeWrites: true,
    requiredAtRuntime: true,
  }),
  WEBUI_SECRET_KEY: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.RUNTIME_SECURE,
    allowRuntimeWrites: true,
    requiredAtRuntime: true,
  }),
  CLOUDSMITH_ENTITLEMENT_TOKEN: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.RUNTIME_SECURE,
    allowRuntimeWrites: true,
    requiredAtRuntime: false,
  }),
  CLOUDSMITH_API_KEY: Object.freeze({
    scope: RUNTIME_SECRET_SCOPE.DEV_ONLY,
    allowRuntimeWrites: false,
    requiredAtRuntime: false,
  }),
});
// Keys scrubbed from plaintext runtime env/secrets files in keychain-only mode.
// CLOUDSMITH_API_KEY is intentionally excluded: its managed cloudsmith.env
// lifecycle is handled by resolveCloudsmithApiKey only after verified Keychain
// persistence, while the repository .env copy is protected operator input.
const RUNTIME_SECRET_ENV_FILE_KEYS = [
  "PORTICO_LLM_API_KEY",
  "AI_MARKETPLACE_API_KEY",
  ...LOCAL_STACK_FILE_KEYS,
  "BIFROST_BRIDGE_LOCAL_API_KEY",
  "ULTRA_MULTI_AGENT_SIGNING_SECRET",
  "OWUI_AUTH_BRIDGE_SECRET",
  "WEBUI_SECRET_KEY",
  "CLOUDSMITH_ENTITLEMENT_TOKEN",
  // Stale Slack OAuth client credentials from the pre-PKCE confidential-client
  // path. Slack now uses an inline public client ID with PKCE, but scrub any
  // old plaintext values if they appear in managed env files.
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_CLIENT_SECRET",
  "PORTICO_LLM_API_KEY_FILE",
  "BIFROST_BRIDGE_LOCAL_API_KEY_FILE",
  "ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE",
  "OWUI_AUTH_BRIDGE_SECRET_FILE",
  "WEBUI_SECRET_KEY_FILE",
  "SLACK_OAUTH_CLIENT_ID_FILE",
  "SLACK_OAUTH_CLIENT_SECRET_FILE",
  "SLACK_MCP_XOXP_TOKEN",
  "SLACK_MCP_XOXP_TOKEN_FILE",
];
const STALE_SLACK_OAUTH_CLIENT_KEYS = [
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_CLIENT_SECRET",
  "SLACK_OAUTH_CLIENT_ID_FILE",
  "SLACK_OAUTH_CLIENT_SECRET_FILE",
];
const BUNDLED_AI_MARKETPLACE_API_KEY_BASE64 =
  "dWhnNzM4aCZHSFM3M0hHM0lERA==";

function uniqPaths(paths) {
  return Array.from(
    new Set(
      (Array.isArray(paths) ? paths : [])
        .filter((candidate) => typeof candidate === "string" && candidate.trim())
        .map((candidate) => path.resolve(candidate)),
    ),
  );
}

function parseEnvFile(filePath) {
  const values = {};
  if (!filePath) {
    return values;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) {
        let value = match[2];
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1);
        }
        values[match[1]] = value;
      }
    }
  } catch (_error) {
    return values;
  }

  return values;
}

function isKeychainDisabled(env = process.env) {
  const raw = String(env?.PORTICO_RUNTIME_DISABLE_KEYCHAIN || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function normalizeFlagValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isTruthyFlag(value) {
  const raw = normalizeFlagValue(value);
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isFalseyFlag(value) {
  const raw = normalizeFlagValue(value);
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

function isPlaintextFallbackAllowed(env = process.env) {
  return isTruthyFlag(env?.PORTICO_RUNTIME_ALLOW_PLAINTEXT_FALLBACK);
}

function normalizeRequiredEnvVar(entry) {
  if (typeof entry === "string") {
    const name = entry.trim();
    return name ? { name, sensitive: false } : null;
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const name = String(entry.name || "").trim();
  if (!name) {
    return null;
  }
  return {
    ...entry,
    name,
    sensitive: entry.sensitive === true,
  };
}

function dockerSecretNameForEnvVar(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function runtimeFileSlug(value, fallback = "file") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

function runtimeFileTargetHash(serverId, target) {
  return crypto
    .createHash("sha256")
    .update(String(serverId || ""))
    .update("\0")
    .update(String(target || ""))
    .digest("hex")
    .slice(0, 12);
}

function sensitiveRuntimeFileSecretName(serverId, target) {
  const basename = path.posix.basename(String(target || "")) || "file";
  return [
    "PORTICO_RUNTIME_FILE",
    runtimeFileSlug(serverId, "server"),
    runtimeFileSlug(basename, "file"),
    runtimeFileTargetHash(serverId, target),
  ].join("_");
}

function sensitiveRuntimeFileSecretEnvVar(secretName) {
  return `${String(secretName || "").toUpperCase()}_FILE`;
}

function staticSecretTokenEnvVar(serverId, secretName) {
  return [
    "PORTICO_STATIC_SECRET_TOKEN",
    runtimeFileSlug(serverId, "server").toUpperCase(),
    runtimeFileSlug(secretName, "secret").toUpperCase(),
  ].join("_");
}

function staticSecretAvailabilityEnvVar(serverId, secretName) {
  return [
    "PORTICO_STATIC_SECRET_AVAILABLE",
    runtimeFileSlug(serverId, "server").toUpperCase(),
    runtimeFileSlug(secretName, "secret").toUpperCase(),
  ].join("_");
}

function oauthAccessTokenTokenEnvVar(serverId) {
  return [
    "PORTICO_OAUTH_ACCESS_TOKEN_TOKEN",
    runtimeFileSlug(serverId, "server").toUpperCase(),
  ].join("_");
}

function defaultRuntimeSecretCacheDir({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (env?.PORTICO_RUNTIME_SECRET_CACHE_DIR) {
    return env.PORTICO_RUNTIME_SECRET_CACHE_DIR;
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Caches", "portico", "runtime-secrets");
  }
  return path.join(
    env?.XDG_STATE_HOME || path.join(homeDir, ".local", "state"),
    "portico",
    "runtime-secrets",
  );
}

function sensitiveRuntimeFileKeychainAccount(serverId, target) {
  return `MCP_RUNTIME_FILE::${serverId}::${runtimeFileTargetHash(serverId, target)}`;
}

const SENSITIVE_RUNTIME_FILE_STUB_MARKER =
  "# Portico imported this sensitive runtime file into secure storage.";
const SENSITIVE_RUNTIME_FILE_STUB = [
  SENSITIVE_RUNTIME_FILE_STUB_MARKER,
  "# Plaintext contents were removed from this provisioning path.",
  "# To rotate the credential, replace this file with a fresh secret file and restart Portico.",
  "",
].join("\n");

function isSensitiveRuntimeFileStubContent(content) {
  const firstLine = Buffer.isBuffer(content)
    ? content.toString("utf8", 0, Math.min(content.length, 1024)).split(/\r?\n/, 1)[0]
    : String(content || "").split(/\r?\n/, 1)[0];
  return firstLine === SENSITIVE_RUNTIME_FILE_STUB_MARKER;
}

function isSensitiveRuntimeFileStubFile(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    return isSensitiveRuntimeFileStubContent(fs.readFileSync(filePath));
  } catch (_error) {
    return false;
  }
}

// Exactly the stub and nothing else (trailing whitespace tolerated). A stub
// the user extended with their own content below the marker is NOT pure and
// must never be rewritten by the restore path.
function isPureSensitiveRuntimeFileStubContent(content) {
  const text = Buffer.isBuffer(content)
    ? content.toString("utf8")
    : String(content || "");
  return text.trimEnd() === SENSITIVE_RUNTIME_FILE_STUB.trimEnd();
}

function sensitiveRuntimeFileSourceHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Sensitive runtime-file sources are user-owned files (e.g. the shared
// ~/.snowflake/connections.toml) and are never overwritten with the stub.
// Both structures live for the Electron main-process lifetime, keyed by the
// Keychain account (MCP_RUNTIME_FILE::<serverId>::<hash12>):
// - importedSourceHashes: sha256 of the raw source bytes last verified
//   persisted, so the recurring resolve callers (60s health loop, static
//   secret broker fetches, shell-env builders) skip the Keychain write when
//   the file is unchanged — at most one write per app launch per file.
// - restoreAttempted: once-per-session guard so a legacy stub left by an
//   older build is restored (or fails) once, not on every cycle.
const sensitiveRuntimeFileImportedSourceHashes = new Map();
const sensitiveRuntimeFileRestoreAttempted = new Set();

function resetSensitiveRuntimeFileImportSessionStateForTests() {
  sensitiveRuntimeFileImportedSourceHashes.clear();
  sensitiveRuntimeFileRestoreAttempted.clear();
}

const SNOWFLAKE_GENERATED_CONNECTIONS_MARKER =
  "# Generated by Portico Snowflake Setup.";
const LEGACY_SNOWFLAKE_PAT_AUTHENTICATOR_LINE =
  /^authenticator\s*=\s*"PROGRAMMATIC_ACCESS_TOKEN"\s*$/;
const LEGACY_SNOWFLAKE_PASSWORD_KEY = /^password(\s*=\s*)/;
const SNOWFLAKE_TOKEN_KEY_LINE = /^token\s*=/;

// One-shot migration for generated Snowflake connection files created before
// round 8: they store the PAT under `password` while naming the strict PAT
// authenticator, but the Snowflake connector reads that credential from
// `token` (AuthByPAT), so those files send a null token and Snowflake rejects
// the login with 394400. Renaming the key makes the stored (still valid)
// token work without asking the user for a new one. Returns migrated bytes,
// or null when the value is not ours to touch.
function migrateLegacySnowflakeRuntimeFileBytes(serverId, bytes) {
  if (serverId !== "snowflake" || !Buffer.isBuffer(bytes) || bytes.length === 0) {
    return null;
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return null; // not lossless UTF-8 — leave unknown payloads untouched
  }
  if (!text.startsWith(SNOWFLAKE_GENERATED_CONNECTIONS_MARKER)) {
    return null; // hand-written files are never rewritten
  }
  // Only the pristine generated shape is migrated: exactly one section
  // ([default]) and no multi-line strings. A marker file the user extended
  // with their own sections or values is not ours to rewrite — a `password`
  // key elsewhere could be a real corporate credential.
  if (text.includes("'''") || text.includes('"""')) {
    return null;
  }
  const lines = text.split(/(?<=\n)/);
  const stripLineEnding = (line) => line.replace(/\r?\n$/, "");
  const sectionHeaders = lines
    .map(stripLineEnding)
    .filter((line) => /^\s*\[/.test(line));
  if (sectionHeaders.length !== 1 || sectionHeaders[0].trim() !== "[default]") {
    return null;
  }
  const defaultStart = lines.findIndex(
    (line) => stripLineEnding(line).trim() === "[default]",
  );
  const inDefault = (index) => index > defaultStart;
  const hasPatAuthenticator = lines.some(
    (line, index) =>
      inDefault(index) &&
      LEGACY_SNOWFLAKE_PAT_AUTHENTICATOR_LINE.test(stripLineEnding(line)),
  );
  if (!hasPatAuthenticator) {
    return null;
  }
  if (
    lines.some(
      (line, index) =>
        inDefault(index) && SNOWFLAKE_TOKEN_KEY_LINE.test(stripLineEnding(line)),
    )
  ) {
    return null; // already carries a token key — nothing to migrate
  }
  const passwordLineIndexes = lines.flatMap((line, index) =>
    inDefault(index) && LEGACY_SNOWFLAKE_PASSWORD_KEY.test(stripLineEnding(line))
      ? [index]
      : [],
  );
  if (passwordLineIndexes.length !== 1) {
    return null; // ambiguous shape — refuse to guess
  }
  const index = passwordLineIndexes[0];
  const migratedLine = lines[index].replace(LEGACY_SNOWFLAKE_PASSWORD_KEY, "token$1");
  const migrated = [...lines];
  migrated[index] = migratedLine;
  return Buffer.from(migrated.join(""), "utf8");
}

function restoreSensitiveRuntimeFileSource(filePath, bytes) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, bytes, { mode: 0o600 });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch (_error) {
      // Best-effort on platforms/filesystems that do not support chmod.
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_cleanupError) {
      // Leaving a 0600 temp file behind is preferable to masking the error.
    }
    throw error;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_error) {
    // Best-effort on platforms/filesystems that do not support chmod.
  }
}

function notifySensitiveRuntimeFileSourceRestored(runtimeFile) {
  const message = `Restored ${runtimeFile.sourcePath} from secure storage (a previous Portico import had replaced it with a placeholder).`;
  console.log(`[Runtime Secrets] ${message}`);
  try {
    // electron is only available inside the main-process runtime; in unit
    // tests or worker contexts this throws and the log line above stands.
    const { Notification } = require("electron");
    if (Notification?.isSupported?.()) {
      new Notification({ title: "Portico", body: message }).show();
    }
  } catch (_error) {
    // Outside the Electron main process (unit tests, CLI helpers) the
    // structured log line above is the notification.
  }
}

function nonEmptyFileExists(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    const metadata = fs.statSync(filePath);
    return metadata.isFile() && metadata.size > 0;
  } catch (_error) {
    return false;
  }
}

function readNonStubFileBytes(filePath) {
  if (!nonEmptyFileExists(filePath) || isSensitiveRuntimeFileStubFile(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath);
}

function sensitiveRuntimeFileCachePath(serverId, target, options = {}) {
  const secretName = sensitiveRuntimeFileSecretName(serverId, target);
  return path.join(defaultRuntimeSecretCacheDir(options), secretName);
}

function materializeSensitiveRuntimeFileCache({
  serverId,
  target,
  bytes,
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (!serverId || !target || !Buffer.isBuffer(bytes) || bytes.length === 0) {
    return "";
  }
  const cachePath = sensitiveRuntimeFileCachePath(serverId, target, {
    env,
    homeDir,
    platform,
  });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(cachePath), 0o700);
  } catch (_error) {
    // Best-effort on platforms/filesystems that do not support chmod.
  }
  if (fs.existsSync(cachePath) && fs.readFileSync(cachePath).equals(bytes)) {
    try {
      fs.chmodSync(cachePath, 0o600);
    } catch (_error) {
      // Best-effort on platforms/filesystems that do not support chmod.
    }
    return cachePath;
  }
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, bytes, { mode: 0o600 });
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch (_error) {
    // Best-effort on platforms/filesystems that do not support chmod.
  }
  fs.renameSync(tempPath, cachePath);
  try {
    fs.chmodSync(cachePath, 0o600);
  } catch (_error) {
    // Best-effort on platforms/filesystems that do not support chmod.
  }
  return cachePath;
}

function readSensitiveRuntimeFilePersistedBytes({
  serverId,
  target,
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (!serverId || !target) {
    return null;
  }
  const account = sensitiveRuntimeFileKeychainAccount(serverId, target);
  const value = readSecretFromKeychain(account, { env });
  if (!String(value || "").trim()) {
    return null;
  }
  const decoded = Buffer.from(String(value).trim(), "base64");
  if (decoded.length === 0 || isSensitiveRuntimeFileStubContent(decoded)) {
    return null;
  }
  const migrated = migrateLegacySnowflakeRuntimeFileBytes(serverId, decoded);
  if (migrated) {
    // Best-effort persist-back: the returned bytes are already migrated, so a
    // failed Keychain write only means the (idempotent) rewrite retries on
    // the next read.
    try {
      upsertSecretInKeychain(account, migrated.toString("base64"), { env });
    } catch (_error) {
      // Serving migrated bytes matters more than persisting them.
    }
    return migrated;
  }
  return decoded;
}

function runtimeFileSensitiveFlag(entry) {
  if (!entry || typeof entry !== "object" || entry.sensitive == null) {
    return false;
  }
  if (typeof entry.sensitive !== "boolean") {
    throw new Error("runtime_files sensitive must be true or false");
  }
  return entry.sensitive;
}

function expandRuntimeFileSource(projectRoot, rawSource, { homeDir = os.homedir() } = {}) {
  const source = String(rawSource || "").trim();
  if (!source) {
    throw new Error("runtime_files source is required");
  }
  if (source === "~" || source.startsWith("~/")) {
    if (!homeDir) {
      throw new Error(`runtime_files source '${source}' uses '~' but HOME is not set`);
    }
    return source === "~" ? path.resolve(homeDir) : path.join(homeDir, source.slice(2));
  }
  if (source.startsWith("~")) {
    throw new Error(`runtime_files source '${source}' uses unsupported '~user' expansion`);
  }
  return path.isAbsolute(source)
    ? source
    : path.join(projectRoot || process.cwd(), source);
}

function sensitiveRuntimeFileTarget(sourcePath, entry) {
  const target =
    typeof entry?.target === "string" && entry.target.trim()
      ? entry.target.trim()
      : "";
  if (target) {
    return target;
  }
  const filename =
    typeof entry?.filename === "string" && entry.filename.trim()
      ? entry.filename.trim()
      : path.basename(sourcePath);
  return `/app/runtime/${filename}`;
}

function isSensitiveRuntimeFilePersisted({
  serverId,
  target,
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  return Boolean(
    readSensitiveRuntimeFilePersistedBytes({
      serverId,
      target,
      env,
      homeDir,
      platform,
    }),
  );
}

function collectSensitiveRuntimeFilesFromServerConfig(
  serverId,
  serverConfig,
  { projectRoot = process.cwd() } = {},
) {
  const entries = Array.isArray(serverConfig?.runtime_files)
    ? serverConfig.runtime_files
    : [];
  return entries
    .filter((entry) => runtimeFileSensitiveFlag(entry))
    .map((entry) => {
      const source = String(entry.source || "").trim();
      const sourcePath = expandRuntimeFileSource(projectRoot, source);
      return {
        serverId,
        source,
        sourcePath,
        filename:
          typeof entry.filename === "string" && entry.filename.trim()
            ? entry.filename.trim()
            : null,
        target:
          typeof entry.target === "string" && entry.target.trim()
            ? entry.target.trim()
            : sensitiveRuntimeFileTarget(sourcePath, entry),
      };
    });
}

function discoverSensitiveRuntimeFiles({
  projectRoot = null,
  configDirs = null,
} = {}) {
  const roots = [];
  if (Array.isArray(configDirs)) {
    roots.push(...configDirs);
  } else if (projectRoot) {
    roots.push(path.join(projectRoot, "mcp-configs"));
    roots.push(path.join(projectRoot, "mcp-configs-user"));
  }

  const files = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      continue;
    }
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const yamlPath = path.join(root, dirent.name, `${dirent.name}.yaml`);
      if (!fs.existsSync(yamlPath)) {
        continue;
      }
      files.push(
        ...collectSensitiveRuntimeFilesFromServerConfig(
          dirent.name,
          readYamlFile(yamlPath),
          { projectRoot: projectRoot || path.dirname(root) },
        ),
      );
    }
  }
  return files;
}

function collectSensitiveEnvVarsFromServerConfig(serverConfig) {
  const entries = Array.isArray(serverConfig?.required_env_vars)
    ? serverConfig.required_env_vars
    : [];
  return entries
    .map(normalizeRequiredEnvVar)
    .filter((entry) => entry?.sensitive === true)
    .map((entry) => entry.name);
}

function collectRequiredEnvVarsFromServerConfig(serverConfig) {
  const entries = Array.isArray(serverConfig?.required_env_vars)
    ? serverConfig.required_env_vars
    : [];
  return entries.map(normalizeRequiredEnvVar).filter(Boolean);
}

function readYamlFile(filePath) {
  try {
    return yaml.load(fs.readFileSync(filePath, "utf8")) || {};
  } catch (_error) {
    return {};
  }
}

function discoverSensitiveRequiredEnvVars({
  projectRoot = null,
  configDirs = null,
} = {}) {
  const roots = [];
  if (Array.isArray(configDirs)) {
    roots.push(...configDirs);
  } else if (projectRoot) {
    roots.push(path.join(projectRoot, "mcp-configs"));
    roots.push(path.join(projectRoot, "mcp-configs-user"));
  }

  const keys = new Set();
  const sensitivityByKey = new Map();
  for (const root of roots) {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      continue;
    }
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const yamlPath = path.join(root, dirent.name, `${dirent.name}.yaml`);
      if (!fs.existsSync(yamlPath)) {
        continue;
      }
      for (const entry of collectRequiredEnvVarsFromServerConfig(
        readYamlFile(yamlPath),
      )) {
        const existing = sensitivityByKey.get(entry.name);
        if (existing && existing.sensitive !== entry.sensitive) {
          throw new Error(
            `required_env_vars sensitivity conflict for ${entry.name}: ${existing.source} declares sensitive=${existing.sensitive}, ${yamlPath} declares sensitive=${entry.sensitive}`,
          );
        }
        if (!existing) {
          sensitivityByKey.set(entry.name, {
            sensitive: entry.sensitive,
            source: yamlPath,
          });
        }
        if (entry.sensitive) {
          keys.add(entry.name);
        }
      }
    }
  }
  return Array.from(keys).sort();
}

function discoverSensitiveRequiredEnvVarDescriptors({
  projectRoot = null,
  configDirs = null,
} = {}) {
  const roots = [];
  if (Array.isArray(configDirs)) {
    roots.push(...configDirs);
  } else if (projectRoot) {
    roots.push(path.join(projectRoot, "mcp-configs"));
    roots.push(path.join(projectRoot, "mcp-configs-user"));
  }

  const descriptors = new Map();
  for (const root of roots) {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      continue;
    }
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const serverId = dirent.name;
      const yamlPath = path.join(root, serverId, `${serverId}.yaml`);
      if (!fs.existsSync(yamlPath)) {
        continue;
      }
      for (const key of collectSensitiveEnvVarsFromServerConfig(
        readYamlFile(yamlPath),
      )) {
        const id = `${serverId}\0${key}`;
        descriptors.set(id, {
          serverId,
          key,
          secretName: dockerSecretNameForEnvVar(key),
          yamlPath,
        });
      }
    }
  }

  return Array.from(descriptors.values()).sort((left, right) => {
    const serverCompare = left.serverId.localeCompare(right.serverId);
    return serverCompare || left.key.localeCompare(right.key);
  });
}

function runtimeSecretEnvFileKeys(options = {}) {
  const keys = new Set(RUNTIME_SECRET_ENV_FILE_KEYS);
  for (const descriptor of discoverSensitiveRequiredEnvVarDescriptors(options)) {
    keys.add(descriptor.key);
    keys.add(`${descriptor.key}_FILE`);
    keys.add(
      staticSecretAvailabilityEnvVar(
        descriptor.serverId,
        descriptor.secretName,
      ),
    );
  }
  for (const runtimeFile of discoverSensitiveRuntimeFiles(options)) {
    const secretName = sensitiveRuntimeFileSecretName(
      runtimeFile.serverId,
      runtimeFile.target,
    );
    keys.add(
      sensitiveRuntimeFileSecretEnvVar(secretName),
    );
    keys.add(staticSecretAvailabilityEnvVar(runtimeFile.serverId, secretName));
  }
  return Array.from(keys).sort();
}

function isRuntimeWritableSecretKey(key, options = {}) {
  const metadata = RUNTIME_SECRET_REGISTRY[key];
  if (metadata?.allowRuntimeWrites) {
    return true;
  }
  return discoverSensitiveRequiredEnvVars(options).includes(key);
}

function isDynamicMcpSensitiveSecretKey(key, options = {}) {
  if (RUNTIME_SECRET_REGISTRY[key]) {
    return false;
  }
  return discoverSensitiveRequiredEnvVars(options).includes(key);
}

function listRuntimeWritableSecretKeys(options = {}) {
  const keys = Object.entries(RUNTIME_SECRET_REGISTRY)
    .filter(([, metadata]) => metadata?.allowRuntimeWrites)
    .map(([key]) => key);
  keys.push(...discoverSensitiveRequiredEnvVars(options));
  return Array.from(new Set(keys)).sort();
}

function isKeychainOnlyMode(env = process.env, platform = process.platform) {
  if (platform !== "darwin") {
    return false;
  }
  if (isKeychainDisabled(env)) {
    return false;
  }
  if (isTruthyFlag(env?.PORTICO_RUNTIME_ALLOW_PLAINTEXT_FALLBACK)) {
    return false;
  }

  const explicit = normalizeFlagValue(env?.PORTICO_RUNTIME_KEYCHAIN_ONLY);
  if (!explicit) {
    return true;
  }
  if (isFalseyFlag(explicit)) {
    return false;
  }
  return true;
}

function buildKeychainEnv(env, account) {
  return {
    ...(env || {}),
    PORTICO_LLM_KEYCHAIN_ACCOUNT: account,
  };
}

function readSecretFromKeychain(account, { env = process.env } = {}) {
  if (isKeychainDisabled(env)) {
    return "";
  }

  try {
    const {
      readPorticoLlmApiKeyFromKeychainSync,
    } = require("../services/llm-keychain");
    const value = readPorticoLlmApiKeyFromKeychainSync({
      env: buildKeychainEnv(env, account),
    });
    return typeof value === "string" ? value.trim() : "";
  } catch (_error) {
    return "";
  }
}

function upsertSecretInKeychain(account, value, { env = process.env } = {}) {
  if (isKeychainDisabled(env)) {
    return "";
  }

  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return "";
  }

  try {
    const {
      upsertPorticoLlmApiKeyInKeychainSync,
    } = require("../services/llm-keychain");
    const persisted = upsertPorticoLlmApiKeyInKeychainSync(normalizedValue, {
      env: buildKeychainEnv(env, account),
    });
    return typeof persisted === "string" ? persisted.trim() : "";
  } catch (_error) {
    return "";
  }
}

function clearKeychainReadCache() {
  try {
    const { clearKeychainCache } = require("../services/llm-keychain");
    clearKeychainCache?.();
  } catch (_error) {
    // The subsequent readback still fails closed when the Keychain is unavailable.
  }
}

function deleteSecretFromKeychain(account, { env = process.env } = {}) {
  if (isKeychainDisabled(env)) {
    return false;
  }

  try {
    const {
      deletePorticoLlmApiKeyFromKeychainSync,
    } = require("../services/llm-keychain");
    return deletePorticoLlmApiKeyFromKeychainSync({
      env: buildKeychainEnv(env, account),
    });
  } catch (_error) {
    return false;
  }
}

function persistKeychainSecret(account, value, { env, keychainOnly, keyName }) {
  const persisted = upsertSecretInKeychain(account, value, { env });
  if (persisted) {
    return persisted;
  }
  if (keychainOnly) {
    throw new Error(
      `Keychain-only mode requires macOS Keychain persistence for ${keyName}`,
    );
  }
  return "";
}

function deriveLegacyNumericKey(seed) {
  let hash = 0;
  const source = String(seed || "");
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function decryptLegacyXorBase64(ciphertextBase64, seed) {
  const key = deriveLegacyNumericKey(seed);
  const encrypted = Buffer.from(ciphertextBase64, "base64");
  const output = Buffer.alloc(encrypted.length);
  for (let index = 0; index < encrypted.length; index += 1) {
    const shift = (index % 4) * 8;
    const keyByte = (key >> shift) & 0xff;
    output[index] = encrypted[index] ^ keyByte;
  }
  return output.toString("utf8").trim();
}

function decodeBundledBase64Secret(encodedValue) {
  try {
    return Buffer.from(String(encodedValue || "").trim(), "base64")
      .toString("utf8")
      .trim();
  } catch (_error) {
    return "";
  }
}

function decryptLegacySharedApiKey() {
  // Public builds must never ship a shared provider credential. Keep the
  // migration seam so older managed installations can still load the module,
  // but require an explicit runtime secret for new installations.
  return "";
}

function resolveLegacyFallbackPorticoLlmApiKey() {
  try {
    const candidate = decryptLegacySharedApiKey();
    if (!candidate || isMalformedPorticoLlmApiKey(candidate)) {
      return "";
    }
    return candidate;
  } catch (_error) {
    return "";
  }
}

// Candidate plaintext read paths for runtime secrets. Project-level
// `runtime-secrets.env` and `cloudsmith.env` are intentionally excluded so
// secrets in a cloned repo never contribute to runtime resolution; only
// managed-root paths (and explicit PORTICO_RUNTIME_SECRETS_FILE override) apply.
// `projectRoot` is still accepted as a parameter for back-compat but is only
// used for post-Keychain scrub of `projectRoot/.env`.
function listRuntimeSecretCandidatePaths({
  projectRoot = null, // eslint-disable-line no-unused-vars
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
  env = process.env,
} = {}) {
  const candidates = [];
  if (env.PORTICO_RUNTIME_SECRETS_FILE) {
    candidates.push(env.PORTICO_RUNTIME_SECRETS_FILE);
  }
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, RUNTIME_SECRETS_FILE_NAME));
  }
  candidates.push(path.join(managedRoot, RUNTIME_SECRETS_FILE_NAME));
  return uniqPaths(candidates);
}

function listUpstreamSecretCandidatePaths({
  projectRoot = null, // eslint-disable-line no-unused-vars
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
  env = process.env,
} = {}) {
  return uniqPaths([
    ...listRuntimeSecretCandidatePaths({
      resourcesPath,
      managedRoot,
      env,
    }),
    resourcesPath ? path.join(resourcesPath, "cloudsmith.env") : null,
    path.join(managedRoot, "cloudsmith.env"),
  ]);
}

function listCloudsmithSecretCandidatePaths({
  projectRoot = null, // eslint-disable-line no-unused-vars
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
  env = process.env,
  // eslint-disable-next-line no-unused-vars
  includeProjectRoot = true,
} = {}) {
  return uniqPaths([
    ...listRuntimeSecretCandidatePaths({
      resourcesPath,
      managedRoot,
      env,
    }),
    resourcesPath ? path.join(resourcesPath, "cloudsmith.env") : null,
    path.join(managedRoot, "cloudsmith.env"),
  ]);
}

// Packaged macOS bootstrap is intentionally narrower than the general
// development fallback list. Only a signed app resource or the app-owned
// managed runtime may seed the Keychain; cloned project files and arbitrary
// plaintext override paths are never trusted for first launch.
function listCloudsmithBootstrapCandidatePaths({
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  return uniqPaths([
    resourcesPath ? path.join(resourcesPath, "cloudsmith.env") : null,
    path.join(managedRoot, "cloudsmith.env"),
    path.join(managedRoot, RUNTIME_SECRETS_FILE_NAME),
  ]);
}

// The signed app bundle must remain byte-for-byte unchanged after signing.
// Only mutable copies under the managed runtime are eligible for scrubbing.
function listMutableCloudsmithSecretPaths({
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  return uniqPaths([
    path.join(managedRoot, "cloudsmith.env"),
    path.join(managedRoot, RUNTIME_SECRETS_FILE_NAME),
  ]);
}

function readFirstConfiguredValue(key, candidatePaths) {
  for (const candidatePath of uniqPaths(candidatePaths)) {
    const values = parseEnvFile(candidatePath);
    if (values[key]) {
      return values[key];
    }
  }
  return "";
}

function mcpSensitiveEnvMigrationMarkerPath(projectRoot) {
  if (!projectRoot) {
    return "";
  }
  return path.join(
    projectRoot,
    "open-webui-data",
    "runtime-migrations",
    MCP_SENSITIVE_ENV_KEYCHAIN_MIGRATION,
  );
}

function writePrivateJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto
    .randomBytes(6)
    .toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (_error) {
      // Best-effort on platforms/filesystems that do not support chmod.
    }
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_error) {
      // The rename normally consumes the temporary file.
    }
  }
}

function removeEnvKeysFromFile(filePath, keys) {
  if (
    !filePath ||
    !Array.isArray(keys) ||
    keys.length === 0 ||
    !fs.existsSync(filePath)
  ) {
    return false;
  }

  const normalizedKeys = new Set(
    keys.filter((key) => typeof key === "string" && key.trim()),
  );
  if (normalizedKeys.size === 0) {
    return false;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const filtered = lines.filter((line) => {
    for (const key of normalizedKeys) {
      if (line.startsWith(`${key}=`)) {
        return false;
      }
    }
    return true;
  });
  const nextContent = filtered.join("\n");
  if (nextContent === content) {
    return false;
  }

  fs.writeFileSync(filePath, nextContent, "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_error) {
    // Best-effort on non-POSIX filesystems.
  }
  return true;
}

function stripEnvKeysFromPaths(candidatePaths, keys) {
  const stripped = [];
  for (const candidatePath of uniqPaths(candidatePaths)) {
    if (removeEnvKeysFromFile(candidatePath, keys)) {
      stripped.push(candidatePath);
    }
  }
  return stripped;
}

function ensureManagedRoot(managedRoot = DEFAULT_MANAGED_ROOT) {
  fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(managedRoot, 0o700);
  } catch (_error) {
    // Best-effort on non-POSIX filesystems.
  }
  return managedRoot;
}

function ensureRuntimeSecretsFile({
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  const resolvedRoot = ensureManagedRoot(managedRoot);
  const secretsFilePath = path.join(resolvedRoot, RUNTIME_SECRETS_FILE_NAME);
  if (!fs.existsSync(secretsFilePath)) {
    fs.writeFileSync(secretsFilePath, "", { mode: 0o600 });
  }
  try {
    fs.chmodSync(secretsFilePath, 0o600);
  } catch (_error) {
    // Best-effort on non-POSIX filesystems.
  }
  return secretsFilePath;
}

function writeRuntimeSecretsFile(secrets, options = {}) {
  const secretsFilePath = ensureRuntimeSecretsFile(options);
  const nextSecrets = { ...(secrets || {}) };
  const lines = Object.entries(nextSecrets)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `${key}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    );

  fs.writeFileSync(
    secretsFilePath,
    lines.length > 0 ? `${lines.join("\n")}\n` : "",
    { mode: 0o600 },
  );
  return secretsFilePath;
}

function upsertRuntimeSecret(key, value, options = {}) {
  const env = options.env || process.env;
  const keychainOnly = isKeychainOnlyMode(env);
  const dynamicMcpSensitiveKey = isDynamicMcpSensitiveSecretKey(key, options);
  if (!isRuntimeWritableSecretKey(key, options)) {
    throw new Error(`Runtime secret key is not allowed: ${key}`);
  }

  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    throw new Error(`Runtime secret value for ${key} is required`);
  }

  if (key === "PORTICO_LLM_API_KEY") {
    if (isMalformedPorticoLlmApiKey(normalizedValue)) {
      throw new Error(
        "Runtime secret value for PORTICO_LLM_API_KEY is malformed",
      );
    }
  }

  const keychainAccount = KEYCHAIN_ACCOUNT_BY_RUNTIME_SECRET_KEY[key] || key;
  if (keychainAccount) {
    const persisted = persistKeychainSecret(keychainAccount, normalizedValue, {
      env,
      keychainOnly,
      keyName: key,
    });
    if (persisted) {
      if (dynamicMcpSensitiveKey) {
        const verified = readSecretFromKeychain(keychainAccount, { env });
        if (verified !== normalizedValue) {
          throw new Error(
            `Keychain readback verification failed for sensitive MCP env var ${key}`,
          );
        }
      }
      return normalizedValue;
    }
    if (dynamicMcpSensitiveKey) {
      throw new Error(
        `Keychain persistence is required for sensitive MCP env var ${key}`,
      );
    }
  }

  const secretsFilePath = ensureRuntimeSecretsFile(options);
  const currentSecrets = parseEnvFile(secretsFilePath);
  currentSecrets[key] = normalizedValue;
  writeRuntimeSecretsFile(currentSecrets, options);
  return normalizedValue;
}

function deleteRuntimeSecret(key, options = {}) {
  const env = options.env || process.env;
  if (!isRuntimeWritableSecretKey(key, options)) {
    throw new Error(`Runtime secret key is not allowed: ${key}`);
  }

  const keychainAccount = KEYCHAIN_ACCOUNT_BY_RUNTIME_SECRET_KEY[key] || key;
  if (keychainAccount) {
    deleteSecretFromKeychain(keychainAccount, { env });
  }

  const secretsFilePath = ensureRuntimeSecretsFile(options);
  const currentSecrets = parseEnvFile(secretsFilePath);
  if (Object.prototype.hasOwnProperty.call(currentSecrets, key)) {
    delete currentSecrets[key];
    writeRuntimeSecretsFile(currentSecrets, options);
  }

  return true;
}

function generateLocalStackApiKey() {
  return `sk-local-${crypto.randomBytes(24).toString("base64url")}`;
}

function generateBifrostLocalApiKey() {
  return `sk-bifrost-local-${crypto.randomBytes(24).toString("base64url")}`;
}

function generateUltraMultiAgentSigningSecret() {
  return `ultra-sign-v1-${crypto.randomBytes(48).toString("base64url")}`;
}

function validateUltraMultiAgentSigningSecret(secret, peerSecrets = {}) {
  const normalized = String(secret || "").trim();
  if (!normalized.startsWith("ultra-sign-v1-") || normalized.length < 70) {
    throw new Error(
      "ULTRA_MULTI_AGENT_SIGNING_SECRET must use the strong ultra-sign-v1 format",
    );
  }
  for (const peerSecret of Object.values(peerSecrets)) {
    const peer = String(peerSecret || "").trim();
    if (peer && peer === normalized) {
      throw new Error(
        "ULTRA_MULTI_AGENT_SIGNING_SECRET must be distinct from bearer, upstream, and application secrets",
      );
    }
  }
  return normalized;
}

function generateOwuiAuthBridgeSecret() {
  return `owui-bridge-${crypto.randomBytes(32).toString("base64url")}`;
}

function generateWebuiSecretKey() {
  return crypto.randomBytes(48).toString("base64url");
}

function resolveGeneratedRuntimeSecret({
  key,
  keychainAccount,
  generator,
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env);
  const canReadPlaintextFallback =
    !keychainOnly || isPlaintextFallbackAllowed(env);
  const directValue = String(env[key] || "").trim();
  if (directValue) {
    persistKeychainSecret(keychainAccount, directValue, {
      env,
      keychainOnly,
      keyName: key,
    });
    return directValue;
  }

  const keychainValue = readSecretFromKeychain(keychainAccount, { env });
  if (keychainValue) {
    return keychainValue;
  }

  if (canReadPlaintextFallback) {
    const candidatePaths = listRuntimeSecretCandidatePaths({
      projectRoot,
      resourcesPath,
      managedRoot,
      env,
    });
    const persistedValue = readFirstConfiguredValue(key, candidatePaths);
    if (persistedValue) {
      persistKeychainSecret(keychainAccount, persistedValue, {
        env,
        keychainOnly,
        keyName: key,
      });
      if (keychainOnly) {
        stripEnvKeysFromPaths(candidatePaths, [key]);
      }
      return persistedValue;
    }
  }

  const generatedValue = generator();
  if (
    persistKeychainSecret(keychainAccount, generatedValue, {
      env,
      keychainOnly,
      keyName: key,
    })
  ) {
    return generatedValue;
  }

  return upsertRuntimeSecret(key, generatedValue, {
    managedRoot,
    env,
  });
}

function resolveCloudsmithEntitlementToken({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
  isPackagedApp = false,
  platform = process.platform,
  throwOnPersistenceFailure = false,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env, platform);
  const packagedKeychainBootstrap =
    keychainOnly && isPackagedApp && platform === "darwin";
  const canReadPlaintextFallback =
    !keychainOnly || isPlaintextFallbackAllowed(env);
  const persistenceFailure = (detail) => {
    const message =
      "Cloudsmith entitlement token could not be secured in macOS Keychain. " +
      `${detail} Reinstall the signed app or repair Keychain access, then retry.`;
    if (throwOnPersistenceFailure) {
      throw new Error(message);
    }
    console.error(`[Runtime Secrets] ${message}`);
    return "";
  };
  const persistAndVerify = (value) => {
    const persisted = upsertSecretInKeychain(
      KEYCHAIN_ACCOUNT_CLOUDSMITH_ENTITLEMENT,
      value,
      { env },
    );
    if (!keychainOnly) {
      return value;
    }
    if (persisted !== value) {
      return persistenceFailure("The Keychain write did not succeed.");
    }
    clearKeychainReadCache();
    const verified = readSecretFromKeychain(
      KEYCHAIN_ACCOUNT_CLOUDSMITH_ENTITLEMENT,
      { env },
    );
    if (verified !== value) {
      return persistenceFailure("The Keychain readback verification failed.");
    }
    return verified;
  };

  const directValue = String(env.CLOUDSMITH_ENTITLEMENT_TOKEN || "").trim();
  if (directValue) {
    const verified = persistAndVerify(directValue);
    if (packagedKeychainBootstrap && verified) {
      stripEnvKeysFromPaths(
        listMutableCloudsmithSecretPaths({ managedRoot }),
        ["CLOUDSMITH_ENTITLEMENT_TOKEN"],
      );
    }
    return verified;
  }

  if (packagedKeychainBootstrap) {
    // The signed resource remains authoritative after Phase 1 copies the
    // release payload into the mutable managed runtime. Reconcile against it
    // before accepting an existing Keychain value so a stale managed copy is
    // scrubbed only after verified secure persistence.
    const configuredValue = String(
      readFirstConfiguredValue(
        "CLOUDSMITH_ENTITLEMENT_TOKEN",
        listCloudsmithBootstrapCandidatePaths({ resourcesPath, managedRoot }),
      ) || "",
    ).trim();
    if (!configuredValue) {
      return readSecretFromKeychain(
        KEYCHAIN_ACCOUNT_CLOUDSMITH_ENTITLEMENT,
        { env },
      );
    }

    const keychainValue = readSecretFromKeychain(
      KEYCHAIN_ACCOUNT_CLOUDSMITH_ENTITLEMENT,
      { env },
    );
    const verified =
      keychainValue === configuredValue
        ? keychainValue
        : persistAndVerify(configuredValue);
    if (!verified) {
      return "";
    }
    stripEnvKeysFromPaths(
      listMutableCloudsmithSecretPaths({ managedRoot }),
      ["CLOUDSMITH_ENTITLEMENT_TOKEN"],
    );
    return verified;
  }

  const keychainValue = readSecretFromKeychain(
    KEYCHAIN_ACCOUNT_CLOUDSMITH_ENTITLEMENT,
    { env },
  );
  if (keychainValue) {
    return keychainValue;
  }

  if (!canReadPlaintextFallback) {
    return "";
  }

  const candidatePaths = listCloudsmithSecretCandidatePaths({
    projectRoot,
    resourcesPath,
    managedRoot,
    env,
  });
  const configuredValue = String(
    readFirstConfiguredValue("CLOUDSMITH_ENTITLEMENT_TOKEN", candidatePaths) ||
      "",
  ).trim();
  if (!configuredValue) {
    return "";
  }

  const persisted = upsertSecretInKeychain(
    KEYCHAIN_ACCOUNT_CLOUDSMITH_ENTITLEMENT,
    configuredValue,
    { env },
  );
  if (keychainOnly && !persisted) {
    return "";
  }
  if (keychainOnly && persisted) {
    stripEnvKeysFromPaths(
      listMutableCloudsmithSecretPaths({ managedRoot }),
      ["CLOUDSMITH_ENTITLEMENT_TOKEN"],
    );
  }
  return configuredValue;
}

function resolveCloudsmithApiKey({
  env = process.env,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
  isPackagedApp = false,
  platform = process.platform,
  throwOnPersistenceFailure = false,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env, platform);
  const packagedKeychainBootstrap =
    keychainOnly && isPackagedApp && platform === "darwin";
  const persistenceFailure = (detail) => {
    const message =
      "Cloudsmith API key could not be secured in macOS Keychain. " +
      `${detail} Reinstall the signed app or fix Keychain access, then retry.`;
    if (throwOnPersistenceFailure) {
      throw new Error(message);
    }
    console.error(`[Runtime Secrets] ${message}`);
    return "";
  };
  const persistAndVerify = (value) => {
    const persisted = upsertSecretInKeychain(
      KEYCHAIN_ACCOUNT_CLOUDSMITH_API_KEY,
      value,
      { env },
    );
    if (persisted !== value) {
      return persistenceFailure("The Keychain write did not succeed.");
    }
    clearKeychainReadCache();
    const verified = readSecretFromKeychain(
      KEYCHAIN_ACCOUNT_CLOUDSMITH_API_KEY,
      { env },
    );
    if (verified !== value) {
      return persistenceFailure("The Keychain readback verification failed.");
    }
    return verified;
  };
  const scrubManagedBootstrap = () => {
    stripEnvKeysFromPaths(
      listMutableCloudsmithSecretPaths({ managedRoot }),
      ["CLOUDSMITH_API_KEY"],
    );
  };

  const directValue = String(env.CLOUDSMITH_API_KEY || "").trim();
  if (directValue) {
    if (!packagedKeychainBootstrap) {
      return directValue;
    }
    const verified = persistAndVerify(directValue);
    if (verified) {
      scrubManagedBootstrap();
    }
    return verified;
  }

  if (packagedKeychainBootstrap) {
    // The signed resource is authoritative for each release and precedes the
    // mutable managed copy. This also rotates stale Keychain state before the
    // managed bootstrap file is scrubbed.
    const configuredValue = String(
      readFirstConfiguredValue(
        "CLOUDSMITH_API_KEY",
        listCloudsmithBootstrapCandidatePaths({ resourcesPath, managedRoot }),
      ) || "",
    ).trim();
    if (configuredValue) {
      const keychainValue = readSecretFromKeychain(
        KEYCHAIN_ACCOUNT_CLOUDSMITH_API_KEY,
        { env },
      );
      const verified =
        keychainValue === configuredValue
          ? keychainValue
          : persistAndVerify(configuredValue);
      if (verified) {
        scrubManagedBootstrap();
      }
      return verified;
    }
  }

  return readSecretFromKeychain(KEYCHAIN_ACCOUNT_CLOUDSMITH_API_KEY, { env });
}

function secureCloudsmithBootstrapSecrets({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
  isPackagedApp = false,
  platform = process.platform,
} = {}) {
  const apiKey = resolveCloudsmithApiKey({
    env,
    resourcesPath,
    managedRoot,
    isPackagedApp,
    platform,
    throwOnPersistenceFailure: true,
  });
  const entitlementToken = resolveCloudsmithEntitlementToken({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
    isPackagedApp,
    platform,
    throwOnPersistenceFailure: true,
  });

  if (!apiKey) {
    throw new Error(
      "Cloudsmith API key is unavailable after secure bootstrap reconciliation.",
    );
  }
  if (!entitlementToken) {
    throw new Error(
      "Cloudsmith entitlement token is unavailable after secure bootstrap reconciliation.",
    );
  }

  return {
    apiKeyPersisted: true,
    entitlementTokenPersisted: true,
  };
}

function resolveAiMarketplaceApiKey({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env);
  const canReadPlaintextFallback =
    !keychainOnly || isPlaintextFallbackAllowed(env);
  const directValue = String(env.AI_MARKETPLACE_API_KEY || "").trim();
  if (directValue) {
    persistKeychainSecret(KEYCHAIN_ACCOUNT_AI_MARKETPLACE, directValue, {
      env,
      keychainOnly,
      keyName: "AI_MARKETPLACE_API_KEY",
    });
    return directValue;
  }

  const keychainValue = readSecretFromKeychain(KEYCHAIN_ACCOUNT_AI_MARKETPLACE, {
    env,
  });
  if (keychainValue) {
    return keychainValue;
  }

  if (canReadPlaintextFallback) {
    const candidatePaths = listRuntimeSecretCandidatePaths({
      projectRoot,
      resourcesPath,
      managedRoot,
      env,
    });
    const configuredValue = String(
      readFirstConfiguredValue("AI_MARKETPLACE_API_KEY", candidatePaths) || "",
    ).trim();
    if (configuredValue) {
      persistKeychainSecret(KEYCHAIN_ACCOUNT_AI_MARKETPLACE, configuredValue, {
        env,
        keychainOnly,
        keyName: "AI_MARKETPLACE_API_KEY",
      });
      if (keychainOnly) {
        stripEnvKeysFromPaths(candidatePaths, ["AI_MARKETPLACE_API_KEY"]);
      }
      return configuredValue;
    }
  }

  const bundledValue = decodeBundledBase64Secret(
    BUNDLED_AI_MARKETPLACE_API_KEY_BASE64,
  );
  if (!bundledValue) {
    return "";
  }
  persistKeychainSecret(KEYCHAIN_ACCOUNT_AI_MARKETPLACE, bundledValue, {
    env,
    keychainOnly,
    keyName: "AI_MARKETPLACE_API_KEY",
  });
  return bundledValue;
}

function resolveLocalStackApiKey({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env);
  const canReadPlaintextFallback =
    !keychainOnly || isPlaintextFallbackAllowed(env);
  const directValue =
    env.LOCAL_STACK_API_KEY ||
    env.INTERNAL_OPENAI_API_KEY ||
    env.OPENAI_API_KEY;
  if (directValue) {
    persistKeychainSecret(KEYCHAIN_ACCOUNT_LOCAL_STACK, directValue, {
      env,
      keychainOnly,
      keyName: "LOCAL_STACK_API_KEY",
    });
    return directValue;
  }

  const keychainValue = readSecretFromKeychain(KEYCHAIN_ACCOUNT_LOCAL_STACK, {
    env,
  });
  if (keychainValue) {
    return keychainValue;
  }

  if (canReadPlaintextFallback) {
    const candidatePaths = listRuntimeSecretCandidatePaths({
      projectRoot,
      resourcesPath,
      managedRoot,
      env,
    });
    const persistedValue =
      readFirstConfiguredValue("LOCAL_STACK_API_KEY", candidatePaths) ||
      readFirstConfiguredValue("INTERNAL_OPENAI_API_KEY", candidatePaths) ||
      readFirstConfiguredValue("OPENAI_API_KEY", candidatePaths);
    if (persistedValue) {
      persistKeychainSecret(KEYCHAIN_ACCOUNT_LOCAL_STACK, persistedValue, {
        env,
        keychainOnly,
        keyName: "LOCAL_STACK_API_KEY",
      });
      if (keychainOnly) {
        stripEnvKeysFromPaths(candidatePaths, LOCAL_STACK_FILE_KEYS);
      }
      return persistedValue;
    }
  }

  const generatedValue = generateLocalStackApiKey();
  if (
    persistKeychainSecret(KEYCHAIN_ACCOUNT_LOCAL_STACK, generatedValue, {
      env,
      keychainOnly,
      keyName: "LOCAL_STACK_API_KEY",
    })
  ) {
    return generatedValue;
  }

  return upsertRuntimeSecret("LOCAL_STACK_API_KEY", generatedValue, {
    managedRoot,
    env,
  });
}

function resolveBifrostLocalApiKey({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env);
  const canReadPlaintextFallback =
    !keychainOnly || isPlaintextFallbackAllowed(env);
  const directValue = String(env.BIFROST_BRIDGE_LOCAL_API_KEY || "").trim();
  if (directValue) {
    persistKeychainSecret(KEYCHAIN_ACCOUNT_BIFROST_LOCAL, directValue, {
      env,
      keychainOnly,
      keyName: "BIFROST_BRIDGE_LOCAL_API_KEY",
    });
    return directValue;
  }

  const keychainValue = readSecretFromKeychain(KEYCHAIN_ACCOUNT_BIFROST_LOCAL, {
    env,
  });
  if (keychainValue) {
    return keychainValue;
  }

  if (canReadPlaintextFallback) {
    const candidatePaths = listRuntimeSecretCandidatePaths({
      projectRoot,
      resourcesPath,
      managedRoot,
      env,
    });
    const persistedValue = readFirstConfiguredValue(
      "BIFROST_BRIDGE_LOCAL_API_KEY",
      candidatePaths,
    );
    if (persistedValue) {
      persistKeychainSecret(KEYCHAIN_ACCOUNT_BIFROST_LOCAL, persistedValue, {
        env,
        keychainOnly,
        keyName: "BIFROST_BRIDGE_LOCAL_API_KEY",
      });
      if (keychainOnly) {
        stripEnvKeysFromPaths(candidatePaths, ["BIFROST_BRIDGE_LOCAL_API_KEY"]);
      }
      return persistedValue;
    }
  }

  const generatedValue = generateBifrostLocalApiKey();
  if (
    persistKeychainSecret(KEYCHAIN_ACCOUNT_BIFROST_LOCAL, generatedValue, {
      env,
      keychainOnly,
      keyName: "BIFROST_BRIDGE_LOCAL_API_KEY",
    })
  ) {
    return generatedValue;
  }

  return upsertRuntimeSecret("BIFROST_BRIDGE_LOCAL_API_KEY", generatedValue, {
    managedRoot,
    env,
  });
}

function resolveUltraMultiAgentSigningSecret(options = {}) {
  return resolveGeneratedRuntimeSecret({
    ...options,
    key: "ULTRA_MULTI_AGENT_SIGNING_SECRET",
    keychainAccount: KEYCHAIN_ACCOUNT_ULTRA_MULTI_AGENT,
    generator: generateUltraMultiAgentSigningSecret,
  });
}

function resolveOwuiAuthBridgeSecret(options = {}) {
  return resolveGeneratedRuntimeSecret({
    ...options,
    key: "OWUI_AUTH_BRIDGE_SECRET",
    keychainAccount: KEYCHAIN_ACCOUNT_OWUI_AUTH_BRIDGE,
    generator: generateOwuiAuthBridgeSecret,
  });
}

function resolveWebuiSecretKey(options = {}) {
  return resolveGeneratedRuntimeSecret({
    ...options,
    key: "WEBUI_SECRET_KEY",
    keychainAccount: KEYCHAIN_ACCOUNT_WEBUI_SECRET_KEY,
    generator: generateWebuiSecretKey,
  });
}

function resolvePorticoLlmApiKey({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env);
  const canReadPlaintextFallback =
    !keychainOnly || isPlaintextFallbackAllowed(env);
  const directValue = String(env.PORTICO_LLM_API_KEY || "").trim();
  if (directValue && !isMalformedPorticoLlmApiKey(directValue)) {
    persistKeychainSecret(KEYCHAIN_ACCOUNT_PORTICO, directValue, {
      env,
      keychainOnly,
      keyName: "PORTICO_LLM_API_KEY",
    });
    return directValue;
  }

  const keychainValue = readSecretFromKeychain(KEYCHAIN_ACCOUNT_PORTICO, {
    env,
  });
  if (keychainValue && !isMalformedPorticoLlmApiKey(keychainValue)) {
    return keychainValue;
  }

  const candidatePaths = listUpstreamSecretCandidatePaths({
    projectRoot,
    resourcesPath,
    managedRoot,
    env,
  });
  if (canReadPlaintextFallback) {
    const configuredValue = String(
      readFirstConfiguredValue("PORTICO_LLM_API_KEY", candidatePaths) || "",
    ).trim();
    if (configuredValue && !isMalformedPorticoLlmApiKey(configuredValue)) {
      persistKeychainSecret(KEYCHAIN_ACCOUNT_PORTICO, configuredValue, {
        env,
        keychainOnly,
        keyName: "PORTICO_LLM_API_KEY",
      });
      if (keychainOnly) {
        stripEnvKeysFromPaths(candidatePaths, ["PORTICO_LLM_API_KEY"]);
      }
      return configuredValue;
    }
  }

  const legacyFallback = resolveLegacyFallbackPorticoLlmApiKey();
  if (legacyFallback && !isMalformedPorticoLlmApiKey(legacyFallback)) {
    persistKeychainSecret(KEYCHAIN_ACCOUNT_PORTICO, legacyFallback, {
      env,
      keychainOnly,
      keyName: "PORTICO_LLM_API_KEY",
    });
    if (keychainOnly) {
      stripEnvKeysFromPaths(candidatePaths, ["PORTICO_LLM_API_KEY"]);
    }
    return legacyFallback;
  }

  return "";
}

function resolveMcpSensitiveEnvSecrets({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env);
  const markerPath = mcpSensitiveEnvMigrationMarkerPath(projectRoot);
  const migrationComplete = Boolean(markerPath && fs.existsSync(markerPath));
  const legacySourcePaths = projectRoot
    ? [path.join(projectRoot, ".env"), path.join(projectRoot, ".env.runtime")]
    : [];
  const scrubPaths = listRuntimeSecretCandidatePaths({
    projectRoot,
    resourcesPath,
    managedRoot,
    env,
  });
  if (projectRoot) {
    scrubPaths.push(path.join(projectRoot, ".env"));
    scrubPaths.push(path.join(projectRoot, ".env.runtime"));
  }

  const resolved = {};
  for (const key of discoverSensitiveRequiredEnvVars({ projectRoot })) {
    const directValue = String(env[key] || "").trim();
    if (directValue) {
      const persisted = persistKeychainSecret(key, directValue, {
        env,
        keychainOnly,
        keyName: key,
      });
      if (!persisted) {
        throw new Error(
          `Keychain persistence is required for sensitive MCP env var ${key}`,
        );
      }
      const verified = readSecretFromKeychain(key, { env });
      if (verified !== directValue) {
        throw new Error(
          `Keychain readback verification failed for sensitive MCP env var ${key}`,
        );
      }
      resolved[key] = verified;
      stripEnvKeysFromPaths(scrubPaths, [key, `${key}_FILE`]);
      continue;
    }

    const keychainValue = readSecretFromKeychain(key, { env });
    if (keychainValue) {
      resolved[key] = keychainValue;
      stripEnvKeysFromPaths(scrubPaths, [key, `${key}_FILE`]);
      continue;
    }

    if (!migrationComplete) {
      const legacyValue = readFirstConfiguredValue(key, legacySourcePaths);
      if (legacyValue) {
        const persisted = persistKeychainSecret(key, legacyValue, {
          env,
          keychainOnly,
          keyName: key,
        });
        if (!persisted) {
          throw new Error(
            `Keychain persistence is required for sensitive MCP env var ${key}`,
          );
        }
        const verified = readSecretFromKeychain(key, { env });
        if (verified !== legacyValue) {
          throw new Error(
            `Keychain readback verification failed for sensitive MCP env var ${key}`,
          );
        }
        resolved[key] = verified;
        stripEnvKeysFromPaths(scrubPaths, [key, `${key}_FILE`]);
      }
    }
  }

  if (markerPath && !migrationComplete) {
    writePrivateJsonAtomic(markerPath, {
      migration: MCP_SENSITIVE_ENV_KEYCHAIN_MIGRATION,
      completed_at: new Date().toISOString(),
    });
  }

  return resolved;
}

function getMcpSensitiveSecretPresence(
  serverId,
  {
    env = process.env,
    projectRoot = null,
    resourcesPath = process.resourcesPath,
    managedRoot = DEFAULT_MANAGED_ROOT,
  } = {},
) {
  const normalizedServerId = String(serverId || "").trim();
  if (!normalizedServerId) {
    throw new Error("MCP server ID is required");
  }
  const resolved = resolveMcpSensitiveEnvSecrets({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  const presence = {};
  for (const descriptor of discoverSensitiveRequiredEnvVarDescriptors({
    projectRoot,
  })) {
    if (descriptor.serverId === normalizedServerId) {
      presence[descriptor.key] = Boolean(resolved[descriptor.key]);
    }
  }
  return presence;
}

function resolveMcpSensitiveRuntimeFileSecrets({
  env = process.env,
  projectRoot = null,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (!projectRoot) {
    return [];
  }

  const keychainOnly = isKeychainOnlyMode(env);
  const imported = [];
  for (const runtimeFile of discoverSensitiveRuntimeFiles({ projectRoot })) {
    const account = sensitiveRuntimeFileKeychainAccount(
      runtimeFile.serverId,
      runtimeFile.target,
    );
    try {
      const metadata = fs.existsSync(runtimeFile.sourcePath)
        ? fs.statSync(runtimeFile.sourcePath)
        : null;
      if (metadata?.isFile()) {
        const sourceBytes = fs.readFileSync(runtimeFile.sourcePath);
        if (isSensitiveRuntimeFileStubContent(sourceBytes)) {
          const persistedBytes = readSensitiveRuntimeFilePersistedBytes({
            serverId: runtimeFile.serverId,
            target: runtimeFile.target,
            env,
            homeDir,
            platform,
          });
          if (persistedBytes) {
            // Legacy stub left by a build that still scrubbed the source.
            // Repair the user-owned file from secure storage exactly once per
            // session, and only when the stub carries no user content below
            // the marker — anything else on disk is not ours to rewrite.
            let sourceScrubbed = true;
            if (
              isPureSensitiveRuntimeFileStubContent(sourceBytes) &&
              !sensitiveRuntimeFileRestoreAttempted.has(account)
            ) {
              sensitiveRuntimeFileRestoreAttempted.add(account);
              try {
                restoreSensitiveRuntimeFileSource(
                  runtimeFile.sourcePath,
                  persistedBytes,
                );
                sensitiveRuntimeFileImportedSourceHashes.set(
                  account,
                  sensitiveRuntimeFileSourceHash(persistedBytes),
                );
                sourceScrubbed = false;
                notifySensitiveRuntimeFileSourceRestored(runtimeFile);
              } catch (_error) {
                // The stub stays (e.g. read-only directory); Keychain-backed
                // provisioning is unaffected and startup must not fail here.
              }
            }
            imported.push({
              ...runtimeFile,
              secretName: sensitiveRuntimeFileSecretName(
                runtimeFile.serverId,
                runtimeFile.target,
              ),
              available: true,
              importedFromSource: false,
              sourceScrubbed,
            });
          }
          continue;
        }
        const sourceHash = sensitiveRuntimeFileSourceHash(sourceBytes);
        if (sensitiveRuntimeFileImportedSourceHashes.get(account) === sourceHash) {
          const persistedBytes = readSensitiveRuntimeFilePersistedBytes({
            serverId: runtimeFile.serverId,
            target: runtimeFile.target,
            env,
            homeDir,
            platform,
          });
          if (persistedBytes) {
            imported.push({
              ...runtimeFile,
              secretName: sensitiveRuntimeFileSecretName(
                runtimeFile.serverId,
                runtimeFile.target,
              ),
              available: true,
              importedFromSource: false,
              sourceScrubbed: false,
            });
            continue;
          }
          // The Keychain entry vanished mid-session — re-import below.
          sensitiveRuntimeFileImportedSourceHashes.delete(account);
        }
        const migratedSourceBytes = migrateLegacySnowflakeRuntimeFileBytes(
          runtimeFile.serverId,
          sourceBytes,
        );
        const encoded = (migratedSourceBytes || sourceBytes).toString("base64");
        let persisted = "";
        if (encoded) {
          persisted = persistKeychainSecret(account, encoded, {
            env,
            keychainOnly,
            keyName: `runtime file ${runtimeFile.serverId}:${runtimeFile.target}`,
          });
          if (!persisted && keychainOnly) {
            throw new Error(
              `Keychain persistence is required for sensitive runtime file ${runtimeFile.serverId}:${runtimeFile.target}`,
            );
          }
          if (persisted) {
            sensitiveRuntimeFileImportedSourceHashes.set(account, sourceHash);
          }
        }
        imported.push({
          ...runtimeFile,
          secretName: sensitiveRuntimeFileSecretName(
            runtimeFile.serverId,
            runtimeFile.target,
          ),
          available: Boolean(persisted),
          importedFromSource: true,
          sourceScrubbed: false,
        });
        continue;
      }
      const persistedBytes = readSensitiveRuntimeFilePersistedBytes({
        serverId: runtimeFile.serverId,
        target: runtimeFile.target,
        env,
        homeDir,
        platform,
      });
      if (persistedBytes) {
        imported.push({
          ...runtimeFile,
          secretName: sensitiveRuntimeFileSecretName(
            runtimeFile.serverId,
            runtimeFile.target,
          ),
          available: true,
          importedFromSource: false,
        });
      }
    } catch (error) {
      if (keychainOnly) {
        throw error;
      }
    }
  }
  return imported;
}

function isMalformedPorticoLlmApiKey(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return true;
  }
  if (normalized.length < MIN_PORTICO_LLM_API_KEY_LENGTH) {
    return true;
  }
  if (KNOWN_INVALID_PORTICO_LLM_KEYS.has(normalized)) {
    return true;
  }
  if (JWT_LIKE_PATTERN.test(normalized)) {
    return true;
  }
  return PORTICO_LLM_PLACEHOLDER_PATTERN.test(normalized);
}

function stripLegacyPorticoLlmApiKeyFromRuntimeFiles({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
} = {}) {
  const stripped = [];
  const candidatePaths = listRuntimeSecretCandidatePaths({
    projectRoot,
    resourcesPath,
    managedRoot,
    env,
  });

  stripped.push(...stripEnvKeysFromPaths(candidatePaths, ["PORTICO_LLM_API_KEY"]));

  return stripped;
}

function slackPkceMigrationMarkerPath(projectRoot) {
  if (!projectRoot) {
    return "";
  }
  return path.join(
    projectRoot,
    "open-webui-data",
    "runtime-migrations",
    "slack-pkce-public-client-artifacts-cleared-v2",
  );
}

function removeEmptyDirectory(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return false;
  }
  try {
    fs.rmdirSync(dirPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function pruneEmptyLegacySlackOAuthDirs(projectRoot) {
  if (!projectRoot) {
    return 0;
  }
  let removed = 0;
  for (const rootName of ["mcpo-oauth-tokens", "mcpo-core-oauth-tokens"]) {
    const rootDir = path.join(projectRoot, rootName);
    const serverDir = path.join(rootDir, "slack");
    const tokensDir = path.join(serverDir, "tokens");
    for (const dirPath of [tokensDir, serverDir, rootDir]) {
      if (removeEmptyDirectory(dirPath)) {
        removed += 1;
      }
    }
  }
  return removed;
}

function clearLegacySlackOAuthArtifacts({ projectRoot = null } = {}) {
  const markerPath = slackPkceMigrationMarkerPath(projectRoot);
  if (!markerPath) {
    return { cleared: false, skipped: true, reason: "project_root_missing" };
  }
  if (fs.existsSync(markerPath)) {
    pruneEmptyLegacySlackOAuthDirs(projectRoot);
    return { cleared: false, skipped: true, reason: "already_migrated" };
  }

  const tokenDirs = [
    path.join(projectRoot, "mcpo-oauth-tokens", "slack", "tokens"),
    path.join(projectRoot, "mcpo-core-oauth-tokens", "slack", "tokens"),
  ];
  const clearedFiles = [];
  for (const tokensDir of tokenDirs) {
    if (!fs.existsSync(tokensDir)) {
      continue;
    }
    for (const dirent of fs.readdirSync(tokensDir, { withFileTypes: true })) {
      if (!dirent.isFile()) {
        continue;
      }
      if (
        !dirent.name.endsWith("_tokens.json") &&
        !dirent.name.endsWith("_client.json")
      ) {
        continue;
      }
      const filePath = path.join(tokensDir, dirent.name);
      fs.unlinkSync(filePath);
      clearedFiles.push(filePath);
    }
  }
  pruneEmptyLegacySlackOAuthDirs(projectRoot);

  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      migration: "slack-pkce-public-client-artifacts-cleared",
      marker_version: 2,
      cleared_at: new Date().toISOString(),
      cleared_files: clearedFiles.length,
    }) + "\n",
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(markerPath, 0o600);
  } catch (_error) {
    // Best-effort on non-POSIX filesystems.
  }
  return { cleared: clearedFiles.length > 0, clearedFiles, markerPath };
}

function cleanupLegacyBundledSlackKeychainCredentials({
  env = process.env,
} = {}) {
  const metadataRaw = readSecretFromKeychain(
    LEGACY_KEYCHAIN_ACCOUNT_SLACK_OAUTH_CREDENTIALS_METADATA,
    { env },
  );
  if (!metadataRaw) {
    return { deleted: false, reason: "missing_metadata" };
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataRaw);
  } catch (_error) {
    return { deleted: false, reason: "invalid_metadata" };
  }

  if (metadata?.owner !== "bundled") {
    return { deleted: false, reason: "not_bundled" };
  }

  const accounts = [
    LEGACY_KEYCHAIN_ACCOUNT_SLACK_OAUTH_CLIENT_ID,
    LEGACY_KEYCHAIN_ACCOUNT_SLACK_OAUTH_CLIENT_SECRET,
    LEGACY_KEYCHAIN_ACCOUNT_SLACK_OAUTH_CREDENTIALS_METADATA,
  ];
  let deletedCount = 0;
  for (const account of accounts) {
    if (deleteSecretFromKeychain(account, { env })) {
      deletedCount += 1;
    }
  }
  return { deleted: deletedCount > 0, deletedCount };
}

// Packaged macOS always scrubs plaintext fallbacks post-Keychain, even when
// keychain-only mode isn't explicitly on. Dev/test environments still follow
// the explicit keychain-only opt-in so they can keep working with runtime
// files during local development.
function shouldAutoScrubAfterKeychain({ env, platform, isPackagedApp }) {
  if (platform !== "darwin") {
    return false;
  }
  if (isKeychainDisabled(env)) {
    return false;
  }
  if (isTruthyFlag(env?.PORTICO_RUNTIME_ALLOW_PLAINTEXT_FALLBACK)) {
    return false;
  }
  return Boolean(isPackagedApp);
}

function buildRuntimeSecretEnv({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = DEFAULT_MANAGED_ROOT,
  isPackagedApp = false,
  platform = process.platform,
} = {}) {
  const keychainOnly = isKeychainOnlyMode(env, platform);
  const autoScrubAfterKeychain = shouldAutoScrubAfterKeychain({
    env,
    platform,
    isPackagedApp,
  });
  const shouldScrubPlaintext = keychainOnly || autoScrubAfterKeychain;
  const localStackApiKey = resolveLocalStackApiKey({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  const bifrostLocalApiKey = resolveBifrostLocalApiKey({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  const ultraMultiAgentSigningSecret = resolveUltraMultiAgentSigningSecret({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  const owuiAuthBridgeSecret = resolveOwuiAuthBridgeSecret({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  const webuiSecretKey = resolveWebuiSecretKey({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  const upstreamKey = resolvePorticoLlmApiKey({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  validateUltraMultiAgentSigningSecret(ultraMultiAgentSigningSecret, {
    localStackApiKey,
    bifrostLocalApiKey,
    owuiAuthBridgeSecret,
    webuiSecretKey,
    upstreamKey,
  });
  const cloudsmithEntitlementToken = resolveCloudsmithEntitlementToken({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
    isPackagedApp,
    platform,
    throwOnPersistenceFailure: isPackagedApp && platform === "darwin",
  });
  // This credential is required only by the Electron updater. Resolve it here
  // to complete packaged bootstrap persistence and scrubbing, but never add it
  // to the child runtime environment below.
  resolveCloudsmithApiKey({
    env,
    resourcesPath,
    managedRoot,
    isPackagedApp,
    platform,
    throwOnPersistenceFailure: isPackagedApp && platform === "darwin",
  });
  resolveAiMarketplaceApiKey({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  cleanupLegacyBundledSlackKeychainCredentials({ env });
  clearLegacySlackOAuthArtifacts({ projectRoot });
  const mcpSensitiveSecrets = resolveMcpSensitiveEnvSecrets({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  const resolvedRuntimeFileSecrets = resolveMcpSensitiveRuntimeFileSecrets({
    env,
    projectRoot,
  });
  const availableRuntimeFileSecrets = new Set(
    resolvedRuntimeFileSecrets
      .filter((runtimeFile) => runtimeFile.available === true)
      .map((runtimeFile) => `${runtimeFile.serverId}\0${runtimeFile.secretName}`),
  );

  const runtimeSecrets = {
    LOCAL_STACK_API_KEY: localStackApiKey,
    INTERNAL_OPENAI_API_KEY: localStackApiKey,
    OPENAI_API_KEY: localStackApiKey,
    BIFROST_BRIDGE_LOCAL_API_KEY: bifrostLocalApiKey,
    ULTRA_MULTI_AGENT_SIGNING_SECRET: ultraMultiAgentSigningSecret,
    OWUI_AUTH_BRIDGE_SECRET: owuiAuthBridgeSecret,
    WEBUI_SECRET_KEY: webuiSecretKey,
  };

  if (upstreamKey) {
    runtimeSecrets.PORTICO_LLM_API_KEY = upstreamKey;
  }
  if (cloudsmithEntitlementToken) {
    runtimeSecrets.CLOUDSMITH_ENTITLEMENT_TOKEN = cloudsmithEntitlementToken;
  }
  const availableMcpSensitiveSecrets = new Set(Object.keys(mcpSensitiveSecrets));
  for (const descriptor of discoverSensitiveRequiredEnvVarDescriptors({
    projectRoot,
  })) {
    runtimeSecrets[
      staticSecretAvailabilityEnvVar(
        descriptor.serverId,
        descriptor.secretName,
      )
    ] = availableMcpSensitiveSecrets.has(descriptor.key) ? "1" : "";
  }
  for (const runtimeFile of discoverSensitiveRuntimeFiles({ projectRoot })) {
    const secretName = sensitiveRuntimeFileSecretName(
      runtimeFile.serverId,
      runtimeFile.target,
    );
    const availabilityKey = staticSecretAvailabilityEnvVar(
      runtimeFile.serverId,
      secretName,
    );
    runtimeSecrets[availabilityKey] = availableRuntimeFileSecrets.has(
      `${runtimeFile.serverId}\0${secretName}`,
    )
      ? "1"
      : "";
  }

  const runtimeCandidatePaths = listRuntimeSecretCandidatePaths({
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  });
  stripEnvKeysFromPaths(runtimeCandidatePaths, STALE_SLACK_OAUTH_CLIENT_KEYS);
  if (projectRoot) {
    stripEnvKeysFromPaths(
      [path.join(projectRoot, ".env"), path.join(projectRoot, ".env.runtime")],
      STALE_SLACK_OAUTH_CLIENT_KEYS,
    );
  }

  if (shouldScrubPlaintext) {
    const dynamicMcpSecretKeys = new Set();
    for (const key of discoverSensitiveRequiredEnvVars({ projectRoot })) {
      dynamicMcpSecretKeys.add(key);
      dynamicMcpSecretKeys.add(`${key}_FILE`);
    }
    const scrubKeys = runtimeSecretEnvFileKeys({ projectRoot }).filter(
      (key) => !dynamicMcpSecretKeys.has(key),
    );
    stripEnvKeysFromPaths(runtimeCandidatePaths, scrubKeys);

    const upstreamCandidatePaths = listUpstreamSecretCandidatePaths({
      env,
      projectRoot,
      resourcesPath,
      managedRoot,
    });
    stripEnvKeysFromPaths(upstreamCandidatePaths, ["PORTICO_LLM_API_KEY"]);

    const cloudsmithScrubTargets = listMutableCloudsmithSecretPaths({
      managedRoot,
    });
    stripEnvKeysFromPaths(cloudsmithScrubTargets, [
      "CLOUDSMITH_ENTITLEMENT_TOKEN",
    ]);

    if (projectRoot) {
      const projectEnvPath = path.join(projectRoot, ".env");
      stripEnvKeysFromPaths(
        [projectEnvPath],
        scrubKeys,
      );
    }
  }

  return runtimeSecrets;
}

module.exports = {
  DEFAULT_MANAGED_ROOT,
  RUNTIME_SECRET_ENV_FILE_KEYS,
  RUNTIME_SECRET_REGISTRY,
  RUNTIME_SECRET_SCOPE,
  RUNTIME_SECRETS_FILE_NAME,
  SENSITIVE_RUNTIME_FILE_STUB,
  SENSITIVE_RUNTIME_FILE_STUB_MARKER,
  SNOWFLAKE_GENERATED_CONNECTIONS_MARKER,
  buildRuntimeSecretEnv,
  migrateLegacySnowflakeRuntimeFileBytes,
  clearLegacySlackOAuthArtifacts,
  cleanupLegacyBundledSlackKeychainCredentials,
  collectSensitiveEnvVarsFromServerConfig,
  collectSensitiveRuntimeFilesFromServerConfig,
  deleteRuntimeSecret,
  discoverSensitiveRequiredEnvVars,
  discoverSensitiveRuntimeFiles,
  discoverSensitiveRequiredEnvVarDescriptors,
  dockerSecretNameForEnvVar,
  ensureRuntimeSecretsFile,
  expandRuntimeFileSource,
  isMalformedPorticoLlmApiKey,
  isSensitiveRuntimeFileStubContent,
  isSensitiveRuntimeFileStubFile,
  isSensitiveRuntimeFilePersisted,
  isRuntimeWritableSecretKey,
  getMcpSensitiveSecretPresence,
  listCloudsmithSecretCandidatePaths,
  listCloudsmithBootstrapCandidatePaths,
  listMutableCloudsmithSecretPaths,
  listRuntimeSecretCandidatePaths,
  listRuntimeWritableSecretKeys,
  listUpstreamSecretCandidatePaths,
  parseEnvFile,
  readSensitiveRuntimeFilePersistedBytes,
  readFirstConfiguredValue,
  resolveAiMarketplaceApiKey,
  resolveBifrostLocalApiKey,
  resolveUltraMultiAgentSigningSecret,
  validateUltraMultiAgentSigningSecret,
  resolveCloudsmithApiKey,
  resolveCloudsmithEntitlementToken,
  secureCloudsmithBootstrapSecrets,
  resolvePorticoLlmApiKey,
  resolveLocalStackApiKey,
  resolveMcpSensitiveEnvSecrets,
  resolveMcpSensitiveRuntimeFileSecrets,
  resetSensitiveRuntimeFileImportSessionStateForTests,
  runtimeSecretEnvFileKeys,
  runtimeFileSensitiveFlag,
  sensitiveRuntimeFileCachePath,
  sensitiveRuntimeFileKeychainAccount,
  sensitiveRuntimeFileSecretEnvVar,
  sensitiveRuntimeFileSecretName,
  sensitiveRuntimeFileTarget,
  oauthAccessTokenTokenEnvVar,
  staticSecretAvailabilityEnvVar,
  staticSecretTokenEnvVar,
  shouldAutoScrubAfterKeychain,
  stripLegacyPorticoLlmApiKeyFromRuntimeFiles,
  upsertRuntimeSecret,
  writeRuntimeSecretsFile,
};
