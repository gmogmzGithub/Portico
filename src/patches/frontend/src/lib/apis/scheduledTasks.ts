export type ScheduleKind = 'cron' | 'once';
export type LastRunStatus =
	| 'success'
	| 'failed'
	| 'missed'
	| 'cancelled'
	| 'interrupted'
	| 'missing_integration'
	| 'auth_required';
export type LastRunTrigger = 'scheduled' | 'manual';

export interface TaskSchedule {
	kind: ScheduleKind;
	cron_expression?: string | null;
	run_at?: string | null;
	timezone: string;
}

export interface ScheduledTask {
	id: string;
	name?: string;
	prompt: string;
	model_id: string;
	schedule: TaskSchedule;
	skill_ids: string[];
	tool_server_ids: string[];
	enabled: boolean;
	created_at: string;
	updated_at: string;
	next_run_at?: string | null;
	last_run_at?: string | null;
	last_run_status?: LastRunStatus | null;
	last_run_chat_id?: string | null;
	last_run_error?: string | null;
	last_run_response_preview?: string | null;
	last_run_trigger?: LastRunTrigger | null;
	current_run?: ScheduledTaskCurrentRun | null;
	needs_attention?: boolean;
	needs_attention_reason?: string | null;
	needs_attention_since?: string | null;
	runs?: ScheduledTaskRun[];
}

export interface ScheduledTaskCurrentRun {
	run_id: string;
	chat_id: string;
	started_at: string;
	trigger: LastRunTrigger;
}

export interface ScheduledTaskRun {
	run_id: string;
	chat_id?: string | null;
	started_at: string;
	finished_at?: string | null;
	status?: LastRunStatus | null;
	trigger: LastRunTrigger;
	error?: string | null;
	response_preview?: string | null;
	needs_attention?: boolean;
	needs_attention_reason?: string | null;
}

export interface ScheduledTasksListResponse {
	tasks: ScheduledTask[];
	count: number;
}

export interface ScheduledTaskSkillCapability {
	id: string;
	display_name: string;
	description?: string;
	source?: string;
}

export interface ScheduledTaskToolServerCapability {
	id: string;
	display_name: string;
	description?: string;
	icon_url?: string;
	is_core?: boolean;
	user_installed?: boolean;
	deployment_type?: string;
}

export interface ScheduledTaskCapabilitiesResponse {
	skills: ScheduledTaskSkillCapability[];
	tool_servers: ScheduledTaskToolServerCapability[];
}

export interface ScheduledTaskInput {
	name: string;
	prompt: string;
	model_id: string;
	schedule: TaskSchedule;
	skill_ids?: string[];
	tool_server_ids?: string[];
	enabled?: boolean;
}

export interface ScheduledTaskPatch {
	name?: string;
	prompt?: string;
	model_id?: string;
	schedule?: TaskSchedule;
	skill_ids?: string[];
	tool_server_ids?: string[];
	enabled?: boolean;
}

export interface ScheduledTaskRunResponse {
	task_id: string;
	run_id: string;
	chat_id: string;
	started_at: string;
	trigger: LastRunTrigger;
	status: 'running' | 'already_running';
}

const authedJsonFetch = async <T>(
	token: string,
	url: string,
	options: RequestInit = {}
): Promise<T> => {
	const res = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
			...(options.headers ?? {})
		}
	});

	if (!res.ok) {
		throw await res.json().catch(() => new Error(`HTTP ${res.status}`));
	}

	return await res.json();
};

export const listScheduledTasks = async (
	token: string,
	includeDisabled = true
): Promise<ScheduledTasksListResponse> =>
	authedJsonFetch(
		token,
		`/api/v1/scheduled-tasks?include_disabled=${includeDisabled ? 'true' : 'false'}`,
		{ method: 'GET' }
	);

export const listScheduledTaskCapabilities = async (
	token: string
): Promise<ScheduledTaskCapabilitiesResponse> =>
	authedJsonFetch(token, '/api/v1/scheduled-tasks/capabilities', { method: 'GET' });

export interface AgentCapabilitiesResponse {
	skill_ids: string[];
	tool_server_ids: string[];
}

// An agent's configured skills + MCP servers, used to pre-populate the task
// form (and by "Reload from Agent") when an agent is selected as the model.
export const getAgentCapabilities = async (
	token: string,
	agentId: string
): Promise<AgentCapabilitiesResponse> =>
	authedJsonFetch(
		token,
		`/api/v1/scheduled-tasks/agent-capabilities/${encodeURIComponent(agentId)}`,
		{ method: 'GET' }
	);

export const createScheduledTask = async (
	token: string,
	input: ScheduledTaskInput
): Promise<ScheduledTask> =>
	authedJsonFetch(token, '/api/v1/scheduled-tasks', {
		method: 'POST',
		body: JSON.stringify(input)
	});

export const getScheduledTask = async (token: string, taskId: string): Promise<ScheduledTask> =>
	authedJsonFetch(token, `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}`, {
		method: 'GET'
	});

export const updateScheduledTask = async (
	token: string,
	taskId: string,
	patch: ScheduledTaskPatch
): Promise<ScheduledTask> =>
	authedJsonFetch(token, `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}`, {
		method: 'PATCH',
		body: JSON.stringify(patch)
	});

export const deleteScheduledTask = async (
	token: string,
	taskId: string
): Promise<{ success: boolean; task_id: string }> =>
	authedJsonFetch(token, `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}`, {
		method: 'DELETE'
	});

export const runScheduledTaskNow = async (
	token: string,
	taskId: string
): Promise<ScheduledTaskRunResponse> =>
	authedJsonFetch(token, `/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}/run`, {
		method: 'POST'
	});
