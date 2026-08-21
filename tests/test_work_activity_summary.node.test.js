const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const utilityPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/utils/work-activity-summary.mjs'
);
const responseMessagePath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte'
);
const summaryComponentPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage/WorkActivitySummary.svelte'
);
const answerCardPath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage/UserQuestionAnswerCard.svelte'
);
const collapsiblePath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/common/Collapsible.svelte'
);
const userMessagePath = path.join(
	repoRoot,
	'src/patches/frontend/src/lib/components/chat/Messages/UserMessage.svelte'
);

let summaryUtils;
const SERVICE_CATALOG = [
	{ id: 'agent-vm', display_name: 'Agent VM' },
	{ id: 'artifacts', display_name: 'Artifacts' },
	{ id: 'google_workspace', display_name: 'Google Workspace' },
	{ id: 'mcp-assistant', display_name: 'MCP Assistant' },
	{ id: 'mcp-atlassian', display_name: 'Atlassian' },
	{ id: 'scheduling', display_name: 'Scheduling' },
	{ id: 'skills', display_name: 'Skills' },
	{ id: 'slack', display_name: 'Slack' },
	{ id: 'subagents', display_name: 'Subagents' }
];

const encodeAttribute = (value) =>
	String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');

const toolDetails = ({
	name,
	id,
	done = true,
	result = done ? 'ok' : undefined,
	arguments: args,
	duration,
	stopReason
}) => {
	const attributes = [
		'type="tool_calls"',
		`done="${done}"`,
		id ? `id="${encodeAttribute(id)}"` : '',
		`name="${encodeAttribute(name)}"`,
		args ? `arguments="${encodeAttribute(JSON.stringify(args))}"` : '',
		result !== undefined ? `result="${encodeAttribute(typeof result === 'string' ? result : JSON.stringify(result))}"` : '',
		duration !== undefined ? `duration="${duration}"` : '',
		stopReason ? `stop_reason="${encodeAttribute(stopReason)}"` : ''
	]
		.filter(Boolean)
		.join(' ');
	return `<details ${attributes}><summary>Tool</summary></details>`;
};

test.before(async () => {
	summaryUtils = await import(pathToFileURL(utilityPath).href);
});

test('completed activity condenses reasoning and tools into a concise past-tense summary', () => {
	const content = [
		'<details type="reasoning" done="true"><summary>Thought</summary>Plan</details>',
		'<details type="tool_calls" done="true" name="apply_patch" result="ok"><summary>Tool</summary></details>',
		'<details type="tool_calls" done="true" name="read_file" result="ok"><summary>Tool</summary></details>',
		'<details type="tool_calls" done="true" name="Bash" result="ok"><summary>Tool</summary></details>'
	].join('\n');

	assert.deepEqual(summaryUtils.summarizeWorkActivity(content, true), {
		hasActivity: true,
		isActive: false,
		kind: 'completed',
		label: 'Updated content, reviewed information, and completed background work',
		toolCount: 3,
		reasoningCount: 1
	});
});

test('live reasoning and tool work use active labels until the parent message finishes', () => {
	const reasoning = summaryUtils.summarizeWorkActivity(
		'<details type="reasoning" done="false"><summary>Thought</summary>Plan</details>',
		false
	);
	assert.equal(reasoning.isActive, true);
	assert.equal(reasoning.kind, 'reasoning');
	assert.equal(reasoning.label, 'Thinking through the request');

	const toolContent =
		'<details type="tool_calls" done="false" name="google_workspace_get_events"><summary>Tool</summary></details>';
	const runningTool = summaryUtils.summarizeWorkActivity(toolContent, false);
	assert.equal(runningTool.isActive, true);
	assert.equal(runningTool.kind, 'tool');
	assert.equal(runningTool.label, 'Checking the calendar');

	const completedParent = summaryUtils.summarizeWorkActivity(toolContent, true);
	assert.equal(completedParent.isActive, false);
	assert.equal(completedParent.label, 'Checked the calendar');
});

test('service-aware summaries match the supplied activity examples', () => {
	const examples = [
		{
			label: 'Loaded skills',
			content: [
				toolDetails({ name: 'skills_activate_skill', id: 'skill-1', arguments: { skill_name: 'one' } }),
				toolDetails({ name: 'skills_activate_skill', id: 'skill-2', arguments: { skill_name: 'two' } })
			].join('\n')
		},
		{
			label: 'Fetched data from Google',
			content: toolDetails({ name: 'google_workspace_Extract_Document_Summary', id: 'google-1' })
		},
		{
			label: 'Fetched data from Google and Atlassian',
			content: [
				toolDetails({ name: 'google_workspace_Get_Drive_File_Download_URL', id: 'google-2' }),
				toolDetails({ name: 'mcp_atlassian_Search_JIRA_Issues_Using_JQL', id: 'jira-1' })
			].join('\n')
		},
		{
			label: 'Completed background work',
			content: toolDetails({ name: 'agent_vm_Bash', id: 'bash-1' })
		},
		{
			label: 'Loaded extra skill references',
			content: [
				toolDetails({ name: 'skills_get_skill_reference', id: 'ref-1', arguments: { skill_name: 'a', reference_path: 'one.md' } }),
				toolDetails({ name: 'skills_get_skill_reference', id: 'ref-2', arguments: { skill_name: 'a', reference_path: 'two.md' } }),
				toolDetails({ name: 'skills_get_skill_reference', id: 'ref-3', arguments: { skill_name: 'a', reference_path: 'three.md' } })
			].join('\n')
		},
		{
			label: 'Fetched data from Google and processed it',
			content: [
				toolDetails({ name: 'google_workspace_Get_Drive_File_Content', id: 'google-3' }),
				toolDetails({ name: 'agent_vm_Bash', id: 'bash-2' })
			].join('\n')
		},
		{
			label: 'Fetched data from Atlassian, processed it, and delegated to subagents',
			content: [
				toolDetails({ name: 'mcp_atlassian_Search', id: 'jira-2' }),
				toolDetails({ name: 'mcp_atlassian_Search', id: 'jira-3' }),
				toolDetails({ name: 'agent_vm_Python', id: 'python-1' }),
				toolDetails({ name: 'agent_vm_Bash', id: 'bash-3' }),
				toolDetails({ name: 'subagents_run_subagent', id: 'subagent-1' }),
				toolDetails({ name: 'subagents_run_subagent', id: 'subagent-2' })
			].join('\n')
		},
		{
			label: 'Thought through the request',
			content: '<details type="reasoning" done="true"><summary>Thought</summary>Plan</details>'
		}
	];

	for (const example of examples) {
		assert.equal(
			summaryUtils.summarizeWorkActivity(example.content, true, SERVICE_CATALOG).label,
			example.label
		);
	}
});

