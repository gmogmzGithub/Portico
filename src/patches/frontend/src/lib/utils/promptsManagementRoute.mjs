export const PROMPTS_MANAGEMENT_PATH = '/workspace/prompts';

export const isPromptsManagementPath = (pathname = '') => {
	const normalizedPathname = String(pathname || '');
	return (
		normalizedPathname === PROMPTS_MANAGEMENT_PATH ||
		normalizedPathname.startsWith(`${PROMPTS_MANAGEMENT_PATH}/`)
	);
};

export const resolvePromptsManagementRedirect = ({
	pathname = '',
	canManagePrompts = false
} = {}) => {
	if (!canManagePrompts) {
		return '/';
	}

	return isPromptsManagementPath(pathname) ? null : PROMPTS_MANAGEMENT_PATH;
};
