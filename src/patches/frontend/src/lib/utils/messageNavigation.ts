const MESSAGE_REVEAL_RETRY_INTERVAL_MS = 250;
const MESSAGE_REVEAL_MAX_ATTEMPTS = 20;
const SEARCH_HIGHLIGHT_DURATION_MS = 2000;
const DEFAULT_MESSAGE_NAVIGATION_CLEARANCE_PX = 96;
const MIN_VIEWPORT_HEIGHT_PX = 50;
export const REVEAL_EXPAND_REQUEST_EVENT = 'portico-reveal-expand-request';

type RevealMessageOptions = {
	behavior?: ScrollBehavior;
	highlight?: boolean;
};

function getMessagesContainer(): HTMLElement | null {
	return document.getElementById('messages-container');
}

function getMessageNavigationClearancePx(): number {
	const root = document.documentElement;
	const raw = window
		.getComputedStyle(root)
		.getPropertyValue('--message-navigation-clearance')
		.trim();
	const parsed = Number.parseFloat(raw);
	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed;
	}

	return DEFAULT_MESSAGE_NAVIGATION_CLEARANCE_PX;
}

function flashSearchHighlight(element: HTMLElement) {
	element.classList.remove('search-highlight-flash');
	void element.offsetWidth;
	element.classList.add('search-highlight-flash');
	window.setTimeout(() => {
		element.classList.remove('search-highlight-flash');
	}, SEARCH_HIGHLIGHT_DURATION_MS);
}

export function revealMessageElement(
	element: HTMLElement,
	options: RevealMessageOptions = {}
) {
	const behavior = options.behavior ?? 'smooth';
	const shouldHighlight = options.highlight !== false;
	const container = getMessagesContainer();

	if (container) {
		const clearancePx = getMessageNavigationClearancePx();
		const containerRect = container.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();
		const nextTop =
			container.scrollTop + (elementRect.top - containerRect.top) - clearancePx;
		const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
		container.scrollTo({
			top: Math.max(0, Math.min(nextTop, maxTop)),
			behavior
		});
	} else {
		element.scrollIntoView({ behavior, block: 'start' });
	}

	if (shouldHighlight) {
		flashSearchHighlight(element);
	}
}

export function revealMessageWithRetry(
	messageId: string,
	attempts = 0,
	options: RevealMessageOptions = {}
) {
	const element = document.getElementById(`message-${messageId}`) as HTMLElement | null;
	const container = getMessagesContainer();
	const viewportReady = container !== null && container.clientHeight >= MIN_VIEWPORT_HEIGHT_PX;

	if (element && viewportReady) {
		revealMessageElement(element, options);
		return;
	}

	if (attempts < MESSAGE_REVEAL_MAX_ATTEMPTS) {
		window.dispatchEvent(
			new CustomEvent(REVEAL_EXPAND_REQUEST_EVENT, { detail: { messageId } })
		);
		window.setTimeout(() => {
			revealMessageWithRetry(messageId, attempts + 1, options);
		}, MESSAGE_REVEAL_RETRY_INTERVAL_MS);
	}
}