test('agent creation reads as its own activity instead of a generic service', () => {
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({
				name: 'subagents_create_agent',
				id: 'agent-create-1',
				arguments: { name: 'Everyday Helper' }
			}),
			true,
			SERVICE_CATALOG
		).label,
		'Created an agent'
	);
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'subagents_create_agent', id: 'agent-create-2', done: false }),
			false,
			SERVICE_CATALOG
		).label,
		'Creating an agent'
	);
});

test('service-aware summaries use configured names, action verbs, and clearer domain labels', () => {
	const catalog = [
		...SERVICE_CATALOG,
		{ id: 'custom-connector', display_name: '' }
	];
	const actionSummary = summaryUtils.summarizeWorkActivity(
		[
			toolDetails({ name: 'mcp_atlassian_Update_JIRA_Issue', id: 'update-1' }),
			toolDetails({ name: 'slack_send_message', id: 'message-1' }),
			toolDetails({ name: 'custom_connector_ping', id: 'custom-1' })
		].join('\n'),
		true,
		catalog
	);
	assert.equal(
		actionSummary.label,
		'Updated data in Atlassian, sent information through Slack, and worked with Custom Connector'
	);

	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'google_workspace_get_events', id: 'calendar-read' }),
			true,
			catalog
		).label,
		'Checked the calendar'
	);
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'google_workspace_create_event', id: 'calendar-write' }),
			true,
			catalog
		).label,
		'Updated the calendar'
	);
});

test('active service-aware labels describe the work currently running', () => {
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'google_workspace_get_file', id: 'active-google', done: false, result: undefined }),
			false,
			SERVICE_CATALOG
		).label,
		'Fetching data from Google'
	);
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			[
				toolDetails({ name: 'skills_activate_skill', id: 'active-skill-1', done: false, result: undefined }),
				toolDetails({ name: 'skills_activate_skill', id: 'active-skill-2', done: false, result: undefined })
			].join('\n'),
			false,
			SERVICE_CATALOG
		).label,
		'Loading skills'
	);
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			[
				toolDetails({ name: 'google_workspace_get_file', id: 'done-google' }),
				toolDetails({ name: 'agent_vm_Bash', id: 'active-bash', done: false, result: undefined })
			].join('\n'),
			false,
			SERVICE_CATALOG
		).label,
		'Processing data'
	);
});

test('catalog hydration relabels summaries without changing segment identity', () => {
	const content = toolDetails({ name: 'portico_incident_data_get_incidents', id: 'incident-1' });
	const beforeCatalog = summaryUtils.segmentWorkActivity(content, true);
	const afterCatalog = summaryUtils.segmentWorkActivity(content, true, new Map(), [
		{ id: 'portico', display_name: 'Portico' },
		{ id: 'portico-incident-data', display_name: 'Incident Data' }
	]);

	assert.deepEqual(
		beforeCatalog.map((segment) => segment.id),
		afterCatalog.map((segment) => segment.id)
	);
	assert.equal(beforeCatalog[0].summary.label, 'Used a connected service');
	assert.equal(afterCatalog[0].summary.label, 'Fetched data from Incident Data');
});

test('skill, reference, and subagent targets deduplicate and pluralize by logical work', () => {
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			[
				toolDetails({ name: 'skills_activate_skill', id: 'skill-repeat-1', arguments: { skill_name: 'same' } }),
				toolDetails({ name: 'skills_activate_skill', id: 'skill-repeat-2', arguments: { skill_name: 'same' } })
			].join('\n'),
			true,
			SERVICE_CATALOG
		).label,
		'Loaded a skill'
	);
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({
				name: 'skills_get_skill_reference',
				id: 'single-ref',
				arguments: { skill_name: 'skill', reference_path: 'reference.md' }
			}),
			true,
			SERVICE_CATALOG
		).label,
		'Loaded an extra skill reference'
	);
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'subagents_run_subagent', id: 'single-subagent' }),
			true,
			SERVICE_CATALOG
		).label,
		'Delegated to a subagent'
	);
});

test('ask_user_question reports asking questions, not a generic connected service', () => {
	// Active (tool still running, parent message not yet done).
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'skills_ask_user_question', id: 'q-active', done: false, result: undefined }),
			false,
			SERVICE_CATALOG
		).label,
		'Asking questions'
	);
	// Completed.
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'skills_ask_user_question', id: 'q-done' }),
			true,
			SERVICE_CATALOG
		).label,
		'Asked questions'
	);
	// Bare canonical name (no skills_ prefix) is classified the same way.
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'ask_user_question', id: 'q-bare' }),
			true,
			SERVICE_CATALOG
		).label,
		'Asked questions'
	);
	// Asking IS the success — even a failed/unanswered ask never reads "tried to".
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'skills_ask_user_question', id: 'q-fail', result: { success: false } }),
			true,
			SERVICE_CATALOG
		).label,
		'Asked questions'
	);
});

