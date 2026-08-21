export const rebindSocketListeners = (currentSocket, nextSocket, listeners) => {
	if (currentSocket === nextSocket) return currentSocket ?? null;
	for (const [eventName, listener] of listeners) {
		currentSocket?.off?.(eventName, listener);
	}
	for (const [eventName, listener] of listeners) {
		nextSocket?.on?.(eventName, listener);
	}
	return nextSocket ?? null;
};
