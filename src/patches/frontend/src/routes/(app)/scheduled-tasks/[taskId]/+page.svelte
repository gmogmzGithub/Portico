<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { showSidebar } from '$lib/stores';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import ArrowTopRightOnSquare from '$lib/components/icons/ArrowTopRightOnSquare.svelte';
	import ScheduledTaskIcon from '$lib/components/scheduled-tasks/ScheduledTaskIcon.svelte';
	import {
		getScheduledTask,
		listScheduledTaskCapabilities,
		runScheduledTaskNow,
		updateScheduledTask,
		type ScheduledTask,
		type ScheduledTaskRun,
		type ScheduledTaskToolServerCapability,
		type TaskSchedule
	} from '$lib/apis/scheduledTasks';
	import { toast } from 'svelte-sonner';

	type RunFilter = 'all' | 'attention' | 'failed' | 'success';
	const runFilters: RunFilter[] = ['all', 'attention', 'failed', 'success'];

	let task: ScheduledTask | null = null;
	let loading = true;
	let error = '';
	let running = false;
	let filter: RunFilter = 'all';
	let runningPollTimer: ReturnType<typeof setInterval> | null = null;
	let toolServerCapabilities: ScheduledTaskToolServerCapability[] = [];
	let failedIntegrationIcons = new Set<string>();
	let integrationIconRetries: Record<string, number> = {};

	$: taskId = $page.params.taskId;
	$: runs = [...(task?.runs ?? [])].reverse();
	$: filteredRuns = runs.filter((run) => {
		if (filter === 'attention') {
			return Boolean(run.needs_attention);
		}
		if (filter === 'failed') {
			return isFailureStatus(run.status);
		}
		if (filter === 'success') {
			return run.status === 'success';
		}
		return true;
	});
	$: syncRunningPoll(Boolean(task?.current_run));

	const errorMessage = (value: unknown) => {
		if (typeof value === 'string') {
			return value;
		}
		if (value instanceof Error) {
			return value.message;
		}
		if (typeof value === 'object' && value !== null && 'detail' in value) {
			const detail = (value as { detail?: unknown }).detail;
			return typeof detail === 'string' ? detail : JSON.stringify(detail);
		}
		return 'Something went wrong.';
	};

	const formatDate = (value?: string | null) => {
		if (!value) {
			return 'Not scheduled';
		}
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(value));
	};

	const formatScheduleTime = (hour: number, minute: number) =>
		new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
			new Date(2020, 0, 1, hour, minute)
		);

	const scheduleSummary = (schedule: TaskSchedule) => {
		if (schedule.kind === 'once') return `Once · ${formatDate(schedule.run_at)}`;
		const cron = schedule.cron_expression?.trim() ?? '';
		const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
		if (
			!/^\d+$/.test(minute ?? '') ||
			!/^\d+$/.test(hour ?? '') ||
			dayOfMonth !== '*' ||
			month !== '*'
		) {
			return cron || 'Custom schedule';
		}
		const time = formatScheduleTime(Number(hour), Number(minute));
		if (dayOfWeek === '*') return `Every day at ${time}`;
		if (['1-5', 'MON-FRI'].includes(dayOfWeek)) return `Weekdays at ${time}`;
		if (['0,6', '6,0', 'SUN,SAT', 'SAT,SUN'].includes(dayOfWeek)) return `Weekends at ${time}`;
		const weekdays: Record<string, string> = {
			'0': 'Sunday',
			'1': 'Monday',
			'2': 'Tuesday',
			'3': 'Wednesday',
			'4': 'Thursday',
			'5': 'Friday',
			'6': 'Saturday',
			SUN: 'Sunday',
			MON: 'Monday',
			TUE: 'Tuesday',
			WED: 'Wednesday',
			THU: 'Thursday',
			FRI: 'Friday',
			SAT: 'Saturday'
		};
		return weekdays[dayOfWeek] ? `Every ${weekdays[dayOfWeek]} at ${time}` : cron;
	};

	const isFailureStatus = (status?: string | null) =>
		['failed', 'missed', 'interrupted', 'missing_integration', 'auth_required'].includes(
			status ?? ''
		);

	const statusLabel = (status?: string | null) => {
		if (!status) {
			return 'Running';
		}
		return status
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	};

	const statusTone = (run: ScheduledTaskRun) => {
		if (run.needs_attention || isFailureStatus(run.status)) return 'attention';
		if (run.status === 'success') return 'success';
		if (!run.status) return 'running';
		return 'muted';
	};

	const runPreview = (run: ScheduledTaskRun) =>
		run.response_preview || run.error || (run.status ? statusLabel(run.status) : 'Run is in progress.');

	const taskName = (value: ScheduledTask) => {
		const savedName = `${value.name ?? ''}`.replace(/\s+/g, ' ').trim();
		if (savedName) {
			return savedName;
		}
		const promptLine =
			value.prompt
				.replace(/[*_`#>]/g, '')
				.split('\n')
				.map((line) => line.trim())
				.find(Boolean) ?? value.prompt.trim();
		return promptLine.split(/\s+/).filter(Boolean).slice(0, 5).join(' ') || 'Scheduled task';
	};

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

	const integrationOption = (id: string) =>
		toolServerCapabilities.find(
			(option) => normalizeToolServerId(option.id) === normalizeToolServerId(id)
		);
	const integrationName = (id: string) => integrationOption(id)?.display_name ?? displayNameFromId(id);
	const integrationNames = (ids: string[]) => ids.map(integrationName).join(', ');
	const integrationIcon = (id: string) => {
		const normalizedId = normalizeToolServerId(id);
		if (failedIntegrationIcons.has(normalizedId)) return '';
		const serverId = normalizedId.replace(/^server:/, '');
		return serverId ? `/api/v1/chats/mcp/servers/${encodeURIComponent(serverId)}/icon` : '';
	};
	const integrationIconSrc = (id: string) => {
		const iconUrl = integrationIcon(id);
		const retry = integrationIconRetries[normalizeToolServerId(id)] ?? 0;
		if (!iconUrl || retry === 0) return iconUrl;
		return `${iconUrl}${iconUrl.includes('?') ? '&' : '?'}scheduledTaskDetailIconRetry=${retry}`;
	};
	const handleIntegrationIconError = (id: string) => {
		const normalizedId = normalizeToolServerId(id);
		const retry = integrationIconRetries[normalizedId] ?? 0;
		if (retry === 0) {
			integrationIconRetries = { ...integrationIconRetries, [normalizedId]: Date.now() };
			return;
		}
		failedIntegrationIcons = new Set(failedIntegrationIcons).add(normalizedId);
	};

	const isTaskRunning = () => running || Boolean(task?.current_run);

	const loadTask = async ({ silent = false } = {}) => {
		if (!silent) {
			loading = true;
		}
		error = '';
		try {
			task = await getScheduledTask(localStorage.token, taskId);
		} catch (err) {
			error = errorMessage(err);
		} finally {
			if (!silent) {
				loading = false;
			}
		}
	};

	const loadCapabilities = async () => {
		try {
			const response = await listScheduledTaskCapabilities(localStorage.token);
			toolServerCapabilities = response.tool_servers ?? [];
		} catch {
			toolServerCapabilities = [];
		}
	};

	const syncRunningPoll = (shouldPoll: boolean) => {
		if (!shouldPoll) {
			if (runningPollTimer) {
				clearInterval(runningPollTimer);
				runningPollTimer = null;
			}
			return;
		}
		if (runningPollTimer) {
			return;
		}
		runningPollTimer = setInterval(() => {
			void loadTask({ silent: true });
		}, 2000);
	};

	const goBack = () => {
		if (history.length > 1) {
			history.back();
			return;
		}
		void goto('/scheduled-tasks');
	};

	const openRunChat = (chatId?: string | null) => {
		if (!chatId) {
			return;
		}
		void goto(`/c/${encodeURIComponent(chatId)}`);
	};

	const toggleTask = async () => {
		if (!task) {
			return;
		}
		try {
			task = await updateScheduledTask(localStorage.token, task.id, { enabled: !task.enabled });
		} catch (err) {
			toast.error(errorMessage(err));
		}
	};

	const runNow = async () => {
		if (!task) {
			return;
		}
		running = true;
		try {
			const response = await runScheduledTaskNow(localStorage.token, task.id);
			toast.success(
				response.status === 'already_running'
					? 'Scheduled task is already running.'
					: 'Scheduled task started.'
			);
			await loadTask();
		} catch (err) {
			toast.error(errorMessage(err));
		} finally {
			running = false;
		}
	};

	onMount(() => {
		void loadTask();
		void loadCapabilities();
	});

	onDestroy(() => {
		if (runningPollTimer) {
			clearInterval(runningPollTimer);
			runningPollTimer = null;
		}
	});
</script>

<svelte:head>
	<title>{task ? `${taskName(task)} - Scheduled Task` : 'Scheduled Task'}</title>
</svelte:head>

<div
	class="scheduled-task-detail-shell relative flex h-screen max-h-[100dvh] w-full max-w-full flex-col transition-width duration-200 ease-in-out {$showSidebar
		? 'md:max-w-[calc(100%-var(--sidebar-width))]'
		: ''}"
>
	<div class="scheduled-tasks-content flex-1 overflow-y-auto px-5 pb-12 pt-14 md:px-8">
		<div
			class="scheduled-tasks-page mx-auto flex w-full max-w-[920px] flex-col gap-5 text-gray-900 transition-transform duration-200 ease-in-out dark:text-gray-100 {$showSidebar
				? ''
				: 'md:-translate-x-[1.625rem]'}"
			data-portico-rail-compensated={$showSidebar ? 'false' : 'true'}
		>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-gray-400">
					<button class="text-blue-600 hover:underline dark:text-blue-300" on:click={() => void goto('/scheduled-tasks')}>
						Scheduled Tasks
					</button>
					<span>/</span>
					<span class="max-w-lg truncate">{task ? taskName(task) : taskId}</span>
				</div>
				<button
					class="scheduled-task-button scheduled-task-button-secondary"
					on:click={goBack}
				>
					Back
				</button>
			</div>

			{#if loading}
				<div class="flex items-center justify-center py-16">
					<Spinner />
				</div>
			{:else if error || !task}
				<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">
					<div class="font-medium">Scheduled task is unavailable.</div>
					<div class="mt-1">{error || 'Task not found.'}</div>
				</div>
			{:else}
				<section class="scheduled-task-detail-hero scheduled-task-surface p-6">
					<div class="scheduled-task-detail-icon"><ScheduledTaskIcon kind="hero" size={24} /></div>
					<div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
						<div class="min-w-0">
							<div class="mb-2 flex flex-wrap items-center gap-2">
								<span
									class="rounded-full px-2 py-0.5 text-xs font-medium {task.enabled
										? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
										: 'bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-300'}"
								>
									{task.enabled ? 'Enabled' : 'Paused'}
								</span>
								{#if task.needs_attention}
									<span class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
										<span class="size-2 rounded-full bg-current"></span>
										Needs attention
									</span>
								{/if}
								{#if task.current_run}
									<span class="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
										Running now
									</span>
								{/if}
							</div>
							<h1 class="break-words text-2xl font-semibold">{taskName(task)}</h1>
							<p class="mt-2 max-w-3xl whitespace-pre-wrap break-words text-sm text-slate-600 dark:text-gray-400">
								{task.prompt}
							</p>
						</div>
						<div class="flex flex-wrap gap-2 md:justify-end">
							<button
								class="scheduled-task-button scheduled-task-button-primary disabled:opacity-60"
								on:click={runNow}
								disabled={isTaskRunning()}
							>
								{isTaskRunning() ? 'Running...' : 'Run now'}
							</button>
							<button
								class="scheduled-task-button scheduled-task-button-secondary"
								on:click={toggleTask}
							>
								{task.enabled ? 'Pause' : 'Enable'}
							</button>
						</div>
					</div>

					<div class="scheduled-task-detail-stats mt-6 grid gap-3 text-sm md:grid-cols-3">
						<div>
							<div class="text-xs font-medium text-slate-600 dark:text-gray-400">Next run</div>
							<div>{formatDate(task.next_run_at)}</div>
						</div>
						<div>
							<div class="text-xs font-medium text-slate-600 dark:text-gray-400">Schedule</div>
							<div>{scheduleSummary(task.schedule)}</div>
						</div>
						<div>
							<div class="text-xs font-medium text-slate-600 dark:text-gray-400">Integrations</div>
							{#if (task.tool_server_ids ?? []).length === 0}
								<div>None</div>
							{:else}
								<strong
									class="scheduled-task-integration-summary scheduled-task-detail-integrations"
									aria-label={integrationNames(task.tool_server_ids)}
								>
									{#each task.tool_server_ids as id}
										<span
											title={integrationName(id)}
											aria-label={integrationName(id)}
											class:has-icon={Boolean(integrationIcon(id))}
										>
											{#if integrationIcon(id)}
												<img
													src={integrationIconSrc(id)}
													alt=""
													loading="eager"
													decoding="async"
													on:error={() => handleIntegrationIconError(id)}
												/>
											{:else}
												{integrationName(id).charAt(0)}
											{/if}
										</span>
									{/each}
								</strong>
							{/if}
						</div>
					</div>
				</section>

				<section class="scheduled-task-surface overflow-hidden">
					<div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4 dark:border-gray-800">
						<div>
							<div class="flex items-center gap-2">
								<span class="scheduled-task-history-icon"><ScheduledTaskIcon kind="history" size={18} /></span>
								<h2 class="text-lg font-semibold">Run history</h2>
							</div>
							<p class="mt-1 text-sm text-slate-600 dark:text-gray-400">
								Each run keeps its own chat and terminal status.
							</p>
						</div>
						<div class="flex flex-wrap gap-2">
							{#each runFilters as option}
								<button
									class="rounded-lg border px-3 py-1.5 text-sm {filter === option
										? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200'
										: 'border-slate-300 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900'}"
									on:click={() => (filter = option)}
								>
									{option === 'all' ? 'All' : statusLabel(option)}
								</button>
							{/each}
						</div>
					</div>

					{#if filteredRuns.length === 0}
						<div class="p-8 text-center text-sm text-slate-600 dark:text-gray-400">
							No runs match this filter.
						</div>
					{:else}
						<div class="scheduled-task-detail-run-list">
							{#each filteredRuns as run (run.run_id)}
								<button
									type="button"
									class="scheduled-task-detail-run-row"
									disabled={!run.chat_id}
									on:click={() => openRunChat(run.chat_id)}
								>
									<div class="font-medium">{formatDate(run.finished_at ?? run.started_at)}</div>
									<span class="scheduled-task-status-pill w-fit" data-tone={statusTone(run)}>
										{statusLabel(run.status)}
									</span>
									<span class="scheduled-task-run-preview" title={runPreview(run)}>{runPreview(run)}</span>
									{#if run.chat_id}
										<span class="scheduled-task-run-open" aria-label="Open chat">
											<ArrowTopRightOnSquare className="size-4" />
										</span>
									{/if}
								</button>
							{/each}
						</div>
					{/if}
				</section>
			{/if}
		</div>
	</div>
</div>
