<!-- PORTICO_PATCH_v1: Inline MCP tool images at bottom of message -->
<script lang="ts">
	import { toast } from 'svelte-sonner';
	import dayjs from 'dayjs';

	import { createEventDispatcher, onDestroy } from 'svelte';
	import { onMount, tick, getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType, t } from 'i18next';

	const i18n = getContext<Writable<i18nType>>('i18n');

	const dispatch = createEventDispatcher();

	import { createNewFeedback, getFeedbackById, updateFeedbackById } from '$lib/apis/evaluations';
	import { getChatById } from '$lib/apis/chats';
	import { generateTags } from '$lib/apis';

	import {
		audioQueue,
		config,
		models,
		settings,
		temporaryChatEnabled,
		TTSWorker,
		user
	} from '$lib/stores';
	import { mcpServerCatalog } from '$lib/stores/mcpServerIds';
	import { synthesizeOpenAISpeech } from '$lib/apis/audio';
	import { imageGenerations } from '$lib/apis/images';
	import {
		copyToClipboard as _copyToClipboard,
		approximateToHumanReadable,
		getMessageContentParts,
		sanitizeResponseContent,
		createMessagesList,
		formatDate,
		removeDetails,
		removeAllDetails
	} from '$lib/utils';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';

	import Name from './Name.svelte';
	import ProfileImage from './ProfileImage.svelte';
	import AnimatedAtlasLogo from '$lib/components/common/AnimatedAtlasLogo.svelte';
	import AnimatedTerraLogo from '$lib/components/common/AnimatedTerraLogo.svelte';
	import Skeleton from './Skeleton.svelte';
	// PORTICO_PATCH: Import ActivityIndicator for humorous loading states
	import ActivityIndicator from '$lib/components/chat/ActivityIndicator.svelte';
	import Image from '$lib/components/common/Image.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import RateComment from './RateComment.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import WebSearchResults from './ResponseMessage/WebSearchResults.svelte';
	import Sparkles from '$lib/components/icons/Sparkles.svelte';

	import DeleteConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';

	import Error from './Error.svelte';
	import Citations from './Citations.svelte';
	import ContentRenderer from './ContentRenderer.svelte';
	import { KokoroWorker } from '$lib/workers/KokoroWorker';
	import FileItem from '$lib/components/common/FileItem.svelte';
	import FollowUps from './ResponseMessage/FollowUps.svelte';
	import { fade } from 'svelte/transition';
	import { flyAndScale } from '$lib/utils/transitions';
	import RegenerateMenu from './ResponseMessage/RegenerateMenu.svelte';
	import StatusHistory from './ResponseMessage/StatusHistory.svelte';
	import WorkActivitySummary from './ResponseMessage/WorkActivitySummary.svelte';
	import UserQuestionAnswerCard from './ResponseMessage/UserQuestionAnswerCard.svelte';
	import DisplayFilesInline from './Markdown/DisplayFilesInline.svelte';
	import FullHeightIframe from '$lib/components/common/FullHeightIframe.svelte';
	// PORTICO PATCH (N-012): tool-confirmation cards no longer render inline
	// inside the assistant message — they appear as chips in the chat input
	// frame (see MessageInput/ToolConfirmationChip.svelte). Only the rejection
	// notice still anchors here as a post-mortem record.
	import {
		getModelLogoSources,
		resolveBaseModelRecord,
		usesCelestialModelLogo,
		usesDarkLogoBadgeInLightMode
	} from '$lib/utils/modelBranding';
	import {
		getAtlasModelLogoMotionTier,
		getStreamingModelLogoMotionKind,
		getStreamingModelLogoMotionStyle
	} from '$lib/utils/modelLogoMotion';
	import { partitionStatusHistory } from '$lib/utils/chatStatusHistory';
	import { extractUserQuestionAnswerRecords, segmentWorkActivity } from '$lib/utils/work-activity-summary.mjs';

	interface MessageType {
		id: string;
		model: string;
		content: string;
		files?: { type?: string; url?: string; content?: string; content_type?: string }[];
		contentBlocks?: any[];
		timestamp: number;
		streamStartedAt?: number;
		role: string;
		statusHistory?: {
			done: boolean;
			action: string;
			description: string;
			error?: boolean;
			hidden?: boolean;
			observed_at?: number | string;
			queries?: string[];
			status_key?: string;
			urls?: string[];
			query?: string;
		}[];
		status?: {
			done: boolean;
			action: string;
			description: string;
			error?: boolean;
			hidden?: boolean;
			observed_at?: number | string;
			queries?: string[];
			status_key?: string;
			urls?: string[];
			query?: string;
		};
		done: boolean;
		error?: boolean | { content: string };
		sources?: string[];
		info?: {
			openai?: boolean;
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
			eval_count?: number;
			eval_duration?: number;
			prompt_eval_count?: number;
			prompt_eval_duration?: number;
			total_duration?: number;
			load_duration?: number;
			usage?: unknown;
		};
		annotation?: { type: string; rating: number };
	}

	export let chatId = '';
	export let history;
	export let messageId;
	export let selectedModels = [];
	export let richContentReady = true;

	// Avoid deep clone + stringify on every stream tick; that becomes O(n) with large messages.
	let message: MessageType =
		(history?.messages?.[messageId] as MessageType) ??
		({
			id: messageId,
			model: '',
			content: '',
			timestamp: 0,
			role: 'assistant',
			done: false
		} as MessageType);
	$: {
		const nextMessage = history?.messages?.[messageId] as MessageType | undefined;
		if (nextMessage) {
			message = nextMessage;
		}
	}
	$: statusHistoryPartitions = partitionStatusHistory(message?.statusHistory);
	$: userQuestionAnswerRecords = extractUserQuestionAnswerRecords(message?.contentBlocks ?? []);
	$: workActivitySegments = segmentWorkActivity(
		message?.content ?? '',
		message?.done ?? false,
		userQuestionAnswerRecords,
		$mcpServerCatalog
	);
	let expandedWorkActivityGroups: Record<string, boolean> = {};
	let mountedWorkActivityGroups: Record<string, boolean> = {};
	let workActivityMountFrames: Record<string, number> = {};

	const setWorkActivityGroupExpanded = (groupId: string, expanded: boolean) => {
		expandedWorkActivityGroups = { ...expandedWorkActivityGroups, [groupId]: expanded };
		const pendingFrame = workActivityMountFrames[groupId];
		if (pendingFrame !== undefined) {
			window.cancelAnimationFrame(pendingFrame);
			delete workActivityMountFrames[groupId];
		}
		if (!expanded) {
			mountedWorkActivityGroups = { ...mountedWorkActivityGroups, [groupId]: false };
			return;
		}

		// Paint the expanded summary state first, then construct the expensive
		// markdown/tool detail renderer on the following frame.
		workActivityMountFrames[groupId] = window.requestAnimationFrame(() => {
			workActivityMountFrames[groupId] = window.requestAnimationFrame(() => {
				delete workActivityMountFrames[groupId];
				if (expandedWorkActivityGroups[groupId]) {
					mountedWorkActivityGroups = { ...mountedWorkActivityGroups, [groupId]: true };
				}
			});
		});
	};

	export let siblings;

	export let setInputText: Function = () => {};
	export let gotoMessage: Function = () => {};
	export let showPreviousMessage: Function;
	export let showNextMessage: Function;

	export let updateChat: Function;
	export let editMessage: Function;
	export let saveMessage: Function;
	export let rateMessage: Function;
	export let actionMessage: Function;
	export let deleteMessage: Function;

	export let submitMessage: Function;
	export let continueResponse: Function;
	export let regenerateResponse: Function;
	export let stopResponse: Function = () => {};
	// PORTICO PATCH (fork-chat): fork the conversation at this message into a new chat
	export let forkChat: Function | null = null;
	let forkingChat = false;

	export let addMessages: Function;
	export let debugMarkersAfterToolBlockIndex: Record<number, any[]> = {};
	export let openDebugRequestModal: (requestId: string) => void = () => {};

	export let isLastMessage = true;
	export let readOnly = false;

	const getAssistantModelLogoSources = (candidate: Record<string, any> | null | undefined) =>
		getModelLogoSources(
			candidate,
			WEBUI_API_BASE_URL,
			$i18n?.language || 'en',
			`${WEBUI_BASE_URL}/static/favicon.png`
		);
	export let editCodeBlock = true;
	export let topPadding = false;

	let citationsElement: HTMLDivElement;

	let contentContainerElement: HTMLDivElement;
	let buttonsContainerElement: HTMLDivElement;
	let showDeleteConfirm = false;

	let model = null;
	$: model = $models.find((m) => m.id === message.model);
	// When the message is from an agent (a derived model), show its BASE model's
	// animated logo — not the agent's own (empty) profile image → generic favicon.
	$: logoModel = resolveBaseModelRecord(model, $models);
	$: assistantModelMotionCandidate = logoModel ?? { id: message.model };
	$: assistantModelMotionKind = getStreamingModelLogoMotionKind(assistantModelMotionCandidate);
	$: assistantModelAtlasTier = getAtlasModelLogoMotionTier(assistantModelMotionCandidate);
	$: assistantModelMotionStyle = getStreamingModelLogoMotionStyle(
		message.id,
		assistantModelMotionKind,
		assistantModelMotionCandidate
	);
	$: assistantModelLogoIsStreaming = !message.done && !message.error;
	let assistantModelLogoSources = getAssistantModelLogoSources(null);
	$: assistantModelLogoSources = getModelLogoSources(
		logoModel,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);

	let edit = false;
	let editedContent = '';
	let editTextAreaElement: HTMLTextAreaElement;

	let messageIndexEdit = false;

	let speaking = false;
	let speakingIdx: number | undefined;

	let loadingSpeech = false;
	let generatingImage = false;

	let showRateComment = false;

	// PORTICO_PATCH: With the incremental markdown renderer (patched Markdown.svelte),
	// the plain-text streaming threshold is no longer needed.  The incremental
	// renderer achieves O(delta) per commit for both lexing and DOM updates, so
	// markdown renders during streaming without growing cost.
	//
	// The manual disable toggle is kept for A/B debugging.
	let markdownRendererDisabled = false;

	const resolveMarkdownRendererDisabled = (): boolean => {
		if (typeof window === 'undefined') return false;

		const rawValue = localStorage.getItem('disable_markdown_renderer');
		if (!rawValue) return false;

		const normalized = rawValue.trim().toLowerCase();
		return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
	};

	const copyToClipboard = async (text) => {
		text = removeAllDetails(text);

		if (($config?.ui?.response_watermark ?? '').trim() !== '') {
			text = `${text}\n\n${$config?.ui?.response_watermark}`;
		}

		const res = await _copyToClipboard(text, null, $settings?.copyFormatted ?? false);
		if (res) {
			toast.success($i18n.t('Copying to clipboard was successful!'));
		}
	};

	$: usePlainTextRenderer = markdownRendererDisabled;

	const stopAudio = () => {
		try {
			speechSynthesis.cancel();
			$audioQueue.stop();
		} catch {}

		if (speaking) {
			speaking = false;
			speakingIdx = undefined;
		}
	};

	const speak = async () => {
		if (!(message?.content ?? '').trim().length) {
			toast.info($i18n.t('No content to speak'));
			return;
		}

		speaking = true;
		const content = removeAllDetails(message.content);

		if ($config.audio.tts.engine === '') {
			let voices = [];
			const getVoicesLoop = setInterval(() => {
				voices = speechSynthesis.getVoices();
				if (voices.length > 0) {
					clearInterval(getVoicesLoop);

					const voice =
						voices
							?.filter(
								(v) => v.voiceURI === ($settings?.audio?.tts?.voice ?? $config?.audio?.tts?.voice)
							)
							?.at(0) ?? undefined;

					console.log(voice);

					const speech = new SpeechSynthesisUtterance(content);
					speech.rate = $settings.audio?.tts?.playbackRate ?? 1;

					console.log(speech);

					speech.onend = () => {
						speaking = false;
						if ($settings.conversationMode) {
							document.getElementById('voice-input-button')?.click();
						}
					};

					if (voice) {
						speech.voice = voice;
					}

					speechSynthesis.speak(speech);
				}
			}, 100);
		} else {
			$audioQueue.setId(`${message.id}`);
			$audioQueue.setPlaybackRate($settings.audio?.tts?.playbackRate ?? 1);
			$audioQueue.onStopped = () => {
				speaking = false;
				speakingIdx = undefined;
			};

			loadingSpeech = true;
			const messageContentParts: string[] = getMessageContentParts(
				content,
				$config?.audio?.tts?.split_on ?? 'punctuation'
			);

			if (!messageContentParts.length) {
				console.log('No content to speak');
				toast.info($i18n.t('No content to speak'));

				speaking = false;
				loadingSpeech = false;
				return;
			}

			console.debug('Prepared message content for TTS', messageContentParts);
			if ($settings.audio?.tts?.engine === 'browser-kokoro') {
				if (!$TTSWorker) {
					await TTSWorker.set(
						new KokoroWorker({
							dtype: $settings.audio?.tts?.engineConfig?.dtype ?? 'fp32'
						})
					);

					await $TTSWorker.init();
				}

				for (const [idx, sentence] of messageContentParts.entries()) {
					const url = await $TTSWorker
						.generate({
							text: sentence,
							voice: $settings?.audio?.tts?.voice ?? $config?.audio?.tts?.voice
						})
						.catch((error) => {
							console.error(error);
							toast.error(`${error}`);

							speaking = false;
							loadingSpeech = false;
						});

					if (url && speaking) {
						$audioQueue.enqueue(url);
						loadingSpeech = false;
					}
				}
			} else {
				for (const [idx, sentence] of messageContentParts.entries()) {
					const res = await synthesizeOpenAISpeech(
						localStorage.token,
						$settings?.audio?.tts?.defaultVoice === $config.audio.tts.voice
							? ($settings?.audio?.tts?.voice ?? $config?.audio?.tts?.voice)
							: $config?.audio?.tts?.voice,
						sentence
					).catch((error) => {
						console.error(error);
						toast.error(`${error}`);

						speaking = false;
						loadingSpeech = false;
					});

					if (res && speaking) {
						const blob = await res.blob();
						const url = URL.createObjectURL(blob);

						$audioQueue.enqueue(url);
						loadingSpeech = false;
					}
				}
			}
		}
	};

	let preprocessedDetailsCache = [];

	function preprocessForEditing(content: string): string {
		// Replace <details>...</details> with unique ID placeholder
		const detailsBlocks = [];
		let i = 0;

		content = content.replace(/<details[\s\S]*?<\/details>/gi, (match) => {
			detailsBlocks.push(match);
			return `<details id="__DETAIL_${i++}__"/>`;
		});

		// Store original blocks in the editedContent or globally (see merging later)
		preprocessedDetailsCache = detailsBlocks;

		return content;
	}

	function postprocessAfterEditing(content: string): string {
		const restoredContent = content.replace(
			/<details id="__DETAIL_(\d+)__"\/>/g,
			(_, index) => preprocessedDetailsCache[parseInt(index)] || ''
		);

		return restoredContent;
	}

	const editMessageHandler = async () => {
		edit = true;

		editedContent = preprocessForEditing(message.content);

		await tick();

		editTextAreaElement.style.height = '';
		editTextAreaElement.style.height = `${editTextAreaElement.scrollHeight}px`;
	};

	const editMessageConfirmHandler = async () => {
		const messageContent = postprocessAfterEditing(editedContent ? editedContent : '');
		editMessage(message.id, { content: messageContent }, false);

		edit = false;
		editedContent = '';

		await tick();
	};

	const saveAsCopyHandler = async () => {
		const messageContent = postprocessAfterEditing(editedContent ? editedContent : '');

		editMessage(message.id, { content: messageContent });

		edit = false;
		editedContent = '';

		await tick();
	};

	const cancelEditMessage = async () => {
		edit = false;
		editedContent = '';
		await tick();
	};

	const generateImage = async (message: MessageType) => {
		generatingImage = true;
		const res = await imageGenerations(localStorage.token, message.content).catch((error) => {
			toast.error(`${error}`);
		});
		console.log(res);

		if (res) {
			const files = res.map((image) => ({
				type: 'image',
				url: `${image.url}`
			}));

			saveMessage(message.id, {
				...message,
				files: files
			});
		}

		generatingImage = false;
	};

	let feedbackLoading = false;

	const feedbackHandler = async (rating: number | null = null, details: object | null = null) => {
		feedbackLoading = true;
		console.log('Feedback', rating, details);

		const updatedMessage = {
			...message,
			annotation: {
				...(message?.annotation ?? {}),
				...(rating !== null ? { rating: rating } : {}),
				...(details ? details : {})
			}
		};

		const chat = await getChatById(localStorage.token, chatId).catch((error) => {
			toast.error(`${error}`);
		});
		if (!chat) {
			return;
		}

		const messages = createMessagesList(history, message.id);

		let feedbackItem = {
			type: 'rating',
			data: {
				...(updatedMessage?.annotation ? updatedMessage.annotation : {}),
				model_id: message?.selectedModelId ?? message.model,
				...(history.messages[message.parentId].childrenIds.length > 1
					? {
							sibling_model_ids: history.messages[message.parentId].childrenIds
								.filter((id) => id !== message.id)
								.map((id) => history.messages[id]?.selectedModelId ?? history.messages[id].model)
						}
					: {})
			},
			meta: {
				arena: message ? message.arena : false,
				model_id: message.model,
				message_id: message.id,
				message_index: messages.length,
				chat_id: chatId
			},
			snapshot: {
				chat: chat
			}
		};

		const baseModels = [
			feedbackItem.data.model_id,
			...(feedbackItem.data.sibling_model_ids ?? [])
		].reduce((acc, modelId) => {
			const model = $models.find((m) => m.id === modelId);
			if (model) {
				acc[model.id] = model?.info?.base_model_id ?? null;
			} else {
				// Log or handle cases where corresponding model is not found
				console.warn(`Model with ID ${modelId} not found`);
			}
			return acc;
		}, {});
		feedbackItem.meta.base_models = baseModels;

		let feedback = null;
		if (message?.feedbackId) {
			feedback = await updateFeedbackById(
				localStorage.token,
				message.feedbackId,
				feedbackItem
			).catch((error) => {
				toast.error(`${error}`);
			});
		} else {
			feedback = await createNewFeedback(localStorage.token, feedbackItem).catch((error) => {
				toast.error(`${error}`);
			});

			if (feedback) {
				updatedMessage.feedbackId = feedback.id;
			}
		}

		console.log(updatedMessage);
		saveMessage(message.id, updatedMessage);

		await tick();

		if (!details) {
			showRateComment = true;

			if (!updatedMessage.annotation?.tags && (message?.content ?? '') !== '') {
				// attempt to generate tags
				const tags = await generateTags(localStorage.token, message.model, messages, chatId).catch(
					(error) => {
						console.error(error);
						return [];
					}
				);
				console.log(tags);

				if (tags) {
					updatedMessage.annotation.tags = tags;
					feedbackItem.data.tags = tags;

					saveMessage(message.id, updatedMessage);
					await updateFeedbackById(
						localStorage.token,
						updatedMessage.feedbackId,
						feedbackItem
					).catch((error) => {
						toast.error(`${error}`);
					});
				}
			}
		}

		feedbackLoading = false;
	};

	const deleteMessageHandler = async () => {
		deleteMessage(message.id);
	};

	$: if (!edit) {
		(async () => {
			await tick();
		})();
	}

	const buttonsWheelHandler = (event: WheelEvent) => {
		if (buttonsContainerElement) {
			if (buttonsContainerElement.scrollWidth <= buttonsContainerElement.clientWidth) {
				// If the container is not scrollable, horizontal scroll
				return;
			} else {
				event.preventDefault();

				if (event.deltaY !== 0) {
					// Adjust horizontal scroll position based on vertical scroll
					buttonsContainerElement.scrollLeft += event.deltaY;
				}
			}
		}
	};

	const contentCopyHandler = (e) => {
		if (contentContainerElement) {
			e.preventDefault();
			// Get the selected HTML
			const selection = window.getSelection();
			const range = selection.getRangeAt(0);
			const tempDiv = document.createElement('div');

			// Remove background, color, and font styles
			tempDiv.appendChild(range.cloneContents());

			tempDiv.querySelectorAll('table').forEach((table) => {
				table.style.borderCollapse = 'collapse';
				table.style.width = 'auto';
				table.style.tableLayout = 'auto';
			});

			tempDiv.querySelectorAll('th').forEach((th) => {
				th.style.whiteSpace = 'nowrap';
				th.style.padding = '4px 8px';
			});

			// Put cleaned HTML + plain text into clipboard
			e.clipboardData.setData('text/html', tempDiv.innerHTML);
			e.clipboardData.setData('text/plain', selection.toString());
		}
	};

	onMount(async () => {
		// console.log('ResponseMessage mounted');
		markdownRendererDisabled = resolveMarkdownRendererDisabled();

		await tick();
		if (buttonsContainerElement) {
			buttonsContainerElement.addEventListener('wheel', buttonsWheelHandler);
		}

		if (contentContainerElement) {
			contentContainerElement.addEventListener('copy', contentCopyHandler);
		}
	});

	onDestroy(() => {
		for (const frameId of Object.values(workActivityMountFrames)) {
			window.cancelAnimationFrame(frameId);
		}
		workActivityMountFrames = {};
		if (buttonsContainerElement) {
			buttonsContainerElement.removeEventListener('wheel', buttonsWheelHandler);
		}

		if (contentContainerElement) {
			contentContainerElement.removeEventListener('copy', contentCopyHandler);
		}
	});

	// PORTICO_PATCH: Helper function to check if a file is a displayable image
	function isDisplayableImage(file: any): boolean {
		if (typeof file === 'string') {
			return file.startsWith('data:image/');
		}
		if (typeof file === 'object' && file !== null) {
			// Check various image formats from MCP tools
			if (file.type === 'image' && file.url) return true;
			if (file.type === 'data' && file.content?.startsWith('data:image/')) return true;
			if (file?.content_type?.startsWith('image/')) return true;
		}
		return false;
	}

	// PORTICO_PATCH: Helper function to get the image source URL
	function getImageSrc(file: any): string {
		if (typeof file === 'string') return file;
		if (file.type === 'image' && file.url) return file.url;
		if (file.type === 'data' && file.content) return file.content;
		if (file.url) return file.url;
		return '';
	}

	function normalizeImageUrlPath(url: string): string {
		const raw = String(url || '').trim();
		if (!raw) return '';
		try {
			const parsed = new URL(raw, 'http://localhost');
			return `${parsed.pathname}${parsed.search}`;
		} catch (_error) {
			const match = raw.match(/\/workspace\/[^#\s)]+/);
			return match?.[0] ?? raw;
		}
	}

	function imageDedupeIdentityFromSrc(src: string): string {
		const raw = String(src || '').trim();
		if (!raw) return '';
		if (raw.startsWith('data:image/')) {
			return `data:${raw}`;
		}
		return `url:${normalizeImageUrlPath(raw)}`;
	}

	function imageDedupeIdentity(file: any): string {
		return imageDedupeIdentityFromSrc(getImageSrc(file));
	}

	function hashString(value: string): string {
		let hash = 0;
		for (let index = 0; index < value.length; index += 1) {
			hash = (hash * 31 + value.charCodeAt(index)) | 0;
		}
		return `${value.length}:${hash >>> 0}`;
	}

	function getImageRenderKey(file: any, index: number): string {
		const identity = imageDedupeIdentity(file);
		if (!identity) return `image:${index}`;
		if (identity.startsWith('data:')) {
			return `data:${hashString(identity)}`;
		}
		return identity;
	}

	function getWorkspaceMarkdownImagePaths(content: string, currentChatId: string): Set<string> {
		const paths = new Set<string>();
		const normalizedChatId = String(currentChatId || '').trim();
		if (!normalizedChatId || !content) return paths;

		const markdownImagePattern = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
		let match: RegExpExecArray | null;
		while ((match = markdownImagePattern.exec(content)) !== null) {
			const path = normalizeImageUrlPath(match[1]);
			if (path.includes(`/workspace/${encodeURIComponent(normalizedChatId)}/`) || path.includes(`/workspace/${normalizedChatId}/`)) {
				paths.add(imageDedupeIdentityFromSrc(match[1]));
			}
		}
		return paths;
	}

	function shouldSuppressInlineImageFile(file: any, markdownImagePaths: Set<string>): boolean {
		if (markdownImagePaths.size === 0) return false;
		const identity = imageDedupeIdentity(file);
		return Boolean(identity && markdownImagePaths.has(identity));
	}

	function getToolResultImageFilesFromContentBlocks(contentBlocks: any[] | undefined): any[] {
		if (!Array.isArray(contentBlocks)) return [];
		const files: any[] = [];
		for (const block of contentBlocks) {
			if (!block || typeof block !== 'object' || block.type !== 'tool_calls') continue;
			const results = Array.isArray(block.results) ? block.results : [];
			for (const result of results) {
				if (!result || typeof result !== 'object' || !Array.isArray(result.files)) continue;
				files.push(...result.files);
			}
		}
		return files;
	}

	function mergeDistinctDisplayableImageFiles(files: any[]): any[] {
		const merged: any[] = [];
		const seen = new Set<string>();
		for (const file of files) {
			if (!isDisplayableImage(file)) continue;
			const identity = imageDedupeIdentity(file);
			if (!identity || seen.has(identity)) continue;
			seen.add(identity);
			merged.push(file);
		}
		return merged;
	}

	function getVisibleInlineImageFiles(_message: MessageType): any[] {
		// Tool-result files render only at the explicit tool-call location.
		// Keeping this bottom gallery empty prevents generated previews from stacking
		// at the end of an assistant message.
		return [];
	}

	let imageFiles: any[] = [];
	$: imageFiles = getVisibleInlineImageFiles(message);
</script>

<DeleteConfirmDialog
	bind:show={showDeleteConfirm}
	title={$i18n.t('Delete message?')}
	on:confirm={() => {
		deleteMessageHandler();
	}}
/>

{#key message.id}
	<div
		class=" flex w-full message-{message.id}"
		id="message-{message.id}"
		dir={$settings.chatDirection}
	>
		<div class={`shrink-0 ltr:mr-3 rtl:ml-3 hidden @lg:flex mt-1 `}>
			<div
				class={`assistant-model-logo-motion assistant-model-logo-motion--${assistantModelMotionKind} ${assistantModelLogoIsStreaming ? 'is-streaming' : ''}`.trim()}
				style={assistantModelMotionStyle}
				data-model-logo-motion={assistantModelMotionKind}
				data-atlas-motion-tier={assistantModelAtlasTier}
				data-model-logo-streaming={assistantModelLogoIsStreaming ? 'true' : 'false'}
				aria-hidden="true"
			>
				<div class="assistant-model-logo-rotor">
					<div
						class={`assistant-model-logo-badge rounded-full ${usesDarkLogoBadgeInLightMode(logoModel) ? 'bg-black p-0.5 shadow-sm ring-1 ring-black/10 dark:bg-transparent dark:p-1 dark:shadow-none dark:ring-0' : 'bg-transparent p-0 dark:bg-transparent dark:p-1'} w-fit h-fit`.trim()}
					>
						{#if assistantModelMotionKind === 'atlas'}
							<AnimatedAtlasLogo
								className="size-8 assistant-message-profile-image"
								tier={assistantModelAtlasTier}
							/>
						{:else if assistantModelMotionKind === 'terra'}
							<AnimatedTerraLogo
								className="size-8 assistant-message-profile-image"
								clipId={`animated-terra-response-${`${message.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')}-clip`}
							/>
						{:else if assistantModelLogoSources.dark}
							<ProfileImage
								src={assistantModelLogoSources.light}
								className={`size-8 assistant-message-profile-image dark:hidden ${usesCelestialModelLogo(logoModel) ? 'celestial-model-logo' : ''}`.trim()}
							/>
							<ProfileImage
								src={assistantModelLogoSources.dark ?? assistantModelLogoSources.light}
								className={`hidden size-8 assistant-message-profile-image dark:block ${usesCelestialModelLogo(logoModel) ? 'celestial-model-logo' : ''}`.trim()}
							/>
						{:else}
							<ProfileImage
								src={assistantModelLogoSources.light}
								className={`size-8 assistant-message-profile-image ${usesCelestialModelLogo(logoModel) ? 'celestial-model-logo' : ''}`.trim()}
							/>
						{/if}
					</div>
				</div>
			</div>
		</div>

		<div class="flex-auto w-0 pl-1 relative">
			<Name>
				<Tooltip content={model?.name ?? message.model} placement="top-start">
					<span
						id="response-message-model-name"
						class="chat-assistant-model-name line-clamp-1 text-black dark:text-white"
					>
						{model?.name ?? message.model}
					</span>
				</Tooltip>

				{#if message.timestamp}
					<div
						class="chat-hover-timestamp self-center text-xs font-medium first-letter:capitalize ml-0.5 translate-y-[1px] {($settings?.highContrastMode ??
						false)
							? 'dark:text-gray-100 text-gray-900'
							: 'invisible group-hover:visible transition text-gray-400'}"
					>
						<Tooltip content={dayjs(message.timestamp * 1000).format('LLLL')}>
							<span class="line-clamp-1"
								>{$i18n.t(formatDate(message.timestamp * 1000), {
									LOCALIZED_TIME: dayjs(message.timestamp * 1000).format('LT'),
									LOCALIZED_DATE: dayjs(message.timestamp * 1000).format('L')
								})}</span
							>
						</Tooltip>
					</div>
				{/if}
			</Name>

			<div>
				<div class="chat-{message.role} w-full min-w-full markdown-prose">
					<div>
						{#if model?.info?.meta?.capabilities?.status_updates ?? true}
							<StatusHistory statusHistory={statusHistoryPartitions.top} />
						{/if}

						<!-- PORTICO_PATCH: Removed top-positioned image rendering - images now render at bottom -->

						{#if message?.embeds && message.embeds.length > 0}
							<div class="my-1 w-full flex overflow-x-auto gap-2 flex-wrap">
								{#each message.embeds as embed, idx}
									<div class="my-2 w-full" id={`${message.id}-embeds-${idx}`}>
										<FullHeightIframe
											src={embed}
											allowScripts={true}
											allowForms={true}
											allowSameOrigin={true}
											allowPopups={true}
										/>
									</div>
								{/each}
							</div>
						{/if}

						{#if message?.toolConfirmationRejections && message.toolConfirmationRejections.length > 0}
							<div class="my-1 w-full">
								{#each message.toolConfirmationRejections as rejection, rIdx (rIdx)}
									<div
										class="my-2 px-3 py-2 rounded-lg text-xs"
										style="background: rgba(220, 38, 38, 0.12); color: #991b1b; border: 1px solid rgba(220, 38, 38, 0.4);"
									>
										<strong>Tool call refused.</strong>
										<code>{rejection.tool_name}</code> &mdash; {rejection.reason}
									</div>
								{/each}
							</div>
						{/if}

						{#if edit === true}
							<div class="w-full bg-gray-100 dark:bg-gray-800 rounded-3xl px-5 py-3 my-2">
								<textarea
									id="message-edit-{message.id}"
									bind:this={editTextAreaElement}
									class=" bg-transparent outline-hidden w-full resize-none text-gray-900 dark:text-gray-100"
									bind:value={editedContent}
									on:input={(e) => {
										e.target.style.height = '';
										e.target.style.height = `${e.target.scrollHeight}px`;
									}}
									on:keydown={(e) => {
										if (e.key === 'Escape') {
											document.getElementById('close-edit-message-button')?.click();
										}

										const isCmdOrCtrlPressed = e.metaKey || e.ctrlKey;
										const isEnterPressed = e.key === 'Enter';

										if (isCmdOrCtrlPressed && isEnterPressed) {
											document.getElementById('confirm-edit-message-button')?.click();
										}
									}}
								/>

								<div class=" mt-2 mb-1 flex justify-between text-sm font-medium">
									<div>
										<button
											id="save-new-message-button"
											class="px-3.5 py-1.5 bg-gray-50 hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-200 transition rounded-3xl"
											on:click={() => {
												saveAsCopyHandler();
											}}
										>
											{$i18n.t('Save As Copy')}
										</button>
									</div>

									<div class="flex space-x-1.5">
										<button
											id="close-edit-message-button"
											class="px-3.5 py-1.5 bg-white dark:bg-gray-900 hover:bg-gray-100 text-gray-800 dark:text-gray-100 transition rounded-3xl"
											on:click={() => {
												cancelEditMessage();
											}}
										>
											{$i18n.t('Cancel')}
										</button>

										<button
											id="confirm-edit-message-button"
											class="px-3.5 py-1.5 bg-gray-900 dark:bg-white hover:bg-gray-850 text-gray-100 dark:text-gray-800 transition rounded-3xl"
											on:click={() => {
												editMessageConfirmHandler();
											}}
										>
											{$i18n.t('Save')}
										</button>
									</div>
								</div>
							</div>
						{/if}

						<div
							bind:this={contentContainerElement}
							class="w-full flex flex-col relative {edit ? 'hidden' : ''}"
							id="response-content-container"
						>
							{#if message.content && message.error !== true}
								<!-- always show message contents even if there's an error -->
								<!-- unless message.error === true which is legacy error handling, where the error message is stored in message.content -->
								{#if usePlainTextRenderer}
									<div
										class="w-full whitespace-pre-wrap break-words text-[15px] leading-6"
										dir="auto"
									>
										{message.content}
									</div>
								{:else}
									{#each workActivitySegments as segment, segmentIndex (segment.id)}
										{#if segment.type === 'user_question_answer'}
											<UserQuestionAnswerCard record={segment.record} />
										{:else if segment.type === 'display_files'}
											<DisplayFilesInline
												id={`${chatId}-${message.id}-${segment.id}`}
												attributes={segment.attributes}
											/>
										{:else}
											{#if segment.type === 'activity' && segment.summary?.hasActivity}
												<WorkActivitySummary
													summary={segment.summary}
													expanded={expandedWorkActivityGroups[segment.id] ?? false}
													first={segment.first}
													controlsId={`work-activity-details-${message.id}-${segment.id}`}
													on:toggle={(event) =>
														setWorkActivityGroupExpanded(segment.id, event.detail.expanded)}
												/>
											{/if}

											<div
												id={segment.type === 'activity'
													? `work-activity-details-${message.id}-${segment.id}`
													: undefined}
												class:hidden={segment.type === 'activity' &&
													!(expandedWorkActivityGroups[segment.id] ?? false)}
											>
												{#if segment.type === 'content' && !richContentReady}
													<div
														class="w-full whitespace-pre-wrap break-words text-[15px] leading-6"
														data-chat-narrative-first-paint="true"
														dir="auto"
													>
														{segment.content}
													</div>
												{:else if segment.type !== 'activity' || mountedWorkActivityGroups[segment.id]}
													<ContentRenderer
														id={`${chatId}-${message.id}-${segment.id}`}
														messageId={message.id}
														{history}
														{selectedModels}
														content={segment.content}
														sources={message.sources}
														floatingButtons={segmentIndex === workActivitySegments.length - 1 &&
															message?.done &&
															!readOnly &&
															($settings?.showFloatingActionButtons ?? true)}
														save={!readOnly}
														preview={!readOnly}
														renderDisplayFilesInline={segment.type !== 'activity'}
														{editCodeBlock}
														{topPadding}
														done={($settings?.chatFadeStreamingText ?? true)
															? (message?.done ?? false)
															: true}
														{model}
														messageStopReason={message?.stop_reason ?? null}
														{debugMarkersAfterToolBlockIndex}
														{openDebugRequestModal}
														onTaskClick={async (e) => {
															console.log(e);
														}}
														onStopResponse={() => {
															stopResponse();
														}}
														onSourceClick={async (id) => {
															console.log(id);

															if (citationsElement) {
																citationsElement?.showSourceModal(id);
															}
														}}
														onAddMessages={({ modelId, parentId, messages }) => {
															addMessages({ modelId, parentId, messages });
														}}
														onSave={({ raw, oldContent, newContent }) => {
															history.messages[message.id].content = history.messages[
																message.id
															].content.replace(raw, raw.replace(oldContent, newContent));

															updateChat();
														}}
													/>
												{:else if expandedWorkActivityGroups[segment.id]}
													<div
														class="flex items-center gap-2 py-3 text-sm text-gray-500 dark:text-gray-400"
														data-work-activity-render-state="pending"
													>
														<Spinner className="size-4" />
														<span>{$i18n.t('Loading work details…')}</span>
													</div>
												{/if}
											</div>
										{/if}
									{/each}
								{/if}
							{/if}

							{#if message?.error}
								<Error content={message?.error?.content ?? message.content} />
							{/if}

							{#if model?.info?.meta?.capabilities?.status_updates ?? true}
								<StatusHistory statusHistory={statusHistoryPartitions.bottom} />
							{/if}

							{#if (message?.sources || message?.citations) && (model?.info?.meta?.capabilities?.citations ?? true)}
								<Citations
									bind:this={citationsElement}
									id={message?.id}
									{chatId}
									sources={message?.sources ?? message?.citations}
									{readOnly}
								/>
							{/if}

							<!-- PORTICO_PATCH: Explicit file display renders at the tool-call location, not at the bottom of the message. -->
							{#if imageFiles.length > 0}
								<div class="my-2 w-full flex overflow-x-auto gap-2 flex-wrap" dir={$settings?.chatDirection ?? 'auto'}>
									{#each imageFiles as file, imageIndex (getImageRenderKey(file, imageIndex))}
										<div>
											<Image src={getImageSrc(file)} alt="Generated Image" />
										</div>
									{/each}
								</div>
							{/if}

							<!-- PORTICO_PATCH: Show activity indicator while generating response below every top-level phase. -->
							{#if assistantModelLogoIsStreaming}
								<ActivityIndicator
									isActive={true}
									messageId={message.id}
									startedAt={message.streamStartedAt ?? message.timestamp}
								/>
							{/if}
						</div>
					</div>
				</div>

				{#if !edit}
					<div
						bind:this={buttonsContainerElement}
						class="mt-2 flex justify-start overflow-x-auto buttons text-gray-600 dark:text-gray-500"
					>
						{#if message.done || siblings.length > 1}
							{#if siblings.length > 1}
								<div class="flex self-center min-w-fit" dir="ltr">
									<button
										aria-label={$i18n.t('Previous message')}
										class="self-center p-1 hover:bg-black/5 dark:hover:bg-white/5 dark:hover:text-white hover:text-black rounded-md transition"
										on:click={() => {
											showPreviousMessage(message);
										}}
									>
										<svg
											aria-hidden="true"
											xmlns="http://www.w3.org/2000/svg"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											stroke-width="2.5"
											class="size-3.5"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												d="M15.75 19.5 8.25 12l7.5-7.5"
											/>
										</svg>
									</button>

									{#if messageIndexEdit}
										<div
											class="text-sm flex justify-center font-semibold self-center dark:text-gray-100 min-w-fit"
										>
											<input
												id="message-index-input-{message.id}"
												type="number"
												value={siblings.indexOf(message.id) + 1}
												min="1"
												max={siblings.length}
												on:focus={(e) => {
													e.target.select();
												}}
												on:blur={(e) => {
													gotoMessage(message, e.target.value - 1);
													messageIndexEdit = false;
												}}
												on:keydown={(e) => {
													if (e.key === 'Enter') {
														gotoMessage(message, e.target.value - 1);
														messageIndexEdit = false;
													}
												}}
												class="bg-transparent font-semibold self-center dark:text-gray-100 min-w-fit outline-hidden"
											/>/{siblings.length}
										</div>
									{:else}
										<!-- svelte-ignore a11y-no-static-element-interactions -->
										<div
											class="text-sm tracking-widest font-semibold self-center dark:text-gray-100 min-w-fit"
											on:dblclick={async () => {
												messageIndexEdit = true;

												await tick();
												const input = document.getElementById(`message-index-input-${message.id}`);
												if (input) {
													input.focus();
													input.select();
												}
											}}
										>
											{siblings.indexOf(message.id) + 1}/{siblings.length}
										</div>
									{/if}

									<button
										class="self-center p-1 hover:bg-black/5 dark:hover:bg-white/5 dark:hover:text-white hover:text-black rounded-md transition"
										on:click={() => {
											showNextMessage(message);
										}}
										aria-label={$i18n.t('Next message')}
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											fill="none"
											aria-hidden="true"
											viewBox="0 0 24 24"
											stroke="currentColor"
											stroke-width="2.5"
											class="size-3.5"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												d="m8.25 4.5 7.5 7.5-7.5 7.5"
											/>
										</svg>
									</button>
								</div>
							{/if}

							{#if message.done}
								{#if !readOnly}
									{#if $user?.role === 'user' ? ($user?.permissions?.chat?.edit ?? true) : true}
										<Tooltip content={$i18n.t('Edit')} placement="bottom">
											<button
												aria-label={$i18n.t('Edit')}
												class="{isLastMessage || ($settings?.highContrastMode ?? false)
													? 'visible'
													: 'invisible group-hover:visible'} p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
												on:click={() => {
													editMessageHandler();
												}}
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													fill="none"
													viewBox="0 0 24 24"
													stroke-width="2.3"
													aria-hidden="true"
													stroke="currentColor"
													class="w-4 h-4"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125"
													/>
												</svg>
											</button>
										</Tooltip>
									{/if}
								{/if}

								<Tooltip content={$i18n.t('Copy')} placement="bottom">
									<button
										aria-label={$i18n.t('Copy')}
										class="{isLastMessage || ($settings?.highContrastMode ?? false)
											? 'visible'
											: 'invisible group-hover:visible'} p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition copy-response-button"
										on:click={() => {
											copyToClipboard(message.content);
										}}
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											fill="none"
											aria-hidden="true"
											viewBox="0 0 24 24"
											stroke-width="2.3"
											stroke="currentColor"
											class="w-4 h-4"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
											/>
										</svg>
									</button>
								</Tooltip>

								{#if $config?.features.enable_image_generation && ($user?.role === 'admin' || $user?.permissions?.features?.image_generation) && !readOnly}
									<Tooltip content={$i18n.t('Generate Image')} placement="bottom">
										<button
											aria-label={$i18n.t('Generate Image')}
											class="{isLastMessage || ($settings?.highContrastMode ?? false)
												? 'visible'
												: 'invisible group-hover:visible'}  p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
											on:click={() => {
												if (!generatingImage) {
													generateImage(message);
												}
											}}
										>
											{#if generatingImage}
												<svg
													aria-hidden="true"
													class=" w-4 h-4"
													fill="currentColor"
													viewBox="0 0 24 24"
													xmlns="http://www.w3.org/2000/svg"
												>
													<style>
														.spinner_S1WN {
															animation: spinner_MGfb 0.8s linear infinite;
															animation-delay: -0.8s;
														}

														.spinner_Km9P {
															animation-delay: -0.65s;
														}

														.spinner_JApP {
															animation-delay: -0.5s;
														}

														@keyframes spinner_MGfb {
															93.75%,
															100% {
																opacity: 0.2;
															}
														}
													</style>
													<circle class="spinner_S1WN" cx="4" cy="12" r="3" />
													<circle class="spinner_S1WN spinner_Km9P" cx="12" cy="12" r="3" />
													<circle class="spinner_S1WN spinner_JApP" cx="20" cy="12" r="3" />
												</svg>
											{:else}
												<svg
													xmlns="http://www.w3.org/2000/svg"
													fill="none"
													aria-hidden="true"
													viewBox="0 0 24 24"
													stroke-width="2.3"
													stroke="currentColor"
													class="w-4 h-4"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
													/>
												</svg>
											{/if}
										</button>
									</Tooltip>
								{/if}

								{#if !readOnly}
									<!-- PORTICO PATCH: Continue Response button hidden per user request —
									     only the UI is suppressed; continueResponse() and its backend
									     path stay wired. Restore by deleting the `false &&` guard. -->
									{#if false && isLastMessage && ($user?.role === 'admin' || ($user?.permissions?.chat?.continue_response ?? true))}
										<Tooltip content={$i18n.t('Continue Response')} placement="bottom">
											<button
												aria-label={$i18n.t('Continue Response')}
												type="button"
												id="continue-response-button"
												class="{isLastMessage || ($settings?.highContrastMode ?? false)
													? 'visible'
													: 'invisible group-hover:visible'} p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
												on:click={() => {
													continueResponse();
												}}
											>
												<svg
													aria-hidden="true"
													xmlns="http://www.w3.org/2000/svg"
													fill="none"
													viewBox="0 0 24 24"
													stroke-width="2.3"
													stroke="currentColor"
													class="w-4 h-4"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
													/>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														d="M15.91 11.672a.375.375 0 0 1 0 .656l-5.603 3.113a.375.375 0 0 1-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112Z"
													/>
												</svg>
											</button>
										</Tooltip>
									{/if}

									{#if $user?.role === 'admin' || ($user?.permissions?.chat?.regenerate_response ?? true)}
										{#if $settings?.regenerateMenu ?? true}
											<button
												type="button"
												class="hidden regenerate-response-button"
												on:click={() => {
													showRateComment = false;
													regenerateResponse(message);

													(model?.actions ?? []).forEach((action) => {
														dispatch('action', {
															id: action.id,
															event: {
																id: 'regenerate-response',
																data: {
																	messageId: message.id
																}
															}
														});
													});
												}}
											/>

											<RegenerateMenu
												onRegenerate={(prompt = null) => {
													showRateComment = false;
													regenerateResponse(message, prompt);

													(model?.actions ?? []).forEach((action) => {
														dispatch('action', {
															id: action.id,
															event: {
																id: 'regenerate-response',
																data: {
																	messageId: message.id
																}
															}
														});
													});
												}}
											>
												<Tooltip content={$i18n.t('Regenerate')} placement="bottom">
													<div
														aria-label={$i18n.t('Regenerate')}
														class="{isLastMessage
															? 'visible'
															: 'invisible group-hover:visible'} p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
													>
														<svg
															xmlns="http://www.w3.org/2000/svg"
															fill="none"
															viewBox="0 0 24 24"
															stroke-width="2.3"
															aria-hidden="true"
															stroke="currentColor"
															class="w-4 h-4"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
															/>
														</svg>
													</div>
												</Tooltip>
											</RegenerateMenu>
										{:else}
											<Tooltip content={$i18n.t('Regenerate')} placement="bottom">
												<button
													type="button"
													aria-label={$i18n.t('Regenerate')}
													class="{isLastMessage
														? 'visible'
														: 'invisible group-hover:visible'} p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition regenerate-response-button"
													on:click={() => {
														showRateComment = false;
														regenerateResponse(message);

														(model?.actions ?? []).forEach((action) => {
															dispatch('action', {
																id: action.id,
																event: {
																	id: 'regenerate-response',
																	data: {
																		messageId: message.id
																	}
																}
															});
														});
													}}
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														fill="none"
														viewBox="0 0 24 24"
														stroke-width="2.3"
														aria-hidden="true"
														stroke="currentColor"
														class="w-4 h-4"
													>
														<path
															stroke-linecap="round"
															stroke-linejoin="round"
															d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
														/>
													</svg>
												</button>
											</Tooltip>
										{/if}
									{/if}

									{#if $user?.role === 'admin' || ($user?.permissions?.chat?.delete_message ?? true)}
										{#if siblings.length > 1}
											<Tooltip content={$i18n.t('Delete')} placement="bottom">
												<button
													type="button"
													aria-label={$i18n.t('Delete')}
													id="delete-response-button"
													class="{isLastMessage || ($settings?.highContrastMode ?? false)
														? 'visible'
														: 'invisible group-hover:visible'} p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
													on:click={() => {
														showDeleteConfirm = true;
													}}
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														fill="none"
														viewBox="0 0 24 24"
														stroke-width="2"
														stroke="currentColor"
														aria-hidden="true"
														class="w-4 h-4"
													>
														<path
															stroke-linecap="round"
															stroke-linejoin="round"
															d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
														/>
													</svg>
												</button>
											</Tooltip>
										{/if}
									{/if}

									{#each model?.actions ?? [] as action}
										<Tooltip content={action.name} placement="bottom">
											<button
												type="button"
												aria-label={action.name}
												class="{isLastMessage || ($settings?.highContrastMode ?? false)
													? 'visible'
													: 'invisible group-hover:visible'} p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
												on:click={() => {
													actionMessage(action.id, message);
												}}
											>
												{#if action?.icon}
													<div class="size-4">
														<img
															src={action.icon}
															class="w-4 h-4 {action.icon.includes('svg')
																? 'dark:invert-[80%]'
																: ''}"
															style="fill: currentColor;"
															alt={action.name}
														/>
													</div>
												{:else}
													<Sparkles strokeWidth="2.1" className="size-4" />
												{/if}
											</button>
										</Tooltip>
									{/each}

									<!-- PORTICO PATCH (fork-chat): must stay the rightmost action in this row -->
									{#if forkChat && !$temporaryChatEnabled}
										<Tooltip content={$i18n.t('Fork')} placement="bottom">
											<button
												type="button"
												id="fork-chat-button"
												aria-label={$i18n.t('Fork')}
												disabled={forkingChat}
												class="{isLastMessage || ($settings?.highContrastMode ?? false)
													? 'visible'
													: 'invisible group-hover:visible'} p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
												on:click={async () => {
													if (forkingChat) {
														return;
													}
													forkingChat = true;
													try {
														await forkChat(message);
													} finally {
														forkingChat = false;
													}
												}}
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													fill="none"
													viewBox="0 0 24 24"
													stroke-width="2"
													stroke="currentColor"
													stroke-linecap="round"
													stroke-linejoin="round"
													aria-hidden="true"
													class="w-4 h-4"
												>
													<circle cx="12" cy="18" r="3" />
													<circle cx="6" cy="6" r="3" />
													<circle cx="18" cy="6" r="3" />
													<path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
													<path d="M12 12v3" />
												</svg>
											</button>
										</Tooltip>
									{/if}
								{/if}
							{/if}
						{/if}
					</div>

					{#if message.done && showRateComment}
						<RateComment
							bind:message
							bind:show={showRateComment}
							on:save={async (e) => {
								await feedbackHandler(null, {
									...e.detail
								});
							}}
						/>
					{/if}

					{#if (isLastMessage || ($settings?.keepFollowUpPrompts ?? false)) && message.done && !readOnly && (message?.followUps ?? []).length > 0}
						<div class="mt-2.5" in:fade={{ duration: 100 }}>
							<FollowUps
								followUps={message?.followUps}
								onClick={(prompt) => {
									if ($settings?.insertFollowUpPrompt ?? false) {
										// Insert the follow-up prompt into the input box
										setInputText(prompt);
									} else {
										// Submit the follow-up prompt directly
										submitMessage(message?.id, prompt);
									}
								}}
							/>
						</div>
					{/if}
				{/if}
			</div>
		</div>
	</div>
{/key}

<style>
	.buttons::-webkit-scrollbar {
		display: none; /* for Chrome, Safari and Opera */
	}

	.buttons {
		-ms-overflow-style: none; /* IE and Edge */
		scrollbar-width: none; /* Firefox */
	}
</style>
