import { readable } from "svelte/store";
import {
  createMcpServerIdRegistry,
  type McpServerCatalogEntry,
  type ServerId,
} from "$lib/utils/mcpServerIdRegistry";

const fetchServerCatalog = async (): Promise<unknown> => {
  try {
    const res = await fetch("http://localhost:9876/api/mcp/servers/catalog");
    if (!res.ok) {
      return [];
    }

    return await res.json();
  } catch {
    return [];
  }
};

const registry = createMcpServerIdRegistry(fetchServerCatalog);

export const refreshMcpServerIds = (): Promise<ServerId[]> =>
  registry.refresh();

export const invalidateMcpServerIds = (): void => registry.invalidate();

export const ensureMcpServerIdForToolName = (
  toolName: string,
): Promise<ServerId[]> => registry.ensureForToolName(toolName);

export const ensureMcpServerIds = (serverIds: string[]): Promise<ServerId[]> =>
  registry.ensureKnownServerIds(serverIds);

export const mcpServerIds = readable<ServerId[]>(
  registry.getSnapshot(),
  (set) => {
    const unsubscribe = registry.subscribe(set);
    if (registry.getSnapshot().length === 0) {
      void registry.refresh();
    }
    return unsubscribe;
  },
);

export const mcpServerCatalog = readable<McpServerCatalogEntry[]>(
  registry.getCatalogSnapshot(),
  (set) => {
    const unsubscribe = registry.subscribeCatalog(set);
    if (registry.getCatalogSnapshot().length === 0) {
      void registry.refresh();
    }
    return unsubscribe;
  },
);
