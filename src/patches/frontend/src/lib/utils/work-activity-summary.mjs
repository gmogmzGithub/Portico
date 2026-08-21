const ACTIVITY_TYPES = new Set(['reasoning', 'tool_calls', 'tool_preparation', 'tool_analysis']);
const USER_QUESTION_TOOL_NAMES = new Set(['ask_user_question', 'skills_ask_user_question']);

const decodeAttribute = (value) =>
	String(value ?? '')
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&amp;', '&')
		.trim();

const parseAttributes = (raw = '') => {
	const attributes = {};
	const attributePattern = /([^\s=]+)\s*=\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)')/g;
	let match;
	while ((match = attributePattern.exec(raw)) !== null) {
		attributes[match[1].toLowerCase()] = decodeAttribute(match[2] ?? match[3] ?? '');
	}
	return attributes;
};

const parseJsonObject = (value) => {
	let current = value;
	for (let depth = 0; depth < 3; depth += 1) {
		if (current && typeof current === 'object' && !Array.isArray(current)) {
			return current;
		}
		if (typeof current !== 'string' || !current.trim()) return null;
		try {
			current = JSON.parse(current);
		} catch {
			return null;
		}
	}
	return current && typeof current === 'object' && !Array.isArray(current) ? current : null;
};

const normalizedQuestionToolName = (value) => String(value ?? '').trim().toLowerCase();

const normalizeToolName = (value) =>
	String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');

export const isDisplayFilesToolCall = (attributes) => {
	if (String(attributes?.type ?? '').trim().toLowerCase() !== 'tool_calls') return false;
	const name = normalizeToolName(attributes?.name);
	return name === 'display_files' || name === 'agent_vm_display_files';
};

const USER_QUESTION_COMPONENT_LABELS = {
	skill_picker: 'Skills',
	mcp_server_picker: 'MCP servers',
	model_picker: 'Model',
	reasoning_effort_picker: 'Reasoning effort'
};

const prettifyComponentSelectionValue = (type, value) => {
	const raw = String(value ?? '').trim();
	if (!raw) return '';
	// Model values arrive as display names; humanizing would mangle them.
	if (type === 'model_picker') return raw;
	if (type === 'reasoning_effort_picker') return sentenceCase(raw.replace(/[-_]+/g, ' '));
	return humanizeServiceId(raw.replace(/^server:/i, ''));
};

// Projects a component answer ({componentId: [ids]}) into display groups
// ([{label, values}]) using the question's declared components for labels and
// value prettification. Null when the question/answer carries no components.
const buildComponentSelectionGroups = (question, answer) => {
	const components = Array.isArray(question?.components) ? question.components : [];
	const selections = answer?.component_selections;
	if (
		components.length === 0 ||
		!selections ||
		typeof selections !== 'object' ||
		Array.isArray(selections)
	) {
		return null;
	}
	const groups = [];
	for (const component of components) {
		const componentId = String(component?.id ?? '').trim();
		if (!componentId || !Object.prototype.hasOwnProperty.call(selections, componentId)) continue;
		const type = String(component?.type ?? '').trim().toLowerCase();
		const values = (Array.isArray(selections[componentId]) ? selections[componentId] : [])
			.map((value) => prettifyComponentSelectionValue(type, value))
			.filter(Boolean);
		groups.push({
			label:
				String(component?.label ?? '').trim() ||
				USER_QUESTION_COMPONENT_LABELS[type] ||
				'Options',
			values
		});
	}
	return groups.length > 0 ? groups : null;
};

const buildUserQuestionAnswerRecord = (toolCall, result) => {
	const toolCallId = String(toolCall?.id ?? '').trim();
	const toolName = normalizedQuestionToolName(toolCall?.function?.name);
	if (!toolCallId || !USER_QUESTION_TOOL_NAMES.has(toolName)) return null;

	const args = parseJsonObject(toolCall?.function?.arguments);
	const resultPayload = parseJsonObject(result?.content);
	if (
		!args ||
		!Array.isArray(args.questions) ||
		args.questions.length === 0 ||
		!resultPayload ||
		resultPayload.success !== true ||
		resultPayload.status !== 'submitted' ||
		!Array.isArray(resultPayload.answers)
	) {
		return null;
	}

	const questionsById = new Map();
	for (const question of args.questions) {
		const questionId = String(question?.id ?? '').trim();
		const header = String(question?.header ?? '').trim();
		const prompt = String(question?.question ?? '').trim();
		if (!questionId || !header || !prompt || questionsById.has(questionId)) return null;
		questionsById.set(questionId, question);
	}

	const answersById = new Map();
	for (const answer of resultPayload.answers) {
		const questionId = String(answer?.question_id ?? '').trim();
		if (!questionId || answersById.has(questionId) || !questionsById.has(questionId)) return null;
		answersById.set(questionId, answer);
	}
	if (answersById.size !== questionsById.size) return null;

	const questions = [];
	for (const [questionId, question] of questionsById) {
		const answer = answersById.get(questionId);
		const selectedOptionId = String(answer?.selected_option_id ?? '').trim();
		let selectedOptionLabel = String(answer?.selected_option_label ?? '').trim();
		if (!selectedOptionLabel && selectedOptionId && Array.isArray(question?.options)) {
			selectedOptionLabel = String(
				question.options.find((option) => String(option?.id ?? '').trim() === selectedOptionId)
					?.label ?? ''
			).trim();
		}
		const hasOption = Boolean(selectedOptionId && selectedOptionLabel);
		const componentSelections = buildComponentSelectionGroups(question, answer);
		const freeformText =
			typeof answer?.freeform_text === 'string' && answer.freeform_text.trim()
				? answer.freeform_text.trim()
				: null;
		// Component answers carry no selected option; a question is renderable
		// with any of the three. One unrenderable answer still nulls the whole
		// record (consistent with the count/shape guards above).
		if (!hasOption && !componentSelections && !freeformText) return null;

		questions.push({
			questionId,
			header: String(question.header).trim(),
			question: String(question.question).trim(),
			selectedOptionId: hasOption ? selectedOptionId : null,
			selectedOptionLabel: hasOption ? selectedOptionLabel : null,
			componentSelections,
			freeformText
		});
	}

	return {
		toolCallId,
		flowId: String(resultPayload.flow_id ?? '').trim() || null,
		questions
	};
};

/**
 * Builds read-only answer-card projections from the existing persisted tool
 * calls and results. Nothing produced here is written back to chat history.
 */
