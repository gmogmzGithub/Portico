/**
 * Chat Capabilities API Client
 * Fetches active MCP tools and skills for a chat session
 * PORTICO PATCH: Real-time capabilities display
 */

export interface ActiveTool {
	server_id: string;
	display_name: string;
	icon_url: string;
	tool_count?: number;
	is_core?: boolean;
}

export interface ActiveSkill {
	name: string;
	display_name: string;
	// Provenance enrichment (backend joins the skills catalog; absent when the
	// catalog was unreachable or the name was ambiguous — render unbadged).
	source?: 'system' | 'user' | 'marketplace' | null;
	marketplace_relationship?: string | null;
	marketplace_id?: string | null;
	// Plugin identity for plugin-layout marketplace installs (display only).
	plugin_name?: string | null;
}

export interface ChatCapabilities {
	tools: ActiveTool[];
	skills: ActiveSkill[];
}

/**
 * Fetch active capabilities (tools and skills) for a chat session
 * @param token - Auth token
 * @param chatId - Chat ID to fetch capabilities for
 * @returns ChatCapabilities object with tools and skills arrays
 */
export async function getChatCapabilities(
	token: string,
	chatId: string
): Promise<ChatCapabilities> {
	try {
		const res = await fetch(`/api/v1/chats/${chatId}/active-capabilities`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`
			}
		});
		if (!res.ok) {
			console.warn(`Failed to fetch chat capabilities: ${res.status}`);
			return { tools: [], skills: [] };
		}
		return await res.json();
	} catch (error) {
		console.warn('Error fetching chat capabilities:', error);
		return { tools: [], skills: [] };
	}
}
