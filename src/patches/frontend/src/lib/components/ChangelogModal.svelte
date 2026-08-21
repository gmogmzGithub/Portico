<script lang="ts">
	// Portico owns its release experience. Keep this compatibility
	// component so upstream imports remain valid, but never render or fetch the
	// Open WebUI changelog. Reset the bound store as an additional safeguard.
	export let show = false;

	$: if (show) {
		show = false;
	}
</script>