export const extractUserQuestionAnswerRecords = (contentBlocks = []) => {
	const records = new Map();
	if (!Array.isArray(contentBlocks)) return records;

	for (const block of contentBlocks) {
		if (String(block?.type ?? '').trim().toLowerCase() !== 'tool_calls') continue;
		const results = Array.isArray(block?.results) ? block.results : [];
		const resultByToolCallId = new Map(
			results
				.map((result) => [String(result?.tool_call_id ?? '').trim(), result])
				.filter(([toolCallId]) => Boolean(toolCallId))
		);
		for (const toolCall of Array.isArray(block?.content) ? block.content : []) {
			const toolCallId = String(toolCall?.id ?? '').trim();
			const record = buildUserQuestionAnswerRecord(toolCall, resultByToolCallId.get(toolCallId));
			if (record) records.set(toolCallId, record);
		}
	}

	return records;
};

const isTruthy = (value) => ['true', '1', 'yes'].includes(String(value ?? '').trim().toLowerCase());

const isStopped = (value) => {
	const normalized = String(value ?? '').trim().toLowerCase();
	return ['user', 'user_stop', 'cancelled', 'canceled', 'client_disconnect'].includes(normalized);
};

const buildWorkActivityEntry = (attributes) => ({
	type: String(attributes.type ?? '').trim().toLowerCase(),
	name: decodeAttribute(attributes.name),
	done:
		isTruthy(attributes.done) ||
		isStopped(attributes.stop_reason) ||
		Object.prototype.hasOwnProperty.call(attributes, 'result'),
	attributes
});

export const extractWorkActivityEntries = (content = '') => {
	const entries = [];
	const detailsPattern = /<details\b([^>]*)>/gi;
	let match;
	while ((match = detailsPattern.exec(String(content ?? ''))) !== null) {
		const attributes = parseAttributes(match[1]);
		const type = String(attributes.type ?? '').trim().toLowerCase();
		if (!ACTIVITY_TYPES.has(type)) continue;
		entries.push(buildWorkActivityEntry(attributes));
	}
	return entries;
};

