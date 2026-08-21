const modelLogoCache = new Map<string, string>();
const modelLogoPendingRequests = new Map<string, Promise<string>>();
const MAX_CACHED_MODEL_LOGOS = 256;
const MODEL_LOGO_CACHE_STORAGE_NAME = 'open-webui-model-logos-v1';

const normalizeLogoCacheValue = (value: unknown) => {
	const normalized = `${value ?? ''}`.trim();
	return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : '';
};

export const getModelLogoCacheVersion = (model: ModelLogoCacheCandidate | null | undefined) =>
	normalizeLogoCacheValue(
		model?.info?.updated_at ??
			model?.info?.updatedAt ??
			model?.updated_at ??
			model?.updatedAt ??
			model?.model?.info?.updated_at ??
			model?.model?.info?.updatedAt ??
			model?.model?.updated_at ??
			model?.model?.updatedAt
	);

export const getModelLogoCacheKey = (modelId: string, language: string, version: string = '') =>
	`${modelId}::${language}::${version || 'unversioned'}`;

export const getCachedModelLogoUrl = (cacheKey: string) => modelLogoCache.get(cacheKey);

export const isVersionedModelLogoCacheKey = (cacheKey: string) =>
	normalizeLogoCacheValue(cacheKey) !== '' && !cacheKey.endsWith('::unversioned');

export const buildModelLogoUrl = (
	apiBaseUrl: string,
	modelId: string,
	language: string,
	version: string = ''
) => {
	const normalizedVersion = normalizeLogoCacheValue(version);
	const url = `${apiBaseUrl.replace(/\/$/, '')}/models/model/profile/image?id=${encodeURIComponent(modelId)}&lang=${encodeURIComponent(language || 'en')}`;
	return normalizedVersion ? `${url}&v=${encodeURIComponent(normalizedVersion)}` : url;
};

const evictOldestModelLogo = () => {
	const oldestCacheKey = modelLogoCache.keys().next().value as string | undefined;
	if (!oldestCacheKey) {
		return;
	}

	const oldestLogoUrl = modelLogoCache.get(oldestCacheKey);
	if (oldestLogoUrl?.startsWith('blob:')) {
		URL.revokeObjectURL(oldestLogoUrl);
	}
	modelLogoCache.delete(oldestCacheKey);
};

const rememberModelLogoBlob = (cacheKey: string, blob: Blob) => {
	const blobUrl = URL.createObjectURL(blob);
	if (!isVersionedModelLogoCacheKey(cacheKey)) {
		return blobUrl;
	}

	if (modelLogoCache.size >= MAX_CACHED_MODEL_LOGOS) {
		evictOldestModelLogo();
	}

	modelLogoCache.set(cacheKey, blobUrl);
	return blobUrl;
};

const getModelLogoBrowserCache = async () => {
	if (typeof caches === 'undefined') {
		return null;
	}

	try {
		return await caches.open(MODEL_LOGO_CACHE_STORAGE_NAME);
	} catch {
		return null;
	}
};

const readBrowserCachedModelLogo = async (url: string, cacheKey: string) => {
	if (!isVersionedModelLogoCacheKey(cacheKey)) {
		return '';
	}

	const cache = await getModelLogoBrowserCache();
	if (!cache) {
		return '';
	}

	try {
		const cachedResponse = await cache.match(url);
		if (!cachedResponse?.ok) {
			return '';
		}

		return rememberModelLogoBlob(cacheKey, await cachedResponse.blob());
	} catch {
		return '';
	}
};

const writeBrowserCachedModelLogo = async (url: string, cacheKey: string, response: Response) => {
	if (!isVersionedModelLogoCacheKey(cacheKey)) {
		return;
	}

	const cache = await getModelLogoBrowserCache();
	if (!cache) {
		return;
	}

	try {
		await cache.put(url, response);
	} catch {
		// Cache Storage can reject responses in restricted contexts; memory cache still covers this tab.
	}
};

export const fetchAndCacheModelLogo = async (url: string, cacheKey: string): Promise<string> => {
	const cachedLogo = modelLogoCache.get(cacheKey);
	if (cachedLogo) {
		return cachedLogo;
	}

	const pendingRequest = modelLogoPendingRequests.get(cacheKey);
	if (pendingRequest) {
		return pendingRequest;
	}

	const request = (async () => {
		const browserCachedLogo = await readBrowserCachedModelLogo(url, cacheKey);
		if (browserCachedLogo) {
			return browserCachedLogo;
		}

		const response = await fetch(url, { credentials: 'include' });
		if (!response.ok) {
			throw new Error(`Failed to load model logo (${response.status})`);
		}

		const responseForBrowserCache = response.clone();
		const blobUrl = rememberModelLogoBlob(cacheKey, await response.blob());
		void writeBrowserCachedModelLogo(url, cacheKey, responseForBrowserCache);
		return blobUrl;
	})().finally(() => {
		modelLogoPendingRequests.delete(cacheKey);
	});

	modelLogoPendingRequests.set(cacheKey, request);
	return request;
};

type ModelLogoCacheCandidate = {
	id?: string | null;
	updated_at?: unknown;
	updatedAt?: unknown;
	info?: Record<string, any> | null;
	model?: Record<string, any> | null;
	[key: string]: unknown;
};
