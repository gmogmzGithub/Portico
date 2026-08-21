const archiveRequests = new Map();

const responseError = async (response) => {
	const body = await response.json().catch(() => null);
	const detail = typeof body?.detail === 'string' ? body.detail : null;
	return new Error(detail ?? `HTTP ${response.status}`);
};

const requestJson = async (fetchImpl, url, options) => {
	const response = await fetchImpl(url, options);
	if (!response.ok) {
		throw await responseError(response);
	}
	return await response.json();
};

/**
 * Archive a chat with shared request coalescing and a post-mutation read.
 *
 * The explicit archived=true endpoint is idempotent. The read after every
 * issued mutation resolves commit-then-disconnect ambiguity before callers
 * update navigation or list state.
 */
export function archiveChatSafely(
	token,
	id,
	{ fetchImpl = globalThis.fetch, apiBaseUrl = '/api/v1' } = {}
) {
	if (!id) {
		return Promise.reject(new Error('A chat ID is required'));
	}

	const existingRequest = archiveRequests.get(id);
	if (existingRequest) {
		return existingRequest;
	}

	const baseUrl = apiBaseUrl.replace(/\/$/, '');
	const encodedId = encodeURIComponent(id);
	const headers = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		...(token ? { Authorization: `Bearer ${token}` } : {})
	};

	const request = (async () => {
		let mutationError = null;
		try {
			await requestJson(fetchImpl, `${baseUrl}/chats/${encodedId}/archive?archived=true`, {
				method: 'POST',
				headers
			});
		} catch (error) {
			mutationError = error;
		}

		let currentChat;
		try {
			currentChat = await requestJson(fetchImpl, `${baseUrl}/chats/${encodedId}`, {
				method: 'GET',
				headers,
				cache: 'no-store'
			});
		} catch (reconciliationError) {
			throw mutationError ?? reconciliationError;
		}

		if (currentChat?.archived === true) {
			return currentChat;
		}

		throw mutationError ?? new Error('The chat archive state could not be confirmed');
	})();

	const trackedRequest = request.finally(() => {
		if (archiveRequests.get(id) === trackedRequest) {
			archiveRequests.delete(id);
		}
	});
	archiveRequests.set(id, trackedRequest);
	return trackedRequest;
}
