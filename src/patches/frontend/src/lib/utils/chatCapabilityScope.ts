import type { ChatCapabilities } from "../apis/chatCapabilities";

export interface ScopedActiveCapabilityToolIdsInput {
  activeCapabilities: ChatCapabilities | null | undefined;
  requestChatId: string | null | undefined;
  activeCapabilitiesChatId: string | null | undefined;
}

export const normalizeChatCapabilityChatId = (
  chatId: string | null | undefined,
): string => {
  return typeof chatId === "string" ? chatId.trim() : "";
};

export const normalizeActiveCapabilityToolIds = (
  activeCapabilities: ChatCapabilities | null | undefined,
): string[] => {
  const toolIds = new Set<string>();

  for (const capabilityTool of activeCapabilities?.tools ?? []) {
    const serverId =
      typeof capabilityTool?.server_id === "string"
        ? capabilityTool.server_id.trim().replace(/^(server:)+/, "")
        : "";
    if (!serverId) {
      continue;
    }
    toolIds.add(`server:${serverId}`);
  }

  return [...toolIds];
};

export const shouldUseActiveCapabilitiesForChat = ({
  requestChatId,
  activeCapabilitiesChatId,
}: Omit<ScopedActiveCapabilityToolIdsInput, "activeCapabilities">): boolean => {
  const normalizedRequestChatId = normalizeChatCapabilityChatId(requestChatId);
  const normalizedCapabilitiesChatId = normalizeChatCapabilityChatId(
    activeCapabilitiesChatId,
  );

  return (
    normalizedRequestChatId.length > 0 &&
    normalizedRequestChatId === normalizedCapabilitiesChatId
  );
};

export const getScopedActiveCapabilityToolIds = ({
  activeCapabilities,
  requestChatId,
  activeCapabilitiesChatId,
}: ScopedActiveCapabilityToolIdsInput): string[] => {
  if (
    !shouldUseActiveCapabilitiesForChat({
      requestChatId,
      activeCapabilitiesChatId,
    })
  ) {
    return [];
  }

  return normalizeActiveCapabilityToolIds(activeCapabilities);
};
