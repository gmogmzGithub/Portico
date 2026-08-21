// Environment variable management for guided setup wizard
// Refactored to use secure IPC instead of direct Node.js fs access

const {
  getRequiredEnvVars,
  serverRequiresConfig,
} = require('./server-requirements');

// Reference to project root (set by init) - kept for compatibility
let PROJECT_ROOT = null;
// Canonical runtime secret keys persisted via upsertRuntimeSecret.
// Do not add aliases here - wizard persistence is only defined for these.
const RUNTIME_SECRET_KEYS = new Set([
  "PORTICO_LLM_API_KEY",
  "LOCAL_STACK_API_KEY",
  "BIFROST_BRIDGE_LOCAL_API_KEY",
  "OWUI_AUTH_BRIDGE_SECRET",
  "WEBUI_SECRET_KEY",
  "ULTRA_MULTI_AGENT_SIGNING_SECRET",
  "CLOUDSMITH_ENTITLEMENT_TOKEN",
]);

// Broader strip set: canonical runtime keys + aliases + _FILE pointers.
// CLOUDSMITH_API_KEY is protected release-operator input in the repository
// .env. It remains hidden from setup forms but must survive every rewrite.
const RUNTIME_SECRET_STRIP_KEYS = new Set([
  ...RUNTIME_SECRET_KEYS,
  "INTERNAL_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "PORTICO_LLM_API_KEY_FILE",
  "BIFROST_BRIDGE_LOCAL_API_KEY_FILE",
  "OWUI_AUTH_BRIDGE_SECRET_FILE",
  "WEBUI_SECRET_KEY_FILE",
  "ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE",
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_CLIENT_SECRET",
  "SLACK_OAUTH_CLIENT_ID_FILE",
  "SLACK_OAUTH_CLIENT_SECRET_FILE",
  "SLACK_MCP_XOXP_TOKEN",
  "SLACK_MCP_XOXP_TOKEN_FILE",
]);
const RUNTIME_SECRET_LOAD_SKIP_KEYS = new Set([
  ...RUNTIME_SECRET_STRIP_KEYS,
  "CLOUDSMITH_API_KEY",
]);
const SENSITIVE_REQUIRED_ENV_KEYS = new Set();

// Initialize with project root (kept for API compatibility)
function init(projectRoot) {
  PROJECT_ROOT = projectRoot;
}

function configureSensitiveRequiredEnvVars(servers = []) {
  SENSITIVE_REQUIRED_ENV_KEYS.clear();
  for (const server of Array.isArray(servers) ? servers : []) {
    for (const envVar of server.required_env_vars || server.requiredVars || []) {
      if (envVar && typeof envVar === "object" && envVar.sensitive === true) {
        const name = String(envVar.name || "").trim();
        if (name) {
          SENSITIVE_REQUIRED_ENV_KEYS.add(name);
          RUNTIME_SECRET_STRIP_KEYS.add(name);
          RUNTIME_SECRET_STRIP_KEYS.add(`${name}_FILE`);
          RUNTIME_SECRET_LOAD_SKIP_KEYS.add(name);
          RUNTIME_SECRET_LOAD_SKIP_KEYS.add(`${name}_FILE`);
        }
      }
    }
  }
}

// Get project root
function getProjectRoot() {
  return PROJECT_ROOT;
}

function isRuntimeSecretKey(key) {
  return RUNTIME_SECRET_KEYS.has(key) || SENSITIVE_REQUIRED_ENV_KEYS.has(key);
}

function isRuntimeSecretLoadSkipKey(key) {
  return RUNTIME_SECRET_LOAD_SKIP_KEYS.has(key);
}

function stripRuntimeSecretsFromEnvContent(envContent) {
  let nextContent = String(envContent || "");
  for (const runtimeKey of RUNTIME_SECRET_STRIP_KEYS) {
    const runtimeKeyRegex = new RegExp(`^${runtimeKey}=.*$`, "gm");
    if (nextContent.match(runtimeKeyRegex)) {
      nextContent = nextContent.replace(runtimeKeyRegex, "");
    }
  }
  return nextContent.replace(/\n\n\n+/g, "\n\n");
}

async function persistRuntimeSecretIfNeeded(key, value) {
  if (!isRuntimeSecretKey(key)) {
    return false;
  }

  const normalizedValue = typeof value === "string" ? value.trim() : "";
  if (!normalizedValue || isPlaceholderValue(normalizedValue)) {
    console.log(
      `[persistRuntimeSecretIfNeeded] Skipping empty/placeholder runtime secret for ${key}`,
    );
    return true;
  }

  if (typeof window?.electronAPI?.upsertRuntimeSecret !== "function") {
    throw new Error("Runtime secret persistence is unavailable");
  }

  const persistResult = await window.electronAPI.upsertRuntimeSecret(
    key,
    normalizedValue,
  );
  if (!persistResult?.success) {
    throw new Error(persistResult?.error || `Failed to persist ${key}`);
  }

  console.log(
    `[persistRuntimeSecretIfNeeded] Persisted runtime secret for ${key}`,
  );
  return true;
}

const PLACEHOLDER_VALUE_PATTERNS = [
  /^your[-_]/i,
  /placeholder/i,
  /^example(?:[-_]|$)/i,
  /(?:^|[-_\s])(api[-_\s]?)?key[-_\s]?here(?:$|[-_\s])/i,
  /(?:^|[-_\s])paste[-_\s]?here(?:$|[-_\s])/i,
];

// Check if value is a placeholder
function isPlaceholderValue(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return false;
  }
  return PLACEHOLDER_VALUE_PATTERNS.some((pattern) =>
    pattern.test(normalizedValue),
  );
}