test('failed and cancelled tools use truthful attempted wording', () => {
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'google_workspace_get_file', id: 'failed-google', result: { success: false } }),
			true,
			SERVICE_CATALOG
		).label,
		'Tried to fetch data from Google'
	);

	const mixedProviderResult = summaryUtils.summarizeWorkActivity(
		[
			toolDetails({ name: 'google_workspace_get_file', id: 'google-success' }),
			toolDetails({ name: 'google_workspace_get_file', id: 'google-failure', result: { is_error: true, error: { message: 'boom' } } }),
			toolDetails({ name: 'mcp_atlassian_Search', id: 'jira-failure', result: { status: 'failed' } })
		].join('\n'),
		true,
		SERVICE_CATALOG
	);
	assert.equal(
		mixedProviderResult.label,
		'Fetched data from Google and tried to fetch data from Atlassian'
	);

	const neverStartedCancellation = summaryUtils.summarizeWorkActivity(
		[
			toolDetails({ name: 'google_workspace_get_file', id: 'google-success-2' }),
			toolDetails({
				name: 'mcp_atlassian_Search',
				id: 'jira-cancelled',
				result: 'Interrupted: user stopped the response.',
				duration: 0,
				stopReason: 'user_stop'
			})
		].join('\n'),
		true,
		SERVICE_CATALOG
	);
	assert.equal(neverStartedCancellation.label, 'Fetched data from Google');

	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({
				name: 'mcp_atlassian_Search',
				id: 'jira-cancelled-running',
				result: 'Interrupted: user stopped the response.',
				duration: 2,
				stopReason: 'user_stop'
			}),
			true,
			SERVICE_CATALOG
		).label,
		'Tried to fetch data from Atlassian'
	);
});

test('core first-party tools summarize with specific labels instead of generic phrasing', () => {
	const examples = [
		{ name: 'agent_vm_read_files', label: 'Read files in its workspace' },
		{ name: 'agent_vm_edit_file', label: 'Edited files in its workspace' },
		{
			name: 'agent_vm_request_sensitive_information',
			label: 'Requested sensitive information securely'
		},
		{ name: 'agent_vm_set_chat_workspace', label: 'Asked to use a folder as the chat workspace' },
		{ name: 'skills_create_skill', label: 'Edited a skill' },
		{ name: 'artifacts_create_artifact', label: 'Built an artifact' },
		{ name: 'scheduling_create_task', label: 'Scheduled a task' },
		{ name: 'mcp_assistant_toggle_integration', label: 'Set up an integration' }
	];

	for (const example of examples) {
		assert.equal(
			summaryUtils.summarizeWorkActivity(
				toolDetails({ name: example.name, id: `core-${example.name}` }),
				true,
				SERVICE_CATALOG
			).label,
			example.label
		);
	}
});

test('failed core first-party tools use truthful failed wording', () => {
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			toolDetails({ name: 'agent_vm_edit_file', id: 'core-fail-1', result: { success: false } }),
			true,
			SERVICE_CATALOG
		).label,
		'Failed to edit files in its workspace'
	);
});

test('running core first-party tools use present-tense specific labels', () => {
	const running = summaryUtils.summarizeWorkActivity(
		toolDetails({ name: 'agent_vm_grep', id: 'core-active-1', done: false, result: undefined }),
		false,
		SERVICE_CATALOG
	);
	assert.equal(running.isActive, true);
	assert.equal(running.kind, 'tool');
	assert.equal(running.label, 'Reading files in its workspace');
});

test('core tools sharing one label rule merge into a single summary phrase', () => {
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			[
				toolDetails({ name: 'agent_vm_grep', id: 'core-merge-1' }),
				toolDetails({ name: 'agent_vm_read_file', id: 'core-merge-2' })
			].join('\n'),
			true,
			SERVICE_CATALOG
		).label,
		'Read files in its workspace'
	);
});

test('narrative prose separates work into summaries at the correct reading position', () => {
	const content = [
		'<details type="tool_calls" done="true" name="glean_search" result="ok"><summary>Tool</summary></details>',
		'The first search was too broad, so I narrowed it down.',
		'<details type="tool_calls" done="false" name="glean_search"><summary>Tool</summary></details>'
	].join('\n');

	const segments = summaryUtils.segmentWorkActivity(content, false);
	assert.deepEqual(segments.map((segment) => segment.type), ['activity', 'content', 'activity']);
	assert.equal(segments[0].summary.label, 'Searched for information');
	assert.match(segments[1].content, /first search was too broad/);
	assert.equal(segments[2].summary.label, 'Searching for information');
	assert.equal(segments[0].first, true);
	assert.equal(segments[2].first, false);
	assert.equal(
		typeof Object.getOwnPropertyDescriptor(segments[0], 'content')?.get,
		'function',
		'collapsed activity content should remain lazy until the renderer reads it'
	);
	assert.deepEqual(
		summaryUtils.summarizeSegmentedWorkActivity(segments, false),
		summaryUtils.summarizeWorkActivity(content, false)
	);
});

