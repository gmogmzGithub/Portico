<script lang="ts">
	import { WEBUI_BASE_URL } from '$lib/constants';

	export let className = 'size-8';
	export let src = `${WEBUI_BASE_URL}/static/favicon.png`;

	// Portico: Fallback handler for broken profile images
	const handleImageError = (event: Event) => {
		const img = event.target as HTMLImageElement;
		// Check if this is a user profile image (contains /users/) and fall back to Portico logo
		// Otherwise fall back to the default favicon
		if (img.src.includes('/users/')) {
			img.src = `${WEBUI_BASE_URL}/static/portico-logo.png`;
		} else {
			img.src = `${WEBUI_BASE_URL}/static/favicon.png`;
		}
	};
</script>

<img
	aria-hidden="true"
	src={src === ''
		? `${WEBUI_BASE_URL}/static/favicon.png`
		: src.startsWith(WEBUI_BASE_URL) ||
			  src.startsWith('https://www.gravatar.com/avatar/') ||
			  src.startsWith('data:') ||
			  src.startsWith('/')
			? src
			: `${WEBUI_BASE_URL}/user.png`}
	class=" {className} object-cover rounded-full"
	alt="profile"
	draggable="false"
	on:error={handleImageError}
/>
