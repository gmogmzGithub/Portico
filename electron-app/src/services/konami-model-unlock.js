const {
  OPEN_WEBUI_HOME_URL,
  getOwuiAuthBridgeSecret,
} = require("./owui-auth-bridge-client");

const KONAMI_UNLOCK_MODEL_ID = "GPT-5.6 Sol Pro";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

class KonamiModelUnlockError extends Error {
  constructor(
    message,
    { code = null, status = null, body = null, cause = undefined } = {},
  ) {
    super(message);
    this.name = "KonamiModelUnlockError";
    this.code = code;
    this.status = status;
    this.body = body;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function createRequestSignal(timeoutMs) {
  if (typeof globalThis.AbortSignal?.timeout !== "function") {
    return undefined;
  }
  return globalThis.AbortSignal.timeout(timeoutMs);
}

async function request(fetchImpl, url, options, timeoutMs) {
  try {
    return await fetchImpl(url, {
      ...options,
      signal: createRequestSignal(timeoutMs),
    });
  } catch (error) {
    throw new KonamiModelUnlockError(
      `OWUI request failed: ${error?.message || String(error)}`,
      {
        code: "owui-unavailable",
        cause: error,
      },
    );
  }
}

function isAlreadyUnlocked(model) {
  const meta = model?.meta;
  return Boolean(
    meta &&
      typeof meta === "object" &&
      meta.disabled === false &&
      !Object.prototype.hasOwnProperty.call(meta, "disabled_reason"),
  );
}

function buildUnlockedModelPayload(model) {
  const payload = {
    ...model,
    meta: {
      ...(model?.meta && typeof model.meta === "object" ? model.meta : {}),
      disabled: false,
    },
  };
  delete payload.meta.disabled_reason;
  delete payload.user;
  delete payload.info;
  return payload;
}

async function unlockKonamiModelWithServiceAuth(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new KonamiModelUnlockError("Fetch is unavailable for Konami model unlock", {
      code: "fetch-unavailable",
    });
  }

  const baseUrl = options.baseUrl || OPEN_WEBUI_HOME_URL;
  const modelId = options.modelId || KONAMI_UNLOCK_MODEL_ID;
  const timeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const bridgeSecret = String(
    options.bridgeSecret ?? getOwuiAuthBridgeSecret(),
  ).trim();
  if (!bridgeSecret) {
    throw new KonamiModelUnlockError("OWUI auth bridge secret is unavailable", {
      code: "missing-bridge-secret",
    });
  }

  const serviceTokenResponse = await request(
    fetchImpl,
    `${baseUrl}/api/v1/portico/auth/service-token`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bridgeSecret}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ reason: "konami-model-unlock" }),
    },
    timeoutMs,
  );
  const serviceTokenBody = await parseResponseBody(serviceTokenResponse);
  if (!serviceTokenResponse.ok) {
    throw new KonamiModelUnlockError(
      `Failed to acquire OWUI service token (HTTP ${serviceTokenResponse.status})`,
      {
        code: "service-token-failed",
        status: serviceTokenResponse.status,
        body: serviceTokenBody,
      },
    );
  }

  const serviceToken = String(
    serviceTokenBody?.token || serviceTokenBody?.access_token || "",
  ).trim();
  if (!serviceToken) {
    throw new KonamiModelUnlockError(
      "OWUI service-token bridge returned no token",
      {
        code: "missing-service-token",
      },
    );
  }

  const serviceHeaders = {
    Authorization: `Bearer ${serviceToken}`,
    Accept: "application/json",
  };
  const modelUrl = new URL("/api/v1/models/model", baseUrl);
  modelUrl.searchParams.set("id", modelId);
  const modelResponse = await request(
    fetchImpl,
    modelUrl.toString(),
    {
      method: "GET",
      headers: serviceHeaders,
    },
    timeoutMs,
  );
  const modelBody = await parseResponseBody(modelResponse);
  if (!modelResponse.ok) {
    throw new KonamiModelUnlockError(
      `Failed to fetch model (HTTP ${modelResponse.status})`,
      {
        code: modelResponse.status === 404 ? "model-not-found" : "fetch-model-failed",
        status: modelResponse.status,
        body: modelBody,
      },
    );
  }
  if (!modelBody || typeof modelBody !== "object" || Array.isArray(modelBody)) {
    throw new KonamiModelUnlockError("Unable to resolve GPT-5.6 Sol Pro model", {
      code: "model-resolution-failed",
    });
  }

  if (isAlreadyUnlocked(modelBody)) {
    return {
      success: true,
      modelId: String(modelBody.id || modelId),
      alreadyUnlocked: true,
      auth: "service",
    };
  }

  const updateUrl = new URL("/api/v1/models/model/update", baseUrl);
  updateUrl.searchParams.set("id", String(modelBody.id || modelId));
  const updateResponse = await request(
    fetchImpl,
    updateUrl.toString(),
    {
      method: "POST",
      headers: {
        ...serviceHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildUnlockedModelPayload(modelBody)),
    },
    timeoutMs,
  );
  const updateBody = await parseResponseBody(updateResponse);
  if (!updateResponse.ok) {
    throw new KonamiModelUnlockError(
      `Failed to update model (HTTP ${updateResponse.status})`,
      {
        code: "update-model-failed",
        status: updateResponse.status,
        body: updateBody,
      },
    );
  }

  return {
    success: true,
    modelId: String(modelBody.id || modelId),
    alreadyUnlocked: false,
    auth: "service",
  };
}

module.exports = {
  KONAMI_UNLOCK_MODEL_ID,
  KonamiModelUnlockError,
  buildUnlockedModelPayload,
  isAlreadyUnlocked,
  unlockKonamiModelWithServiceAuth,
};
