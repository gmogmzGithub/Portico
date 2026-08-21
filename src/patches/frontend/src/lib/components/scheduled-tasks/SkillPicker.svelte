<script lang="ts">
	import type { ScheduledTaskSkillCapability } from '$lib/apis/scheduledTasks';
	import CapabilityPicker from './CapabilityPicker.svelte';

	export let selectedIds: string[] = [];
	export let options: ScheduledTaskSkillCapability[] = [];
	export let loading = false;
</script>

<CapabilityPicker
	id="scheduled-task-skill-picker"
	label="Skills"
	placeholder="Add skills"
	searchPlaceholder="Search skills"
	emptyDescription="Allow this task to use selected skills"
	selectedDescription="Click to review or change access"
	pickerTitle="Choose skills"
	pickerDescription="Available to this task when its instructions need them"
	loadingMessage="Loading skills..."
	emptyMessage="No matching skills"
	unavailableMessage="No skills available"
	iconKind="skill"
	{options}
	{loading}
	bind:selectedIds
/>
