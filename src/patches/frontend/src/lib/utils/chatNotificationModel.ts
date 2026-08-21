import { resolveSidebarChatModelId } from './chatSidebarModel';

export type ChatNotificationModelIdentity = {
	id: string;
	name?: string;
	ownedBy?: string;
	baseModelId?: string;
	baseModelName?: string;
	baseModelOwnedBy?: string;
};

const normalizeModelValue = (value: unknown): string => {
	const normalized = `${value ?? ''}`.trim();
	return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : '';
};

const getModelId = (model: any): string => normalizeModelValue(model?.id);

const findModelById = (modelCatalog: any[], modelId: string): any | null => {
	const normalizedModelId = normalizeModelValue(modelId).replace(/:latest$/i, '');
	if (!normalizedModelId) return null;
	return (
		(modelCatalog ?? []).find(
			(model) => getModelId(model).replace(/:latest$/i, '') === normalizedModelId
		) ?? null
	);
};

const getBaseModelId = (model: any): string =>
	normalizeModelValue(
		model?.base_model_id ??
			model?.baseModelId ??
			model?.info?.base_model_id ??
			model?.info?.baseModelId
	);

export const resolveNotificationModelIdentityForId = (
	modelId: unknown,
	modelCatalog: any[] = []
): ChatNotificationModelIdentity | null => {
	const normalizedModelId = normalizeModelValue(modelId);
	if (!normalizedModelId) return null;

	const model = findModelById(modelCatalog, normalizedModelId);
	const baseModelId = getBaseModelId(model);
	const baseModel = baseModelId ? findModelById(modelCatalog, baseModelId) : null;
	const identity: ChatNotificationModelIdentity = {
		id: normalizedModelId
	};

	const name = normalizeModelValue(model?.name);
	const ownedBy = normalizeModelValue(model?.owned_by);
	const baseModelName = normalizeModelValue(baseModel?.name);
	const baseModelOwnedBy = normalizeModelValue(baseModel?.owned_by);
	if (name) identity.name = name;
	if (ownedBy) identity.ownedBy = ownedBy;
	if (baseModelId) identity.baseModelId = baseModelId;
	if (baseModelName) identity.baseModelName = baseModelName;
	if (baseModelOwnedBy) identity.baseModelOwnedBy = baseModelOwnedBy;
	return identity;
};

export const resolveChatNotificationModelIdentity = ({
	chatRow,
	modelCatalog = [],
	fallbackModelIds = []
}: {
	chatRow: any;
	modelCatalog?: any[];
	fallbackModelIds?: unknown[];
}): ChatNotificationModelIdentity | null => {
	const latestModelId =
		resolveSidebarChatModelId(chatRow) ??
		(fallbackModelIds ?? []).map(normalizeModelValue).find(Boolean) ??
		'';
	return resolveNotificationModelIdentityForId(latestModelId, modelCatalog);
};
