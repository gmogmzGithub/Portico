export type ServerId = string;
export type McpServerCatalogEntry = {
  id: ServerId;
  display_name: string;
};

type ServerIdListener = (serverIds: ServerId[]) => void;
type ServerCatalogListener = (catalog: McpServerCatalogEntry[]) => void;

const FULL_CAPS_WORDS = [
  "vm",
  "lm",
  "mcp",
  "pdf",
  "pptx",
  "xlsx",
  "api",
  "url",
  "id",
  "json",
  "xml",
  "html",
  "css",
  "sql",
  "http",
  "https",
  "oauth",
  "jwt",
  "ui",
  "ux",
  "ai",
  "suid",
  "jira",
  "jql",
  "cql",
];

const TOOL_TRANSPORT_SUFFIX = /_(post|get|put|delete|patch)$/i;

export const stripToolTransportDecorators = (toolName: string): string => {
  if (!toolName) {
    return "";
  }

  const withoutPrefix = toolName.startsWith("tool_")
    ? toolName.substring(5)
    : toolName;
  return withoutPrefix.replace(TOOL_TRANSPORT_SUFFIX, "");
};

export function applyAcronymCapitalization(text: string): string {
  let result = text;
  for (const word of FULL_CAPS_WORDS) {
    const regex = new RegExp(
      `\\b${word.charAt(0).toUpperCase() + word.slice(1)}\\b`,
      "g",
    );
    result = result.replace(regex, word.toUpperCase());
  }
  return result;
}

export function extractServerIdFromToolName(
  toolName: string,
  knownServerIds: string[],
): string | null {
  if (!toolName || knownServerIds.length === 0) return null;

  const name = stripToolTransportDecorators(toolName);
  const normalizedServerIds = knownServerIds.map((id) => ({
    original: id,
    normalized: id.replace(/-/g, "_"),
  }));

  let bestMatch: { original: string; normalized: string } | null = null;
  for (const { original, normalized } of normalizedServerIds) {
    if (name.startsWith(normalized + "_") || name === normalized) {
      if (!bestMatch || normalized.length > bestMatch.normalized.length) {
        bestMatch = { original, normalized };
      }
    }
  }

  return bestMatch?.original ?? null;
}

export function formatToolDisplayName(
  toolName: string,
  serverId: string | null,
): string {
  if (!toolName) return toolName;

  if (toolName === "tool_run_subagent_post") {
    return "Run Subagent";
  }

  let name = stripToolTransportDecorators(toolName);

  if (serverId) {
    const normalizedServerId = serverId.replace(/-/g, "_");
    if (name.startsWith(normalizedServerId + "_")) {
      name = name.substring(normalizedServerId.length + 1);
    }
  }

  const titleCased = name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  return applyAcronymCapitalization(titleCased);
}

export function looksLikeMcpToolName(toolName: string): boolean {
  const normalizedName = stripToolTransportDecorators(toolName);
  if (!normalizedName) {
    return false;
  }

  const segments = normalizedName.split("_").filter(Boolean);
  return segments.length >= 2;
}

export function normalizeServerIds(value: unknown): ServerId[] {
  return normalizeServerCatalog(value).map((entry) => entry.id);
}

export function normalizeServerCatalog(
  value: unknown,
): McpServerCatalogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = new Map<ServerId, McpServerCatalogEntry>();

  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) {
        normalized.set(trimmed, { id: trimmed, display_name: trimmed });
      }
      continue;
    }

    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string"
    ) {
      const trimmed = (entry as { id: string }).id.trim();
      if (trimmed) {
        const displayName = String(
          (entry as { display_name?: unknown }).display_name ?? trimmed,
        ).trim();
        normalized.set(trimmed, {
          id: trimmed,
          display_name: displayName || trimmed,
        });
      }
    }
  }

  return [...normalized.values()];
}

export function createMcpServerIdRegistry(
  fetchServerIds: () => Promise<unknown>,
) {
  let cachedServerIds: ServerId[] = [];
  let cachedCatalog: McpServerCatalogEntry[] = [];
  let hasLoaded = false;
  let inFlightRequest: Promise<ServerId[]> | null = null;
  const listeners = new Set<ServerIdListener>();
  const catalogListeners = new Set<ServerCatalogListener>();

  const notifyListeners = () => {
    const snapshot = [...cachedServerIds];
    for (const listener of listeners) {
      listener(snapshot);
    }
    const catalogSnapshot = cachedCatalog.map((entry) => ({ ...entry }));
    for (const listener of catalogListeners) {
      listener(catalogSnapshot);
    }
  };

  const load = async (force = false): Promise<ServerId[]> => {
    if (!force && hasLoaded) {
      return [...cachedServerIds];
    }

    if (!inFlightRequest) {
      inFlightRequest = Promise.resolve()
        .then(fetchServerIds)
        .then((value) => normalizeServerCatalog(value))
        .catch(() => [])
        .then((catalog) => {
          cachedCatalog = catalog;
          cachedServerIds = catalog.map((entry) => entry.id);
          hasLoaded = true;
          notifyListeners();
          return [...cachedServerIds];
        })
        .finally(() => {
          inFlightRequest = null;
        });
    }

    return inFlightRequest;
  };

  return {
    subscribe(listener: ServerIdListener) {
      listeners.add(listener);
      listener([...cachedServerIds]);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeCatalog(listener: ServerCatalogListener) {
      catalogListeners.add(listener);
      listener(cachedCatalog.map((entry) => ({ ...entry })));
      return () => {
        catalogListeners.delete(listener);
      };
    },
    getSnapshot(): ServerId[] {
      return [...cachedServerIds];
    },
    getCatalogSnapshot(): McpServerCatalogEntry[] {
      return cachedCatalog.map((entry) => ({ ...entry }));
    },
    refresh(): Promise<ServerId[]> {
      return load(true);
    },
    invalidate() {
      cachedServerIds = [];
      cachedCatalog = [];
      hasLoaded = false;
      notifyListeners();
    },
    async ensureForToolName(toolName: string): Promise<ServerId[]> {
      const snapshot = hasLoaded ? [...cachedServerIds] : await load();

      if (!looksLikeMcpToolName(toolName)) {
        return snapshot;
      }

      if (extractServerIdFromToolName(toolName, snapshot)) {
        return snapshot;
      }

      return load(true);
    },
    async ensureKnownServerIds(serverIds: string[]): Promise<ServerId[]> {
      const requiredServerIds = normalizeServerIds(serverIds);
      const snapshot = hasLoaded ? [...cachedServerIds] : await load();

      if (requiredServerIds.length === 0) {
        return snapshot;
      }

      const knownServerIds = new Set(snapshot);
      if (requiredServerIds.every((serverId) => knownServerIds.has(serverId))) {
        return snapshot;
      }

      return load(true);
    },
  };
}