test('an activity that follows narrative text is not treated as the first segment', () => {
	const content = [
		'Here is what I found so far.',
		'<details type="tool_calls" done="true" name="glean_search" result="ok"><summary>Tool</summary></details>'
	].join('\n');

	const segments = summaryUtils.segmentWorkActivity(content, true);
	assert.deepEqual(segments.map((segment) => segment.type), ['content', 'activity']);
	assert.equal(segments[1].first, false);

	const activityFirst = summaryUtils.segmentWorkActivity(
		'<details type="tool_calls" done="true" name="glean_search" result="ok"><summary>Tool</summary></details>',
		true
	);
	assert.equal(activityFirst[0].type, 'activity');
	assert.equal(activityFirst[0].first, true);
});

test('each new reasoning block freezes the preceding work summary and starts a new phase', () => {
	const content = [
		'<details type="reasoning" done="false" started_at="100"><summary>Thought</summary>First plan</details>',
		'<details type="tool_calls" done="false" id="read-1" name="read_file"><summary>Tool</summary></details>',
		'<details type="reasoning" done="false" started_at="200"><summary>Thought</summary>Revised plan</details>',
		'<details type="tool_calls" done="false" id="command-1" name="Bash"><summary>Tool</summary></details>'
	].join('\n');

	const segments = summaryUtils.segmentWorkActivity(content, false);
	assert.deepEqual(segments.map((segment) => segment.type), ['activity', 'activity']);
	assert.equal(segments[0].frozen, true);
	assert.equal(segments[0].summary.isActive, false);
	assert.equal(segments[0].summary.kind, 'completed');
	assert.equal(segments[0].summary.label, 'Reviewed information');
	assert.equal(segments[1].frozen, false);
	assert.equal(segments[1].summary.isActive, true);
	assert.equal(segments[1].summary.kind, 'tool');
	assert.equal(segments[1].summary.label, 'Working on the request');
	assert.match(segments[0].content, /First plan/);
	assert.doesNotMatch(segments[0].content, /Revised plan/);
	assert.match(segments[1].content, /Revised plan/);
});

test('reasoning phase ids remain stable when later tools stream into the latest phase', () => {
	const initialContent = [
		'<details type="reasoning" done="true" started_at="100"><summary>Thought</summary>First plan</details>',
		'<details type="tool_calls" done="true" id="read-1" name="read_file" result="ok"><summary>Tool</summary></details>',
		'<details type="reasoning" done="false" started_at="200"><summary>Thought</summary>Second plan</details>'
	].join('\n');
	const extendedContent = `${initialContent}\n<details type="tool_calls" done="false" id="command-1" name="Bash"><summary>Tool</summary></details>`;

	const initialSegments = summaryUtils.segmentWorkActivity(initialContent, false);
	const extendedSegments = summaryUtils.segmentWorkActivity(extendedContent, false);

	assert.deepEqual(
		initialSegments.map((segment) => segment.id),
		extendedSegments.map((segment) => segment.id)
	);
	assert.equal(extendedSegments[0].frozen, true);
	assert.equal(extendedSegments[1].frozen, false);
	assert.match(extendedSegments[1].content, /command-1/);
});

test('contiguous tool work remains grouped and trailing whitespace does not freeze it', () => {
	const content = [
		'<details type="tool_calls" done="false" id="read-1" name="read_file"><summary>Tool</summary></details>',
		'<details type="tool_calls" done="false" id="command-1" name="Bash"><summary>Tool</summary></details>'
	].join('\n');
	const toolSegments = summaryUtils.segmentWorkActivity(content, false);
	assert.deepEqual(toolSegments.map((segment) => segment.type), ['activity']);
	assert.equal(toolSegments[0].activityEntries.length, 2);
	assert.equal(toolSegments[0].frozen, false);
	assert.equal(toolSegments[0].summary.isActive, true);

	const whitespaceSegments = summaryUtils.segmentWorkActivity(
		'<details type="reasoning" done="false" started_at="300"><summary>Thought</summary>Active</details>\n',
		false
	);
	assert.deepEqual(whitespaceSegments.map((segment) => segment.type), ['activity', 'content']);
	assert.equal(whitespaceSegments[0].frozen, false);
	assert.equal(whitespaceSegments[0].summary.isActive, true);
});

test('non-activity details and ordinary prose do not create a work summary', () => {
	assert.equal(summaryUtils.summarizeWorkActivity('Plain response', true).hasActivity, false);
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			'<details type="citation" done="true"><summary>Sources</summary>x</details>',
			true
		).hasActivity,
		false
	);
});

test('submitted question tool data is projected from persisted contentBlocks', () => {
	const contentBlocks = [
		{
			type: 'tool_calls',
			content: [
				{
					id: 'question-call-1',
					function: {
						name: 'skills_ask_user_question',
						arguments: JSON.stringify({
							questions: [
								{
									id: 'scope',
									header: 'Week scope',
									question: 'Which meetings should I analyze?',
									options: [
										{ id: 'all', label: 'All meetings' },
										{ id: 'mine', label: 'Only my meetings' }
									]
								},
								{
									id: 'format',
									header: 'Format',
									question: 'How should I present it?',
									options: [
										{ id: 'brief', label: 'Brief summary' },
										{ id: 'detail', label: 'Detailed report' }
									]
								}
							]
						})
					}
				}
			],
			results: [
				{
					tool_call_id: 'question-call-1',
					content: JSON.stringify({
						success: true,
						status: 'submitted',
						flow_id: 'flow-1',
						answers: [
							{
								question_id: 'scope',
								selected_option_id: 'all',
								selected_option_label: 'All meetings',
								freeform_text: 'Exclude focus blocks.'
							},
							{
								question_id: 'format',
								selected_option_id: 'brief',
								selected_option_label: 'Brief summary',
								freeform_text: null
							}
						]
					})
				}
			]
		}
	];

	const records = summaryUtils.extractUserQuestionAnswerRecords(contentBlocks);
	assert.equal(records.size, 1);
	assert.deepEqual(records.get('question-call-1'), {
		toolCallId: 'question-call-1',
		flowId: 'flow-1',
		questions: [
			{
				questionId: 'scope',
				header: 'Week scope',
				question: 'Which meetings should I analyze?',
				selectedOptionId: 'all',
				selectedOptionLabel: 'All meetings',
				componentSelections: null,
				freeformText: 'Exclude focus blocks.'
			},
			{
				questionId: 'format',
				header: 'Format',
				question: 'How should I present it?',
				selectedOptionId: 'brief',
				selectedOptionLabel: 'Brief summary',
				componentSelections: null,
				freeformText: null
			}
		]
	});
});

