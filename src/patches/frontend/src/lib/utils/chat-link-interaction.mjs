const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export const normalizeAbsoluteHttpUrl = (value) => {
	const raw = String(value ?? '').trim();
	if (!/^https?:\/\//i.test(raw)) {
		return null;
	}

	try {
		const parsed = new URL(raw);
		return HTTP_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
	} catch {
		return null;
	}
};

const isLoopbackHost = (hostname) =>
	hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

export const isAppOwnedChatUrl = (value, currentHref = globalThis.location?.href) => {
	const normalized = normalizeAbsoluteHttpUrl(value);
	if (!normalized) {
		return false;
	}

	try {
		const parsed = new URL(normalized);
		if (currentHref && parsed.origin === new URL(currentHref).origin) {
			return true;
		}
		return (
			isLoopbackHost(parsed.hostname) &&
			parsed.port === '9876' &&
			parsed.pathname.startsWith('/workspace/')
		);
	} catch {
		return false;
	}
};

export const getChatLinkAction = (
	event,
	value,
	currentHref = globalThis.location?.href,
	platform = globalThis.navigator?.platform || globalThis.navigator?.userAgent || ''
) => {
	const url = normalizeAbsoluteHttpUrl(value);
	if (!url || isAppOwnedChatUrl(url, currentHref)) {
		return { action: 'preserve', url };
	}

	return {
		action: /Mac|iPhone|iPad|iPod/i.test(String(platform || ''))
			? event?.metaKey
				? 'open'
				: 'copy'
			: event?.ctrlKey
				? 'open'
				: 'copy',
		url
	};
};