const CORE_SERVICE_IDS = new Set([
	'agent-vm',
	'artifacts',
	'mcp-assistant',
	'scheduling',
	'skills',
	'subagents',
	'web-tools'
]);
// Specific summary labels for first-party tools. Keys are normalized service
// ids (normalizeToolName of the catalog id); patterns are anchored regexes
// tested against the action name (the tool name minus the service prefix).
// First matching rule wins. done/failed/attempted phrases are lowercase verb
// phrases (joined and sentence-cased by completedPhraseForEntries); active
// labels are capitalized standalone present-tense lines. The outcome picks
// the tier: success → done, failed (errored / failure-shaped result) →
// failed, attempted (user-stopped / interrupted / incomplete) → attempted;
// failed falls back to the attempted phrasing when a rule omits it. Without
// identityBy a rule's calls collapse into ONE descriptor, so the *One
// singular (when present) is what actually renders — author both forms
// anyway so identityBy stays a drop-in. A rule may opt into per-target
// identity via identityBy (argument field names for toolTarget); none do
// today because toolTarget falls back to per-call ids when arguments are
// missing, which would stop reduceDescriptors from merging repeats.
const CORE_TOOL_LABEL_RULES = {
	agent_vm: [
		{
			key: 'workspace-read',
			pattern: /^(read_file|read_files|read_fragment|list_files|find_files|grep|grep_file)$/,
			labels: {
				active: 'Reading files in its workspace',
				done: 'read files in its workspace',
				failed: 'failed to read files in its workspace',
				attempted: 'tried to read files in its workspace'
			}
		},
		{
			key: 'workspace-edit',
			pattern: /^(create_file|create_files|edit_file|edit_files|delete_file|unzip_file)$/,
			labels: {
				active: 'Editing files in its workspace',
				done: 'edited files in its workspace',
				failed: 'failed to edit files in its workspace',
				attempted: 'tried to edit files in its workspace'
			}
		},
		{
			key: 'skill-script',
			pattern: /^execute_skill_script$/,
			labels: {
				active: 'Running a skill script',
				done: 'ran a skill script',
				failed: 'failed to run a skill script',
				attempted: 'tried to run a skill script'
			}
		},
		{
			key: 'share-files',
			pattern: /^(display_files|get_workspace_file_link)$/,
			labels: {
				active: 'Sharing files from its workspace',
				done: 'shared files from its workspace',
				failed: 'failed to share files from its workspace',
				attempted: 'tried to share files from its workspace'
			}
		},
		{
			key: 'review-images',
			pattern: /^request_images$/,
			labels: {
				active: 'Reviewing images from its workspace',
				done: 'reviewed images from its workspace',
				failed: 'failed to review images from its workspace',
				attempted: 'tried to review images from its workspace'
			}
		},
		{
			key: 'sensitive-info',
			pattern: /^request_sensitive_information$/,
			labels: {
				active: 'Requesting sensitive information securely',
				done: 'requested sensitive information securely',
				failed: 'failed to request sensitive information',
				attempted: 'tried to request sensitive information'
			}
		},
		{
			key: 'chat-workspace',
			pattern: /^set_chat_workspace$/,
			labels: {
				active: 'Asking to use a folder as the chat workspace',
				done: 'asked to use a folder as the chat workspace',
				failed: 'failed to set the chat workspace',
				attempted: 'tried to set the chat workspace'
			}
		},
		{
			key: 'workspace-setup',
			pattern: /^(create|get_status)$/,
			labels: {
				active: 'Setting up its workspace',
				done: 'set up its workspace',
				failed: 'failed to set up its workspace',
				attempted: 'tried to set up its workspace'
			}
		},
		{
			key: 'workspace-cleanup',
			pattern: /^destroy$/,
			labels: {
				active: 'Cleaning up its workspace',
				done: 'cleaned up its workspace',
				failed: 'failed to clean up its workspace',
				attempted: 'tried to clean up its workspace'
			}
		}
	],
	skills: [
		{
			key: 'skill-edit',
			pattern: /^(create|update|delete|rename)_skill(_reference|_script)?$/,
			labels: {
				active: 'Editing skills',
				done: 'edited skills',
				doneOne: 'edited a skill',
				failed: 'failed to edit skills',
				failedOne: 'failed to edit a skill',
				attempted: 'tried to edit skills',
				attemptedOne: 'tried to edit a skill'
			}
		},
		{
			key: 'skill-toggle',
			pattern: /^deactivate_skill$/,
			labels: {
				active: 'Unloading a skill',
				done: 'unloaded skills',
				doneOne: 'unloaded a skill',
				failed: 'failed to unload a skill',
				attempted: 'tried to unload a skill'
			}
		},
		{
			key: 'skill-review',
			pattern: /^(read_skill|list_skills|get_skill_assets|get_activated_skills)$/,
			labels: {
				active: 'Reviewing available skills',
				done: 'reviewed available skills',
				failed: 'failed to review available skills',
				attempted: 'tried to review available skills'
			}
		},
		{
			key: 'skill-publish',
			pattern: /^publish_skill$/,
			labels: {
				active: 'Publishing a skill',
				done: 'published skills',
				doneOne: 'published a skill',
				failed: 'failed to publish skills',
				failedOne: 'failed to publish a skill',
				attempted: 'tried to publish skills',
				attemptedOne: 'tried to publish a skill'
			}
		},
		{
			key: 'skill-unpublish',
			pattern: /^unpublish_skill$/,
			labels: {
				active: 'Unpublishing a skill',
				done: 'unpublished skills',
				doneOne: 'unpublished a skill',
				failed: 'failed to unpublish skills',
				failedOne: 'failed to unpublish a skill',
				attempted: 'tried to unpublish skills',
				attemptedOne: 'tried to unpublish a skill'
			}
		},
		{
			key: 'skill-export',
			pattern: /^export_skill_bundle$/,
			labels: {
				active: 'Exporting a skill bundle',
				done: 'exported skill bundles',
				doneOne: 'exported a skill bundle',
				failed: 'failed to export skill bundles',
				failedOne: 'failed to export a skill bundle',
				attempted: 'tried to export skill bundles',
				attemptedOne: 'tried to export a skill bundle'
			}
		},
		{
			key: 'skill-copy',
			pattern: /^copy_skill$/,
			labels: {
				active: 'Copying a skill',
				done: 'copied skills',
				doneOne: 'copied a skill',
				failed: 'failed to copy skills',
				failedOne: 'failed to copy a skill',
				attempted: 'tried to copy skills',
				attemptedOne: 'tried to copy a skill'
			}
		},
		{
			key: 'skill-reclaim',
			pattern: /^reclaim_skill$/,
			labels: {
				active: 'Reclaiming a published skill',
				done: 'reclaimed published skills',
				doneOne: 'reclaimed a published skill',
				failed: 'failed to reclaim published skills',
				failedOne: 'failed to reclaim a published skill',
				attempted: 'tried to reclaim published skills',
				attemptedOne: 'tried to reclaim a published skill'
			}
		},
		{
			key: 'published-skills-list',
			pattern: /^list_published_skills$/,
			labels: {
				active: 'Listing published skills',
				done: 'listed published skills',
				failed: 'failed to list published skills',
				attempted: 'tried to list published skills'
			}
		},
		{
			key: 'marketplace-browse',
			pattern:
				/^(list_marketplaces|get_marketplace_skills|search_marketplace_solutions|get_marketplace_solution|get_marketplace_bundle|check_marketplace_skill_updates)$/,
			labels: {
				active: 'Browsing the skill marketplace',
				done: 'browsed the skill marketplace',
				failed: 'failed to browse the skill marketplace',
				attempted: 'tried to browse the skill marketplace'
			}
		},
		{
			key: 'marketplace-manage',
			pattern:
				/^(add_marketplace|remove_marketplace|sync_marketplace|sync_all_marketplaces|install_marketplace_skill|uninstall_marketplace_skill|replace_user_skill_with_marketplace_install|detach_marketplace_skill_to_user_skill|update_marketplace_skill|install_marketplace_solution)$/,
			labels: {
				active: 'Updating marketplace skills',
				done: 'updated marketplace skills',
				failed: 'failed to update marketplace skills',
				attempted: 'tried to update marketplace skills'
			}
		},
		{
			// Waiting has no failure tense: an interrupted or errored wait still
			// just reads as a pause.
			key: 'wait',
			pattern: /^wait$/,
			labels: {
				active: 'Waiting briefly',
				done: 'paused briefly',
				attempted: 'paused briefly'
			}
		}
	],
	subagents: [
		{
			key: 'cross-chat-start',
			pattern: /^start_chat$/,
			labels: {
				active: 'Starting a new agent chat',
				done: 'started new agent chats',
				doneOne: 'started a new agent chat',
				failed: 'failed to start new agent chats',
				failedOne: 'failed to start a new agent chat',
				attempted: 'tried to start new agent chats',
				attemptedOne: 'tried to start a new agent chat'
			}
		},
		{
			key: 'cross-chat-message',
			pattern: /^send_message_to_chat$/,
			labels: {
				active: 'Messaging another chat',
				done: 'messaged other chats',
				doneOne: 'messaged another chat',
				failed: 'failed to message other chats',
				failedOne: 'failed to message another chat',
				attempted: 'tried to message other chats',
				attemptedOne: 'tried to message another chat'
			}
		},
		{
			key: 'cross-chat-list',
			pattern: /^list_chats$/,
			labels: {
				active: 'Listing recent chats',
				done: 'listed recent chats',
				doneOne: 'listed recent chats',
				failed: 'failed to list recent chats',
				failedOne: 'failed to list recent chats',
				attempted: 'tried to list recent chats',
				attemptedOne: 'tried to list recent chats'
			}
		},
		{
			key: 'agent-review',
			pattern: /^(get_agent|list_agents|get_agent_system_prompt|list_available_tools)$/,
			labels: {
				active: 'Reviewing available agents',
				done: 'reviewed available agents',
				failed: 'failed to review available agents',
				attempted: 'tried to review available agents'
			}
		},
		{
			key: 'agent-published-list',
			pattern: /^list_published_agents$/,
			labels: {
				active: 'Listing published agents',
				done: 'listed published agents',
				failed: 'failed to list published agents',
				attempted: 'tried to list published agents'
			}
		},
		{
			key: 'agent-marketplace-browse',
			pattern: /^(search_marketplace_agents|get_marketplace_agent)$/,
			labels: {
				active: 'Browsing the agent marketplace',
				done: 'browsed the agent marketplace',
				failed: 'failed to browse the agent marketplace',
				attempted: 'tried to browse the agent marketplace'
			}
		},
		{
			key: 'agent-edit',
			pattern: /^(update_agent|delete_agent)$/,
			labels: {
				active: 'Updating agents',
				done: 'updated agents',
				doneOne: 'updated an agent',
				failed: 'failed to update agents',
				failedOne: 'failed to update an agent',
				attempted: 'tried to update an agent'
			}
		},
		{
			key: 'agent-publish',
			pattern: /^publish_agent$/,
			labels: {
				active: 'Publishing an agent',
				done: 'published agents',
				doneOne: 'published an agent',
				failed: 'failed to publish agents',
				failedOne: 'failed to publish an agent',
				attempted: 'tried to publish agents',
				attemptedOne: 'tried to publish an agent'
			}
		},
		{
			key: 'agent-unpublish',
			pattern: /^unpublish_agent$/,
			labels: {
				active: 'Unpublishing an agent',
				done: 'unpublished agents',
				doneOne: 'unpublished an agent',
				failed: 'failed to unpublish agents',
				failedOne: 'failed to unpublish an agent',
				attempted: 'tried to unpublish agents',
				attemptedOne: 'tried to unpublish an agent'
			}
		},
		{
			key: 'agent-install',
			pattern: /^install_agent$/,
			labels: {
				active: 'Installing a marketplace agent',
				done: 'installed marketplace agents',
				doneOne: 'installed a marketplace agent',
				failed: 'failed to install marketplace agents',
				failedOne: 'failed to install a marketplace agent',
				attempted: 'tried to install marketplace agents',
				attemptedOne: 'tried to install a marketplace agent'
			}
		},
		{
			key: 'agent-copy',
			pattern: /^copy_agent$/,
			labels: {
				active: 'Copying an agent',
				done: 'copied agents',
				doneOne: 'copied an agent',
				failed: 'failed to copy agents',
				failedOne: 'failed to copy an agent',
				attempted: 'tried to copy agents',
				attemptedOne: 'tried to copy an agent'
			}
		},
		{
			key: 'agent-reclaim',
			pattern: /^reclaim_agent$/,
			labels: {
				active: 'Reclaiming a published agent',
				done: 'reclaimed published agents',
				doneOne: 'reclaimed a published agent',
				failed: 'failed to reclaim published agents',
				failedOne: 'failed to reclaim a published agent',
				attempted: 'tried to reclaim published agents',
				attemptedOne: 'tried to reclaim a published agent'
			}
		},
		{
			key: 'agent-attribution',
			pattern: /^reconcile_agent_attribution$/,
			labels: {
				active: 'Updating agent attribution',
				done: 'updated agent attribution',
				failed: 'failed to update agent attribution',
				attempted: 'tried to update agent attribution'
			}
		},
		{
			key: 'local-runtime',
			pattern: /^(configure_lm_studio|get_lm_studio_status)$/,
			labels: {
				active: 'Checking the local model runtime',
				done: 'checked the local model runtime',
				failed: 'failed to check the local model runtime',
				attempted: 'tried to check the local model runtime'
			}
		},
		{
			key: 'system-info',
			pattern: /^get_system_information$/,
			labels: {
				active: 'Checking system information',
				done: 'checked system information',
				failed: 'failed to check system information',
				attempted: 'tried to check system information'
			}
		}
	],
	artifacts: [
		{
			key: 'artifact-build',
			pattern: /^create_artifact(_version)?$/,
			labels: {
				active: 'Building an artifact',
				done: 'built artifacts',
				doneOne: 'built an artifact',
				failed: 'failed to build artifacts',
				failedOne: 'failed to build an artifact',
				attempted: 'tried to build an artifact'
			}
		},
		{
			key: 'artifact-preview',
			pattern: /^(open_artifact|close_artifact|switch_artifact_version|restore_artifact_version)$/,
			labels: {
				active: 'Managing artifact previews',
				done: 'managed artifact previews',
				failed: 'failed to manage artifact previews',
				attempted: 'tried to manage artifact previews'
			}
		},
		{
			key: 'artifact-remove',
			pattern: /^delete_artifact$/,
			labels: {
				active: 'Removing an artifact',
				done: 'removed artifacts',
				doneOne: 'removed an artifact',
				failed: 'failed to remove artifacts',
				failedOne: 'failed to remove an artifact',
				attempted: 'tried to remove an artifact'
			}
		},
		{
			key: 'artifact-download',
			pattern: /^download_artifact$/,
			labels: {
				active: 'Downloading an artifact',
				done: 'downloaded an artifact',
				failed: 'failed to download an artifact',
				attempted: 'tried to download an artifact'
			}
		},
		{
			key: 'artifact-check',
			pattern: /^(list_artifacts|get_artifact_status|get_artifact_running_versions)$/,
			labels: {
				active: 'Checking on artifacts',
				done: 'checked on artifacts',
				failed: 'failed to check on artifacts',
				attempted: 'tried to check on artifacts'
			}
		}
	],
	scheduling: [
		{
			key: 'task-create',
			pattern: /^create_task$/,
			labels: {
				active: 'Scheduling a task',
				done: 'scheduled tasks',
				doneOne: 'scheduled a task',
				failed: 'failed to schedule tasks',
				failedOne: 'failed to schedule a task',
				attempted: 'tried to schedule a task'
			}
		},
		{
			key: 'task-update',
			pattern: /^(update_task|delete_task|cancel_run|finalize_run)$/,
			labels: {
				active: 'Updating scheduled tasks',
				done: 'updated scheduled tasks',
				failed: 'failed to update scheduled tasks',
				attempted: 'tried to update scheduled tasks'
			}
		},
		{
			key: 'task-check',
			pattern: /^(get_task|list_tasks)$/,
			labels: {
				active: 'Checking scheduled tasks',
				done: 'checked scheduled tasks',
				failed: 'failed to check scheduled tasks',
				attempted: 'tried to check scheduled tasks'
			}
		},
		{
			key: 'task-run',
			pattern: /^run_task_now$/,
			labels: {
				active: 'Running a scheduled task',
				done: 'ran a scheduled task',
				failed: 'failed to run a scheduled task',
				attempted: 'tried to run a scheduled task'
			}
		}
	],
	mcp_assistant: [
		{
			key: 'integration-check',
			pattern:
				/^(list_mcp_servers|get_system_mcp_config|read_user_mcp_server|get_chat_tools|get_host_mcp_bridge_status|get_mcp_server_logs)$/,
			labels: {
				active: 'Checking connected integrations',
				done: 'checked connected integrations',
				failed: 'failed to check connected integrations',
				attempted: 'tried to check connected integrations'
			}
		},
		{
			key: 'integration-edit',
			pattern:
				/^((create|update|delete)_user_mcp_server|validate_mcp_fragment|configure_host_mcp_bridge_clients)$/,
			labels: {
				active: 'Updating integration settings',
				done: 'updated integration settings',
				failed: 'failed to update integration settings',
				attempted: 'tried to update integration settings'
			}
		},
		{
			key: 'integration-restart',
			pattern: /^(restart_mcp_infrastructure|restart_mcp_server)$/,
			labels: {
				active: 'Restarting integrations',
				done: 'restarted integrations',
				failed: 'failed to restart integrations',
				attempted: 'tried to restart integrations'
			}
		},
		{
			key: 'integration-setup',
			pattern: /^(activate_integration|toggle_integration|authorize_integration|trigger_guided_setup)$/,
			labels: {
				active: 'Setting up an integration',
				done: 'set up integrations',
				doneOne: 'set up an integration',
				failed: 'failed to set up integrations',
				failedOne: 'failed to set up an integration',
				attempted: 'tried to set up an integration'
			}
		}
	],
	web_tools: [
		{
			key: 'web-search',
			pattern: /^web_search$/,
			labels: {
				active: 'Searching the web',
				done: 'searched the web',
				failed: 'failed to search the web',
				attempted: 'tried to search the web'
			}
		}
	]
};