test('component answers project prettified selection groups from persisted contentBlocks', () => {
	const contentBlocks = [
		{
			type: 'tool_calls',
			content: [
				{
					id: 'question-call-2',
					function: {
						name: 'skills_ask_user_question',
						arguments: JSON.stringify({
							questions: [
								{
									id: 'model',
									header: 'Model',
									question: 'Which model should power your agent?',
									options: [
										{ id: 'recommended', label: 'Recommended' },
										{ id: 'custom', label: 'Custom' }
									],
									components: [
										{ type: 'model_picker', id: 'model', multiple: false },
										{ type: 'reasoning_effort_picker', id: 'effort', multiple: false }
									]
								},
								{
									id: 'capabilities',
									header: 'Capabilities',
									question: 'What capabilities should your agent have?',
									components: [
										{ type: 'skill_picker', id: 'skills', label: 'Skills' },
										{ type: 'mcp_server_picker', id: 'servers', label: 'Tool servers' },
										{ type: 'skill_picker', id: 'extras', label: 'Extras' }
									]
								}
							]
						})
					}
				}
			],
			results: [
				{
					tool_call_id: 'question-call-2',
					content: JSON.stringify({
						success: true,
						status: 'submitted',
						flow_id: 'flow-2',
						answers: [
							{
								question_id: 'model',
								selected_option_id: 'recommended',
								selected_option_label: 'Recommended',
								component_selections: { model: ['GPT-5.6 Terra'], effort: ['high'] },
								freeform_text: null
							},
							{
								question_id: 'capabilities',
								component_selections: {
									skills: ['code-execution', 'company-knowledge'],
									servers: ['server:mcp-atlassian'],
									extras: []
								},
								freeform_text: 'Keep it lean.'
							}
						]
					})
				}
			]
		}
	];

	const records = summaryUtils.extractUserQuestionAnswerRecords(contentBlocks);
	assert.equal(records.size, 1);
	assert.deepEqual(records.get('question-call-2'), {
		toolCallId: 'question-call-2',
		flowId: 'flow-2',
		questions: [
			{
				questionId: 'model',
				header: 'Model',
				question: 'Which model should power your agent?',
				// Mixed question: the clicked option rides along with the pickers.
				selectedOptionId: 'recommended',
				selectedOptionLabel: 'Recommended',
				componentSelections: [
					// Model values are display names already; efforts sentence-case.
					{ label: 'Model', values: ['GPT-5.6 Terra'] },
					{ label: 'Reasoning effort', values: ['High'] }
				],
				freeformText: null
			},
			{
				questionId: 'capabilities',
				header: 'Capabilities',
				question: 'What capabilities should your agent have?',
				selectedOptionId: null,
				selectedOptionLabel: null,
				componentSelections: [
					{ label: 'Skills', values: ['Code Execution', 'Company Knowledge'] },
					{ label: 'Tool servers', values: ['Atlassian'] },
					{ label: 'Extras', values: [] }
				],
				freeformText: 'Keep it lean.'
			}
		]
	});
});

test('question answers split activity at the exact tool-call position and remain top-level', () => {
	const content = [
		'<details type="reasoning" done="true"><summary>Thought</summary>Plan</details>',
		'<details type="tool_calls" done="true" id="question-call" name="skills_ask_user_question" result="ok"><summary>Tool</summary></details>',
		'<details type="tool_calls" done="true" id="later-tool" name="read_file" result="ok"><summary>Tool</summary></details>'
	].join('\n');
	const record = {
		toolCallId: 'question-call',
		flowId: 'flow-1',
		questions: [{ questionId: 'q', header: 'H', question: 'Q', selectedOptionId: 'a', selectedOptionLabel: 'A', freeformText: null }]
	};
	const segments = summaryUtils.segmentWorkActivity(
		content,
		true,
		new Map([['question-call', record]])
	);

	assert.deepEqual(segments.map((segment) => segment.type), [
		'activity',
		'user_question_answer',
		'activity'
	]);
	assert.match(segments[0].content, /id="question-call"/);
	assert.doesNotMatch(segments[0].content, /id="later-tool"/);
	assert.equal(segments[1].record, record);
	assert.match(segments[2].content, /id="later-tool"/);
});

test('non-submitted and malformed question results remain ordinary activity', () => {
	const baseCall = {
		id: 'question-call-invalid',
		function: {
			name: 'ask_user_question',
			arguments: JSON.stringify({
				questions: [{ id: 'q', header: 'Header', question: 'Question?', options: [] }]
			})
		}
	};
	for (const resultPayload of [
		{ success: false, status: 'dismissed', answers: [] },
		{ success: true, status: 'submitted', answers: [] },
		{ success: true, status: 'submitted', answers: [{ question_id: 'other' }] },
		// Matching id but nothing renderable: no option, components, or freeform.
		{ success: true, status: 'submitted', answers: [{ question_id: 'q' }] }
	]) {
		const records = summaryUtils.extractUserQuestionAnswerRecords([
			{
				type: 'tool_calls',
				content: [baseCall],
				results: [{ tool_call_id: baseCall.id, content: JSON.stringify(resultPayload) }]
			}
		]);
		assert.equal(records.size, 0);
	}
});