// Clean deprecated environment variables from env content
function cleanDeprecatedEnvVars(envContent, deprecatedVars) {
  if (!deprecatedVars || deprecatedVars.length === 0) {
    return envContent;
  }

  for (const varName of deprecatedVars) {
    const regex = new RegExp(`^${varName}=.*$`, 'gm');
    if (envContent.match(regex)) {
      console.log(`[cleanDeprecatedEnvVars] Removing deprecated: ${varName}`);
      envContent = envContent.replace(regex, '');
    }
  }

  // Clean up double newlines left behind
  envContent = envContent.replace(/\n\n\n+/g, '\n\n');
  return envContent;
}

// Check if a server is already configured
function isServerConfigured(server, envVars) {
  if (server?.isConfigured === true) {
    return true;
  }

  if (!serverRequiresConfig(server)) {
    return true; // Servers without required vars are always "configured"
  }

  // Check if all required environment variables are set
  for (const envVar of getRequiredEnvVars(server)) {
    const varName = typeof envVar === "string" ? envVar : envVar?.name;
    const value = varName ? envVars[varName] : "";
    if (!value || isPlaceholderValue(value)) {
      return false;
    }
  }

  return true;
}

// Load existing environment variables from .env file
async function loadExistingEnvVars() {
  const envVars = {};

  try {
    const result = await window.electronAPI.readEnvFile();

    if (!result.success || !result.content) {
      console.log('[loadExistingEnvVars] No existing .env file or empty content');
      return envVars;
    }

    const envContent = result.content;

    // Parse .env file
    const envLines = envContent.split('\n');
    for (const line of envLines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=');

        // Runtime-only secrets (including aliases and _FILE pointers) are
        // resolved at runtime and should not hydrate setup forms.
        if (isRuntimeSecretLoadSkipKey(key)) {
          console.log(`[loadExistingEnvVars] Skipping runtime-only key: ${key}`);
          continue;
        }

        if (key && value && !isPlaceholderValue(value)) {
          envVars[key] = value;
        }
      }
    }

    console.log('[loadExistingEnvVars] Loaded env vars:', Object.keys(envVars));
  } catch (err) {
    console.log('[loadExistingEnvVars] Error reading .env:', err.message);
  }

  return envVars;
}

// Save single environment variable to .env file immediately
async function saveEnvVarImmediately(key, value) {
  console.log(`[saveEnvVarImmediately] Starting save for ${key}`);

  // Runtime-only secrets are persisted outside .env (main process decides secure store).
  if (await persistRuntimeSecretIfNeeded(key, value)) {
    return;
  }

  try {
    // Read existing .env content via IPC
    const readResult = await window.electronAPI.readEnvFile();

    let envContent = '';
    if (readResult.success && readResult.content) {
      envContent = readResult.content;
    } else {
      // If .env doesn't exist, create basic env file
      envContent = '# Portico Configuration\n\n';
    }

    envContent = stripRuntimeSecretsFromEnvContent(envContent);

    // Add or update the specific variable
    // Escape special regex characters in the key
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedKey}=.*$`, 'm');

    console.log(`[saveEnvVarImmediately] Looking for key: ${key}`);
    console.log(`[saveEnvVarImmediately] Found match: ${envContent.match(regex) ? 'YES' : 'NO'}`);

    if (envContent.match(regex)) {
      console.log(`[saveEnvVarImmediately] Replacing existing ${key}`);
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      console.log(`[saveEnvVarImmediately] Adding new ${key}`);
      envContent += `\n${key}=${value}`;
    }

    // Write updated .env file via IPC
    const writeResult = await window.electronAPI.writeEnvFile(envContent);

    if (!writeResult.success) {
      throw new Error(writeResult.error || 'Failed to write .env file');
    }

    console.log(`[saveEnvVarImmediately] Successfully saved ${key} to .env file`);

  } catch (err) {
    console.error(`[saveEnvVarImmediately] Failed to save ${key}:`, err);
    throw new Error(`Failed to save ${key} to .env file: ${err.message}`);
  }
}

// Generate .env file (used for finalization)
async function generateEnvFile(envVars) {
  try {
    // Read existing .env or create new via IPC
    const readResult = await window.electronAPI.readEnvFile();

    let envContent = '';
    if (readResult.success && readResult.content) {
      envContent = readResult.content;
    } else {
      // If .env doesn't exist, create basic env file
      envContent = '# Portico Configuration\n\n';
    }

    envContent = stripRuntimeSecretsFromEnvContent(envContent);

    // Ensure all configured environment variables are saved.
    // Runtime-only secrets are persisted through secure runtime storage instead.
    for (const [key, value] of Object.entries(envVars)) {
      if (await persistRuntimeSecretIfNeeded(key, value)) {
        continue;
      }

      // Escape special regex characters in the key
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
      if (envContent.match(regex)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    // Write .env file via IPC
    const writeResult = await window.electronAPI.writeEnvFile(envContent);

    if (!writeResult.success) {
      throw new Error(writeResult.error || 'Failed to write .env file');
    }

    console.log('[generateEnvFile] .env file updated');

  } catch (err) {
    throw new Error(`Failed to update .env file: ${err.message}`);
  }
}

// Export functions
module.exports = {
  init,
  getProjectRoot,
  isPlaceholderValue,
  cleanDeprecatedEnvVars,
  isServerConfigured,
  loadExistingEnvVars,
  configureSensitiveRequiredEnvVars,
  saveEnvVarImmediately,
  generateEnvFile
};
