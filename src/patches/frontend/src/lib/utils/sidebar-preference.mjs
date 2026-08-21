export function normalizeStoredSidebarPreference(value) {
	if (value === true || value === false) {
		return value;
	}

	return null;
}

export function resolveInitialSidebarOpen({
	isMobile = false,
	delegatedSubagentView = false,
	storedLocalValue = "",
	persistedPreference = null
} = {}) {
	if (isMobile || delegatedSubagentView) {
		return false;
	}

	const normalizedPersistedPreference = normalizeStoredSidebarPreference(persistedPreference);
	if (normalizedPersistedPreference !== null) {
		return normalizedPersistedPreference;
	}

	return String(storedLocalValue || "").trim().toLowerCase() === "true";
}

export function shouldPersistSidebarPreference({
	isMobile = false,
	delegatedSubagentView = false
} = {}) {
	return !isMobile && !delegatedSubagentView;
}
