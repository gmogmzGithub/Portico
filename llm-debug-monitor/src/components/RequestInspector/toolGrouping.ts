import type { ActiveTool } from "../../types/events";
import type { LLMTool } from "../../types/llm";

export interface GroupedToolServer {
  serverId: string;
  displayName: string;
  iconPath: string;
  tools: LLMTool[];
  isCore: boolean;
  isUserInstalled: boolean;
  namespaceKey?: string | null;
}

interface NamespaceServerMeta {
  description?: string;
  server_id?: string;
  is_core?: boolean;
  user_installed?: boolean;
  icon_url?: string;
}

const ACRONYMS = new Set([
  "vm",
  "mcp",
  "ai",
  "api",
  "url",
  "id",
  "ui",
  "llm",
  "http",
  "ssh",
  "sql",
]);

const formatServerId = (serverId: string): string => {
  return serverId
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
};

const normalizeServerKey = (serverId: string): string =>
  serverId.replace(/-/g, "_");

const extractServerPrefix = (
  toolName: string,
  serverMap: Map<string, ActiveTool>,
): string | null => {
  const parts = toolName.split("_");

  for (let index = 1; index <= parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("_");
    if (serverMap.has(prefix)) {
      return prefix;
    }
  }

  return null;
};

const parseNamespaceMetadata = (
  rawPayload?: Record<string, unknown>,
): Record<string, NamespaceServerMeta> => {
  const namespaces = rawPayload?._tool_namespaces;
  if (
    !namespaces ||
    typeof namespaces !== "object" ||
    Array.isArray(namespaces)
  ) {
    return {};
  }

  return namespaces as Record<string, NamespaceServerMeta>;
};

const createFallbackServer = (
  serverId: string,
  overrides: Partial<ActiveTool> = {},
): ActiveTool => ({
  server_id: serverId,
  display_name: overrides.display_name || formatServerId(serverId),
  icon_url: overrides.icon_url || `/api/v1/chats/mcp/servers/${serverId}/icon`,
  is_core: overrides.is_core ?? false,
  user_installed: overrides.user_installed ?? false,
});

const buildServerMap = ({
  activeServers,
  requestToolIds = [],
  rawPayload,
}: {
  activeServers: ActiveTool[];
  requestToolIds?: string[];
  rawPayload?: Record<string, unknown>;
}): {
  serverMap: Map<string, ActiveTool>;
  namespaceMetadata: Record<string, NamespaceServerMeta>;
} => {
  const serverMap = new Map<string, ActiveTool>();

  for (const server of activeServers) {
    serverMap.set(normalizeServerKey(server.server_id), server);
  }

  for (const toolId of requestToolIds) {
    if (!toolId.startsWith("server:")) {
      continue;
    }
    const serverId = toolId.slice("server:".length).trim();
    if (!serverId) {
      continue;
    }
    const normalizedServerId = normalizeServerKey(serverId);
    if (!serverMap.has(normalizedServerId)) {
      serverMap.set(normalizedServerId, createFallbackServer(serverId));
    }
  }

  const namespaceMetadata = parseNamespaceMetadata(rawPayload);
  for (const [namespaceKey, metadata] of Object.entries(namespaceMetadata)) {
    const serverId =
      typeof metadata?.server_id === "string" && metadata.server_id.trim()
        ? metadata.server_id.trim()
        : namespaceKey;
    const normalizedNamespaceKey = normalizeServerKey(namespaceKey);
    if (!serverMap.has(normalizedNamespaceKey)) {
      serverMap.set(
        normalizedNamespaceKey,
        createFallbackServer(serverId, {
          display_name: formatServerId(serverId),
          icon_url:
            typeof metadata?.icon_url === "string" && metadata.icon_url.trim()
              ? metadata.icon_url
              : undefined,
          is_core: metadata?.is_core ?? false,
          user_installed: metadata?.user_installed ?? false,
        }),
      );
    }
  }

  return { serverMap, namespaceMetadata };
};

export const buildToolServerGroups = ({
  tools,
  activeServers,
  requestToolIds = [],
  rawPayload,
}: {
  tools: LLMTool[];
  activeServers: ActiveTool[];
  requestToolIds?: string[];
  rawPayload?: Record<string, unknown>;
}): GroupedToolServer[] => {
  const { serverMap, namespaceMetadata } = buildServerMap({
    activeServers,
    requestToolIds,
    rawPayload,
  });

  const groupedTools = new Map<string, GroupedToolServer>();
  const unknownTools: LLMTool[] = [];
  const functionTools = tools.filter(
    (tool) => tool.type === "function" && tool.function,
  );

  for (const tool of functionTools) {
    const toolName = tool.function?.name ?? "";
    const prefix = extractServerPrefix(toolName, serverMap);

    if (!prefix) {
      unknownTools.push(tool);
      continue;
    }

    const server = serverMap.get(prefix);
    if (!server) {
      unknownTools.push(tool);
      continue;
    }

    const normalizedServerId = normalizeServerKey(server.server_id);
    const namespaceKey = Object.keys(namespaceMetadata).find(
      (key) =>
        normalizeServerKey(key) === prefix ||
        normalizeServerKey(key) === normalizedServerId,
    );
    if (!groupedTools.has(server.server_id)) {
      groupedTools.set(server.server_id, {
        serverId: server.server_id,
        displayName: server.display_name || formatServerId(server.server_id),
        iconPath:
          server.icon_url ||
          `/api/v1/chats/mcp/servers/${server.server_id}/icon`,
        tools: [],
        isCore: server.is_core ?? false,
        isUserInstalled: server.user_installed ?? false,
        namespaceKey: namespaceKey ?? null,
      });
    }
    groupedTools.get(server.server_id)?.tools.push(tool);
  }

  const result = [...groupedTools.values()].sort((left, right) => {
    if (left.isCore !== right.isCore) {
      return left.isCore ? -1 : 1;
    }
    return left.displayName.localeCompare(right.displayName);
  });

  if (unknownTools.length > 0) {
    result.push({
      serverId: "_unknown",
      displayName: "Other Tools",
      iconPath: "",
      tools: unknownTools,
      isCore: false,
      isUserInstalled: false,
      namespaceKey: null,
    });
  }

  return result;
};
