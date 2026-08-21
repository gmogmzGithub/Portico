const path = require("path");
const { pathToFileURL } = require("url");

const APP_SCHEME = "app";
const APP_HOST = "bundle";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_VIEWS_URL_PREFIX = "src/renderer/views";

const APP_PAGE_FILES = Object.freeze([
  "guided-setup.html",
  "loading.html",
  "index.html",
  "mcp-tooltip.html",
  "local-find-overlay.html",
  "artifact-version-menu.html",
  "artifact-divider-overlay.html",
  "conversation-window.html",
]);

const APP_PAGE_FILE_SET = new Set(APP_PAGE_FILES);

const ALLOWED_BUNDLE_PREFIXES = Object.freeze([
  "assets/",
  "src/renderer/",
  "src/utils/",
  "src/services/guided-setup/",
]);

const ALLOWED_BUNDLE_FILES = new Set([
  "src/styles.css",
  "src/services/manager.js",
  "src/services/mcp-server-card-order.js",
]);

function registerAppScheme(protocol) {
  if (!protocol || typeof protocol.registerSchemesAsPrivileged !== "function") {
    throw new TypeError("Electron protocol registration API is unavailable");
  }

  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

function isAllowedBundlePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  const pathSegments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    pathSegments.some(
      (segment) => !segment || segment === "." || segment === "..",
    ) ||
    path.posix.normalize(normalized) !== normalized
  ) {
    return false;
  }

  if (ALLOWED_BUNDLE_FILES.has(normalized)) {
    return true;
  }

  return ALLOWED_BUNDLE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

function parseBundleRequestPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(String(pathname || ""));
  } catch (_error) {
    return { ok: false, status: 400, error: "Malformed URL encoding" };
  }

  if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
    return { ok: false, status: 400, error: "Invalid bundle path" };
  }

  const relativePath = decodedPath.replace(/^\/+/, "");
  const pathSegments = relativePath.split("/");
  if (
    !relativePath ||
    pathSegments.includes("..") ||
    path.posix.isAbsolute(relativePath)
  ) {
    return { ok: false, status: 403, error: "Bundle path is not allowed" };
  }

  const normalizedPath = path.posix.normalize(relativePath);
  if (
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    !isAllowedBundlePath(normalizedPath)
  ) {
    return { ok: false, status: 403, error: "Bundle path is not allowed" };
  }

  return { ok: true, relativePath: normalizedPath };
}

function resolveBundleFilePath(appRoot, relativePath) {
  const resolvedRoot = path.resolve(appRoot);
  const targetPath = path.resolve(
    resolvedRoot,
    ...String(relativePath).split("/"),
  );
  const relativeToRoot = path.relative(resolvedRoot, targetPath);

  if (
    !relativeToRoot ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    return null;
  }

  return targetPath;
}

