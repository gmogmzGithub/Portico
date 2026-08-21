<script lang="ts">
	// Portico updates are managed by the desktop control plane. This
	// no-op override prevents upstream Open WebUI update notices from rendering,
	// including during cache-cleared startup before user settings are hydrated.
	export let version: {
		current: string;
		latest: string;
	};
</script>
