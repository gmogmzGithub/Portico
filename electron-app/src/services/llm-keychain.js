const { execFileSync, execFile } = require("node:child_process");

const DEFAULT_KEYCHAIN_SERVICE = "portico";
const DEFAULT_KEYCHAIN_ACCOUNT = "PORTICO_LLM_API_KEY";

let cachedValue = "";
let cachedIdentity = "";
let cacheInitialized = false;

function normalizeSecretValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isSupportedPlatform(platform = process.platform) {
  return platform === "darwin";
}

function getKeychainCoordinates(env = process.env) {
  const service = normalizeSecretValue(env?.PORTICO_LLM_KEYCHAIN_SERVICE);
  const account = normalizeSecretValue(env?.PORTICO_LLM_KEYCHAIN_ACCOUNT);

  return {
    service: service || DEFAULT_KEYCHAIN_SERVICE,
    account: account || DEFAULT_KEYCHAIN_ACCOUNT,
  };
}

function isKeychainItemMissing(error) {
  if (!error) {
    return false;
  }

  if (Number(error.status) === 44) {
    return true;
  }

  const message = String(error?.message || "");
  const stderr = String(error?.stderr || "");
  return /could not be found|specified item could not be found/i.test(
    `${message}\n${stderr}`,
  );
}

function keychainCacheIdentity({ service, account, platform }) {
  return `${platform}::${service}::${account}`;
}

function readPorticoLlmApiKeyFromKeychainSync({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!isSupportedPlatform(platform)) {
    return "";
  }

  const { service, account } = getKeychainCoordinates(env);
  const cacheIdentity = keychainCacheIdentity({ service, account, platform });
  if (cacheInitialized && cachedIdentity === cacheIdentity) {
    return cachedValue;
  }

  try {
    const stdout = execFileSyncImpl(
      "security",
      [
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    cachedValue = normalizeSecretValue(stdout);
    cachedIdentity = cacheIdentity;
    cacheInitialized = true;
    return cachedValue;
  } catch (error) {
    if (isKeychainItemMissing(error)) {
      cachedValue = "";
      cachedIdentity = cacheIdentity;
      cacheInitialized = true;
      return "";
    }

    const wrapped = new Error(
      `Failed to read PORTICO_LLM_API_KEY from macOS Keychain: ${error.message}`,
    );
    wrapped.code = "keychain_read_failed";
    throw wrapped;
  }
}

function upsertPorticoLlmApiKeyInKeychainSync(
  value,
  {
    env = process.env,
    platform = process.platform,
    execFileSyncImpl = execFileSync,
  } = {},
) {
  if (!isSupportedPlatform(platform)) {
    throw new Error("macOS Keychain is only available on Darwin hosts");
  }

  const normalizedValue = normalizeSecretValue(value);
  if (!normalizedValue) {
    throw new Error("PORTICO_LLM_API_KEY must be a non-empty string");
  }

  const { service, account } = getKeychainCoordinates(env);
  try {
    execFileSyncImpl(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
        normalizedValue,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const wrapped = new Error(
      `Failed to persist PORTICO_LLM_API_KEY to macOS Keychain: ${error.message}`,
    );
    wrapped.code = "keychain_write_failed";
    throw wrapped;
  }

  cachedIdentity = keychainCacheIdentity({ service, account, platform });
  cachedValue = normalizedValue;
  cacheInitialized = true;
  return normalizedValue;
}

function execFilePromise(execFileImpl, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function upsertPorticoLlmApiKeyInKeychain(
  value,
  { env = process.env, platform = process.platform, execFileImpl = execFile } = {},
) {
  if (!isSupportedPlatform(platform)) {
    throw new Error("macOS Keychain is only available on Darwin hosts");
  }

  const normalizedValue = normalizeSecretValue(value);
  if (!normalizedValue) {
    throw new Error("PORTICO_LLM_API_KEY must be a non-empty string");
  }

  const { service, account } = getKeychainCoordinates(env);
  try {
    await execFilePromise(
      execFileImpl,
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
        normalizedValue,
      ],
      {
        encoding: "utf8",
      },
    );
  } catch (error) {
    const wrapped = new Error(
      `Failed to persist PORTICO_LLM_API_KEY to macOS Keychain: ${error.message}`,
    );
    wrapped.code = "keychain_write_failed";
    throw wrapped;
  }

  cachedIdentity = keychainCacheIdentity({ service, account, platform });
  cachedValue = normalizedValue;
  cacheInitialized = true;
  return normalizedValue;
}

function deletePorticoLlmApiKeyFromKeychainSync({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!isSupportedPlatform(platform)) {
    return false;
  }

  const { service, account } = getKeychainCoordinates(env);
  try {
    execFileSyncImpl(
      "security",
      ["delete-generic-password", "-s", service, "-a", account],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    if (!isKeychainItemMissing(error)) {
      const wrapped = new Error(
        `Failed to delete PORTICO_LLM_API_KEY from macOS Keychain: ${error.message}`,
      );
      wrapped.code = "keychain_delete_failed";
      throw wrapped;
    }
  }

  cachedIdentity = keychainCacheIdentity({ service, account, platform });
  cachedValue = "";
  cacheInitialized = true;
  return true;
}

function clearKeychainCache() {
  cachedIdentity = "";
  cachedValue = "";
  cacheInitialized = false;
}

module.exports = {
  DEFAULT_KEYCHAIN_ACCOUNT,
  DEFAULT_KEYCHAIN_SERVICE,
  clearKeychainCache,
  deletePorticoLlmApiKeyFromKeychainSync,
  getKeychainCoordinates,
  isKeychainItemMissing,
  isSupportedPlatform,
  readPorticoLlmApiKeyFromKeychainSync,
  upsertPorticoLlmApiKeyInKeychain,
  upsertPorticoLlmApiKeyInKeychainSync,
};
