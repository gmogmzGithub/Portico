<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { v4 as uuidv4 } from 'uuid';

	import { goto } from '$app/navigation';
	import {
		user,
		chats,
		settings,
		showSettings,
		chatId,
		tags,
		folders as _folders,
		showSidebar,
		showSearch,
		mobile,
		pinnedChats,
		scrollPaginationEnabled,
		temporaryChatEnabled,
		channels,
		socket,
		config,
		isApp,
		models,
		selectedFolder,
		WEBUI_NAME,
		sidebarWidth
	} from '$lib/stores';
	import { page } from '$app/stores';
	import { isDelegatedSubagentRoute } from '$lib/utils/detached-window-mode.mjs';
	import {
		resolveInitialSidebarOpen,
		shouldPersistSidebarPreference
	} from '$lib/utils/sidebar-preference.mjs';
	import { onMount, getContext, tick, onDestroy } from 'svelte';

	const i18n = getContext('i18n');

	import {
		getAllTags,
		getPinnedChatList,
		toggleChatPinnedStatusById,
		getChatById,
		updateChatFolderIdById,
		importChats
	} from '$lib/apis/chats';
	import {
		listScheduledTasks,
		type LastRunStatus,
		type ScheduledTask,
		type ScheduledTaskRun
	} from '$lib/apis/scheduledTasks';
	import { createNewFolder, getFolders, updateFolderParentIdById } from '$lib/apis/folders';
	import { WEBUI_BASE_URL } from '$lib/constants';

	// PORTICO PATCH (Round 4 / Issue 7b): hydrate the chatAttention
	// store on mount + on every chat-list reload so the amber dots
	// stay in sync with the gate's pending-chip state. ChatItem.svelte
	// subscribes to the store directly, so we don't need to drill the
	// per-row attention prop through every caller.
	import { refreshChatAttention } from '$lib/stores/chatAttention';
	import { initializeChatRuntimeStateBridge } from '$lib/stores/chatRuntimeState';
	// PORTICO-348: feeds the inline question card in each chat's transcript.
	import { initializePendingUserQuestionsBridge } from '$lib/stores/pendingUserQuestions';
	import ChatItem from './Sidebar/ChatItem.svelte';
	import Spinner from '../common/Spinner.svelte';
	import Loader from '../common/Loader.svelte';
	import Folder from '../common/Folder.svelte';
	import Tooltip from '../common/Tooltip.svelte';
	import Folders from './Sidebar/Folders.svelte';
	import { getChannels, createNewChannel } from '$lib/apis/channels';
	import ChannelModal from './Sidebar/ChannelModal.svelte';
	import ChannelItem from './Sidebar/ChannelItem.svelte';
	import PencilSquare from '../icons/PencilSquare.svelte';
	import Search from '../icons/Search.svelte';
	import SearchModal from './SearchModal.svelte';
	import FolderModal from './Sidebar/Folders/FolderModal.svelte';
	import Sidebar from '../icons/Sidebar.svelte';
	import PinnedModelList from './Sidebar/PinnedModelList.svelte';
	import Settings from '$lib/components/icons/Settings.svelte';
	import { slide } from 'svelte/transition';
	import HotkeyHint from '../common/HotkeyHint.svelte';
	import { key } from 'vega';
	import { revealMessageWithRetry } from '$lib/utils/messageNavigation';
	import { resolveSidebarChatModelId } from '$lib/utils/chatSidebarModel';
	import {
		appendNextChatListPage,
		chatListPaginationState,
		refreshChatListPageOne
	} from '$lib/utils/chatListPagination';

	const BREAKPOINT = 768;

	type SidebarPreferenceHostApi = {
		getSidebarPreference?: () => Promise<{
			success?: boolean;
			data?: {
				normalWindowSidebarOpen?: boolean | null;
			};
			error?: string;
		}>;
		saveSidebarPreference?: (open: boolean) => Promise<{
			success?: boolean;
			error?: string;
		}>;
	};

	let scrollTop = 0;

	let navElement;
	let shiftKey = false;

	let selectedChatId = null;
	let showCreateChannel = false;

	// Pagination variables
	let chatListRetryTimeout: ReturnType<typeof setTimeout> | null = null;
	let chatListRetryCount = 0;
	const CHAT_LIST_MAX_RETRIES = 8;

	let showCreateFolderModal = false;

	let pinnedModels = [];

	let showPinnedModels = false;
	let showChannels = false;
	let showFolders = false;

	let folders = {};
	let folderRegistry = {};

	let newFolderId = null;
	$: delegatedSubagentView = isDelegatedSubagentRoute($page.url.searchParams);

	$: if ($selectedFolder) {
		initFolders();
	}

	const initFolders = async () => {
		if ($config?.features?.enable_folders === false) {
			return;
		}

		const folderResponse = await getFolders(localStorage.token).catch((error) => {
			return [];
		});
		const folderList = Array.isArray(folderResponse) ? folderResponse : [];
		_folders.set(folderList.sort((a, b) => b.updated_at - a.updated_at));

		folders = {};

		// First pass: Initialize all folder entries
		for (const folder of folderList) {
			// Ensure folder is added to folders with its data
			folders[folder.id] = { ...(folders[folder.id] || {}), ...folder };

			if (newFolderId && folder.id === newFolderId) {
				folders[folder.id].new = true;
				newFolderId = null;
			}
		}

		// Second pass: Tie child folders to their parents
		for (const folder of folderList) {
			if (folder.parent_id) {
				// Ensure the parent folder is initialized if it doesn't exist
				if (!folders[folder.parent_id]) {
					folders[folder.parent_id] = {}; // Create a placeholder if not already present
				}

				// Initialize childrenIds array if it doesn't exist and add the current folder id
				folders[folder.parent_id].childrenIds = folders[folder.parent_id].childrenIds
					? [...folders[folder.parent_id].childrenIds, folder.id]
					: [folder.id];

				// Sort the children by updated_at field
				folders[folder.parent_id].childrenIds.sort((a, b) => {
					return folders[b].updated_at - folders[a].updated_at;
				});
			}
		}
	};

	const createFolder = async ({ name, data }) => {
		name = name?.trim();
		if (!name) {
			toast.error($i18n.t('Folder name cannot be empty.'));
			return;
		}

		const rootFolders = Object.values(folders).filter((folder) => folder.parent_id === null);
		if (rootFolders.find((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
			// If a folder with the same name already exists, append a number to the name
			let i = 1;
			while (
				rootFolders.find((folder) => folder.name.toLowerCase() === `${name} ${i}`.toLowerCase())
			) {
				i++;
			}

			name = `${name} ${i}`;
		}

		// Add a dummy folder to the list to show the user that the folder is being created
		const tempId = uuidv4();
		folders = {
			...folders,
			tempId: {
				id: tempId,
				name: name,
				created_at: Date.now(),
				updated_at: Date.now()
			}
		};

		const res = await createNewFolder(localStorage.token, {
			name,
			data
		}).catch((error) => {
			toast.error(`${error}`);
			return null;
		});

		if (res) {
			// newFolderId = res.id;
			await initFolders();
			showFolders = true;
		}
	};

	const initChannels = async () => {
		// default (none), group, dm type
		const res = await getChannels(localStorage.token).catch((error) => {
			return null;
		});

		if (res) {
			await channels.set(
				res.sort(
					(a, b) =>
						['', null, 'group', 'dm'].indexOf(a.type) - ['', null, 'group', 'dm'].indexOf(b.type)
				)
			);
		}
	};

	const clearChatListRetry = () => {
		if (chatListRetryTimeout) {
			clearTimeout(chatListRetryTimeout);
			chatListRetryTimeout = null;
		}
	};

	const loadPrimaryChatList = async () => {
		try {
			const result = await refreshChatListPageOne(localStorage.token);
			if (result.status === 'stale') return true;

			chatListRetryCount = 0;
			clearChatListRetry();
			scrollPaginationEnabled.set(true);
			return true;
		} catch (error) {
			console.warn('[Sidebar] Chat history load failed; preserving existing rows', error);
			scrollPaginationEnabled.set(false);

			if (!chatListRetryTimeout && chatListRetryCount < CHAT_LIST_MAX_RETRIES) {
				const retryDelayMs = Math.min(1000 * 2 ** chatListRetryCount, 5000);
				chatListRetryCount += 1;
				chatListRetryTimeout = setTimeout(() => {
					chatListRetryTimeout = null;
					void loadPrimaryChatList();
				}, retryDelayMs);
			} else if (chatListRetryCount >= CHAT_LIST_MAX_RETRIES && $chats === null) {
				await chats.set([]);
				toast.error($i18n.t('Chat history is temporarily unavailable. Please try again.'));
			}

			return false;
		}
	};

	const initChatList = async () => {
		// Reset pagination variables
		console.log('initChatList');
		scrollPaginationEnabled.set(false);
		chatListRetryCount = 0;
		clearChatListRetry();

		void initFolders();
		await Promise.all([
			(async () => {
				console.log('Init tags');
				const _tags = await getAllTags(localStorage.token).catch(() => null);
				if (Array.isArray(_tags)) {
					tags.set(_tags);
				}
			})(),
			(async () => {
				console.log('Init pinned chats');
				const _pinnedChats = await getPinnedChatList(localStorage.token).catch(() => null);
				if (Array.isArray(_pinnedChats)) {
					pinnedChats.set(_pinnedChats);
				}
			})(),
			(async () => {
				console.log('Init chat list');
				await loadPrimaryChatList();
			})(),
			// PORTICO PATCH (Round 4 / Issue 7b): refresh per-chat
			// attention so amber dots reconcile on every list reload
			// (covers chip-resolved + new-chip-proposed paths). Soft-
			// fails inside the helper, never blocks the chat list.
			refreshChatAttention(localStorage.token)
		]);

	};

	const loadMoreChats = async () => {
		try {
			await appendNextChatListPage(localStorage.token);
		} catch (error) {
			console.warn('[Sidebar] Additional chat page failed to load; preserving existing rows', error);
		}
	};

	const importChatHandler = async (items, pinned = false, folderId = null) => {
		console.log('importChatHandler', items, pinned, folderId);
		for (const item of items) {
			console.log(item);
			if (item.chat) {
				await importChats(localStorage.token, [
					{
						chat: item.chat,
						meta: item?.meta ?? {},
						pinned: pinned,
						folder_id: folderId,
						created_at: item?.created_at ?? null,
						updated_at: item?.updated_at ?? null
					}
				]);
			}
		}

		initChatList();
	};

	const inputFilesHandler = async (files) => {
		console.log(files);

		for (const file of files) {
			const reader = new FileReader();
			reader.onload = async (e) => {
				const content = e.target.result;

				try {
					const chatItems = JSON.parse(content);
					importChatHandler(chatItems);
				} catch {
					toast.error($i18n.t(`Invalid file format.`));
				}
			};

			reader.readAsText(file);
		}
	};

	const tagEventHandler = async (type, tagName, chatId) => {
		console.log(type, tagName, chatId);
		if (type === 'delete') {
			initChatList();
		} else if (type === 'add') {
			initChatList();
		}
	};

	let draggedOver = false;

	const onDragOver = (e) => {
		e.preventDefault();

		// Check if a file is being draggedOver.
		if (e.dataTransfer?.types?.includes('Files')) {
			draggedOver = true;
		} else {
			draggedOver = false;
		}
	};

	const onDragLeave = () => {
		draggedOver = false;
	};

	const onDrop = async (e) => {
		e.preventDefault();
		console.log(e); // Log the drop event

		// Perform file drop check and handle it accordingly
		if (e.dataTransfer?.files) {
			const inputFiles = Array.from(e.dataTransfer?.files);

			if (inputFiles && inputFiles.length > 0) {
				console.log(inputFiles); // Log the dropped files
				inputFilesHandler(inputFiles); // Handle the dropped files
			}
		}

		draggedOver = false; // Reset draggedOver status after drop
	};

	let touchstart;
	let touchend;

	function checkDirection() {
		const screenWidth = window.innerWidth;
		const swipeDistance = Math.abs(touchend.screenX - touchstart.screenX);
		if (touchstart.clientX < 40 && swipeDistance >= screenWidth / 8) {
			if (touchend.screenX < touchstart.screenX) {
				showSidebar.set(false);
			}
			if (touchend.screenX > touchstart.screenX) {
				showSidebar.set(true);
			}
		}
	}

	const onTouchStart = (e) => {
		touchstart = e.changedTouches[0];
		console.log(touchstart.clientX);
	};

	const onTouchEnd = (e) => {
		touchend = e.changedTouches[0];
		checkDirection();
	};

	const onKeyDown = (e) => {
		if (e.key === 'Shift') {
			shiftKey = true;
		}
	};

	const onKeyUp = (e) => {
		if (e.key === 'Shift') {
			shiftKey = false;
		}
	};

	const onFocus = () => {};

	const onBlur = () => {
		shiftKey = false;
		selectedChatId = null;
	};

	const MIN_WIDTH = 220;
	const MAX_WIDTH = 480;
	const DEFAULT_WIDTH = 360;

	let isResizing = false;

	let startWidth = 0;
	let startClientX = 0;

	const getSidebarPreferenceHostApi = (): SidebarPreferenceHostApi | undefined => {
		if (typeof window === 'undefined') {
			return undefined;
		}

		return (window as any)?.webviewHost as SidebarPreferenceHostApi | undefined;
	};

	const readLegacySidebarPreference = () => {
		try {
			return localStorage.getItem('sidebar') ?? '';
		} catch {
			return '';
		}
	};

	const writeLegacySidebarPreference = (value: boolean) => {
		try {
			localStorage.setItem('sidebar', String(value));
		} catch {}
	};

	const loadInitialSidebarOpenState = async () => {
		const storedLocalValue = readLegacySidebarPreference();
		if (
			!shouldPersistSidebarPreference({
				isMobile: $mobile,
				delegatedSubagentView
			})
		) {
			return resolveInitialSidebarOpen({
				isMobile: $mobile,
				delegatedSubagentView,
				storedLocalValue,
				persistedPreference: null
			});
		}

		const hostApi = getSidebarPreferenceHostApi();
		if (typeof hostApi?.getSidebarPreference !== 'function') {
			return resolveInitialSidebarOpen({
				isMobile: $mobile,
				delegatedSubagentView,
				storedLocalValue,
				persistedPreference: null
			});
		}

		try {
			const result = await hostApi.getSidebarPreference();
			if (!result?.success) {
				console.warn(
					'[Sidebar] Failed to load persisted sidebar preference:',
					result?.error ?? 'unknown error'
				);
			}

			return resolveInitialSidebarOpen({
				isMobile: $mobile,
				delegatedSubagentView,
				storedLocalValue,
				persistedPreference: result?.success
					? (result?.data?.normalWindowSidebarOpen ?? null)
					: null
			});
		} catch (error) {
			console.warn('[Sidebar] Failed to load persisted sidebar preference:', error);
			return resolveInitialSidebarOpen({
				isMobile: $mobile,
				delegatedSubagentView,
				storedLocalValue,
				persistedPreference: null
			});
		}
	};

	const persistSidebarOpenState = async (value: boolean) => {
		if (
			!shouldPersistSidebarPreference({
				isMobile: $mobile,
				delegatedSubagentView
			})
		) {
			return;
		}

		writeLegacySidebarPreference(value);

		const hostApi = getSidebarPreferenceHostApi();
		if (typeof hostApi?.saveSidebarPreference !== 'function') {
			return;
		}

		try {
			const result = await hostApi.saveSidebarPreference(value);
			if (!result?.success) {
				console.warn(
					'[Sidebar] Failed to persist sidebar preference:',
					result?.error ?? 'unknown error'
				);
			}
		} catch (error) {
			console.warn('[Sidebar] Failed to persist sidebar preference:', error);
		}
	};

	const resizeStartHandler = (e: MouseEvent) => {
		if ($mobile) return;
		isResizing = true;

		startClientX = e.clientX;
		startWidth = $sidebarWidth ?? DEFAULT_WIDTH;

		document.body.style.userSelect = 'none';
	};

	const resizeEndHandler = () => {
		if (!isResizing) return;
		isResizing = false;

		document.body.style.userSelect = '';
		localStorage.setItem('sidebarWidth', String($sidebarWidth));
	};

	const resizeSidebarHandler = (endClientX) => {
		const dx = endClientX - startClientX;
		const newSidebarWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + dx));

		sidebarWidth.set(newSidebarWidth);
		document.documentElement.style.setProperty('--sidebar-width', `${newSidebarWidth}px`);
	};

	let unsubscribers = [];
	const onTriggerSearch = () => showSearch.set(true);
	const onNewChat = () => {
		goto('/');
		newChatHandler();
	};
	let lastUrlTargetMessageSignature = '';
	let scheduledTaskNotificationInterval: ReturnType<typeof setInterval> | null = null;
	let scheduledTaskNotificationSeeded = false;
	const scheduledTaskNotificationSeen = new Set<string>();
	const scheduledTaskNotificationSessionStartedAt = Date.now();
	const SCHEDULED_TASK_NOTIFICATION_POLL_MS = 15000;
	const SCHEDULED_TASK_NOTIFICATION_SEEN_STORAGE_KEY = 'scheduledTaskTerminalRunsSeen';
	const SCHEDULED_TASK_TERMINAL_STATUSES = new Set<LastRunStatus>([
		'success',
		'failed',
		'missed',
		'cancelled',
		'interrupted',
		'missing_integration',
		'auth_required'
	]);

	const onNavigateToMessage = async (e: Event) => {
		const detail = (e as CustomEvent).detail || {};
		const targetChatId = detail.chatId;
		const messageId = detail.messageId;
		if (!targetChatId) return;

		const currentPath = window.location.pathname;
		const alreadyOnTarget = currentPath === `/c/${targetChatId}`;

		if (!alreadyOnTarget) {
			if (currentPath === '/' || currentPath === '') {
				return;
			}
			await goto(`/c/${targetChatId}`);
		}

		if (messageId) {
			revealMessageWithRetry(messageId);
		}
	};

	const clearUrlTargetMessage = () => {
		if (typeof window === 'undefined') {
			return;
		}

		try {
			const url = new URL(window.location.href);
			url.searchParams.delete('portico-target-message');
			const nextUrl = `${url.pathname}${url.search}${url.hash}`;
			window.history.replaceState(window.history.state, '', nextUrl);
		} catch {}
	};

	const maybeRevealUrlTargetMessage = async () => {
		const currentPath = $page.url.pathname;
		const targetMatch = currentPath.match(/^\/c\/([^/?#]+)/);
		const targetMessageId = $page.url.searchParams.get('portico-target-message');
		if (!targetMatch || !targetMessageId) {
			return;
		}

		const signature = `${targetMatch[1]}:${targetMessageId}:${$page.url.search}`;
		if (signature === lastUrlTargetMessageSignature) {
			return;
		}
		lastUrlTargetMessageSignature = signature;

		await tick();
		revealMessageWithRetry(targetMessageId);
		clearUrlTargetMessage();
	};

	$: if (typeof window !== 'undefined' && $page.url.searchParams.get('portico-target-message')) {
		void maybeRevealUrlTargetMessage();
	}

	const loadScheduledTaskNotificationSeen = () => {
		try {
			const raw = sessionStorage.getItem(SCHEDULED_TASK_NOTIFICATION_SEEN_STORAGE_KEY);
			const values = raw ? JSON.parse(raw) : [];
			if (Array.isArray(values)) {
				for (const value of values) {
					if (typeof value === 'string' && value) {
						scheduledTaskNotificationSeen.add(value);
					}
				}
			}
		} catch {}
	};

	const persistScheduledTaskNotificationSeen = () => {
		try {
			sessionStorage.setItem(
				SCHEDULED_TASK_NOTIFICATION_SEEN_STORAGE_KEY,
				JSON.stringify([...scheduledTaskNotificationSeen].slice(-500))
			);
		} catch {}
	};

	const isTerminalScheduledTaskRun = (run: ScheduledTaskRun) =>
		Boolean(run.status && SCHEDULED_TASK_TERMINAL_STATUSES.has(run.status));

	const scheduledTaskNotificationKey = (task: ScheduledTask, run: ScheduledTaskRun) =>
		`${task.id}:${run.run_id}:${run.status ?? 'running'}`;

	const truncateScheduledTaskNotificationText = (value: string, maxLength = 140) => {
		const collapsed = value.replace(/\s+/g, ' ').trim();
		return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
	};

	const scheduledTaskRunFinishedAt = (run: ScheduledTaskRun) => {
		const value = run.finished_at ?? run.started_at;
		const time = value ? new Date(value).getTime() : 0;
		return Number.isFinite(time) ? time : 0;
	};

	const scheduledTaskRunFinishedAfterSessionStart = (run: ScheduledTaskRun) =>
		scheduledTaskRunFinishedAt(run) >= scheduledTaskNotificationSessionStartedAt;

	// A run that terminated badly while the app was closed. Cancelled runs
	// are user-initiated and excluded; rows older than the age bound stay
	// visible on the Scheduled Tasks page without re-toasting every session.
	const SCHEDULED_TASK_AWAY_FAILURE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
	const isAwayFailedScheduledTaskRun = (run: ScheduledTaskRun) => {
		if (!run.status || run.status === 'success' || run.status === 'cancelled') {
			return Boolean(run.needs_attention);
		}
		return true;
	};

	const notifyAwayScheduledTaskFailures = (
		failures: Array<{ task: ScheduledTask; run: ScheduledTaskRun }>
	) => {
		if (failures.length === 0) {
			return;
		}
		if (failures.length === 1) {
			notifyScheduledTaskRun(failures[0].task, failures[0].run);
			return;
		}
		const taskCount = new Set(failures.map(({ task }) => task.id)).size;
		const body =
			taskCount === 1
				? `${failures.length} scheduled runs need attention since you were away.`
				: `${failures.length} scheduled runs across ${taskCount} tasks need attention since you were away.`;
		toast.warning(body, {
			description: 'Scheduled tasks need attention',
			action: {
				label: 'View tasks',
				onClick: () => {
					void goto('/scheduled-tasks');
				}
			}
		});
	};

	const notifyScheduledTaskRun = (task: ScheduledTask, run: ScheduledTaskRun) => {
		const failed = run.needs_attention || (run.status && run.status !== 'success');
		const title = failed ? 'Scheduled task needs attention' : 'Scheduled task finished';
		const body = truncateScheduledTaskNotificationText(
			run.response_preview || run.error || task.prompt || 'Open the run for details.'
		);
		const target = run.chat_id ? `/c/${run.chat_id}` : `/scheduled-tasks/${encodeURIComponent(task.id)}`;

		const action = {
			label: run.chat_id ? 'Open chat' : 'View task',
			onClick: () => {
				void goto(target);
			}
		};

		if (failed) {
			toast.warning(body, { description: title, action });
		} else {
			toast.success(body, { description: title, action });
		}

	};

	const pollScheduledTaskRunNotifications = async () => {
		if (!localStorage.token) {
			return;
		}

		try {
			const response = await listScheduledTasks(localStorage.token, true);
			const awayFailures: Array<{ task: ScheduledTask; run: ScheduledTaskRun }> = [];
			for (const task of response.tasks ?? []) {
				for (const run of task.runs ?? []) {
					if (!isTerminalScheduledTaskRun(run)) {
						continue;
					}
					const key = scheduledTaskNotificationKey(task, run);
					if (scheduledTaskNotificationSeen.has(key)) {
						continue;
					}
					scheduledTaskNotificationSeen.add(key);
					if (scheduledTaskNotificationSeeded) {
						if (scheduledTaskRunFinishedAfterSessionStart(run)) {
							notifyScheduledTaskRun(task, run);
						}
					} else if (
						isAwayFailedScheduledTaskRun(run) &&
						Date.now() - scheduledTaskRunFinishedAt(run) <=
							SCHEDULED_TASK_AWAY_FAILURE_MAX_AGE_MS
					) {
						// First poll of the session: runs that terminated badly
						// while the app was closed used to be seeded as seen and
						// never surfaced. Collect them for one summary notice.
						awayFailures.push({ task, run });
					}
				}
			}
			if (!scheduledTaskNotificationSeeded) {
				notifyAwayScheduledTaskFailures(awayFailures);
			}
			scheduledTaskNotificationSeeded = true;
			persistScheduledTaskNotificationSeen();
		} catch (error) {
			console.warn('[ScheduledTasks] Failed to poll task run notifications:', error);
		}
	};

	const startScheduledTaskRunNotifications = () => {
		if (scheduledTaskNotificationInterval) {
			return;
		}
		loadScheduledTaskNotificationSeen();
		void pollScheduledTaskRunNotifications();
		scheduledTaskNotificationInterval = setInterval(
			() => void pollScheduledTaskRunNotifications(),
			SCHEDULED_TASK_NOTIFICATION_POLL_MS
		);
	};

	const stopScheduledTaskRunNotifications = () => {
		if (!scheduledTaskNotificationInterval) {
			return;
		}
		clearInterval(scheduledTaskNotificationInterval);
		scheduledTaskNotificationInterval = null;
	};

	onMount(async () => {
		void initializeChatRuntimeStateBridge();
		void initializePendingUserQuestionsBridge();
		let initialSidebarWidth = DEFAULT_WIDTH;

		try {
			const width = Number(localStorage.getItem('sidebarWidth'));
			if (!Number.isNaN(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) {
				initialSidebarWidth = width;
			}
		} catch {}

		sidebarWidth.set(initialSidebarWidth);
		document.documentElement.style.setProperty('--sidebar-width', `${initialSidebarWidth}px`);
		const sidebarWidthUnsubscriber = sidebarWidth.subscribe((w) => {
			document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
		});

		showSidebar.set(await loadInitialSidebarOpenState());

		unsubscribers = [
			sidebarWidthUnsubscriber,
			mobile.subscribe((value) => {
				if ($showSidebar && value) {
					showSidebar.set(false);
				}

				if ($showSidebar && !value) {
					const navElement = document.getElementsByTagName('nav')[0];
					if (navElement) {
						navElement.style['-webkit-app-region'] = 'drag';
					}
				}
			}),
			showSidebar.subscribe(async (value) => {
				void persistSidebarOpenState(value);

				// nav element is not available on the first render
				const navElement = document.getElementsByTagName('nav')[0];

				if (navElement) {
					if ($mobile) {
						if (!value) {
							navElement.style['-webkit-app-region'] = 'drag';
						} else {
							navElement.style['-webkit-app-region'] = 'no-drag';
						}
					} else {
						navElement.style['-webkit-app-region'] = 'drag';
					}
				}

				if (value) {
					// Only fetch channels if the feature is enabled and user has permission
					if (
						$config?.features?.enable_channels &&
						($user?.role === 'admin' || ($user?.permissions?.features?.channels ?? true))
					) {
						await initChannels();
					}
					await initChatList();
				}
			}),
			settings.subscribe((value) => {
				if (pinnedModels != value?.pinnedModels ?? []) {
					pinnedModels = value?.pinnedModels ?? [];
					showPinnedModels = pinnedModels.length > 0;
				}
			})
		];

		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);

		window.addEventListener('touchstart', onTouchStart);
		window.addEventListener('touchend', onTouchEnd);

		window.addEventListener('focus', onFocus);
		window.addEventListener('blur', onBlur);

		window.addEventListener('trigger-search', onTriggerSearch);
		window.addEventListener('open-new-chat', onNewChat);
		window.addEventListener('navigate-to-message', onNavigateToMessage);
		startScheduledTaskRunNotifications();

		const dropZone = document.getElementById('sidebar');

		dropZone?.addEventListener('dragover', onDragOver);
		dropZone?.addEventListener('drop', onDrop);
		dropZone?.addEventListener('dragleave', onDragLeave);
	});

	onDestroy(() => {
		clearChatListRetry();
		if (unsubscribers && unsubscribers.length > 0) {
			unsubscribers.forEach((unsubscriber) => {
				if (unsubscriber) {
					unsubscriber();
				}
			});
		}

		window.removeEventListener('keydown', onKeyDown);
		window.removeEventListener('keyup', onKeyUp);

		window.removeEventListener('touchstart', onTouchStart);
		window.removeEventListener('touchend', onTouchEnd);

		window.removeEventListener('focus', onFocus);
		window.removeEventListener('blur', onBlur);
		window.removeEventListener('trigger-search', onTriggerSearch);
		window.removeEventListener('open-new-chat', onNewChat);
		window.removeEventListener('navigate-to-message', onNavigateToMessage);
		stopScheduledTaskRunNotifications();

		const dropZone = document.getElementById('sidebar');

		dropZone?.removeEventListener('dragover', onDragOver);
		dropZone?.removeEventListener('drop', onDrop);
		dropZone?.removeEventListener('dragleave', onDragLeave);
	});

	const newChatHandler = async () => {
		selectedChatId = null;
		selectedFolder.set(null);

		if ($user?.role !== 'admin' && $user?.permissions?.chat?.temporary_enforced) {
			await temporaryChatEnabled.set(true);
		} else {
			await temporaryChatEnabled.set(false);
		}

		setTimeout(() => {
			if ($mobile) {
				showSidebar.set(false);
			}
		}, 0);
	};

	const itemClickHandler = async () => {
		selectedChatId = null;
		chatId.set('');

		if ($mobile) {
			showSidebar.set(false);
		}

		await tick();
	};

	const isWindows = /Windows/i.test(navigator.userAgent);
</script>

<ChannelModal
	bind:show={showCreateChannel}
	onSubmit={async ({ type, name, is_private, access_control, group_ids, user_ids }) => {
		name = name?.trim();

		if (type === 'dm') {
			if (!user_ids || user_ids.length === 0) {
				toast.error($i18n.t('Please select at least one user for Direct Message channel.'));
				return;
			}
		} else {
			if (!name) {
				toast.error($i18n.t('Channel name cannot be empty.'));
				return;
			}
		}

		const res = await createNewChannel(localStorage.token, {
			type: type,
			name: name,
			is_private: is_private,
			access_control: access_control,
			group_ids: group_ids,
			user_ids: user_ids
		}).catch((error) => {
			toast.error(`${error}`);
			return null;
		});

		if (res) {
			$socket.emit('join-channels', { auth: { token: $user?.token } });
			await initChannels();
			showCreateChannel = false;
			showChannels = true;
			goto(`/channels/${res.id}`);
		}
	}}
/>

<FolderModal
	bind:show={showCreateFolderModal}
	onSubmit={async (folder) => {
		await createFolder(folder);
		showCreateFolderModal = false;
	}}
/>

<!-- svelte-ignore a11y-no-static-element-interactions -->

{#if $showSidebar}
	<div
		class=" {$isApp
			? ' ml-[4.5rem] md:ml-0'
			: ''} fixed md:hidden z-40 top-0 right-0 left-0 bottom-0 bg-black/60 w-full min-h-screen h-screen flex justify-center overflow-hidden overscroll-contain"
		on:mousedown={() => {
			showSidebar.set(!$showSidebar);
		}}
	/>
{/if}

<SearchModal
	bind:show={$showSearch}
	onClose={() => {
		if ($mobile) {
			showSidebar.set(false);
		}
	}}
/>

<button
	id="sidebar-new-chat-button"
	class="hidden"
	on:click={() => {
		goto('/');
		newChatHandler();
	}}
/>

<svelte:window
	on:mousemove={(e) => {
		if (!isResizing) return;
		resizeSidebarHandler(e.clientX);
	}}
	on:mouseup={() => {
		resizeEndHandler();
	}}
/>

{#if !delegatedSubagentView && !$mobile && !$showSidebar}
	<div
		class=" pt-[7px] pb-2 px-2 flex flex-col justify-between text-black dark:text-white hover:bg-gray-50/30 dark:hover:bg-gray-950/30 h-full z-10 transition-all border-e-[0.5px] border-gray-50 dark:border-gray-850/30"
		id="sidebar"
	>
		<div class="flex flex-col flex-1">
			<div class="pb-1.5">
				<Tooltip
					content={$showSidebar ? $i18n.t('Close Sidebar') : $i18n.t('Open Sidebar')}
					placement="right"
				>
					<button
						class="flex rounded-xl hover:bg-gray-100 dark:hover:bg-gray-850 transition group {isWindows
							? 'cursor-pointer'
							: 'cursor-[e-resize]'}"
						aria-label={$showSidebar ? $i18n.t('Close Sidebar') : $i18n.t('Open Sidebar')}
						on:click={() => {
							showSidebar.set(!$showSidebar);
						}}
					>
						<div class=" self-center flex items-center justify-center size-9">
							<img
								src="{WEBUI_BASE_URL}/static/favicon.png"
								class="sidebar-new-chat-icon size-6 rounded-full group-hover:hidden"
								alt=""
							/>

							<Sidebar className="size-5 hidden group-hover:flex" />
						</div>
					</button>
				</Tooltip>
			</div>

			<div class="-mt-[0.5px]">
				<div class="">
					<Tooltip content={$i18n.t('New Chat')} placement="right">
						<a
							class=" cursor-pointer flex rounded-xl hover:bg-gray-100 dark:hover:bg-gray-850 transition group"
							href="/"
							draggable="false"
							on:click={async (e) => {
								e.stopImmediatePropagation();
								e.preventDefault();

								goto('/');
								newChatHandler();
							}}
							aria-label={$i18n.t('New Chat')}
						>
							<div class=" self-center flex items-center justify-center size-9">
								<PencilSquare className="size-4.5" />
							</div>
						</a>
					</Tooltip>
				</div>

				<div>
					<Tooltip content={$i18n.t('Search')} placement="right">
						<button
							class=" cursor-pointer flex rounded-xl hover:bg-gray-100 dark:hover:bg-gray-850 transition group"
							on:click={(e) => {
								e.stopImmediatePropagation();
								e.preventDefault();

								showSearch.set(true);
							}}
							draggable="false"
							aria-label={$i18n.t('Search')}
						>
							<div class=" self-center flex items-center justify-center size-9">
								<Search className="size-4.5" />
							</div>
						</button>
					</Tooltip>
				</div>

				<div>
					<Tooltip content={$i18n.t('Scheduled Tasks')} placement="right">
						<a
							class=" cursor-pointer flex rounded-xl hover:bg-gray-100 dark:hover:bg-gray-850 transition group"
							href="/scheduled-tasks"
							on:click={async (e) => {
								e.stopImmediatePropagation();
								e.preventDefault();

								goto('/scheduled-tasks');
								itemClickHandler();
							}}
							draggable="false"
							aria-label={$i18n.t('Scheduled Tasks')}
						>
							<div class=" self-center flex items-center justify-center size-9">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									fill="none"
									viewBox="0 0 24 24"
									stroke-width="1.5"
									stroke="currentColor"
									class="size-4.5"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										d="M12 6v6l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
									/>
								</svg>
							</div>
						</a>
					</Tooltip>
				</div>

				{#if $user?.role === 'admin' || $user?.permissions?.workspace?.prompts}
					<div class="">
						<Tooltip content={$i18n.t('Prompts')} placement="right">
							<a
								class=" cursor-pointer flex rounded-xl hover:bg-gray-100 dark:hover:bg-gray-850 transition group"
								href="/workspace/prompts"
								on:click={async (e) => {
									e.stopImmediatePropagation();
									e.preventDefault();

									goto('/workspace/prompts');
									itemClickHandler();
								}}
								aria-label={$i18n.t('Prompts')}
								draggable="false"
							>
								<div class=" self-center flex items-center justify-center size-9">
									<svg
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
										stroke-width="1.5"
										stroke="currentColor"
										class="size-4.5"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z"
										/>
									</svg>
								</div>
							</a>
						</Tooltip>
					</div>
				{/if}

				<div>
					<Tooltip content={$i18n.t('Settings')} placement="right">
						<button
							id="sidebar-collapsed-settings-button"
							type="button"
							class="cursor-pointer flex rounded-xl hover:bg-gray-100 dark:hover:bg-gray-850 transition group no-drag-region"
							aria-label={$i18n.t('Settings')}
							on:click={() => {
								showSettings.set(true);
							}}
						>
							<div class="self-center flex items-center justify-center size-9">
								<Settings className="size-4.5" strokeWidth="1.5" />
							</div>
						</button>
					</Tooltip>
				</div>
			</div>
		</div>

	</div>
{/if}

<!-- {$i18n.t('New Folder')} -->
<!-- {$i18n.t('Pinned')} -->

{#if !delegatedSubagentView && $showSidebar}
	<div
		bind:this={navElement}
		id="sidebar"
		class="h-screen max-h-[100dvh] min-h-screen select-none {$showSidebar
			? `${$mobile
					? 'bg-[rgba(195,203,216,0.98)] dark:bg-gray-950'
					: 'bg-[rgba(195,203,216,0.94)] dark:bg-gray-950/70'} z-50`
			: ' bg-transparent z-0 '} {$isApp
			? `ml-[4.5rem] md:ml-0 `
			: ' transition-all duration-300 '} shrink-0 text-gray-900 dark:text-gray-200 text-sm fixed top-0 left-0 overflow-x-hidden
        "
		transition:slide={{ duration: 250, axis: 'x' }}
		data-state={$showSidebar}
	>
		<div
			class=" my-auto flex flex-col justify-between h-screen max-h-[100dvh] w-[var(--sidebar-width)] overflow-x-hidden scrollbar-hidden z-50 {$showSidebar
				? 'bg-[rgba(195,203,216,0.94)] dark:bg-gray-950'
				: 'invisible'}"
		>
			<div
				class="sidebar px-[0.5625rem] pt-2 pb-1.5 flex justify-between space-x-1 text-gray-600 dark:text-gray-400 sticky top-0 z-10 -mb-3"
			>
				<a
					class="flex items-center rounded-xl size-8.5 h-full justify-center hover:bg-gray-100/50 dark:hover:bg-gray-850/50 transition no-drag-region"
					href="/"
					draggable="false"
					on:click={newChatHandler}
				>
					<img
						crossorigin="anonymous"
						src="{WEBUI_BASE_URL}/static/favicon.png"
						class="sidebar-new-chat-icon size-6 rounded-full"
						alt=""
					/>
				</a>

				<a href="/" class="flex flex-1 px-1.5" on:click={newChatHandler}>
					<div
						id="sidebar-webui-name"
						class=" self-center font-medium text-gray-850 dark:text-white font-primary"
					>
						{$WEBUI_NAME}
					</div>
				</a>
				<Tooltip
					content={$showSidebar ? $i18n.t('Close Sidebar') : $i18n.t('Open Sidebar')}
					placement="bottom"
				>
					<button
						class="flex rounded-xl size-8.5 justify-center items-center hover:bg-gray-100/50 dark:hover:bg-gray-850/50 transition {isWindows
							? 'cursor-pointer'
							: 'cursor-[w-resize]'}"
						on:click={() => {
							showSidebar.set(!$showSidebar);
						}}
						aria-label={$showSidebar ? $i18n.t('Close Sidebar') : $i18n.t('Open Sidebar')}
					>
						<div class=" self-center p-1.5">
							<Sidebar />
						</div>
					</button>
				</Tooltip>

				<div
					class="{scrollTop > 0
						? 'visible'
						: 'invisible'} sidebar-bg-gradient-to-b bg-linear-to-b from-[rgba(195,203,216,0.98)] dark:from-gray-950 to-transparent from-50% pointer-events-none absolute inset-0 -z-10 -mb-6"
				></div>
			</div>

			<div
				class="relative flex flex-col flex-1 overflow-y-auto scrollbar-hidden pt-3 pb-3"
				on:scroll={(e) => {
					if (e.target.scrollTop === 0) {
						scrollTop = 0;
					} else {
						scrollTop = e.target.scrollTop;
					}
				}}
			>
				<div class="pb-1.5">
					<div class="px-[0.4375rem] flex justify-center text-gray-800 dark:text-gray-200">
						<a
							id="sidebar-new-chat-button"
							class="group grow flex items-center space-x-3 rounded-2xl px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-900 transition outline-none"
							href="/"
							draggable="false"
							on:click={newChatHandler}
							aria-label={$i18n.t('New Chat')}
						>
							<div class="self-center">
								<PencilSquare className=" size-4.5" strokeWidth="2" />
							</div>

							<div class="flex flex-1 self-center translate-y-[0.5px]">
								<div class=" self-center text-sm font-primary">{$i18n.t('New Chat')}</div>
							</div>

							<HotkeyHint
								name="newChat"
								className="sidebar-hotkey-hint group-hover:visible group-focus-visible:visible invisible"
							/>
						</a>
					</div>

					<div class="px-[0.4375rem] flex justify-center text-gray-800 dark:text-gray-200">
						<button
							id="sidebar-search-button"
							class="group grow flex items-center space-x-3 rounded-2xl px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-900 transition outline-none"
							on:click={() => {
								showSearch.set(true);
							}}
							draggable="false"
							aria-label={$i18n.t('Search')}
						>
							<div class="self-center">
								<Search strokeWidth="2" className="size-4.5" />
							</div>

							<div class="flex flex-1 self-center translate-y-[0.5px]">
								<div class=" self-center text-sm font-primary">{$i18n.t('Search')}</div>
							</div>
							<HotkeyHint
								name="search"
								className="sidebar-hotkey-hint group-hover:visible group-focus-visible:visible invisible"
							/>
						</button>
					</div>

			<div class="px-[0.4375rem] flex justify-center text-gray-800 dark:text-gray-200">
				<a
					id="sidebar-scheduled-tasks-button"
					class="group grow flex items-center space-x-3 rounded-2xl px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-900 transition outline-none"
					href="/scheduled-tasks"
					on:click={itemClickHandler}
					draggable="false"
					aria-label={$i18n.t('Scheduled Tasks')}
				>
					<div class="self-center">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							fill="none"
							viewBox="0 0 24 24"
							stroke-width="2"
							stroke="currentColor"
							class="size-4.5"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M12 6v6l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
							/>
						</svg>
					</div>

					<div class="flex flex-1 self-center translate-y-[0.5px]">
						<div class=" self-center text-sm font-primary">{$i18n.t('Scheduled Tasks')}</div>
					</div>
				</a>
			</div>

					{#if $user?.role === 'admin' || $user?.permissions?.workspace?.prompts}
						<div class="px-[0.4375rem] flex justify-center text-gray-800 dark:text-gray-200">
							<a
								id="sidebar-workspace-button"
								class="grow flex items-center space-x-3 rounded-2xl px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-900 transition"
								href="/workspace/prompts"
								on:click={itemClickHandler}
								draggable="false"
								aria-label={$i18n.t('Prompts')}
							>
								<div class="self-center">
									<svg
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
										stroke-width="2"
										stroke="currentColor"
										class="size-4.5"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z"
										/>
									</svg>
								</div>

								<div class="flex self-center translate-y-[0.5px]">
									<div class=" self-center text-sm font-primary">{$i18n.t('Prompts')}</div>
								</div>
							</a>
						</div>
					{/if}
				</div>

				{#if ($models ?? []).length > 0 && (($settings?.pinnedModels ?? []).length > 0 || $config?.default_pinned_models)}
					<Folder
						id="sidebar-models"
						bind:open={showPinnedModels}
						className="px-2 mt-0.5"
						name={$i18n.t('Models')}
						chevron={false}
						dragAndDrop={false}
					>
						<PinnedModelList bind:selectedChatId {shiftKey} />
					</Folder>
				{/if}

				{#if $config?.features?.enable_channels && ($user?.role === 'admin' || ($user?.permissions?.features?.channels ?? true))}
					<Folder
						id="sidebar-channels"
						bind:open={showChannels}
						className="px-2 mt-0.5"
						name={$i18n.t('Channels')}
						chevron={false}
						dragAndDrop={false}
						onAdd={$user?.role === 'admin' || ($user?.permissions?.features?.channels ?? true)
							? async () => {
									await tick();

									setTimeout(() => {
										showCreateChannel = true;
									}, 0);
								}
							: null}
						onAddLabel={$i18n.t('Create Channel')}
					>
						{#each $channels as channel, channelIdx (`${channel?.id}`)}
							<ChannelItem
								{channel}
								onUpdate={async () => {
									await initChannels();
								}}
							/>

							{#if channelIdx < $channels.length - 1 && channel.type !== $channels[channelIdx + 1]?.type}<hr
									class=" border-gray-100/40 dark:border-gray-800/10 my-1.5 w-full"
								/>
							{/if}
						{/each}
					</Folder>
				{/if}

				{#if $config?.features?.enable_folders && ($user?.role === 'admin' || ($user?.permissions?.features?.folders ?? true))}
					<Folder
						id="sidebar-folders"
						bind:open={showFolders}
						className="px-2 mt-0.5"
						name={$i18n.t('Folders')}
						chevron={false}
						onAdd={() => {
							showCreateFolderModal = true;
						}}
						onAddLabel={$i18n.t('New Folder')}
						on:drop={async (e) => {
							const { type, id, item } = e.detail;

							if (type === 'folder') {
								if (folders[id].parent_id === null) {
									return;
								}

								const res = await updateFolderParentIdById(localStorage.token, id, null).catch(
									(error) => {
										toast.error(`${error}`);
										return null;
									}
								);

								if (res) {
									await initFolders();
								}
							}
						}}
					>
						<Folders
							bind:folderRegistry
							{folders}
							{shiftKey}
							onDelete={(folderId) => {
								selectedFolder.set(null);
								initChatList();
							}}
							on:update={() => {
								initChatList();
							}}
							on:import={(e) => {
								const { folderId, items } = e.detail;
								importChatHandler(items, false, folderId);
							}}
							on:change={async () => {
								initChatList();
							}}
						/>
					</Folder>
				{/if}

				<Folder
					id="sidebar-chats"
					className="px-2 mt-0.5"
					name={$i18n.t('Chats')}
					chevron={false}
					on:change={async (e) => {
						selectedFolder.set(null);
					}}
					on:import={(e) => {
						importChatHandler(e.detail);
					}}
					on:drop={async (e) => {
						const { type, id, item } = e.detail;

						if (type === 'chat') {
							let chat = await getChatById(localStorage.token, id).catch((error) => {
								return null;
							});
							if (!chat && item) {
								chat = await importChats(localStorage.token, [
									{
										chat: item.chat,
										meta: item?.meta ?? {},
										pinned: false,
										folder_id: null,
										created_at: item?.created_at ?? null,
										updated_at: item?.updated_at ?? null
									}
								]);
							}

							if (chat) {
								console.log(chat);
								if (chat.folder_id) {
									const res = await updateChatFolderIdById(localStorage.token, chat.id, null).catch(
										(error) => {
											toast.error(`${error}`);
											return null;
										}
									);

									folderRegistry[chat.folder_id]?.setFolderItems();
								}

								if (chat.pinned) {
									const res = await toggleChatPinnedStatusById(localStorage.token, chat.id);
								}

								initChatList();
							}
						} else if (type === 'folder') {
							if (folders[id].parent_id === null) {
								return;
							}

							const res = await updateFolderParentIdById(localStorage.token, id, null).catch(
								(error) => {
									toast.error(`${error}`);
									return null;
								}
							);

							if (res) {
								await initFolders();
							}
						}
					}}
				>
					{#if $pinnedChats.length > 0}
						<div class="mb-1">
							<div class="flex flex-col space-y-1 rounded-xl">
								<Folder
									id="sidebar-pinned-chats"
									buttonClassName=" text-gray-500"
									on:import={(e) => {
										importChatHandler(e.detail, true);
									}}
									on:drop={async (e) => {
										const { type, id, item } = e.detail;

										if (type === 'chat') {
											let chat = await getChatById(localStorage.token, id).catch((error) => {
												return null;
											});
											if (!chat && item) {
												chat = await importChats(localStorage.token, [
													{
														chat: item.chat,
														meta: item?.meta ?? {},
														pinned: false,
														folder_id: null,
														created_at: item?.created_at ?? null,
														updated_at: item?.updated_at ?? null
													}
												]);
											}

											if (chat) {
												console.log(chat);
												if (chat.folder_id) {
													const res = await updateChatFolderIdById(
														localStorage.token,
														chat.id,
														null
													).catch((error) => {
														toast.error(`${error}`);
														return null;
													});
												}

												if (!chat.pinned) {
													const res = await toggleChatPinnedStatusById(localStorage.token, chat.id);
												}

												initChatList();
											}
										}
									}}
									name={$i18n.t('Pinned')}
								>
									<div
										class="ml-3 pl-1 mt-[1px] flex flex-col overflow-y-auto scrollbar-hidden border-s border-gray-100 dark:border-gray-900 text-gray-900 dark:text-gray-200"
									>
										{#each $pinnedChats as chat, idx (`pinned-chat-${chat?.id ?? idx}`)}
											<ChatItem
												className=""
												id={chat.id}
												title={chat.title}
												modelId={resolveSidebarChatModelId(chat)}
												{shiftKey}
												selected={selectedChatId === chat.id}
												on:select={() => {
													selectedChatId = chat.id;
												}}
												on:unselect={() => {
													selectedChatId = null;
												}}
												on:change={async () => {
													initChatList();
												}}
												on:tag={(e) => {
													const { type, name } = e.detail;
													tagEventHandler(type, name, chat.id);
												}}
											/>
										{/each}
									</div>
								</Folder>
							</div>
						</div>
					{/if}

					<div class=" flex-1 flex flex-col overflow-y-auto scrollbar-hidden">
						<div class="pt-1.5">
							{#if $chats}
								{#each $chats as chat, idx (`chat-${chat?.id ?? idx}`)}
									{#if idx === 0 || (idx > 0 && chat.time_range !== $chats[idx - 1].time_range)}
										<div
											class="w-full pl-2.5 text-xs text-gray-500 dark:text-gray-500 font-medium {idx ===
											0
												? ''
												: 'pt-5'} pb-1.5"
										>
											{$i18n.t(chat.time_range)}
											<!-- localisation keys for time_range to be recognized from the i18next parser (so they don't get automatically removed):
							{$i18n.t('Today')}
							{$i18n.t('Yesterday')}
							{$i18n.t('Previous 7 days')}
							{$i18n.t('Previous 30 days')}
							{$i18n.t('January')}
							{$i18n.t('February')}
							{$i18n.t('March')}
							{$i18n.t('April')}
							{$i18n.t('May')}
							{$i18n.t('June')}
							{$i18n.t('July')}
							{$i18n.t('August')}
							{$i18n.t('September')}
							{$i18n.t('October')}
							{$i18n.t('November')}
							{$i18n.t('December')}
							-->
										</div>
									{/if}

									<ChatItem
										className=""
										id={chat.id}
										title={chat.title}
										modelId={resolveSidebarChatModelId(chat)}
										{shiftKey}
										selected={selectedChatId === chat.id}
										on:select={() => {
											selectedChatId = chat.id;
										}}
										on:unselect={() => {
											selectedChatId = null;
										}}
										on:change={async () => {
											initChatList();
										}}
										on:tag={(e) => {
											const { type, name } = e.detail;
											tagEventHandler(type, name, chat.id);
										}}
									/>
								{/each}

								{#if $scrollPaginationEnabled && !$chatListPaginationState.exhausted}
									<Loader
										on:visible={(e) => {
											if (
												!$chatListPaginationState.loadingInitial &&
												!$chatListPaginationState.loadingMore
											) {
												loadMoreChats();
											}
										}}
									>
										<div
											class="w-full flex justify-center py-1 text-xs animate-pulse items-center gap-2"
										>
											<Spinner className=" size-4" />
											<div class=" ">{$i18n.t('Loading...')}</div>
										</div>
									</Loader>
								{/if}
							{:else}
								<div
									class="w-full flex justify-center py-1 text-xs animate-pulse items-center gap-2"
								>
									<Spinner className=" size-4" />
									<div class=" ">{$i18n.t('Loading...')}</div>
								</div>
							{/if}
						</div>
					</div>
				</Folder>
			</div>

			<div class="px-[0.5625rem] pb-[calc(env(safe-area-inset-bottom,0px)+0.625rem)] pt-2 border-t border-gray-100/60 dark:border-gray-850/40">
				<button
					id="sidebar-expanded-settings-button"
					type="button"
					class="w-full flex items-center gap-3 rounded-2xl px-2.5 py-2.5 hover:bg-gray-100/60 dark:hover:bg-gray-900/70 transition no-drag-region text-left"
					on:click={() => {
						showSettings.set(true);
					}}
				>
					<div class="self-center shrink-0 text-gray-700 dark:text-gray-300">
						<Settings className="size-5" strokeWidth="1.5" />
					</div>

					<div class="min-w-0 flex-1">
						<div class="truncate font-primary text-[15px] text-gray-900 dark:text-white">
							{$i18n.t('Settings')}
						</div>
					</div>
				</button>
			</div>

		</div>
	</div>

	{#if !$mobile}
		<div
			class="fixed top-0 left-[var(--sidebar-width)] z-[70] h-[100dvh] w-3.5 -translate-x-1/2 cursor-col-resize bg-transparent"
			id="sidebar-resizer"
			on:mousedown={resizeStartHandler}
			role="separator"
			aria-orientation="vertical"
			aria-label={$i18n.t('Resize Sidebar')}
		></div>
	{/if}
{/if}
