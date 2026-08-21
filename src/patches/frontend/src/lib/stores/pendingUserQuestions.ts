// PORTICO-348: pending Ask User Question flows, keyed by the chat that owns them.
//
// Questions used to be presented by a single Electron modal shared by every
// chat tab, which meant a question in one chat blocked the whole app and hid a
// pending question in another. They are now rendered inline in the owning
// chat's transcript, so the renderer needs per-chat access to the flow content.
//
// The host broadcasts every in-progress flow (see
// buildNativeInputPresentationSnapshot) to all OWUI views of a window; this
// store keeps only the user_question flows and indexes them by chat id, so a
// chat never sees another chat's question.

import { writable } from 'svelte/store';

export type PendingUserQuestionOption = {
	id: string;
	label: string;
	description: string;
	// Per-option picker seeds: selecting this option reveals the question's
	// components prefilled with these ids; an explicit [] entry reveals that
	// picker empty.
	component_defaults: Record<string, string[]> | null;
};

export type PendingUserQuestionComponent = {
	id: string;
	// skill_picker | mcp_server_picker | model_picker | reasoning_effort_picker
	type: string;
	label: string | null;
	multiple: boolean;
	// Seed applied when the picker shows ungated (or when the revealing option
	// has no component_defaults entry for it).
	default_selected: string[] | null;
};

export type PendingUserQuestionItem = {
	id: string;
	header: string;
	question: string;
	freeform_placeholder: string | null;
	options: PendingUserQuestionOption[];
	components: PendingUserQuestionComponent[];
	components_gated_by_option_id: string | null;
};

export type PendingUserQuestionFlow = {
	flowId: string;
	chatId: string;
	questions: PendingUserQuestionItem[];
};

export const pendingUserQuestionsByChatId = writable<Map<string, PendingUserQuestionFlow>>(
	new Map()
);

const normalizeString = (value: unknown): string =>
	typeof value === 'string' ? value.trim() : '';

// Empty lists normalize to null (mirroring the host) unless keepEmpty — an
// explicit [] inside component_defaults means "reveal this picker empty".
const normalizeIdList = (value: unknown, keepEmpty = false): string[] | null => {
	if (!Array.isArray(value)) {
		return null;
	}
	const ids = value.map((entry) => normalizeString(entry)).filter(Boolean);
	return ids.length > 0 || keepEmpty ? ids : null;
};

const normalizeComponentDefaults = (value: unknown): Record<string, string[]> | null => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const defaults: Record<string, string[]> = {};
	for (const [key, ids] of Object.entries(value as Record<string, unknown>)) {
		const componentId = normalizeString(key);
		if (!componentId) {
			continue;
		}
		defaults[componentId] = normalizeIdList(ids, true) ?? [];
	}
	return Object.keys(defaults).length > 0 ? defaults : null;
};

const normalizeQuestions = (rawQuestions: unknown): PendingUserQuestionItem[] => {
	if (!Array.isArray(rawQuestions)) {
		return [];
	}
	const questions: PendingUserQuestionItem[] = [];
	for (const raw of rawQuestions) {
		const id = normalizeString((raw as any)?.id);
		const question = normalizeString((raw as any)?.question);
		if (!id || !question) {
			continue;
		}
		const rawOptions = Array.isArray((raw as any)?.options) ? (raw as any).options : [];
		const rawComponents = Array.isArray((raw as any)?.components)
			? (raw as any).components
			: [];
		questions.push({
			id,
			header: normalizeString((raw as any)?.header),
			question,
			freeform_placeholder: normalizeString((raw as any)?.freeform_placeholder) || null,
			options: rawOptions
				.map((option: any) => ({
					id: normalizeString(option?.id),
					label: normalizeString(option?.label),
					description: normalizeString(option?.description),
					component_defaults: normalizeComponentDefaults(option?.component_defaults)
				}))
				.filter((option: PendingUserQuestionOption) => option.id && option.label),
			components: rawComponents
				.map((component: any) => ({
					id: normalizeString(component?.id),
					type: normalizeString(component?.type),
					label: normalizeString(component?.label) || null,
					multiple: component?.multiple !== false,
					default_selected: normalizeIdList(component?.default_selected)
				}))
				.filter((component: PendingUserQuestionComponent) => component.id && component.type),
			components_gated_by_option_id:
				normalizeString((raw as any)?.components_gated_by_option_id) || null
		});
	}
	return questions;
};

export const applyPendingUserQuestionSnapshot = (snapshot: unknown): void => {
	const next = new Map<string, PendingUserQuestionFlow>();
	const flows = Array.isArray((snapshot as any)?.flows) ? (snapshot as any).flows : [];
	for (const flow of flows) {
		if (normalizeString(flow?.kind) !== 'user_question') {
			continue;
		}
		const flowId = normalizeString(flow?.flow_id);
		const chatId = normalizeString(flow?.chat_id);
		if (!flowId || !chatId || next.has(chatId)) {
			continue;
		}
		const questions = normalizeQuestions(flow?.questions);
		if (!questions.length) {
			continue;
		}
		next.set(chatId, { flowId, chatId, questions });
	}
	pendingUserQuestionsByChatId.set(next);
};

let initialized = false;

export const initializePendingUserQuestionsBridge = async (): Promise<void> => {
	if (initialized || typeof window === 'undefined') {
		return;
	}
	initialized = true;

	window.addEventListener('owui-native-input-presentation-snapshot', ((event: CustomEvent) => {
		applyPendingUserQuestionSnapshot(event.detail);
	}) as EventListener);

	const hostApi = (window as any)?.webviewHost;
	if (typeof hostApi?.getNativeInputPresentationSnapshot === 'function') {
		try {
			applyPendingUserQuestionSnapshot(await hostApi.getNativeInputPresentationSnapshot());
		} catch (error) {
			console.warn('[pendingUserQuestions] initial snapshot failed:', error);
		}
	}
};