test('Display Files outputs become stable top-level segments at their tool-call positions', () => {
	const resultPayload = JSON.stringify({
		display_files: true,
		files: [{ name: 'chart.png', browser_url: '/workspace/chat/chart.png', type: 'image' }]
	});
	const filesPayload = JSON.stringify([
		{ name: 'report.csv', download_url: '/workspace/chat/report.csv', content_type: 'text/csv' }
	]);
	const encodeAttribute = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
	const content = [
		'<details type="reasoning" done="true"><summary>Thought</summary>Plan</details>',
		`<details type="tool_calls" done="true" id="display-1" name="display_files" result="${encodeAttribute(resultPayload)}"><summary>Tool</summary></details>`,
		`<details type="tool_calls" done="true" id="display-2" name="agent_vm_display_files" files="${encodeAttribute(filesPayload)}"><summary>Tool</summary></details>`,
		'<details type="tool_calls" done="true" id="later-tool" name="read_file" result="ok"><summary>Tool</summary></details>',
		'Finished.'
	].join('\n');

	const streamingSegments = summaryUtils.segmentWorkActivity(content, false);
	const completedSegments = summaryUtils.segmentWorkActivity(content, true);

	assert.deepEqual(completedSegments.map((segment) => segment.type), [
		'activity',
		'display_files',
		'activity',
		'display_files',
		'activity',
		'content'
	]);
	assert.deepEqual(
		completedSegments.map((segment) => segment.id),
		streamingSegments.map((segment) => segment.id)
	);
	assert.match(completedSegments[0].content, /id="display-1"/);
	assert.doesNotMatch(completedSegments[0].content, /id="display-2"/);
	assert.equal(completedSegments[1].attributes.result, resultPayload);
	assert.match(completedSegments[2].content, /id="display-2"/);
	assert.equal(completedSegments[3].attributes.files, filesPayload);
	assert.match(completedSegments[4].content, /id="later-tool"/);
	assert.equal(completedSegments[5].content.trim(), 'Finished.');
});

test('ordinary tools do not create Display Files output segments', () => {
	const segments = summaryUtils.segmentWorkActivity(
		'<details type="tool_calls" done="true" id="link" name="agent_vm_get_workspace_file_link" result="ok"><summary>Tool</summary></details>',
		true
	);
	assert.deepEqual(segments.map((segment) => segment.type), ['activity']);
});

