const nonEmptyString = (value: unknown): string =>
	typeof value === 'string' && value.trim() ? value.trim() : '';

export const selectDisplayFileUrl = (
	record: Record<string, unknown>,
	isImage: boolean
): string => {
	const keys = isImage
		? ['browser_url', 'url', 'download_url', 'content']
		: ['download_url', 'url', 'browser_url', 'content'];

	for (const key of keys) {
		const value = nonEmptyString(record[key]);
		if (value) return value;
	}
	return '';
};