const resolveCoreToolRule = (serviceId, actionName) => {
	const rules = CORE_TOOL_LABEL_RULES[normalizeToolName(serviceId)];
	if (!rules) return null;
	return rules.find((rule) => rule.pattern.test(actionName)) ?? null;
};
const CANCELLED_STOP_REASONS = new Set([
	'user',
	'user_stop',
	'cancelled',
	'canceled',
	'client_disconnect'
]);
const FAILURE_STATUSES = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled']);
const READ_ACTION_PATTERN =
	/(^|_)(browse|download|extract|fetch|find|get|inspect|list|load|lookup|query|read|retrieve|search)(_|$)/;
const WRITE_ACTION_PATTERN =
	/(^|_)(add|approve|archive|assign|copy|create|delete|edit|link|move|patch|remove|replace|restore|save|set|unlink|update|upload|write)(_|$)/;
const MESSAGE_ACTION_PATTERN =
	/(^|_)(comment|invite|message|notify|post|publish|reply|send|share)(_|$)/;

const joinNatural = (items) => {
	const values = [...items].filter(Boolean);
	if (values.length <= 1) return values[0] ?? '';
	if (values.length === 2) return `${values[0]} and ${values[1]}`;
	return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
};

const sentenceCase = (value) =>
	value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;

const humanizeServiceId = (value) =>
	String(value ?? '')
		.replace(/^mcp[-_]/i, '')
		.replace(/[-_](?:mcp|mcp-server)$/i, '')
		.replace(/[-_]+/g, ' ')
		.replace(/\b\w/g, (letter) => letter.toUpperCase())
		.replace(/\bJira\b/g, 'JIRA')
		.replace(/\bGitlab\b/g, 'GitLab')
		.trim();

