<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';

	import { generateTitle } from '$lib/apis';
	import ModelSelector from '$lib/components/chat/ModelSelector.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import ArrowTopRightOnSquare from '$lib/components/icons/ArrowTopRightOnSquare.svelte';
	import McpServerPicker from '$lib/components/scheduled-tasks/McpServerPicker.svelte';
	import ScheduledTaskIcon from '$lib/components/scheduled-tasks/ScheduledTaskIcon.svelte';
	import { models, showSidebar } from '$lib/stores';
	import { resolveEnabledSelectedModelIds } from '$lib/utils/modelSelection';
	import { mergeAgentCapabilities } from '$lib/utils/scheduledTaskCapabilities';
	import {
		createScheduledTask,
		deleteScheduledTask,
		getAgentCapabilities,
		listScheduledTaskCapabilities,
		listScheduledTasks,
		runScheduledTaskNow,
		updateScheduledTask,
		type LastRunStatus,
		type ScheduledTask,
		type ScheduledTaskCurrentRun,
		type ScheduledTaskInput,
		type ScheduledTaskRun,
		type ScheduledTaskToolServerCapability,
		type TaskSchedule
	} from '$lib/apis/scheduledTasks';

	type SchedulePreset = 'once' | 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'custom';
	type TaskFilter = 'all' | 'active' | 'paused' | 'attention';

	const defaultTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const toDateTimeLocalValue = (date: Date) => {
		const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
		return localDate.toISOString().slice(0, 16);
	};
	const defaultRunAt = () => toDateTimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));

	let tasks: ScheduledTask[] = [];
	let taskOrderIds: string[] = [];
	let loading = true;
	let saving = false;
	let runningTaskId: string | null = null;
	let error = '';
	let contentElement: HTMLDivElement;
	let runningPollTimer: ReturnType<typeof setInterval> | null = null;

	let taskSearch = '';
	let taskFilter: TaskFilter = 'all';
	let expandedTaskIds: Record<string, boolean> = {};
	let showForm = false;
	let editingTask: ScheduledTask | null = null;

	let prompt = '';
	let selectedModelIds = [''];
	let unavailableSavedModelId = '';
	let pendingSavedModelId = '';
	let initializeDefaultModelWhenReady = false;
	let failedIntegrationSummaryIcons = new Set<string>();
	let integrationSummaryIconRetries: Record<string, number> = {};
	let enabled = true;
	let timezone = defaultTimezone();
	let schedulePreset: SchedulePreset = 'weekdays';
	let runAtLocal = defaultRunAt();
	let dailyTime = '09:00';
	let weeklyDay = '1';
	let cronExpression = '0 9 * * *';
	let selectedSkillIds: string[] = [];
	let selectedToolServerIds: string[] = [];
	let toolServerCapabilities: ScheduledTaskToolServerCapability[] = [];
	let capabilitiesLoading = false;
	let capabilityError = '';
	let prepopulatedForAgentId = '';
	let agentCapabilitiesLoading = false;
	let reloadingFromAgent = false;
	let formEpoch = 0;
	let formElement: HTMLFormElement;
	let instructionsElement: HTMLTextAreaElement;
	let formOpener: HTMLElement | null = null;

	const uniqueStrings = (values: string[]) =>
		Array.from(new Set((values ?? []).map((value) => `${value}`.trim()).filter(Boolean)));
	const normalizeToolServerId = (value: string) => {
		const normalized = `${value}`.trim();
		return normalized && !normalized.startsWith('server:') ? `server:${normalized}` : normalized;
	};
	const displayNameFromId = (value: string) =>
		value
			.replace(/^server:/, '')
			.split(/[-/_]+/)
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ') || value;

	const errorMessage = (value: unknown) => {
		if (typeof value === 'string') return value;
		if (value instanceof Error) return value.message;
		if (typeof value === 'object' && value !== null && 'detail' in value) {
			const detail = (value as { detail?: unknown }).detail;
			return typeof detail === 'string' ? detail : JSON.stringify(detail);
		}
		return 'Something went wrong.';
	};

	const dateMs = (value?: string | null) => {
		const parsed = value ? new Date(value).getTime() : 0;
		return Number.isFinite(parsed) ? parsed : 0;
	};
	const formatDate = (value?: string | null) => {
		if (!value) return 'Not scheduled';
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(value)
		);
	};
	const formatClock = (value?: string | null) => {
		if (!value) return '—';
		return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
			new Date(value)
		);
	};
	const formatRelative = (value?: string | null) => {
		if (!value) return '';
		const diffMs = new Date(value).getTime() - Date.now();
		const minutes = Math.round(Math.abs(diffMs) / 60000);
		if (minutes < 60) return diffMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 48) return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
		const days = Math.round(hours / 24);
		return diffMs >= 0 ? `in ${days}d` : `${days}d ago`;
	};

	const isFailureStatus = (status?: string | null) =>
		['failed', 'missed', 'interrupted', 'missing_integration', 'auth_required'].includes(
			status ?? ''
		);
	const statusLabel = (status?: string | null) => {
		if (!status) return 'Running';
		return status
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	};
	const statusTone = (status?: LastRunStatus | null, needsAttention = false) => {
		if (needsAttention || isFailureStatus(status)) return 'attention';
		if (status === 'success') return 'success';
		if (!status) return 'running';
		return 'muted';
	};

	const promptSnippet = (task: ScheduledTask) =>
		task.prompt
			.replace(/[*_`#>]/g, '')
			.split('\n')
			.map((line) => line.trim())
			.find(Boolean) ?? task.prompt.trim();
	const taskName = (task: ScheduledTask) => {
		const savedName = `${task.name ?? ''}`.replace(/\s+/g, ' ').trim();
		if (savedName) return savedName;
		return promptSnippet(task).split(/\s+/).filter(Boolean).slice(0, 5).join(' ') || 'Scheduled task';
	};
	const modelName = (task: ScheduledTask) =>
		($models ?? []).find((model) => model.id === task.model_id)?.name ?? task.model_id;
	const isTaskRunning = (task: ScheduledTask) => Boolean(task.current_run) || runningTaskId === task.id;
	const taskStatusLabel = (task: ScheduledTask) => {
		if (isTaskRunning(task)) return 'Running';
		if (task.needs_attention) return 'Attention';
		return task.last_run_status ? statusLabel(task.last_run_status) : '—';
	};
	const taskStatusTone = (task: ScheduledTask) => {
		if (isTaskRunning(task)) return 'running';
		if (!task.last_run_status && !task.needs_attention) return 'muted';
		return statusTone(task.last_run_status, task.needs_attention);
	};

	const formatScheduleTime = (hour: number, minute: number) =>
		new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
			new Date(2020, 0, 1, hour, minute)
		);
	const scheduleSummary = (schedule: TaskSchedule) => {
		if (schedule.kind === 'once') return `Once · ${formatDate(schedule.run_at)}`;
		const cron = schedule.cron_expression?.trim() ?? '';
		const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
		if (!/^\d+$/.test(minute ?? '') || !/^\d+$/.test(hour ?? '') || dayOfMonth !== '*' || month !== '*') {
			return cron || 'Custom schedule';
		}
		const time = formatScheduleTime(Number(hour), Number(minute));
		if (dayOfWeek === '*') return `Every day at ${time}`;
		if (['1-5', 'MON-FRI'].includes(dayOfWeek)) return `Weekdays at ${time}`;
		if (['0,6', '6,0', 'SUN,SAT', 'SAT,SUN'].includes(dayOfWeek)) return `Weekends at ${time}`;
		const weekdays: Record<string, string> = {
			'0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday',
			'5': 'Friday', '6': 'Saturday', SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday',
			WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday'
		};
		return weekdays[dayOfWeek] ? `Every ${weekdays[dayOfWeek]} at ${time}` : cron;
	};

	const recentActivityMs = (task: ScheduledTask) =>
		Math.max(
			dateMs(task.updated_at),
			dateMs(task.current_run?.started_at),
			dateMs(task.last_run_at),
			...(task.runs ?? []).flatMap((run) => [dateMs(run.finished_at), dateMs(run.started_at)])
		);
	const sortTasks = (items: ScheduledTask[]) =>
		[...items].sort(
			(left, right) =>
				recentActivityMs(right) - recentActivityMs(left) || dateMs(right.created_at) - dateMs(left.created_at)
		);
	const reconcileTaskOrderIds = (orderIds: string[], items: ScheduledTask[]) => {
		const currentIds = new Set(items.map((task) => task.id));
		const knownIds = orderIds.filter((id) => currentIds.has(id));
		const knownIdSet = new Set(knownIds);
		return [...knownIds, ...sortTasks(items.filter((task) => !knownIdSet.has(task.id))).map((task) => task.id)];
	};
	const orderTasks = (items: ScheduledTask[], orderIds: string[]) => {
		const order = orderIds.length ? reconcileTaskOrderIds(orderIds, items) : sortTasks(items).map((task) => task.id);
		const taskById = new Map(items.map((task) => [task.id, task]));
		return order.map((id) => taskById.get(id)).filter((task): task is ScheduledTask => Boolean(task));
	};
	const taskMatchesView = (task: ScheduledTask, query: string, filter: TaskFilter) => {
		if (filter === 'active' && !task.enabled) return false;
		if (filter === 'paused' && task.enabled) return false;
		if (filter === 'attention' && !task.needs_attention) return false;
		const normalizedQuery = query.trim().toLowerCase();
		return (
			!normalizedQuery ||
			[taskName(task), task.prompt, task.model_id].some((value) => value.toLowerCase().includes(normalizedQuery))
		);
	};
	const recentRuns = (task: ScheduledTask, limit = 3) => [...(task.runs ?? [])].reverse().slice(0, limit);
	const runPreview = (run: ScheduledTaskRun) =>
		run.response_preview || run.error || (run.status ? statusLabel(run.status) : 'Run is in progress.');

	$: sortedTasks = orderTasks(tasks, taskOrderIds);
	$: visibleTasks = sortedTasks.filter((task) => taskMatchesView(task, taskSearch, taskFilter));
	$: runningCount = tasks.filter((task) => Boolean(task.current_run)).length;
	$: if (runningCount > 0 && !runningPollTimer) {
		runningPollTimer = setInterval(
			() => void loadTasks({ preserveScroll: true, silent: true, preserveOrder: true }),
			2000
		);
	} else if (runningCount === 0 && runningPollTimer) {
		clearInterval(runningPollTimer);
		runningPollTimer = null;
	}

	const resolveAvailableModelId = (candidate: string) =>
		resolveEnabledSelectedModelIds([candidate], $models ?? [])[0] ?? '';
	const firstAvailableModelId = () =>
		resolveEnabledSelectedModelIds(($models ?? []).map((model) => model.id), $models ?? [])[0] ?? '';
	const setFormModelId = (candidate: string, preserveUnavailable = false) => {
		initializeDefaultModelWhenReady = false;
		const normalizedCandidate = `${candidate ?? ''}`.trim();
		const resolved = resolveAvailableModelId(normalizedCandidate);
		selectedModelIds = [resolved];
		unavailableSavedModelId = !resolved && preserveUnavailable ? normalizedCandidate : '';
		pendingSavedModelId =
			!resolved && preserveUnavailable && ($models ?? []).length === 0 ? normalizedCandidate : '';
	};
	$: formModelId = selectedModelIds[0]?.trim() ?? '';
	$: activeUnavailableSavedModelId = formModelId ? '' : unavailableSavedModelId;
	$: modelPickerPlaceholder = activeUnavailableSavedModelId
		? `${activeUnavailableSavedModelId} (unavailable - choose a replacement)`
		: 'Select a model or agent';
	$: if (pendingSavedModelId && ($models ?? []).length > 0) {
		const savedModelId = pendingSavedModelId;
		pendingSavedModelId = '';
		setFormModelId(savedModelId, true);
	}
	$: if (initializeDefaultModelWhenReady && ($models ?? []).length > 0) {
		const defaultModelId = firstAvailableModelId();
		if (defaultModelId) {
			initializeDefaultModelWhenReady = false;
			selectedModelIds = [defaultModelId];
		}
	}
	const agentIdForModel = (modelId: string) => {
		const model = ($models ?? []).find((candidate) => candidate.id === modelId);
		return model?.base_model_id || model?.info?.base_model_id ? modelId : '';
	};
	$: selectedAgentId = agentIdForModel(formModelId);
	$: if (showForm) void maybePrepopulateFromAgent(formModelId);

	async function maybePrepopulateFromAgent(modelId: string) {
		const agentId = agentIdForModel(modelId);
		if (!agentId) {
			if (modelId && ($models ?? []).some((model) => model.id === modelId)) {
				prepopulatedForAgentId = '';
				agentCapabilitiesLoading = false;
			}
			return;
		}
		if (agentId === prepopulatedForAgentId) return;
		prepopulatedForAgentId = agentId;
		const requestEpoch = formEpoch;
		agentCapabilitiesLoading = true;
		try {
			const capabilities = await getAgentCapabilities(localStorage.token, agentId);
			if (!showForm || requestEpoch !== formEpoch || agentIdForModel(formModelId) !== agentId) {
				return;
			}
			selectedSkillIds = mergeAgentCapabilities(selectedSkillIds, capabilities.skill_ids ?? []);
			selectedToolServerIds = mergeAgentCapabilities(
				selectedToolServerIds,
				(capabilities.tool_server_ids ?? []).map(normalizeToolServerId)
			);
		} catch (loadError) {
			if (requestEpoch === formEpoch) {
				console.warn('[ScheduledTasks] Failed to prepopulate from agent', loadError);
			}
		} finally {
			if (requestEpoch === formEpoch && agentIdForModel(formModelId) === agentId) {
				agentCapabilitiesLoading = false;
			}
		}
	}

	const reloadFromAgent = async () => {
		if (!selectedAgentId || reloadingFromAgent) return;
		const agentId = selectedAgentId;
		const requestEpoch = formEpoch;
		reloadingFromAgent = true;
		try {
			const capabilities = await getAgentCapabilities(localStorage.token, agentId);
			if (!showForm || requestEpoch !== formEpoch || selectedAgentId !== agentId) return;
			selectedSkillIds = mergeAgentCapabilities(selectedSkillIds, capabilities.skill_ids ?? []);
			selectedToolServerIds = mergeAgentCapabilities(
				selectedToolServerIds,
				(capabilities.tool_server_ids ?? []).map(normalizeToolServerId)
			);
			toast.success('Reloaded integrations from the agent.');
		} catch (loadError) {
			if (requestEpoch === formEpoch) toast.error(errorMessage(loadError));
		} finally {
			if (requestEpoch === formEpoch) reloadingFromAgent = false;
		}
	};

	const resetForm = () => {
		editingTask = null;
		prompt = '';
		const defaultModelId = firstAvailableModelId();
		selectedModelIds = [defaultModelId];
		unavailableSavedModelId = '';
		pendingSavedModelId = '';
		initializeDefaultModelWhenReady = !defaultModelId;
		enabled = true;
		timezone = defaultTimezone();
		schedulePreset = 'weekdays';
		runAtLocal = defaultRunAt();
		dailyTime = '09:00';
		weeklyDay = '1';
		cronExpression = '0 9 * * *';
		selectedSkillIds = [];
		selectedToolServerIds = [];
		prepopulatedForAgentId = '';
		agentCapabilitiesLoading = false;
		reloadingFromAgent = false;
	};
	const focusFormInstructions = async () => {
		await tick();
		instructionsElement?.focus();
	};
	const rememberFormOpener = () => {
		formOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	};
	const restoreFormOpener = async () => {
		const opener = formOpener;
		formOpener = null;
		await tick();
		opener?.focus();
	};
	const startCreate = () => {
		formEpoch += 1;
		rememberFormOpener();
		resetForm();
		showForm = true;
		void focusFormInstructions();
	};
	const setScheduleFormValues = (schedule: TaskSchedule) => {
		timezone = schedule.timezone || defaultTimezone();
		if (schedule.kind === 'once') {
			schedulePreset = 'once';
			runAtLocal = schedule.run_at ? toDateTimeLocalValue(new Date(schedule.run_at)) : defaultRunAt();
			return;
		}
		cronExpression = schedule.cron_expression || '0 9 * * *';
		const [minute, hour, dayOfMonth, month, dayOfWeek] = cronExpression.split(/\s+/);
		if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === '*' && month === '*') {
			dailyTime = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
			if (dayOfWeek === '*') schedulePreset = 'daily';
			else if (['1-5', 'MON-FRI'].includes(dayOfWeek)) schedulePreset = 'weekdays';
			else if (['0,6', '6,0', 'SUN,SAT', 'SAT,SUN'].includes(dayOfWeek)) schedulePreset = 'weekends';
			else if (/^[0-6]$/.test(dayOfWeek)) {
				schedulePreset = 'weekly';
				weeklyDay = dayOfWeek;
			} else schedulePreset = 'custom';
		} else schedulePreset = 'custom';
	};
	const startEdit = (task: ScheduledTask) => {
		formEpoch += 1;
		rememberFormOpener();
		editingTask = task;
		prompt = task.prompt;
		setFormModelId(task.model_id, true);
		enabled = task.enabled;
		setScheduleFormValues(task.schedule);
		selectedSkillIds = uniqueStrings(task.skill_ids ?? []);
		selectedToolServerIds = uniqueStrings((task.tool_server_ids ?? []).map(normalizeToolServerId));
		prepopulatedForAgentId = task.model_id;
		showForm = true;
		void focusFormInstructions();
	};
	const closeForm = () => {
		if (saving) return;
		formEpoch += 1;
		showForm = false;
		resetForm();
		void restoreFormOpener();
	};
	const trapFormFocus = (event: KeyboardEvent) => {
		if (event.key !== 'Tab' || !formElement) return;
		const focusable = Array.from(
			formElement.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
			)
		).filter((element) => !element.hidden && element.getClientRects().length > 0);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const buildCron = (time: string, day = '*') => {
		const [hour = '9', minute = '0'] = time.split(':');
		return `${Number(minute)} ${Number(hour)} * * ${day}`;
	};
	const buildSchedule = (): TaskSchedule => {
		if (schedulePreset === 'once') {
			return { kind: 'once', run_at: new Date(runAtLocal).toISOString(), timezone };
		}
		if (schedulePreset === 'daily') return { kind: 'cron', cron_expression: buildCron(dailyTime), timezone };
		if (schedulePreset === 'weekdays') return { kind: 'cron', cron_expression: buildCron(dailyTime, 'MON-FRI'), timezone };
		if (schedulePreset === 'weekends') return { kind: 'cron', cron_expression: buildCron(dailyTime, 'SAT,SUN'), timezone };
		if (schedulePreset === 'weekly') return { kind: 'cron', cron_expression: buildCron(dailyTime, weeklyDay), timezone };
		return { kind: 'cron', cron_expression: cronExpression.trim(), timezone };
	};
	const generateTaskName = async () => {
		const generated = await generateTitle(localStorage.token, formModelId, [
			{ role: 'user', content: prompt.trim() }
		]);
		const normalized = `${generated ?? ''}`.replace(/\s+/g, ' ').trim();
		if (!normalized) throw new Error('The model could not generate a task name. Please try again.');
		return normalized.slice(0, 80);
	};
	const submitTask = async () => {
		if (!prompt.trim()) return toast.error('Instructions are required.');
		if (agentCapabilitiesLoading || reloadingFromAgent) {
			return toast.error('Wait for the agent integrations to finish loading.');
		}
		if (!formModelId) {
			return toast.error(
				activeUnavailableSavedModelId
					? 'Choose an available model or agent to replace the saved target.'
					: 'Model or agent is required.'
			);
		}
		saving = true;
		try {
			const sharedInput = {
				prompt: prompt.trim(), model_id: formModelId, schedule: buildSchedule(),
				skill_ids: selectedSkillIds, tool_server_ids: selectedToolServerIds, enabled
			};
			const name = await generateTaskName();
			if (editingTask) {
				const updated = await updateScheduledTask(localStorage.token, editingTask.id, { name, ...sharedInput });
				tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
				toast.success('Scheduled task updated.');
			} else {
				const input: ScheduledTaskInput = { name, ...sharedInput };
				const created = await createScheduledTask(localStorage.token, input);
				taskOrderIds = [created.id, ...taskOrderIds.filter((id) => id !== created.id)];
				tasks = [created, ...tasks];
				toast.success('Scheduled task created.');
			}
			formEpoch += 1;
			showForm = false;
			resetForm();
			void restoreFormOpener();
		} catch (saveError) {
			toast.error(errorMessage(saveError));
		} finally {
			saving = false;
		}
	};

	const loadTasks = async ({ preserveScroll = false, silent = false, preserveOrder = false } = {}) => {
		const previousScrollTop = preserveScroll ? contentElement?.scrollTop : undefined;
		if (!silent) loading = true;
		error = '';
		try {
			const response = await listScheduledTasks(localStorage.token, true);
			const nextTasks = response.tasks ?? [];
			taskOrderIds = preserveOrder
				? reconcileTaskOrderIds(taskOrderIds, nextTasks)
				: sortTasks(nextTasks).map((task) => task.id);
			tasks = nextTasks;
		} catch (loadError) {
			error = errorMessage(loadError);
		} finally {
			if (!silent) loading = false;
			if (previousScrollTop !== undefined) {
				await tick();
				if (contentElement) contentElement.scrollTop = previousScrollTop;
			}
		}
	};
	const loadCapabilities = async () => {
		capabilitiesLoading = true;
		capabilityError = '';
		try {
			const response = await listScheduledTaskCapabilities(localStorage.token);
			toolServerCapabilities = response.tool_servers ?? [];
		} catch (loadError) {
			capabilityError = errorMessage(loadError);
			toolServerCapabilities = [];
		} finally {
			capabilitiesLoading = false;
		}
	};
	const toggleTask = async (task: ScheduledTask) => {
		try {
			const updated = await updateScheduledTask(localStorage.token, task.id, { enabled: !task.enabled });
			tasks = tasks.map((item) => (item.id === updated.id ? updated : item));
		} catch (updateError) {
			toast.error(errorMessage(updateError));
		}
	};
	const runNow = async (task: ScheduledTask) => {
		taskOrderIds = reconcileTaskOrderIds(taskOrderIds, tasks);
		runningTaskId = task.id;
		try {
			const response = await runScheduledTaskNow(localStorage.token, task.id);
			const currentRun: ScheduledTaskCurrentRun = {
				run_id: response.run_id, chat_id: response.chat_id,
				started_at: response.started_at, trigger: response.trigger
			};
			const nextRun: ScheduledTaskRun = { ...currentRun, status: null };
			tasks = tasks.map((item) => item.id === task.id
				? { ...item, current_run: currentRun, runs: [...(item.runs ?? []).filter((run) => run.run_id !== response.run_id), nextRun].slice(-50) }
				: item);
			toast.success(response.status === 'already_running' ? 'Scheduled task is already running.' : 'Scheduled task started.');
			void loadTasks({ preserveScroll: true, silent: true, preserveOrder: true });
		} catch (runError) {
			toast.error(errorMessage(runError));
		} finally {
			runningTaskId = null;
		}
	};
	const removeTask = async (task: ScheduledTask) => {
		if (!confirm(`Delete “${taskName(task)}”?`)) return;
		try {
			await deleteScheduledTask(localStorage.token, task.id);
			tasks = tasks.filter((item) => item.id !== task.id);
			taskOrderIds = taskOrderIds.filter((id) => id !== task.id);
			toast.success('Scheduled task deleted.');
		} catch (deleteError) {
			toast.error(errorMessage(deleteError));
		}
	};
	const openTaskDetail = (task: ScheduledTask) => {
		sessionStorage.setItem('scheduledTasksListState', JSON.stringify({ scrollTop: contentElement?.scrollTop ?? 0, taskId: task.id }));
		void goto(`/scheduled-tasks/${encodeURIComponent(task.id)}`);
	};
	const openRunChat = (chatId?: string | null) => {
		if (chatId) void goto(`/c/${encodeURIComponent(chatId)}`);
	};
	const toggleExpandedTask = (event: MouseEvent | KeyboardEvent, task: ScheduledTask) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest('button, a, input, textarea, select, [role="switch"]')) return;
		if (event instanceof MouseEvent && window.getSelection?.()?.toString()) return;
		if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return;
		if (event instanceof KeyboardEvent) event.preventDefault();
		expandedTaskIds = { ...expandedTaskIds, [task.id]: !expandedTaskIds[task.id] };
	};
	const integrationOption = (id: string) =>
		toolServerCapabilities.find(
			(option) => normalizeToolServerId(option.id) === normalizeToolServerId(id)
		);
	const integrationName = (id: string) => integrationOption(id)?.display_name ?? displayNameFromId(id);
	const integrationIcon = (id: string) => {
		const normalizedId = normalizeToolServerId(id);
		if (failedIntegrationSummaryIcons.has(normalizedId)) return '';
		const serverId = normalizedId.replace(/^server:/, '');
		return serverId ? `/api/v1/chats/mcp/servers/${encodeURIComponent(serverId)}/icon` : '';
	};
	const integrationIconSrc = (id: string) => {
		const iconUrl = integrationIcon(id);
		const retry = integrationSummaryIconRetries[normalizeToolServerId(id)] ?? 0;
		if (!iconUrl || retry === 0) return iconUrl;
		return `${iconUrl}${iconUrl.includes('?') ? '&' : '?'}scheduledTaskIconRetry=${retry}`;
	};
	const handleIntegrationSummaryIconError = (id: string) => {
		const normalizedId = normalizeToolServerId(id);
		const retry = integrationSummaryIconRetries[normalizedId] ?? 0;
		if (retry === 0) {
			integrationSummaryIconRetries = {
				...integrationSummaryIconRetries,
				[normalizedId]: Date.now()
			};
			return;
		}
		failedIntegrationSummaryIcons = new Set(failedIntegrationSummaryIcons).add(normalizedId);
	};

	onMount(() => {
		resetForm();
		void loadTasks();
		void loadCapabilities();
		const rawState = sessionStorage.getItem('scheduledTasksListState');
		if (rawState) {
			try {
				const state = JSON.parse(rawState);
				void tick().then(() => {
					if (contentElement && Number.isFinite(state?.scrollTop)) contentElement.scrollTop = state.scrollTop;
				});
			} catch {}
		}
	});
	onDestroy(() => {
		if (runningPollTimer) clearInterval(runningPollTimer);
	});
</script>

<svelte:head>
	<title>Scheduled Tasks</title>
</svelte:head>

<svelte:window
	on:keydown={(event) => {
		if (event.key === 'Escape' && showForm) closeForm();
	}}
/>

<div
	class="scheduled-tasks-shell relative flex h-screen max-h-[100dvh] w-full max-w-full flex-col transition-width duration-200 ease-in-out {$showSidebar
		? 'md:max-w-[calc(100%-var(--sidebar-width))]'
		: ''}"
	inert={showForm}
>
	<div bind:this={contentElement} class="scheduled-tasks-content flex-1 overflow-y-auto px-5 pb-12 pt-14 md:px-8">
		<main
			class="scheduled-tasks-page mx-auto flex w-full max-w-[920px] flex-col text-gray-900 transition-transform duration-200 ease-in-out dark:text-gray-100 {$showSidebar
				? ''
				: 'md:-translate-x-[1.625rem]'}"
			data-portico-rail-compensated={$showSidebar ? 'false' : 'true'}
		>
			<header class="scheduled-task-compact-header">
				<div>
					<h1>Scheduled tasks</h1>
					<p>Plan work once, or keep it moving on a recurring schedule.</p>
				</div>
				<button class="scheduled-task-button scheduled-task-button-primary" on:click={startCreate}>
					<span aria-hidden="true">+</span> New task
				</button>
			</header>

			{#if error}
				<div class="scheduled-task-error" role="alert">
					<strong>Scheduled tasks are unavailable.</strong> {error}
				</div>
			{/if}

			<div class="scheduled-task-toolbar">
				<label class="scheduled-task-search">
					<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<circle cx="8.5" cy="8.5" r="5.25"></circle><path d="m12.5 12.5 4 4"></path>
					</svg>
					<input bind:value={taskSearch} type="search" placeholder="Search tasks" aria-label="Search tasks" />
				</label>
				<div class="scheduled-task-filters" aria-label="Filter scheduled tasks">
					{#each [['all', 'All'], ['active', 'Active'], ['paused', 'Paused'], ['attention', 'Needs attention']] as option}
						<button
							type="button"
							class:active={taskFilter === option[0]}
							aria-pressed={taskFilter === option[0]}
							on:click={() => (taskFilter = option[0] as TaskFilter)}>{option[1]}</button
						>
					{/each}
				</div>
			</div>

			<div class="scheduled-task-column-head" aria-hidden="true">
				<span>Task</span><span>Schedule</span><span>Next run</span><span>Last run</span>
			</div>

			<section class="scheduled-task-compact-table" aria-label="Scheduled tasks">
				{#if loading}
					<div class="scheduled-task-table-loading"><Spinner /></div>
				{:else if visibleTasks.length === 0}
					<div class="scheduled-task-compact-empty">
						<div class="scheduled-task-empty-icon"><ScheduledTaskIcon kind="empty" size={24} /></div>
						{#if tasks.length === 0}
							<strong>No scheduled tasks yet</strong>
							<span>Set up a prompt once and let it run on your schedule.</span>
							<button class="scheduled-task-button scheduled-task-button-primary" on:click={startCreate}>New task</button>
						{:else}
							<strong>No matching tasks</strong>
							<span>Try a different search or filter.</span>
						{/if}
					</div>
				{:else}
					{#each visibleTasks as task (task.id)}
						<div
							class="scheduled-task-compact-row"
							class:expanded={expandedTaskIds[task.id]}
							class:paused={!task.enabled}
							role="button"
							tabindex="0"
							aria-expanded={expandedTaskIds[task.id] ? 'true' : 'false'}
							on:click={(event) => toggleExpandedTask(event, task)}
							on:keydown={(event) => toggleExpandedTask(event, task)}
						>
							<div class="scheduled-task-row-name">
								<strong>{taskName(task)}</strong>
								<span title={task.prompt}>{promptSnippet(task)}</span>
							</div>
							<div class="scheduled-task-row-schedule">
								<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
									<circle cx="8" cy="8" r="6"></circle><path d="M8 4.8V8l2.2 1.4"></path>
								</svg>
								<span>{scheduleSummary(task.schedule)}</span>
							</div>
							<div class="scheduled-task-row-next">
								<span>{task.enabled ? (isTaskRunning(task) ? 'Now' : formatClock(task.next_run_at)) : 'Paused'}</span>
								{#if task.enabled && task.next_run_at && !isTaskRunning(task)}<small>{formatRelative(task.next_run_at)}</small>{/if}
							</div>
							<div class="scheduled-task-row-status">
								<span class="scheduled-task-status-pill" data-tone={taskStatusTone(task)}>
									{#if taskStatusLabel(task) !== '—'}<i></i>{/if}{taskStatusLabel(task)}
								</span>
							</div>
							<span class="scheduled-task-row-caret" aria-hidden="true">
								<ChevronDown className="size-3" strokeWidth="2.5" />
							</span>
						</div>

						{#if expandedTaskIds[task.id]}
							<div class="scheduled-task-expand-panel">
								<div class="scheduled-task-expand-grid">
									<div class="scheduled-task-expand-column">
										<h3>Recent runs</h3>
										{#if recentRuns(task).length === 0}
											<p class="scheduled-task-no-runs">This task has not run yet.</p>
										{:else}
											<div class="scheduled-task-run-list">
												{#each recentRuns(task) as run (run.run_id)}
													<button type="button" disabled={!run.chat_id} on:click={() => openRunChat(run.chat_id)}>
														<span class="scheduled-task-run-time">{formatClock(run.started_at)}<small>{formatRelative(run.started_at)}</small></span>
														<span class="scheduled-task-status-pill" data-tone={statusTone(run.status, run.needs_attention)}>{statusLabel(run.status)}</span>
														<span class="scheduled-task-run-preview" title={runPreview(run)}>{runPreview(run)}</span>
														{#if run.chat_id}<span class="scheduled-task-run-open" aria-label="Open chat"><ArrowTopRightOnSquare className="size-3.5" /></span>{/if}
													</button>
												{/each}
											</div>
										{/if}
									</div>
									<div class="scheduled-task-expand-column scheduled-task-details-column">
										<h3>Details</h3>
										<div><span>Schedule</span><strong>{scheduleSummary(task.schedule)}</strong></div>
										<div><span>Model</span><strong>{modelName(task)}</strong></div>
										<div>
											<span>Integrations</span>
											<strong class="scheduled-task-integration-summary">
												{#if (task.tool_server_ids ?? []).length === 0}
													None
												{:else}
											{#each task.tool_server_ids as id}
												<span title={integrationName(id)} class:has-icon={Boolean(integrationIcon(id))}>
													{#if integrationIcon(id)}
														<img
														src={integrationIconSrc(id)}
															alt=""
															loading="eager"
															decoding="async"
															on:error={() => handleIntegrationSummaryIconError(id)}
														/>
													{:else}
														{integrationName(id).charAt(0)}
													{/if}
												</span>
											{/each}
												{/if}
											</strong>
										</div>
										<div>
											<span>Enabled</span>
											<button class="scheduled-task-switch" class:on={task.enabled} type="button" role="switch" aria-checked={task.enabled} aria-label={`${task.enabled ? 'Pause' : 'Enable'} ${taskName(task)}`} on:click={() => toggleTask(task)}><i></i></button>
										</div>
									</div>
									<div class="scheduled-task-expand-actions">
										<button class="scheduled-task-button scheduled-task-button-primary" type="button" disabled={isTaskRunning(task)} on:click={() => runNow(task)}>{isTaskRunning(task) ? 'Running…' : 'Run now'}</button>
										<button class="scheduled-task-button scheduled-task-button-secondary" type="button" on:click={() => startEdit(task)}>Edit</button>
										<button class="scheduled-task-button scheduled-task-button-secondary" type="button" on:click={() => openTaskDetail(task)}>View all runs</button>
										<span></span>
										<button class="scheduled-task-button scheduled-task-button-danger" type="button" on:click={() => removeTask(task)}>Delete</button>
									</div>
								</div>
							</div>
						{/if}
					{/each}
				{/if}
			</section>
		</main>
	</div>
</div>

{#if showForm}
	<div class="scheduled-task-modal-scrim" role="presentation" on:click|self={closeForm}>
		<form
			bind:this={formElement}
			class="scheduled-task-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="scheduled-task-modal-title"
			on:keydown={trapFormFocus}
			on:submit|preventDefault={submitTask}
		>
			<div class="scheduled-task-modal-heading">
				<div>
					<h2 id="scheduled-task-modal-title">{editingTask ? 'Edit scheduled task' : 'New scheduled task'}</h2>
					<p>{editingTask ? 'Changes apply to future runs.' : 'Describe the task.'}</p>
				</div>
				<button type="button" aria-label="Close" on:click={closeForm}>×</button>
			</div>

			<label class="scheduled-task-field">
				<span>Instructions <i>*</i></span>
				<textarea bind:this={instructionsElement} bind:value={prompt} required placeholder="What should the agent do on each run? e.g. “Check my Jira tickets updated in the last 24 hours and summarize what changed.”"></textarea>
			</label>

			<div class="scheduled-task-field-row">
				<label class="scheduled-task-field">
					<span>Frequency</span>
					<select bind:value={schedulePreset}>
						<option value="daily">Every day</option>
						<option value="weekdays">Weekdays</option>
						<option value="weekends">Weekends</option>
						<option value="weekly">Weekly</option>
						<option value="once">Once</option>
						<option value="custom">Custom (cron)</option>
					</select>
				</label>
				{#if schedulePreset === 'once'}
					<label class="scheduled-task-field"><span>Run at <em>({timezone})</em></span><input type="datetime-local" bind:value={runAtLocal} required /></label>
				{:else if schedulePreset !== 'custom'}
					<label class="scheduled-task-field"><span>Time <em>({timezone})</em></span><input type="time" bind:value={dailyTime} required /></label>
				{/if}
			</div>
			{#if schedulePreset === 'weekly'}
				<label class="scheduled-task-field">
					<span>Day of week</span>
					<select bind:value={weeklyDay}>
						<option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option>
						<option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option>
					</select>
				</label>
			{/if}
			{#if schedulePreset === 'custom'}
				<label class="scheduled-task-field">
					<span>Cron expression</span><input class="font-mono" bind:value={cronExpression} required placeholder="0 9 * * MON-FRI" />
					<small>Standard 5-field cron in {timezone}. Most people should pick a frequency above.</small>
				</label>
			{/if}

			<div class="scheduled-task-field">
				<span>Model or agent</span>
				{#if ($models ?? []).length > 0}
					<div class="scheduled-task-model-field" class:unavailable={Boolean(activeUnavailableSavedModelId)} data-scheduled-task-model-picker={editingTask ? 'edit' : 'create'}>
						<ModelSelector bind:selectedModels={selectedModelIds} formField={true} placeholder={modelPickerPlaceholder} />
					</div>
				{:else}
					<div class="scheduled-task-model-unavailable">No models or agents are available yet.</div>
				{/if}
				{#if activeUnavailableSavedModelId}<small class="scheduled-task-warning">Saved target “{activeUnavailableSavedModelId}” is unavailable. Choose a replacement.</small>{/if}
			</div>

			<div class="scheduled-task-integrations-heading">
				<span>Only integrations added here are pre-approved for unattended runs.</span>
				{#if selectedAgentId}<button type="button" disabled={agentCapabilitiesLoading || reloadingFromAgent} on:click={reloadFromAgent}>{agentCapabilitiesLoading ? 'Loading…' : reloadingFromAgent ? 'Reloading…' : 'Reload from agent'}</button>{/if}
			</div>
			<McpServerPicker
				label="Integrations"
				placeholder="Add integrations"
				searchPlaceholder="Search integrations"
				bind:selectedIds={selectedToolServerIds}
				options={toolServerCapabilities}
				loading={capabilitiesLoading}
			/>
			<p class="scheduled-task-field-hint">Skills activate automatically from your instructions — no need to pick them.</p>
			{#if capabilityError}<p class="scheduled-task-warning">Could not load the integration catalog. Existing selections are preserved.</p>{/if}

			{#if editingTask}
				<label class="scheduled-task-enabled-field">
					<input type="checkbox" bind:checked={enabled} /> <span>Enabled</span>
				</label>
			{/if}

			<div class="scheduled-task-modal-actions">
				<button type="button" class="scheduled-task-button scheduled-task-button-secondary" disabled={saving} on:click={closeForm}>Cancel</button>
				<button type="submit" class="scheduled-task-button scheduled-task-button-primary" disabled={saving || agentCapabilitiesLoading || reloadingFromAgent || !formModelId}>
					{saving ? (editingTask ? 'Saving…' : 'Generating name…') : editingTask ? 'Save changes' : 'Create task'}
				</button>
			</div>
		</form>
	</div>
{/if}
