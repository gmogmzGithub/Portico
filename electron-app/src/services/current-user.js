const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");

const bootstrap = require("./bootstrap");
const {
  writeCanonicalIdentityEnv,
} = require("./identity-env");
const {
  writeProtectedRepositoryEnvAtomic,
} = require("./protected-operator-env");
const { normalizePlausibleEmail } = require("./setup-auth-shared");
const setupAuth = require("./setup-auth");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function buildIdentitySyncFailure(result = {}, error) {
  const requestedCode = typeof error?.code === "string" ? error.code : "";
  const errorCode =
    requestedCode === "identity_sync_invalid" ||
    requestedCode === "identity_sync_project_root_missing"
      ? requestedCode
      : "identity_sync_failed";
  const errorMessages = {
    identity_sync_invalid:
      "The signed-in account is missing required identity information.",
    identity_sync_project_root_missing:
      "The signed-in account could not be saved locally. Try again.",
    identity_sync_failed:
      "The signed-in account could not be saved locally. Try again.",
  };

  return {
    success: false,
    authenticated: false,
    sessionSummary: null,
    source: result?.source || null,
    error: errorMessages[errorCode],
    errorCode,
  };
}

function createCurrentUserService(deps = {}) {
  const logger = deps.logger || console;
  const setupAuthService = deps.setupAuth || setupAuth;
  const getProjectRoot =
    deps.getProjectRoot || (() => bootstrap.PROJECT_ROOT);
  const readFile = deps.readFile || fsPromises.readFile.bind(fsPromises);
  const writeEnvFile =
    deps.writeEnvFile ||
    (async (envPath, content) =>
      writeProtectedRepositoryEnvAtomic(envPath, content, {
        readFile: deps.readFile,
        writeFile: deps.writeFile,
        rename: deps.rename,
        chmod: deps.chmod,
        unlink: deps.unlink,
      }));
  const chmod = deps.chmod || fsPromises.chmod.bind(fsPromises);
  const mkdir = deps.mkdir || fsPromises.mkdir.bind(fsPromises);
  const existsSync = deps.existsSync || fs.existsSync.bind(fs);

  function audit(event, details = {}) {
    const payload = {
      schemaVersion: 1,
      event,
      timestamp: new Date().toISOString(),
      source: details.source || null,
      success: details.success === true,
      authenticated: details.authenticated === true,
      safeErrorCode: details.errorCode || null,
      elapsedMs: Number.isFinite(details.elapsedMs) ? details.elapsedMs : null,
      rootClassification: isNonEmptyString(getProjectRoot())
        ? "active-project-root"
        : "project-root-missing",
      // PORTICO-414 blind spot: an authenticated-but-email-less session used to
      // be byte-identical to a healthy one here. Presence only — never the
      // address itself.
      emailAvailable: Boolean(
        normalizePlausibleEmail(details.sessionSummary?.user?.email),
      ),
      channel: "identity",
    };
    logger.info?.(`[Identity Audit] ${JSON.stringify(payload)}`);
  }

  async function syncEnvIdentity(sessionSummary) {
    const user = sessionSummary?.user || {};
    if (!isNonEmptyString(user.id) || !isNonEmptyString(user.name)) {
      const error = new Error(
        "Authenticated user identity is missing required fields",
      );
      error.code = "identity_sync_invalid";
      throw error;
    }

    const projectRoot = getProjectRoot();
    if (!isNonEmptyString(projectRoot)) {
      const error = new Error(
        "Project root is unavailable, so the signed-in identity could not be synced",
      );
      error.code = "identity_sync_project_root_missing";
      throw error;
    }

    const envPath = path.join(projectRoot, ".env");
    const envDir = path.dirname(envPath);
    let envContent = "";

    if (existsSync(envPath)) {
      envContent = await readFile(envPath, "utf8");
    } else {
      await mkdir(envDir, { recursive: true });
      envContent = "# Portico Configuration\n\n";
    }

    const updatedEnvContent = writeCanonicalIdentityEnv(envContent, {
      userId: user.id,
      userName: user.name,
    });
    const nextEnvContent = updatedEnvContent;

    if (nextEnvContent !== envContent) {
      await writeEnvFile(envPath, nextEnvContent);
    } else {
      await chmod(envPath, 0o600);
    }
    return {
      success: true,
      envPath,
      userId: user.id.trim(),
      userName: user.name.trim(),
    };
  }

  async function syncIdentityForResult(result) {
    if (!result?.authenticated || !result?.sessionSummary) {
      return result;
    }

    try {
      await syncEnvIdentity(result.sessionSummary);
      return {
        ...result,
        success:
          typeof result.success === "boolean" ? result.success : true,
      };
    } catch (error) {
      return buildIdentitySyncFailure(result, error);
    }
  }

  async function get() {
    const startedAt = Date.now();
    const result = await setupAuthService.getCachedSessionSummary();
    const synchronized = await syncIdentityForResult(result);
    audit("identity_reconciliation", {
      ...synchronized,
      elapsedMs: Date.now() - startedAt,
    });
    return synchronized;
  }

  async function ensureAuthenticated() {
    const startedAt = Date.now();
    const result = await setupAuthService.startSetupAuth();
    const synchronized = await syncIdentityForResult(result);
    audit("identity_reconciliation", {
      ...synchronized,
      elapsedMs: Date.now() - startedAt,
    });
    return synchronized;
  }

  async function repairIdentity() {
    const startedAt = Date.now();
    const result = await setupAuthService.repairSessionIdentity();
    audit("identity_repair", {
      source: result?.source || result?.reason || null,
      success: result?.repaired === true,
      authenticated: result?.authenticated === true,
      errorCode: result?.repaired === true ? null : result?.reason || null,
      sessionSummary: result?.sessionSummary || null,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  }

  async function clearError() {
    return setupAuthService.clearSetupAuthError();
  }

  function status() {
    return setupAuthService.getSetupAuthStatus();
  }

  return {
    clearError,
    ensureAuthenticated,
    get,
    repairIdentity,
    status,
    syncEnvIdentity,
  };
}

module.exports = {
  ...createCurrentUserService(),
  createCurrentUserService,
  _test: {
    buildIdentitySyncFailure,
  },
};