test('response rendering hides only work detail shells until the summary is expanded', () => {
	const responseSource = fs.readFileSync(responseMessagePath, 'utf8');
	const summarySource = fs.readFileSync(summaryComponentPath, 'utf8');
	const collapsibleSource = fs.readFileSync(collapsiblePath, 'utf8');
	const answerCardSource = fs.readFileSync(answerCardPath, 'utf8');

	assert.match(responseSource, /<WorkActivitySummary/);
	assert.match(responseSource, /workActivitySegments as segment/);
	assert.match(responseSource, /import \{ mcpServerCatalog \} from '\$lib\/stores\/mcpServerIds'/);
	assert.match(
		responseSource,
		/segmentWorkActivity\([\s\S]*userQuestionAnswerRecords,[\s\S]*\$mcpServerCatalog[\s\S]*\)/
	);
	assert.doesNotMatch(responseSource, /summarizeSegmentedWorkActivity/);
	assert.match(responseSource, /setWorkActivityGroupExpanded/);
	assert.match(responseSource, /mountedWorkActivityGroups/);
	assert.match(responseSource, /requestAnimationFrame/);
	assert.match(responseSource, /class:hidden=\{segment\.type === 'activity'/);
	assert.match(
		responseSource,
		/segment\.type !== 'activity' \|\| mountedWorkActivityGroups\[segment\.id\]/
	);
	assert.match(
		responseSource,
		/segment\.type === 'user_question_answer'[\s\S]*<UserQuestionAnswerCard[\s\S]*segment\.type === 'display_files'[\s\S]*<DisplayFilesInline[\s\S]*attributes=\{segment\.attributes\}[\s\S]*\{:else\}[\s\S]*class:hidden=\{segment\.type === 'activity'/
	);
	assert.match(responseSource, /renderDisplayFilesInline=\{segment\.type !== 'activity'\}/);
	assert.match(answerCardSource, /data-testid="user-question-answer-card"/);
	assert.doesNotMatch(responseSource, /!workActivitySummary\.hasActivity/);
	assert.match(collapsibleSource, /portico-work-activity-detail/);
	assert.match(collapsibleSource, /isWorkActivityType\(attributes\?\.type\)/);
	assert.match(summarySource, /aria-expanded=\{expanded\}/);
	assert.match(summarySource, /work-activity-summary--first/);
	assert.doesNotMatch(summarySource, /text-\[15px\]/);
	assert.match(summarySource, /font-size: inherit !important/);
	assert.match(summarySource, /font-weight: 400 !important/);
	assert.match(summarySource, /color: #475569 !important/);
	assert.match(summarySource, /:global\(\.dark\) \.work-activity-summary \{[\s\S]*color: #a9c9f5 !important/);
	assert.match(summarySource, /work-activity-summary__label--active/);
	assert.match(summarySource, /work-activity-spotlight 2\.4s linear infinite/);
	assert.match(
		summarySource,
		/<script context="module" lang="ts">[\s\S]*const shimmerStates = new Map<string, ShimmerState>\(\)/
	);
	assert.match(summarySource, /animationKey: controlsId/);
	assert.match(summarySource, /label: summary\.label/);
	assert.match(summarySource, /previous\?\.label === label/);
	assert.match(summarySource, /Date\.now\(\) - state\.startedAt/);
	assert.match(summarySource, /const labelChanged = next\.label !== current\.label/);
	assert.match(summarySource, /if \(restartForLabelChange\)/);
	assert.match(summarySource, /void node\.offsetWidth/);
	assert.match(
		summarySource,
		/animation-delay: var\(--work-activity-spotlight-delay, 0ms\)/
	);
	assert.match(summarySource, /background-position: 130% 50%/);
	assert.match(summarySource, /background-position: -130% 50%/);
	assert.match(summarySource, /prefers-reduced-motion: reduce/);
});

test('light-mode user messages use a distinct neutral bubble surface', () => {
	const userMessageSource = fs.readFileSync(userMessagePath, 'utf8');
	assert.match(userMessageSource, /user-message-bubble/);
	assert.match(userMessageSource, /border border-\[#ccd8e6\] bg-\[#e8eef5\]/);
	assert.match(userMessageSource, /shadow-\[0_1px_3px_rgba\(15,23,42,0\.08\)\]/);
	assert.match(userMessageSource, /dark:border-white\/5 dark:bg-gray-850 dark:shadow-none/);
});

test('light-mode thought and tool blocks use visible pastel surfaces without changing dark colors', () => {
	const collapsibleSource = fs.readFileSync(collapsiblePath, 'utf8');
	assert.match(collapsibleSource, /toolBlockBg = \$isDarkMode \? 'rgba\(79, 148, 255, 0\.16\)' : '#cfe3fb'/);
	assert.match(collapsibleSource, /toolChipText = \$isDarkMode \? '#d3e3ff' : '#174a82'/);
	assert.match(collapsibleSource, /toolIconBg = \$isDarkMode \? 'rgba\(79, 148, 255, 0\.2\)' : '#3f75b8'/);
	assert.match(collapsibleSource, /toolIconShadow = \$isDarkMode \? 'none' : 'inset 0 0 0 1px rgba\(15, 64, 118, 0\.28\)/);
	assert.match(collapsibleSource, /width: 26px; height: 26px; object-fit: contain; background: \{toolIconBg\}; padding: 2px; box-shadow: \{toolIconShadow\}/);
	assert.match(collapsibleSource, /toolMetaTextClass = \$isDarkMode \? 'text-slate-300' : 'text-slate-800'/);
	assert.match(collapsibleSource, /toolDurationTextClass = \$isDarkMode \? 'text-slate-400' : 'text-slate-600'/);
	assert.match(collapsibleSource, /thoughtBlockBg = \$isDarkMode \? '#3f454d' : '#e3ebf3'/);
	assert.match(collapsibleSource, /thoughtIconBg = \$isDarkMode \? '#59626d' : '#c9d7e6'/);
	assert.match(collapsibleSource, /box-shadow: \{toolBlockShadow\}/);
	assert.match(collapsibleSource, /box-shadow: \{thoughtBlockShadow\}/);
});

test('publish/unpublish and published-listing tools use action-specific tenses', () => {
	const phases = [
		{
			name: 'subagents_publish_agent',
			running: 'Publishing an agent',
			done: 'Published an agent',
			failed: 'Failed to publish an agent',
			stopped: 'Tried to publish an agent'
		},
		{
			name: 'subagents_unpublish_agent',
			running: 'Unpublishing an agent',
			done: 'Unpublished an agent',
			failed: 'Failed to unpublish an agent',
			stopped: 'Tried to unpublish an agent'
		},
		{
			name: 'skills_publish_skill',
			running: 'Publishing a skill',
			done: 'Published a skill',
			failed: 'Failed to publish a skill',
			stopped: 'Tried to publish a skill'
		},
		{
			name: 'skills_unpublish_skill',
			running: 'Unpublishing a skill',
			done: 'Unpublished a skill',
			failed: 'Failed to unpublish a skill',
			stopped: 'Tried to unpublish a skill'
		},
		{
			name: 'skills_list_published_skills',
			running: 'Listing published skills',
			done: 'Listed published skills',
			failed: 'Failed to list published skills',
			stopped: 'Tried to list published skills'
		}
	];

	for (const example of phases) {
		const running = summaryUtils.summarizeWorkActivity(
			toolDetails({
				name: example.name,
				id: `share-run-${example.name}`,
				done: false,
				result: undefined
			}),
			false,
			SERVICE_CATALOG
		);
		assert.equal(running.isActive, true, `${example.name} running is active`);
		assert.equal(running.label, example.running, `${example.name} running`);

		assert.equal(
			summaryUtils.summarizeWorkActivity(
				toolDetails({ name: example.name, id: `share-done-${example.name}` }),
				true,
				SERVICE_CATALOG
			).label,
			example.done,
			`${example.name} success`
		);

		// Failure-shaped results and errored stop reasons both read "failed to…".
		assert.equal(
			summaryUtils.summarizeWorkActivity(
				toolDetails({
					name: example.name,
					id: `share-failres-${example.name}`,
					result: { success: false }
				}),
				true,
				SERVICE_CATALOG
			).label,
			example.failed,
			`${example.name} failure result`
		);
		assert.equal(
			summaryUtils.summarizeWorkActivity(
				toolDetails({
					name: example.name,
					id: `share-failstop-${example.name}`,
					result: 'boom',
					duration: 3,
					stopReason: 'error'
				}),
				true,
				SERVICE_CATALOG
			).label,
			example.failed,
			`${example.name} errored stop_reason`
		);

		// A user stop mid-call stays an attempt, never a failure.
		assert.equal(
			summaryUtils.summarizeWorkActivity(
				toolDetails({
					name: example.name,
					id: `share-stop-${example.name}`,
					result: 'Interrupted: user stopped the response.',
					duration: 2,
					stopReason: 'user_stop'
				}),
				true,
				SERVICE_CATALOG
			).label,
			example.stopped,
			`${example.name} user stop`
		);
	}
});

test('cross-chat tools read as chat actions, not generic connected services', () => {
	const phases = [
		{
			name: 'subagents_start_chat',
			running: 'Starting a new agent chat',
			done: 'Started a new agent chat',
			failed: 'Failed to start a new agent chat'
		},
		{
			name: 'subagents_send_message_to_chat',
			running: 'Messaging another chat',
			done: 'Messaged another chat',
			failed: 'Failed to message another chat'
		},
		{
			name: 'subagents_list_chats',
			running: 'Listing recent chats',
			done: 'Listed recent chats',
			failed: 'Failed to list recent chats'
		}
	];

	for (const example of phases) {
		const running = summaryUtils.summarizeWorkActivity(
			toolDetails({ name: example.name, id: `xchat-run-${example.name}`, done: false, result: undefined }),
			false,
			SERVICE_CATALOG
		);
		assert.equal(running.isActive, true, `${example.name} running is active`);
		assert.equal(running.label, example.running, `${example.name} running`);

		assert.equal(
			summaryUtils.summarizeWorkActivity(
				toolDetails({ name: example.name, id: `xchat-done-${example.name}` }),
				true,
				SERVICE_CATALOG
			).label,
			example.done,
			`${example.name} success`
		);

		assert.equal(
			summaryUtils.summarizeWorkActivity(
				toolDetails({ name: example.name, id: `xchat-fail-${example.name}`, result: { success: false } }),
				true,
				SERVICE_CATALOG
			).label,
			example.failed,
			`${example.name} failure`
		);
	}
});

test('mixed marketplace outcomes join into one action-specific sentence', () => {
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			[
				toolDetails({ name: 'subagents_publish_agent', id: 'mix-1' }),
				toolDetails({
					name: 'subagents_unpublish_agent',
					id: 'mix-2',
					result: { success: false }
				})
			].join('\n'),
			true,
			SERVICE_CATALOG
		).label,
		'Published an agent and failed to unpublish an agent'
	);

	// The list-then-unpublish shape reads specifically instead of
	// "used a connected service and tried to update a skill's sharing".
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			[
				toolDetails({ name: 'skills_list_published_skills', id: 'mix-3' }),
				toolDetails({
					name: 'skills_unpublish_skill',
					id: 'mix-4',
					result: { success: false }
				})
			].join('\n'),
			true,
			SERVICE_CATALOG
		).label,
		'Listed published skills and failed to unpublish a skill'
	);
});

test('a retried marketplace call reports only the eventual success', () => {
	assert.equal(
		summaryUtils.summarizeWorkActivity(
			[
				toolDetails({
					name: 'skills_publish_skill',
					id: 'retry-1',
					result: { success: false }
				}),
				toolDetails({ name: 'skills_publish_skill', id: 'retry-2' })
			].join('\n'),
			true,
			SERVICE_CATALOG
		).label,
		'Published a skill'
	);
});

test('every core MCP tool renders a specific phrase in all tenses (no generic fallbacks)', () => {
	// Enumerates the shipped core tool specs as INPUT FIXTURES (data files,
	// not application-source pins): a new core tool without a phrase rule (or
	// an intentional describeToolEntry kind) fails here until it gets one.
	const specs = [
		['agent-vm', 'agent-vm-server'],
		['artifacts', 'artifacts-server'],
		['mcp-assistant', 'mcp-assistant-server'],
		['scheduling', 'scheduling-server'],
		['skills', 'skills-server'],
		['subagents', 'subagents-server'],
		['web-tools', 'web-tools-server']
	];
	const catalog = [...SERVICE_CATALOG, { id: 'web-tools', display_name: 'Web Tools' }];
	const genericLabels = new Set([
		'Used a connected service',
		'Used connected services',
		'Tried to use a connected service',
		'Using a connected service'
	]);

	let checkedCount = 0;
	for (const [serviceId, crate] of specs) {
		const spec = JSON.parse(
			fs.readFileSync(
				path.join(repoRoot, 'src/core-mcp-rust/crates', crate, 'tool_spec.json'),
				'utf8'
			)
		);
		const toolNames = spec.map((tool) => tool.name);
		assert.ok(toolNames.length > 0, `${crate} spec lists tools`);
		for (const tool of toolNames) {
			const prefixed = `${serviceId.replaceAll('-', '_')}_${tool}`;
			const scenarios = [
				summaryUtils.summarizeWorkActivity(
					toolDetails({
						name: prefixed,
						id: `sweep-run-${prefixed}`,
						done: false,
						result: undefined
					}),
					false,
					catalog
				),
				summaryUtils.summarizeWorkActivity(
					toolDetails({ name: prefixed, id: `sweep-done-${prefixed}` }),
					true,
					catalog
				),
				summaryUtils.summarizeWorkActivity(
					toolDetails({
						name: prefixed,
						id: `sweep-fail-${prefixed}`,
						result: { success: false }
					}),
					true,
					catalog
				)
			];
			for (const summary of scenarios) {
				assert.ok(
					!genericLabels.has(summary.label),
					`${prefixed} fell back to generic phrasing: "${summary.label}"`
				);
			}
			checkedCount += 1;
		}
	}
	assert.ok(checkedCount >= 100, `swept ${checkedCount} core tools`);
});
