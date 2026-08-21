const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIST_PAGE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/routes/(app)/scheduled-tasks/+page.svelte'
);
const DETAIL_PAGE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/routes/(app)/scheduled-tasks/[taskId]/+page.svelte'
);
const SCHEDULED_TASK_SKILL_PATH = path.join(REPO_ROOT, 'skills/scheduled-tasks/SKILL.md');
const SIDEBAR_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/layout/Sidebar.svelte'
);
const CAPABILITY_PICKER_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/scheduled-tasks/CapabilityPicker.svelte'
);
const MCP_PICKER_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/scheduled-tasks/McpServerPicker.svelte'
);

test('scheduled task list uses recent activity order with compact expandable rows and modal editing', async () => {
	const source = await fs.readFile(LIST_PAGE_PATH, 'utf8');

	assert.match(source, /let taskOrderIds: string\[\] = \[\];/);
	assert.match(source, /\$: sortedTasks = orderTasks\(tasks, taskOrderIds\);/);
	assert.match(source, /\$: visibleTasks = sortedTasks\.filter\(\(task\) => taskMatchesView\(task, taskSearch, taskFilter\)\);/);
	assert.match(source, /const recentActivityMs = \(task: ScheduledTask\) =>[\s\S]*dateMs\(task\.updated_at\)[\s\S]*dateMs\(task\.current_run\?\.started_at\)[\s\S]*dateMs\(task\.last_run_at\)/);
	assert.match(source, /\.flatMap\(\(run\) => \[dateMs\(run\.finished_at\), dateMs\(run\.started_at\)\]\)/);
	assert.match(source, /recentActivityMs\(right\) - recentActivityMs\(left\)/);
	assert.match(source, /type TaskFilter = 'all' \| 'active' \| 'paused' \| 'attention';/);
	assert.match(source, /class="scheduled-task-search"/);
	assert.match(source, /class="scheduled-task-filters"/);
	assert.match(source, /class="scheduled-task-compact-table"/);
	assert.match(source, /class="scheduled-task-compact-row"[\s\S]*aria-expanded=/);
	assert.match(source, /import ChevronDown from '\$lib\/components\/icons\/ChevronDown\.svelte';/);
	assert.match(source, /<span class="scheduled-task-row-caret" aria-hidden="true">\s*<ChevronDown className="size-3" strokeWidth="2\.5" \/>/);
	assert.doesNotMatch(source, /scheduled-task-row-caret" aria-hidden="true">⌄/);
	assert.match(source, /const toggleExpandedTask = \(event: MouseEvent \| KeyboardEvent, task: ScheduledTask\)/);
	assert.match(source, /if \(event instanceof KeyboardEvent && !\['Enter', ' '\]\.includes\(event\.key\)\) return;/);
	assert.match(source, /class="scheduled-task-expand-panel"/);
	assert.match(source, /<h3>Recent runs<\/h3>/);
	assert.match(source, /<h3>Details<\/h3>/);
	assert.match(source, /import ArrowTopRightOnSquare from '\$lib\/components\/icons\/ArrowTopRightOnSquare\.svelte';/);
	assert.match(source, /<ArrowTopRightOnSquare className="size-3\.5" \/>/);

	assert.match(source, /const startEdit = \(task: ScheduledTask\) => \{[\s\S]*editingTask = task;[\s\S]*showForm = true;/);
	assert.match(source, /class="scheduled-task-modal-scrim"/);
	assert.match(source, /role="dialog"/);
	assert.match(source, /aria-modal="true"/);
	assert.match(source, /editingTask \? 'Edit scheduled task' : 'New scheduled task'/);
	assert.match(source, /Save changes/);
	assert.match(source, /Cancel/);
	assert.doesNotMatch(source, /scheduled-task-edit-\$\{task\.id\}/);
});

test('scheduled task create and edit modal reuses the home model picker without changing the global default', async () => {
	const source = await fs.readFile(LIST_PAGE_PATH, 'utf8');

	assert.match(source, /import ModelSelector from '\$lib\/components\/chat\/ModelSelector\.svelte';/);
	assert.equal((source.match(/<ModelSelector/g) ?? []).length, 1);
	assert.equal((source.match(/formField=\{true\}/g) ?? []).length, 1);
	assert.doesNotMatch(source, /showSetDefault/);
	assert.match(source, /data-scheduled-task-model-picker=\{editingTask \? 'edit' : 'create'\}/);
	assert.doesNotMatch(source, /bind:value=\{modelId\}/);
	assert.doesNotMatch(source, /placeholder="Model or agent id"/);
	assert.doesNotMatch(source, /<option value="">Select a model or agent<\/option>/);
	assert.match(source, /let selectedModelIds = \[''\];/);
	assert.match(source, /bind:selectedModels=\{selectedModelIds\}/);
	assert.match(source, /model_id: formModelId/);
});

test('scheduled task edit requires replacing an unavailable saved model after delayed catalog loading', async () => {
	const source = await fs.readFile(LIST_PAGE_PATH, 'utf8');

	assert.match(source, /resolveEnabledSelectedModelIds\(\[candidate\], \$models \?\? \[\]\)/);
	assert.match(source, /setFormModelId\(task\.model_id, true\);/);
	assert.match(
		source,
		/!resolved && preserveUnavailable && \(\$models \?\? \[\]\)\.length === 0 \? normalizedCandidate : ''/
	);
	assert.match(source, /if \(pendingSavedModelId && \(\$models \?\? \[\]\)\.length > 0\)/);
	assert.match(source, /setFormModelId\(savedModelId, true\);/);
	assert.match(source, /activeUnavailableSavedModelId = formModelId \? '' : unavailableSavedModelId/);
	assert.match(source, /initializeDefaultModelWhenReady && \(\$models \?\? \[\]\)\.length > 0/);
	assert.match(source, /Saved target “\{activeUnavailableSavedModelId\}” is unavailable\./);
	assert.match(source, /Choose an available model or agent to replace the saved target\./);
	assert.match(source, /if \(!formModelId\)[\s\S]*return toast\.error[\s\S]*model_id: formModelId/);
});

test('scheduled task integrations reuse the agent-style MCP picker while skills activate from instructions', async () => {
	const [source, picker, mcpPicker] = await Promise.all([
		fs.readFile(LIST_PAGE_PATH, 'utf8'),
		fs.readFile(CAPABILITY_PICKER_PATH, 'utf8'),
		fs.readFile(MCP_PICKER_PATH, 'utf8')
	]);

	assert.match(source, /import McpServerPicker from '\$lib\/components\/scheduled-tasks\/McpServerPicker\.svelte';/);
	assert.doesNotMatch(source, /<SkillPicker/);
	assert.equal((source.match(/<McpServerPicker/g) ?? []).length, 1);
	assert.equal((source.match(/bind:selectedIds=\{selectedToolServerIds\}/g) ?? []).length, 1);
	assert.match(source, /label="Integrations"/);
	assert.match(source, /placeholder="Add integrations"/);
	assert.match(source, /searchPlaceholder="Search integrations"/);
	assert.match(source, /Skills activate automatically from your instructions/);
	assert.doesNotMatch(source, /openCapabilityPicker|skillSearch|toolServerSearch/);
	assert.doesNotMatch(source, /absolute z-20 mt-2 w-full overflow-hidden/);
	assert.match(source, /selectedSkillIds = mergeAgentCapabilities\(selectedSkillIds, capabilities\.skill_ids \?\? \[\]\);/);
	assert.match(source, /skill_ids: selectedSkillIds/);
	assert.match(source, /tool_server_ids: selectedToolServerIds/);
	assert.match(source, /const requestEpoch = formEpoch;/);
	assert.match(source, /!showForm \|\| requestEpoch !== formEpoch \|\| agentIdForModel\(formModelId\) !== agentId/);
	assert.match(source, /disabled=\{saving \|\| agentCapabilitiesLoading \|\| reloadingFromAgent \|\| !formModelId\}/);

	assert.match(picker, /import \{ onMount \} from 'svelte';/);
	assert.match(picker, /<Search className="size-4" strokeWidth="2\.5" \/>/);
	assert.match(picker, /bind:value=\{searchValue\}/);
	assert.match(picker, /\[option\.id, optionName\(option\), option\.description, option\.source\]/);
	assert.match(picker, /selectedIds\.includes\(optionId\)[\s\S]*selectedIds\.filter[\s\S]*uniqueIds\(\[\.\.\.selectedIds, optionId\]\)/);
	assert.match(picker, /role="listbox"[\s\S]*aria-multiselectable="true"/);
	assert.match(picker, /role="option"[\s\S]*aria-selected=\{isSelected\}/);
	assert.match(picker, /data-capability-selected=\{isSelected \? 'true' : 'false'\}/);
	assert.match(picker, /<button[\s\S]*data-capability-option=\{option\.id\}[\s\S]*on:click=\{\(\) => toggleOption\(option\.id\)\}/);
	assert.match(picker, /loading="eager"/);
	assert.match(picker, /data-capability-picker=\{iconKind\}/);
	assert.doesNotMatch(picker, /cap-chips|cap-chip-remove|removeOption/);
	assert.match(picker, /selectedPreviewOptions = selectedOptions\.slice\(0, 3\)/);
	assert.match(picker, /class="cap-summary-icons"/);
	assert.match(picker, /class="cap-summary-title">\{selectedSummary\}/);
	assert.match(picker, /class="cap-summary-description">\{selectedDescription\}/);
	assert.match(picker, /aria-haspopup="dialog"/);
	assert.match(picker, /aria-expanded=\{open\}/);
	assert.match(picker, /class="cap-popover cap-popover-\{popoverPlacement\}"[\s\S]*role="dialog"/);
	assert.match(picker, /style=\{`height: \$\{popoverHeight\}px; width: \$\{popoverWidth\}px; left: \$\{popoverLeft\}px; top: \$\{popoverTop\}px;`\}/);
	assert.match(picker, /rootElement\.closest\('\.scheduled-task-modal'\)\?\.getBoundingClientRect\(\)/);
	assert.match(picker, /const above = Math\.max\(0, rect\.top - gap - topLimit\)/);
	assert.match(picker, /const below = Math\.max\(0, bottomLimit - rect\.bottom - gap\)/);
	assert.match(picker, /const openUp = above >= 330 \|\| above > below/);
	assert.match(picker, /popoverHeight = Math\.min\(440, Math\.max\(240, available\)\)/);
	assert.match(picker, /popoverTop = openUp[\s\S]*Math\.max\(topLimit, rect\.top - gap - popoverHeight\)/);
	assert.match(picker, /focus\(\{ preventScroll: true \}\)/);
	assert.match(picker, /searchValue = '';[\s\S]*activeFilter = 'all';/);
	assert.equal((picker.match(/class="cap-done"/g) ?? []).length, 2);
	assert.match(picker, /document\.addEventListener\('pointerdown', closeOnOutsidePointer\)/);
	assert.match(picker, /window\.addEventListener\('resize', placePopover\)/);
	assert.match(picker, /document\.addEventListener\('scroll', placePopover, true\)/);
	const appCss = await fs.readFile(
		path.join(REPO_ROOT, 'src/patches/frontend/src/app.css'),
		'utf8'
	);
	assert.match(appCss, /\.cap-popover\s*\{[^}]*background/s);
	assert.match(appCss, /\.cap-popover\s*\{[^}]*position:\s*fixed;/s);
	assert.doesNotMatch(appCss, /\.cap-popover-up\s*\{[^}]*bottom:/s);
	assert.doesNotMatch(appCss, /\.cap-popover-down\s*\{[^}]*top:/s);
	assert.match(appCss, /\.cap-list\s*\{[^}]*overflow-y:\s*auto;/s);
	assert.match(appCss, /\.cap-summary-icons\s*\{/);
	assert.match(appCss, /\.cap-popover-footer\s*\{/);
	assert.match(appCss, /\.dark \.cap-popover\s*\{[^}]*background:\s*#222225;/s);

	assert.match(mcpPicker, /export let label = 'MCP servers';/);
	assert.match(mcpPicker, /export let placeholder = 'Add MCP servers';/);
	assert.match(mcpPicker, /export let searchPlaceholder = 'Search MCP servers';/);
	assert.match(mcpPicker, /\{label\}/);
	assert.match(mcpPicker, /\{placeholder\}/);
	assert.match(mcpPicker, /\{searchPlaceholder\}/);
	assert.match(mcpPicker, /pickerTitle="Choose integrations"/);
	assert.match(mcpPicker, /pickerDescription="Pre-approved for unattended task runs"/);
	assert.match(mcpPicker, /iconKind="mcp"/);
	assert.match(mcpPicker, /normalizeToolServerId/);
});

test('scheduled task creation and update generate and persist a model-derived name with legacy fallback', async () => {
	const [source, detailSource] = await Promise.all([
		fs.readFile(LIST_PAGE_PATH, 'utf8'),
		fs.readFile(DETAIL_PAGE_PATH, 'utf8')
	]);

	assert.match(source, /import \{ generateTitle \} from '\$lib\/apis';/);
	assert.match(source, /const generateTaskName = async \(\) => \{/);
	assert.match(source, /generateTitle\(localStorage\.token, formModelId, \[/);
	assert.match(source, /\{ role: 'user', content: prompt\.trim\(\) \}/);
	assert.match(source, /const name = await generateTaskName\(\);/);
	assert.match(source, /updateScheduledTask\(localStorage\.token, editingTask\.id, \{ name, \.\.\.sharedInput \}\)/);
	assert.match(source, /const input: ScheduledTaskInput = \{ name, \.\.\.sharedInput \}/);
	assert.match(source, /const created = await createScheduledTask\(localStorage\.token, input\);/);
	assert.match(source, /task\.name \?\? ''/);
	assert.match(source, /slice\(0, 5\)\.join\(' '\) \|\| 'Scheduled task'/);
	assert.match(source, /editingTask \? 'Changes apply to future runs\.' : 'Describe the task\.'/);
	assert.doesNotMatch(source, /A short name is generated automatically from your instructions\./);
	assert.doesNotMatch(source, /The list shows a model-generated name plus the start of these instructions\./);
	assert.match(source, /bind:this=\{instructionsElement\}/);
	assert.match(source, /on:keydown=\{trapFormFocus\}/);
	assert.match(source, /inert=\{showForm\}/);
	assert.doesNotMatch(source, /scheduled-task-state-dot/);
	assert.match(source, /const integrationIcon = \(id: string\) =>/);
	assert.match(source, /class:has-icon=\{Boolean\(integrationIcon\(id\)\)\}/);
	assert.match(source, /src=\{integrationIconSrc\(id\)\}[\s\S]*loading="eager"/);
	assert.match(source, /scheduledTaskIconRetry=/);
	assert.match(source, /\/api\/v1\/chats\/mcp\/servers\/\$\{encodeURIComponent\(serverId\)\}\/icon/);
	assert.match(detailSource, /const taskName = \(value: ScheduledTask\) => \{/);
	assert.match(detailSource, /<title>\{task \? `\$\{taskName\(task\)\} - Scheduled Task`/);
	assert.match(detailSource, /<h1[^>]*>\{taskName\(task\)\}<\/h1>/);
});

test('scheduled task runs preserve scroll and surface per-run history with stable chats', async () => {
	const source = await fs.readFile(LIST_PAGE_PATH, 'utf8');

	assert.match(source, /const loadTasks = async \(\{ preserveScroll = false, silent = false, preserveOrder = false \} = \{\}\) => \{/);
	assert.match(source, /const previousScrollTop = preserveScroll \? contentElement\?\.scrollTop : undefined;/);
	assert.match(source, /if \(contentElement\) contentElement\.scrollTop = previousScrollTop;/);
	assert.match(source, /taskOrderIds = preserveOrder[\s\S]*\? reconcileTaskOrderIds\(taskOrderIds, nextTasks\)[\s\S]*: sortTasks\(nextTasks\)\.map\(\(task\) => task\.id\);/);
	assert.match(source, /taskOrderIds = reconcileTaskOrderIds\(taskOrderIds, tasks\);/);
	assert.match(source, /let runningPollTimer: ReturnType<typeof setInterval> \| null = null;/);
	assert.match(source, /\$: runningCount = tasks\.filter\(\(task\) => Boolean\(task\.current_run\)\)\.length;/);
	assert.match(source, /\$: if \(runningCount > 0 && !runningPollTimer\)/);
	assert.match(source, /void loadTasks\(\{ preserveScroll: true, silent: true, preserveOrder: true \}\);/);
	assert.match(source, /onDestroy\(\(\) => \{/);

	assert.match(source, /const currentRun: ScheduledTaskCurrentRun = \{/);
	assert.match(source, /current_run: currentRun/);
	assert.match(source, /runs: \[\.\.\.\(item\.runs \?\? \[\]\)\.filter/);
	assert.match(source, /Recent runs/);
	assert.match(source, /View all runs/);
	assert.match(source, /const isTaskRunning = \(task: ScheduledTask\) => Boolean\(task\.current_run\) \|\| runningTaskId === task\.id;/);
	assert.match(source, /const openRunChat = \(chatId\?: string \| null\) => \{/);
	assert.match(source, /if \(chatId\) void goto\(`\/c\/\$\{encodeURIComponent\(chatId\)\}`\);/);
	assert.match(source, /type="button"[\s\S]*on:click=\{\(\) => openRunChat\(run\.chat_id\)\}/);
	assert.match(source, /title=\{runPreview\(run\)\}>\{runPreview\(run\)\}/);
	assert.doesNotMatch(source, /href=\{`\/c\/\$\{(?:task\.last_run_chat_id|run\.chat_id)\}`\}/);
});

test('scheduled task detail view gives a full run history and a direct way back', async () => {
	const source = await fs.readFile(DETAIL_PAGE_PATH, 'utf8');

	assert.match(source, /type RunFilter = 'all' \| 'attention' \| 'failed' \| 'success';/);
	assert.match(source, /const runFilters: RunFilter\[\] = \['all', 'attention', 'failed', 'success'\];/);
	assert.match(source, /const goBack = \(\) => \{/);
	assert.match(source, /history\.back\(\);/);
	assert.match(source, /void goto\('\/scheduled-tasks'\);/);
	assert.match(source, /const openRunChat = \(chatId\?: string \| null\) => \{/);
	assert.match(source, /void goto\(`\/c\/\$\{encodeURIComponent\(chatId\)\}`\);/);
	assert.match(source, /let runningPollTimer: ReturnType<typeof setInterval> \| null = null;/);
	assert.match(source, /\$: syncRunningPoll\(Boolean\(task\?\.current_run\)\);/);
	assert.match(source, /void loadTask\(\{ silent: true \}\);/);
	assert.match(source, /onDestroy\(\(\) => \{/);
	assert.match(source, /class="scheduled-task-detail-run-row"[\s\S]*disabled=\{!run\.chat_id\}[\s\S]*on:click=\{\(\) => openRunChat\(run\.chat_id\)\}/);
	assert.match(source, /title=\{runPreview\(run\)\}>\{runPreview\(run\)\}/);
	assert.doesNotMatch(source, /href=\{`\/c\/\$\{run\.chat_id\}`\}/);
	assert.match(source, /Run history/);
	assert.match(source, /Each run keeps its own chat and terminal status\./);
	assert.match(source, /import ArrowTopRightOnSquare from '\$lib\/components\/icons\/ArrowTopRightOnSquare\.svelte';/);
	assert.match(source, /<span class="scheduled-task-run-open" aria-label="Open chat">\s*<ArrowTopRightOnSquare className="size-4" \/>/);
	assert.doesNotMatch(source, />Open chat<\/button>/);
	assert.doesNotMatch(source, />No chat<\/span>/);
	assert.doesNotMatch(source, />\{run\.run_id\}<\/div>/);
	assert.match(source, /const scheduleSummary = \(schedule: TaskSchedule\) => \{/);
	assert.match(source, /if \(dayOfWeek === '\*'\) return `Every day at \$\{time\}`;/);
	assert.match(source, /return `Weekdays at \$\{time\}`;/);
	assert.match(source, />Integrations<\/div>/);
	assert.match(source, /scheduled-task-integration-summary scheduled-task-detail-integrations/);
	assert.match(source, /scheduledTaskDetailIconRetry=/);
	assert.match(source, /\/api\/v1\/chats\/mcp\/servers\/\$\{encodeURIComponent\(serverId\)\}\/icon/);
	assert.match(source, /class="scheduled-task-status-pill w-fit" data-tone=\{statusTone\(run\)\}/);
	assert.doesNotMatch(source, />MCP context<\/div>/);
	assert.doesNotMatch(source, />Runs kept<\/div>/);
	assert.doesNotMatch(source, /\{run\.trigger\}/);
});

test('scheduled task creation guidance builds concise first-person action prompts with inferred timezone and skills', async () => {
	const source = await fs.readFile(SCHEDULED_TASK_SKILL_PATH, 'utf8');

	assert.match(source, /Write an Action-Oriented Run Prompt/);
	assert.match(source, /job specification for a future unattended agent/);
	assert.match(source, /use "me", "my", and "I" rather than "the user"/);
	assert.match(source, /Remind me to take a break/);
	assert.match(source, /Do not ask the user to choose skills/);
	assert.match(source, /Leave `skill_ids` empty by default/);
	assert.doesNotMatch(source, /### Timezone defaults/);
	assert.match(source, /Use the current\/injected user timezone by default rather than asking for it/);
	assert.match(source, /Do not pre-write or fabricate a report/);
	assert.doesNotMatch(source, /### Reminder failure mode|### Common task patterns/);
	assert.ok(source.includes('0 10-18 * * MON-FRI'));
	assert.match(source, /Do not create separate duplicate tasks/);
});

test('sidebar announces newly finished scheduled task runs across chat tabs', async () => {
	const source = await fs.readFile(SIDEBAR_PATH, 'utf8');

	assert.match(source, /import \{\s*listScheduledTasks,[\s\S]*type ScheduledTaskRun[\s\S]*\} from '\$lib\/apis\/scheduledTasks';/);
	assert.match(source, /const SCHEDULED_TASK_NOTIFICATION_POLL_MS = 15000;/);
	assert.match(source, /const SCHEDULED_TASK_TERMINAL_STATUSES = new Set<LastRunStatus>/);
	assert.match(source, /'missing_integration'/);
	assert.match(source, /'auth_required'/);
	assert.match(source, /sessionStorage\.getItem\(SCHEDULED_TASK_NOTIFICATION_SEEN_STORAGE_KEY\)/);
	assert.match(source, /sessionStorage\.setItem\(/);
	assert.match(source, /listScheduledTasks\(localStorage\.token, true\)/);
	assert.match(source, /scheduledTaskNotificationSeen\.has\(key\)/);
	assert.match(source, /scheduledTaskRunFinishedAfterSessionStart\(run\)/);
	assert.match(source, /toast\.success\(body, \{ description: title, action \}\)/);
	assert.match(source, /toast\.warning\(body, \{ description: title, action \}\)/);
	assert.match(source, /label: run\.chat_id \? 'Open chat' : 'View task'/);
	assert.match(source, /startScheduledTaskRunNotifications\(\);/);
	assert.match(source, /stopScheduledTaskRunNotifications\(\);/);
});
