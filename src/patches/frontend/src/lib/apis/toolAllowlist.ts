// PORTICO PATCH (Round 4 / Issue 2 — frontend API client for the
// per-user tool allowlist). The Settings → Allowlists page calls
// these helpers; the chip's "Always allow" button populates the
// same backend file via the gate's resolve endpoint, so this
// client is read-mostly with the rare manual edit / disable.
//
// Threat-model invariants pinned by the backend:
//   * every endpoint requires get_verified_user (auth header).
//   * the user_id is taken from the verified identity, NEVER from
//     the request body.
//   * mcp + tool_name fingerprints are bounded length.

export interface ToolAllowlistEntry {
	id: string;
	tool_name: string;
	mcp: string;
	enabled: boolean;
	created_at: string;
	updated_at: string;
}

export interface ToolAllowlistFile {
	version: number;
	master_disabled: boolean;
	entries: ToolAllowlistEntry[];
}

export const emptyAllowlistFile = (): ToolAllowlistFile => ({
	version: 1,
	master_disabled: false,
	entries: []
});

const authedJsonFetch = async (
	token: string,
	url: string,
	options: RequestInit = {}
): Promise<any> => {
	const res = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
			...(options.headers ?? {})
		}
	});
	if (!res.ok) {
		// Bubble the backend error JSON so the UI can show a
		// reason — fall back to a synthetic Error if the body
		// isn't JSON-decodable.
		throw await res.json().catch(() => new Error(`HTTP ${res.status}`));
	}
	if (res.status === 204) {
		return null;
	}
	return await res.json();
};

export const getAllowlist = async (token: string): Promise<ToolAllowlistFile> => {
	try {
		return await authedJsonFetch(token, '/api/v1/utils/allowlists', { method: 'GET' });
	} catch (error) {
		console.warn('[toolAllowlist] failed to fetch allowlist:', error);
		return emptyAllowlistFile();
	}
};

export const upsertAllowlistEntry = async (
	token: string,
	form: { tool_name: string; mcp?: string; enabled?: boolean }
): Promise<ToolAllowlistEntry> =>
	authedJsonFetch(token, '/api/v1/utils/allowlists/entries', {
		method: 'POST',
		body: JSON.stringify({
			tool_name: form.tool_name,
			mcp: form.mcp ?? '',
			enabled: form.enabled ?? true
		})
	});

export const setAllowlistEntryEnabled = async (
	token: string,
	entryId: string,
	enabled: boolean
): Promise<ToolAllowlistEntry> =>
	authedJsonFetch(token, `/api/v1/utils/allowlists/entries/${encodeURIComponent(entryId)}`, {
		method: 'PATCH',
		body: JSON.stringify({ enabled })
	});

export const deleteAllowlistEntry = async (
	token: string,
	entryId: string
): Promise<void> => {
	await authedJsonFetch(token, `/api/v1/utils/allowlists/entries/${encodeURIComponent(entryId)}`, {
		method: 'DELETE'
	});
};

export const setAllowlistMasterToggle = async (
	token: string,
	masterDisabled: boolean
): Promise<ToolAllowlistFile> =>
	authedJsonFetch(token, '/api/v1/utils/allowlists/master-toggle', {
		method: 'PUT',
		body: JSON.stringify({ master_disabled: masterDisabled })
	});
