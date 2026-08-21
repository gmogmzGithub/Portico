<script lang="ts">
	import type { ScheduledTaskToolServerCapability } from '$lib/apis/scheduledTasks';
	import CapabilityPicker from './CapabilityPicker.svelte';

	export let selectedIds: string[] = [];
	export let options: ScheduledTaskToolServerCapability[] = [];
	export let loading = false;
	export let label = 'MCP servers';
	export let placeholder = 'Add MCP servers';
	export let searchPlaceholder = 'Search MCP servers';

	const normalizeToolServerId = (value: string) => {
		const normalized = `${value}`.trim();
		return normalized && !normalized.startsWith('server:') ? `server:${normalized}` : normalized;
	};

	$: normalizedOptions = options.map((option) => ({
		...option,
		id: normalizeToolServerId(option.id)
	}));
</script>

<CapabilityPicker
	id="scheduled-task-mcp-picker"
	{label}
	{placeholder}
	{searchPlaceholder}
	emptyDescription="Allow this task to use connected services"
	selectedDescription="Click to review or change access"
	pickerTitle="Choose integrations"
	pickerDescription="Pre-approved for unattended task runs"
	loadingMessage="Loading MCP servers..."
	emptyMessage="No matching MCP servers"
	unavailableMessage="No MCP servers available"
	iconKind="mcp"
	options={normalizedOptions}
	{loading}
	bind:selectedIds
/>
