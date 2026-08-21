import { readable } from 'svelte/store';

export const isDarkMode = readable(false, (set) => {
	if (typeof document === 'undefined') {
		return () => {};
	}

	const update = () => {
		set(document.documentElement.classList.contains('dark'));
	};

	update();

	const observer = new MutationObserver(update);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['class']
	});

	return () => observer.disconnect();
});