const proseServiceName = (entry) => {
	const id = String(entry?.id ?? '').trim();
	const displayName = String(entry?.display_name ?? '').trim() || humanizeServiceId(id);
	if (normalizeToolName(id) === 'google_workspace' || displayName.toLowerCase() === 'google workspace') {
		return 'Google';
	}
	return displayName || id;
};

const normalizeCatalog = (serviceCatalog = []) => {
	if (!Array.isArray(serviceCatalog)) return [];
	if (
		serviceCatalog.every(
			(candidate) =>
				candidate &&
				typeof candidate === 'object' &&
				typeof candidate.normalizedId === 'string' &&
				typeof candidate.proseName === 'string'
		)
	) {
		return serviceCatalog;
	}
	const catalog = [];
	const seen = new Set();
	for (const candidate of serviceCatalog) {
		const id = String(typeof candidate === 'string' ? candidate : candidate?.id ?? '').trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const entry =
			typeof candidate === 'string'
				? { id, display_name: humanizeServiceId(id) }
				: { id, display_name: String(candidate?.display_name ?? '').trim() || humanizeServiceId(id) };
		catalog.push({
			...entry,
			normalizedId: normalizeToolName(id),
			proseName: proseServiceName(entry)
		});
	}
	return catalog.sort((left, right) => right.normalizedId.length - left.normalizedId.length);
};

const resolveToolService = (name, serviceCatalog) => {
	const normalizedName = normalizeToolName(name).replace(/^tool_/, '');
	for (const service of serviceCatalog) {
		if (
			normalizedName === service.normalizedId ||
			normalizedName.startsWith(`${service.normalizedId}_`)
		) {
			return {
				...service,
				actionName: normalizedName.slice(service.normalizedId.length).replace(/^_/, '')
			};
		}
	}
	return null;
};

const parseJsonValue = (value) => {
	let current = value;
	for (let depth = 0; depth < 4; depth += 1) {
		if (typeof current !== 'string' || !current.trim()) return current;
		try {
			current = JSON.parse(current);
		} catch {
			return current;
		}
	}
	return current;
};