function createProtocolResponse(ResponseCtor, status, message, method = "GET") {
  return new ResponseCtor(method === "HEAD" ? null : message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function installAppProtocol({
  protocol,
  net,
  appRoot,
  Response: ResponseCtor = globalThis.Response,
  logger = console,
}) {
  if (!protocol || typeof protocol.handle !== "function") {
    throw new TypeError("Electron protocol handler API is unavailable");
  }
  if (!net || typeof net.fetch !== "function") {
    throw new TypeError("Electron net.fetch API is unavailable");
  }
  if (!appRoot) {
    throw new TypeError("Application root is required");
  }
  if (typeof ResponseCtor !== "function") {
    throw new TypeError("Response constructor is unavailable");
  }
  if (
    typeof protocol.isProtocolHandled === "function" &&
    protocol.isProtocolHandled(APP_SCHEME)
  ) {
    throw new Error(`${APP_SCHEME} protocol is already handled`);
  }

  protocol.handle(APP_SCHEME, async (request) => {
    const method = String(request?.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return createProtocolResponse(
        ResponseCtor,
        405,
        "Method not allowed",
        method,
      );
    }

    let requestUrl;
    try {
      requestUrl = new URL(request.url);
    } catch (_error) {
      return createProtocolResponse(
        ResponseCtor,
        400,
        "Malformed application URL",
        method,
      );
    }

    if (
      requestUrl.protocol !== `${APP_SCHEME}:` ||
      requestUrl.host !== APP_HOST ||
      requestUrl.username ||
      requestUrl.password ||
      requestUrl.port
    ) {
      return createProtocolResponse(
        ResponseCtor,
        404,
        "Application resource not found",
        method,
      );
    }

    const parsedPath = parseBundleRequestPath(requestUrl.pathname);
    if (!parsedPath.ok) {
      return createProtocolResponse(
        ResponseCtor,
        parsedPath.status,
        parsedPath.error,
        method,
      );
    }

    const targetPath = resolveBundleFilePath(appRoot, parsedPath.relativePath);
    if (!targetPath) {
      return createProtocolResponse(
        ResponseCtor,
        403,
        "Bundle path is not allowed",
        method,
      );
    }

    try {
      return await net.fetch(pathToFileURL(targetPath).toString(), {
        method,
      });
    } catch (error) {
      logger.warn?.("[AppProtocol] Failed to read packaged resource", {
        url: requestUrl.toString(),
        error: error?.message || String(error),
      });
      return createProtocolResponse(
        ResponseCtor,
        404,
        "Application resource not found",
        method,
      );
    }
  });
}

function buildAppPageUrl(page, options = {}) {
  const pageName = String(page || "").trim();
  if (!APP_PAGE_FILE_SET.has(pageName)) {
    throw new Error(`Unknown application page: ${pageName || "<empty>"}`);
  }

  const url = new URL(
    `/${APP_VIEWS_URL_PREFIX}/${encodeURIComponent(pageName)}`,
    APP_ORIGIN,
  );
  const query = options.query;
  if (query && typeof query === "object") {
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === undefined || rawValue === null) {
        continue;
      }
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        url.searchParams.append(key, String(value));
      }
    }
  }

  return url.toString();
}

function loadAppPage(windowRef, page, options = {}) {
  if (!windowRef || typeof windowRef.loadURL !== "function") {
    return Promise.reject(new TypeError("BrowserWindow.loadURL is unavailable"));
  }

  const url = buildAppPageUrl(page, options);
  const logger = options.logger || console;
  const label = options.label || page;
  const webContents = windowRef.webContents;
  let didFailLoadDetails = null;

  const didFailLoad = (
    _event,
    errorCode,
    errorDescription,
    validatedURL,
    isMainFrame,
  ) => {
    if (isMainFrame === false) {
      return;
    }
    didFailLoadDetails = {
      errorCode,
      errorDescription,
      validatedURL,
    };
    logger.error?.(`[AppProtocol] Failed to load ${label}`, {
      url,
      errorCode,
      errorDescription,
      validatedURL,
    });
  };

  if (webContents && typeof webContents.on === "function") {
    webContents.on("did-fail-load", didFailLoad);
  }

  return Promise.resolve()
    .then(() => windowRef.loadURL(url))
    .catch((error) => {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      normalizedError.appPageUrl = url;
      normalizedError.appPage = page;

      if (!didFailLoadDetails) {
        logger.error?.(`[AppProtocol] Failed to load ${label}`, {
          url,
          error: normalizedError.message,
        });
      }

      if (typeof options.onFailure === "function") {
        try {
          options.onFailure({
            error: normalizedError,
            url,
            page,
            label,
            didFailLoad: didFailLoadDetails,
          });
        } catch (callbackError) {
          logger.error?.("[AppProtocol] Page failure callback failed", {
            url,
            error: callbackError?.message || String(callbackError),
          });
        }
      }

      throw normalizedError;
    })
    .finally(() => {
      if (webContents && typeof webContents.removeListener === "function") {
        webContents.removeListener("did-fail-load", didFailLoad);
      }
    });
}

module.exports = {
  APP_HOST,
  APP_ORIGIN,
  APP_PAGE_FILES,
  APP_SCHEME,
  ALLOWED_BUNDLE_FILES,
  ALLOWED_BUNDLE_PREFIXES,
  buildAppPageUrl,
  installAppProtocol,
  isAllowedBundlePath,
  loadAppPage,
  parseBundleRequestPath,
  registerAppScheme,
  resolveBundleFilePath,
};
