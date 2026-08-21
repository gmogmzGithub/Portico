const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_ENV_PATH = path.join(REPO_ROOT, "cloudsmith.env");
const OUTPUT_DIR = path.join(__dirname, "..", "build-resources");
const OUTPUT_ENV_PATH = path.join(OUTPUT_DIR, "cloudsmith.env");
const PACKAGED_KEYS = [
  "CLOUDSMITH_OWNER",
  "CLOUDSMITH_REPO",
  "CLOUDSMITH_API_BASE",
  "CLOUDSMITH_DL_BASE",
  "CLOUDSMITH_ENTITLEMENT_TOKEN",
  "CLOUDSMITH_API_KEY",
];
const DEFAULT_KEYCHAIN_SERVICE = "portico";
const DEFAULT_KEYCHAIN_ACCOUNT = "CLOUDSMITH_ENTITLEMENT_TOKEN";

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(normalizeValue(value).toLowerCase());
}

function isKeychainItemMissing(error) {
  if (Number(error?.status) === 44) {
    return true;
  }
  return /could not be found|specified item could not be found/i.test(
    `${String(error?.message || "")}\n${String(error?.stderr || "")}`,
  );
}

function readEntitlementTokenFromMacKeychain({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== "darwin" || isTruthyFlag(env.PORTICO_RUNTIME_DISABLE_KEYCHAIN)) {
    return "";
  }

  const service =
    normalizeValue(env.PORTICO_LLM_KEYCHAIN_SERVICE) || DEFAULT_KEYCHAIN_SERVICE;
  const account =
    normalizeValue(env.CLOUDSMITH_ENTITLEMENT_KEYCHAIN_ACCOUNT) ||
    DEFAULT_KEYCHAIN_ACCOUNT;

  try {
    return normalizeValue(
      execFileSyncImpl(
        "security",
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch (error) {
    if (isKeychainItemMissing(error)) {
      return "";
    }
    const status = Number.isFinite(Number(error?.status))
      ? `, status=${Number(error.status)}`
      : "";
    const wrapped = new Error(
      "Failed to read CLOUDSMITH_ENTITLEMENT_TOKEN from macOS Keychain " +
        `(service=${service}, account=${account}${status}). ` +
        "Set it explicitly or repair Keychain access.",
    );
    wrapped.code = "cloudsmith_keychain_read_failed";
    throw wrapped;
  }
}

function requireEntitlementToken(values) {
  const token = String(values?.CLOUDSMITH_ENTITLEMENT_TOKEN || "").trim();
  if (!token) {
    throw new Error(
      "CLOUDSMITH_ENTITLEMENT_TOKEN is required for packaged builds. " +
        "Provision the read-only entitlement token in the release environment.",
    );
  }
  return token;
}

function requireApiKey(values) {
  const apiKey = String(values?.CLOUDSMITH_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error(
      "CLOUDSMITH_API_KEY is required for packaged update discovery. " +
        "Provision it in the release environment or cloudsmith.env.",
    );
  }
  return apiKey;
}

function requirePackagedCloudsmithCredentials(values) {
  requireEntitlementToken(values);
  requireApiKey(values);
}

function parseEnvFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      parsed[key] = value;
    }
    return parsed;
  } catch {
    return {};
  }
}

function resolvePackagedCloudsmithEnv({
  env = process.env,
  fileValues = parseEnvFile(SOURCE_ENV_PATH),
  readKeychainToken = () => "",
} = {}) {
  const resolved = {};
  for (const key of PACKAGED_KEYS) {
    const environmentValue = normalizeValue(env[key]);
    const fileValue = normalizeValue(fileValues[key]);
    const value = environmentValue || fileValue;
    if (value) {
      resolved[key] = value;
    }
  }
  if (!resolved.CLOUDSMITH_ENTITLEMENT_TOKEN) {
    const keychainValue = normalizeValue(readKeychainToken({ env }));
    if (keychainValue) {
      resolved.CLOUDSMITH_ENTITLEMENT_TOKEN = keychainValue;
    }
  }
  requirePackagedCloudsmithCredentials(resolved);
  return resolved;
}

function writePackagedCloudsmithEnv(values, outputPath = OUTPUT_ENV_PATH) {
  requirePackagedCloudsmithCredentials(values);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = [
    "# Generated for packaged builds.",
    "# API key is used for package discovery; entitlement token is used for downloads.",
    ...PACKAGED_KEYS.map((key) => `${key}=${JSON.stringify(values[key] || "")}`),
    "",
  ];
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${crypto
      .randomBytes(6)
      .toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, outputPath);
    try {
      fs.chmodSync(outputPath, 0o600);
    } catch (_error) {
      // Best effort for filesystems that do not implement POSIX permissions.
    }
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_error) {
      // Atomic rename normally consumes the temporary file.
    }
  }
}

function validatePackagedCloudsmithEnvFile(
  filePath,
  { expectedPath = null } = {},
) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Packaged Cloudsmith resource is missing: ${filePath || "unknown"}`);
  }

  const values = parseEnvFile(filePath);
  requirePackagedCloudsmithCredentials(values);

  if (expectedPath) {
    if (!fs.existsSync(expectedPath)) {
      throw new Error(`Expected packaged Cloudsmith resource is missing: ${expectedPath}`);
    }
    const expected = parseEnvFile(expectedPath);
    requirePackagedCloudsmithCredentials(expected);
    for (const key of PACKAGED_KEYS) {
      const actualValue = String(values[key] || "").trim();
      const expectedValue = String(expected[key] || "").trim();
      if (actualValue !== expectedValue) {
        throw new Error(
          `Packaged Cloudsmith resource does not match the prepared release resource for ${key}: ${filePath}`,
        );
      }
    }
  }

  return values;
}

function main(args = process.argv.slice(2)) {
  if (args[0] === "--validate") {
    const filePath = args[1];
    const expectedIndex = args.indexOf("--expected");
    const expectedPath = expectedIndex >= 0 ? args[expectedIndex + 1] : null;
    validatePackagedCloudsmithEnvFile(filePath, { expectedPath });
    console.log(
      `[prepare-cloudsmith-resource] Validated packaged Cloudsmith resource: ${filePath}`,
    );
    return;
  }

  const fileValues = parseEnvFile(SOURCE_ENV_PATH);
  let usedKeychainFallback = false;
  const packagedValues = resolvePackagedCloudsmithEnv({
    fileValues,
    readKeychainToken: ({ env }) => {
      const value = readEntitlementTokenFromMacKeychain({ env });
      usedKeychainFallback = Boolean(value);
      return value;
    },
  });
  if (usedKeychainFallback) {
    console.log(
      "[prepare-cloudsmith-resource] Resolved entitlement token from macOS Keychain",
    );
  }
  writePackagedCloudsmithEnv(packagedValues);

  console.log(
    `[prepare-cloudsmith-resource] Wrote packaged Cloudsmith resource to ${OUTPUT_ENV_PATH}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_KEYCHAIN_ACCOUNT,
  DEFAULT_KEYCHAIN_SERVICE,
  OUTPUT_ENV_PATH,
  PACKAGED_KEYS,
  SOURCE_ENV_PATH,
  parseEnvFile,
  readEntitlementTokenFromMacKeychain,
  requireApiKey,
  requireEntitlementToken,
  resolvePackagedCloudsmithEnv,
  validatePackagedCloudsmithEnvFile,
  writePackagedCloudsmithEnv,
};