const hasFailureResult = (value, depth = 0) => {
	if (depth > 4 || value == null) return false;
	const parsed = parseJsonValue(value);
	if (typeof parsed === 'string') {
		const normalized = parsed.trim().toLowerCase();
		return normalized.startsWith('interrupted:') || normalized.includes('tool execution failed');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
	if (parsed.is_error === true || parsed.success === false) return true;
	if (FAILURE_STATUSES.has(String(parsed.status ?? parsed.state ?? '').trim().toLowerCase())) {
		return true;
	}
	if (parsed.error != null && String(parsed.error).trim() !== '') return true;
	return ['content', 'result'].some((key) => hasFailureResult(parsed[key], depth + 1));
};

const hasPositiveNumber = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

const getEntryOutcome = (entry) => {
	if (!entry?.done) return 'pending';
	const attributes = entry.attributes ?? {};
	const stopReason = String(attributes.stop_reason ?? '').trim().toLowerCase();
	const cancelled = CANCELLED_STOP_REASONS.has(stopReason);
	const result = attributes.result;
	const interruptedResult =
		typeof parseJsonValue(result) === 'string' &&
		String(parseJsonValue(result)).trim().toLowerCase().startsWith('interrupted:');
	const began =
		Boolean(String(attributes.started_at ?? '').trim()) ||
		hasPositiveNumber(attributes.duration) ||
		hasPositiveNumber(attributes.elapsed) ||
		(Object.prototype.hasOwnProperty.call(attributes, 'result') &&
			!(cancelled && interruptedResult && !hasPositiveNumber(attributes.duration)));
	if (cancelled) return began ? 'attempted' : 'excluded';
	// Interruption is not failure: user stops and incomplete streams read
	// "tried to…" (attempted), while errored / failure-shaped completions
	// read "failed to…". The interrupted checks run first because
	// hasFailureResult also matches "interrupted:" result strings.
	if (/(incomplete|interrupted)/.test(stopReason)) return 'attempted';
	if (/(error|fail|timeout|exhausted)/.test(stopReason)) return 'failed';
	if (interruptedResult) return 'attempted';
	if (hasFailureResult(result)) return 'failed';
	return 'success';
};

const toolTarget = (entry, index, fields) => {
	const args = parseJsonObject(entry?.attributes?.arguments) ?? {};
	const values = fields.map((field) => String(args?.[field] ?? '').trim()).filter(Boolean);
	return values.join(':') || String(entry?.attributes?.id ?? '').trim() || `call-${index}`;
};

const classifyLegacyTool = (normalized) => {
	if (/(apply_?patch|edit|write|replace|create_?file|update_?file|patch_?file)/.test(normalized)) {
		return 'edit';
	}
	if (/(read_?file|view_?file|open_?file|display_?file|view_?image|read_document|cat(?:_|$))/.test(normalized)) {
		return 'read';
	}
	if (/(web_?search|browser|search_?web)/.test(normalized)) return 'web_search';
	if (/(search|grep|find|query|lookup|sourcegraph)/.test(normalized)) return 'search';
	return 'other';
};

const describeToolEntry = (entry, serviceCatalog, index) => {
	const normalized = normalizeToolName(entry?.name).replace(/^tool_/, '');
	const service = resolveToolService(entry?.name, serviceCatalog);
	const actionName = service?.actionName || normalized;
	const outcome = getEntryOutcome(entry);
	const base = { entry, index, outcome, service };

	if (/(^|_)activate_skill(?:_|$)/.test(normalized)) {
		return { ...base, kind: 'skill_load', identity: toolTarget(entry, index, ['skill_name']) };
	}
	if (/(^|_)get_skill_reference(?:_|$)/.test(normalized)) {
		return {
			...base,
			kind: 'skill_reference',
			identity: toolTarget(entry, index, ['skill_name', 'reference_path', 'path'])
		};
	}
	if (/(^|_)run_subagent(?:_|$)/.test(normalized)) {
		return { ...base, kind: 'subagent', identity: toolTarget(entry, index, []) };
	}
	if (/(^|_)create_agent(?:_|$)/.test(normalized)) {
		return { ...base, kind: 'agent_create', identity: toolTarget(entry, index, ['name', 'display_name']) };
	}
	if (/(^|_)ask_user_question$/.test(normalized)) {
		return { ...base, kind: 'user_question', identity: 'user_question' };
	}

	const isExternalService = service && !CORE_SERVICE_IDS.has(service.id);
	const isWriteAction = WRITE_ACTION_PATTERN.test(actionName);
	const isMessageAction = MESSAGE_ACTION_PATTERN.test(actionName);
	const isReadAction = READ_ACTION_PATTERN.test(actionName);
	if (/(^|_)(calendars?|events?|meetings?)(_|$)/.test(actionName)) {
		return {
			...base,
			kind: isWriteAction || isMessageAction ? 'calendar_update' : 'calendar_check',
			identity: isWriteAction || isMessageAction ? 'calendar_update' : 'calendar_check'
		};
	}

	const coreRule =
		service && CORE_SERVICE_IDS.has(service.id) ? resolveCoreToolRule(service.id, actionName) : null;
	if (coreRule) {
		const identity = coreRule.identityBy
			? `core:${service.id}:${coreRule.key}:${toolTarget(entry, index, coreRule.identityBy)}`
			: `core:${service.id}:${coreRule.key}`;
		return { ...base, kind: 'core_labeled', identity, coreLabels: coreRule.labels };
	}

	const isCommand = /(^|_)(bash|shell|exec|command|terminal|python|run_script|execute)(_|$)/.test(
		normalized
	);
	if (isCommand && !isExternalService) {
		return { ...base, kind: 'command', identity: 'command' };
	}

	if (isExternalService) {
		const kind = isMessageAction
			? 'provider_message'
			: isWriteAction
				? 'provider_update'
				: isReadAction
					? 'provider_fetch'
					: 'provider_use';
		return { ...base, kind, identity: `${kind}:${service.id}` };
	}

	const kind = classifyLegacyTool(normalized);
	return { ...base, kind, identity: kind };
};

const outcomeRank = (outcome) =>
	({ excluded: 0, attempted: 1, failed: 2, pending: 3, success: 4 })[outcome] ?? 0;

const reduceDescriptors = (descriptors, messageDone) => {
	const reduced = new Map();
	for (const descriptor of descriptors) {
		const outcome = descriptor.outcome === 'pending' && messageDone ? 'success' : descriptor.outcome;
		if (outcome === 'excluded' || outcome === 'pending') continue;
		const current = reduced.get(descriptor.identity);
		const candidate = { ...descriptor, outcome };
		if (!current) {
			reduced.set(descriptor.identity, candidate);
			continue;
		}
		current.index = Math.min(current.index, candidate.index);
		if (outcomeRank(candidate.outcome) > outcomeRank(current.outcome)) {
			current.outcome = candidate.outcome;
		}
	}
	return [...reduced.values()];
};

const groupCompletedDescriptors = (descriptors) => {
	const groups = new Map();
	for (const descriptor of descriptors) {
		let outcome = descriptor.outcome;
		if (['skill_load', 'skill_reference', 'subagent', 'command'].includes(descriptor.kind)) {
			const hasSuccess = descriptors.some(
				(candidate) => candidate.kind === descriptor.kind && candidate.outcome === 'success'
			);
			if (hasSuccess && (outcome === 'attempted' || outcome === 'failed')) continue;
		}
		// core_labeled groups key on identity so descriptors from different
		// label rules never merge into one phrase.
		const key =
			descriptor.kind === 'core_labeled'
				? `${descriptor.identity}:${outcome}`
				: `${descriptor.kind}:${outcome}`;
		const group = groups.get(key) ?? {
			kind: descriptor.kind,
			outcome,
			index: descriptor.index,
			count: 0,
			services: [],
			...(descriptor.coreLabels ? { coreLabels: descriptor.coreLabels } : {})
		};
		group.index = Math.min(group.index, descriptor.index);
		group.count += 1;
		if (descriptor.service && !group.services.some((service) => service.id === descriptor.service.id)) {
			group.services.push({ ...descriptor.service, index: descriptor.index });
		}
		groups.set(key, group);
	}
	return [...groups.values()].sort((left, right) => left.index - right.index);
};

const phraseForCompletedGroup = (group, successfulFetches) => {
	if (group.kind === 'core_labeled' && group.coreLabels) {
		const labels = group.coreLabels;
		if (group.outcome === 'failed') {
			return (
				(group.count === 1 && labels.failedOne) ||
				labels.failed ||
				(group.count === 1 && labels.attemptedOne) ||
				labels.attempted
			);
		}
		if (group.outcome === 'attempted') {
			return (group.count === 1 && labels.attemptedOne) || labels.attempted;
		}
		return (group.count === 1 && labels.doneOne) || labels.done;
	}
	// Generic (non-core) phrasing keeps one attempted tense for both failure
	// and interruption — per-tool failed wording is a core-rule feature.
	const attempted = group.outcome === 'attempted' || group.outcome === 'failed';
	const serviceNames = joinNatural(
		group.services.sort((left, right) => left.index - right.index).map((service) => service.proseName)
	);
	if (group.kind === 'skill_load') {
		return attempted
			? `tried to load ${group.count === 1 ? 'a skill' : 'skills'}`
			: `loaded ${group.count === 1 ? 'a skill' : 'skills'}`;
	}
	if (group.kind === 'skill_reference') {
		return attempted
			? `tried to load ${group.count === 1 ? 'an extra skill reference' : 'extra skill references'}`
			: `loaded ${group.count === 1 ? 'an extra skill reference' : 'extra skill references'}`;
	}
	if (group.kind === 'provider_fetch') {
		return `${attempted ? 'tried to fetch' : 'fetched'} data from ${serviceNames}`;
	}
	if (group.kind === 'provider_update') {
		return `${attempted ? 'tried to update' : 'updated'} data in ${serviceNames}`;
	}
	if (group.kind === 'provider_message') {
		return `${attempted ? 'tried to send' : 'sent'} information through ${serviceNames}`;
	}
	if (group.kind === 'provider_use') {
		return `${attempted ? 'tried to work' : 'worked'} with ${serviceNames}`;
	}
	if (group.kind === 'command') {
		const processesFetchedData = successfulFetches.some((fetch) => fetch.index < group.index);
		if (processesFetchedData) return attempted ? 'tried to process it' : 'processed it';
		return attempted ? 'tried to complete background work' : 'completed background work';
	}
	if (group.kind === 'subagent') {
		return attempted
			? `tried to delegate to ${group.count === 1 ? 'a subagent' : 'subagents'}`
			: `delegated to ${group.count === 1 ? 'a subagent' : 'subagents'}`;
	}
	if (group.kind === 'agent_create') {
		return attempted
			? `tried to create ${group.count === 1 ? 'an agent' : 'agents'}`
			: `created ${group.count === 1 ? 'an agent' : 'agents'}`;
	}
	if (group.kind === 'user_question') {
		// Asking a question (showing the modal) IS the success — a cancelled or
		// unanswered ask is not a failed ask — so never say "tried to". Plural reads
		// correctly regardless of tool-call count (one call bundles the questions).
		return 'asked questions';
	}
	if (group.kind === 'calendar_check') return attempted ? 'tried to check the calendar' : 'checked the calendar';
	if (group.kind === 'calendar_update') return attempted ? 'tried to update the calendar' : 'updated the calendar';
	if (group.kind === 'edit') return attempted ? 'tried to update content' : 'updated content';
	if (group.kind === 'read') return attempted ? 'tried to review information' : 'reviewed information';
	if (group.kind === 'web_search' || group.kind === 'search') {
		return attempted ? 'tried to search for information' : 'searched for information';
	}
	return attempted
		? 'tried to use a connected service'
		: group.count === 1
			? 'used a connected service'
			: 'used connected services';
};

const completedPhraseForEntries = (entries, messageDone, serviceCatalog) => {
	const descriptors = entries
		.filter((entry) => entry.type === 'tool_calls')
		.map((entry, index) => describeToolEntry(entry, serviceCatalog, index));
	const reduced = reduceDescriptors(descriptors, messageDone);
	const successfulFetches = reduced.filter(
		(descriptor) => descriptor.kind === 'provider_fetch' && descriptor.outcome === 'success'
	);
	const phrases = groupCompletedDescriptors(reduced).map((group) =>
		phraseForCompletedGroup(group, successfulFetches)
	);
	return phrases.length > 0 ? sentenceCase(joinNatural(phrases)) : 'Thought through the request';
};

const activeToolLabel = (entries, activeEntry, serviceCatalog) => {
	const indexedEntries = entries.map((entry, index) => ({ entry, index }));
	const activeIndex = entries.lastIndexOf(activeEntry);
	const descriptor = describeToolEntry(activeEntry, serviceCatalog, activeIndex);
	if (descriptor.kind === 'core_labeled' && descriptor.coreLabels) return descriptor.coreLabels.active;
	const matchingActive = indexedEntries
		.filter(({ entry }) => entry.type === 'tool_calls' && !entry.done)
		.map(({ entry, index }) => describeToolEntry(entry, serviceCatalog, index))
		.filter((candidate) => candidate.kind === descriptor.kind);
	const serviceNames = joinNatural(
		matchingActive
			.map((candidate) => candidate.service)
			.filter(Boolean)
			.filter((service, index, services) => services.findIndex((item) => item.id === service.id) === index)
			.map((service) => service.proseName)
	);
	if (descriptor.kind === 'skill_load') return matchingActive.length > 1 ? 'Loading skills' : 'Loading a skill';
	if (descriptor.kind === 'skill_reference') {
		return matchingActive.length > 1 ? 'Loading extra skill references' : 'Loading an extra skill reference';
	}
	if (descriptor.kind === 'provider_fetch') return `Fetching data from ${serviceNames}`;
	if (descriptor.kind === 'provider_update') return `Updating data in ${serviceNames}`;
	if (descriptor.kind === 'provider_message') return `Sending information through ${serviceNames}`;
	if (descriptor.kind === 'provider_use') return `Working with ${serviceNames}`;
	if (descriptor.kind === 'subagent') return matchingActive.length > 1 ? 'Delegating to subagents' : 'Delegating to a subagent';
	if (descriptor.kind === 'agent_create') return matchingActive.length > 1 ? 'Creating agents' : 'Creating an agent';
	if (descriptor.kind === 'user_question') return 'Asking questions';
	if (descriptor.kind === 'calendar_check') return 'Checking the calendar';
	if (descriptor.kind === 'calendar_update') return 'Updating the calendar';
	if (descriptor.kind === 'command') {
		const priorSuccessfulFetch = indexedEntries.some(
			({ entry, index }) =>
				index < activeIndex &&
				entry.type === 'tool_calls' &&
				describeToolEntry(entry, serviceCatalog, index).kind === 'provider_fetch' &&
				getEntryOutcome(entry) === 'success'
		);
		return priorSuccessfulFetch ? 'Processing data' : 'Working on the request';
	}
	if (descriptor.kind === 'edit') return 'Updating content';
	if (descriptor.kind === 'read') return 'Reviewing information';
	if (descriptor.kind === 'web_search' || descriptor.kind === 'search') return 'Searching for information';
	return 'Using a connected service';
};

const activeLabelForEntry = (entry, entries, serviceCatalog) => {
	if (!entry) return 'Working';
	if (entry.type === 'reasoning') return 'Thinking through the request';
	if (entry.type === 'tool_preparation') return 'Getting things ready';
	if (entry.type === 'tool_analysis') return 'Reviewing what came back';
	return activeToolLabel(entries, entry, serviceCatalog);
};

const summarizeWorkActivityEntries = (entries, messageDone = false, serviceCatalog = []) => {
	if (entries.length === 0) {
		return {
			hasActivity: false,
			isActive: false,
			kind: 'none',
			label: '',
			toolCount: 0,
			reasoningCount: 0
		};
	}

	const normalizedServiceCatalog = normalizeCatalog(serviceCatalog);
	const activeEntry = messageDone ? null : [...entries].reverse().find((entry) => !entry.done) ?? null;
	const isActive = activeEntry !== null;
	const toolCount = entries.filter((entry) => entry.type === 'tool_calls').length;
	const reasoningCount = entries.filter((entry) => entry.type === 'reasoning').length;

	return {
		hasActivity: true,
		isActive,
		kind: isActive ? (activeEntry?.type === 'reasoning' ? 'reasoning' : 'tool') : 'completed',
		label: isActive
			? activeLabelForEntry(activeEntry, entries, normalizedServiceCatalog)
			: completedPhraseForEntries(entries, messageDone, normalizedServiceCatalog),
		toolCount,
		reasoningCount
	};
};

export const summarizeWorkActivity = (content = '', messageDone = false, serviceCatalog = []) =>
	summarizeWorkActivityEntries(extractWorkActivityEntries(content), messageDone, serviceCatalog);

export const summarizeSegmentedWorkActivity = (segments = [], messageDone = false, serviceCatalog = []) =>
	summarizeWorkActivityEntries(
		segments.flatMap((segment) =>
			segment?.type === 'activity' && Array.isArray(segment.activityEntries)
				? segment.activityEntries
				: []
		),
		messageDone,
		serviceCatalog
	);

export const isWorkActivityType = (value) =>
	ACTIVITY_TYPES.has(String(value ?? '').trim().toLowerCase());

const WORK_DETAILS_PATTERN = /<details\b([^>]*)>[\s\S]*?<\/details>/gi;

const appendNarrativeSegment = (segments, content) => {
	if (!content) return;
	const previous = segments.at(-1);
	if (previous?.type === 'content') {
		previous.content += content;
		return;
	}
	segments.push({ type: 'content', id: `content-${segments.length}`, content });
};

const createLazyActivitySegment = ({ source, sourceStart, sourceEnd, id, first, entry }) => {
	const segment = {
		type: 'activity',
		id,
		sourceStart,
		sourceEnd,
		activityEntries: [entry],
		summary: null,
		frozen: false,
		first
	};
	Object.defineProperty(segment, 'content', {
		enumerable: true,
		get() {
			return source.slice(this.sourceStart, this.sourceEnd);
		}
	});
	return segment;
};

/**
 * Splits a response into narrative and work phases without mutating the stored
 * message. Narrative text and every new reasoning block are intentional
 * boundaries: once either arrives, the preceding summary is frozen and later
 * work receives a new summary in its real reading order.
 */
export const segmentWorkActivity = (
	content = '',
	messageDone = false,
	userQuestionAnswerRecords = new Map(),
	serviceCatalog = []
) => {
	const source = String(content ?? '');
	const normalizedServiceCatalog = normalizeCatalog(serviceCatalog);
	const segments = [];
	let cursor = 0;
	let activityGroupIndex = 0;
	let match;

	WORK_DETAILS_PATTERN.lastIndex = 0;
	while ((match = WORK_DETAILS_PATTERN.exec(source)) !== null) {
		const before = source.slice(cursor, match.index);
		const attributes = parseAttributes(match[1]);
		const type = String(attributes.type ?? '').trim().toLowerCase();
		const block = match[0];

		if (!ACTIVITY_TYPES.has(type)) {
			const trailingActivity = segments.at(-1);
			if (trailingActivity?.type === 'activity') trailingActivity.frozen = true;
			appendNarrativeSegment(segments, `${before}${block}`);
			cursor = WORK_DETAILS_PATTERN.lastIndex;
			continue;
		}

		const previous = segments.at(-1);
		const activityEntry = buildWorkActivityEntry(attributes);
		const beginsNewReasoningPhase = type === 'reasoning' && previous?.type === 'activity';
		if (before.trim() || previous?.type !== 'activity' || beginsNewReasoningPhase) {
			if (previous?.type === 'activity') previous.frozen = true;
			if (before.trim()) appendNarrativeSegment(segments, before);
			const idSeed = attributes.id || attributes.started_at || activityGroupIndex;
			segments.push(
				createLazyActivitySegment({
					source,
					sourceStart: match.index,
					sourceEnd: WORK_DETAILS_PATTERN.lastIndex,
					id: `activity-${activityGroupIndex}-${String(idSeed).replace(/[^a-zA-Z0-9_-]/g, '')}`,
					first: segments.length === 0,
					entry: activityEntry
				})
			);
			activityGroupIndex += 1;
		} else {
			previous.sourceEnd = WORK_DETAILS_PATTERN.lastIndex;
			previous.activityEntries.push(activityEntry);
		}

		const toolCallId = String(attributes.id ?? '').trim();
		const questionAnswerRecord =
			userQuestionAnswerRecords instanceof Map
				? userQuestionAnswerRecords.get(toolCallId)
				: userQuestionAnswerRecords?.[toolCallId];
		if (type === 'tool_calls' && questionAnswerRecord) {
			const trailingActivity = segments.at(-1);
			if (trailingActivity?.type === 'activity') trailingActivity.frozen = true;
			segments.push({
				type: 'user_question_answer',
				id: `user-question-answer-${toolCallId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
				record: questionAnswerRecord
			});
		}

		if (isDisplayFilesToolCall(attributes)) {
			const trailingActivity = segments.at(-1);
			if (trailingActivity?.type === 'activity') trailingActivity.frozen = true;
			const displayIdSeed = toolCallId || attributes.started_at || match.index;
			segments.push({
				type: 'display_files',
				id: `display-files-${String(displayIdSeed).replace(/[^a-zA-Z0-9_-]/g, '')}`,
				attributes
			});
		}

		cursor = WORK_DETAILS_PATTERN.lastIndex;
	}

	const trailingContent = source.slice(cursor);
	if (trailingContent.trim()) {
		const trailingActivity = segments.at(-1);
		if (trailingActivity?.type === 'activity') trailingActivity.frozen = true;
	}
	appendNarrativeSegment(segments, trailingContent);

	for (const segment of segments) {
		if (segment.type === 'activity') {
			segment.summary = summarizeWorkActivityEntries(
				segment.activityEntries,
				messageDone || segment.frozen,
				normalizedServiceCatalog
			);
		}
	}

	return segments.length > 0
		? segments
		: [{ type: 'content', id: 'content-0', content: source }];
};
