<script lang="ts">
	// PORTICO-348: the interactive Ask User Question card, rendered inline in the
	// owning chat's transcript. Replaces the window-wide blocking modal, so a
	// question in one chat no longer freezes the app or hides another chat's
	// question. Sibling of the read-only UserQuestionAnswerCard, which renders
	// the answers once the flow has completed.
	//
	// A flow carries up to five questions and is presented one at a time, the way
	// the modal did: question 1, answered or skipped, then question 2, with
	// pagination back and forth over the whole flow. Stepper rules live in
	// $lib/utils/userQuestionPagination so they are executable in tests.
	import { getContext, onMount } from 'svelte';
	import { models as modelsStore } from '$lib/stores';
	import { listScheduledTaskCapabilities } from '$lib/apis/scheduledTasks';
	import { getModelCapability } from '$lib/config/model-capabilities';
	import {
		areComponentsActive,
		isQuestionAnswered,
		NONE_OF_THE_ABOVE_OPTION_ID
	} from '$lib/utils/userQuestionAnswered';
	import {
		applyCatalogSeedsToSlots,
		bucketHasCatalogSeeds,
		bucketKeyFor,
		buildBucketSlots,
		isComponentRevealOptionDriven,
		isSeedPending,
		seededKeyFor
	} from '$lib/utils/userQuestionComponentDefaults';
	import {
		FORWARD_ACTION_NEXT,
		QUESTION_STEP_ANSWERED,
		QUESTION_STEP_SKIPPED,
		buildQuestionStepperModel,
		clampQuestionIndex,
		markQuestionSkipped
	} from '$lib/utils/userQuestionPagination';
	import ModelSelector from '$lib/components/chat/ModelSelector.svelte';
	import ReasoningEffortControl from '$lib/components/chat/MessageInput/ReasoningEffortControl.svelte';
	import SkillPicker from '$lib/components/scheduled-tasks/SkillPicker.svelte';
	import McpServerPicker from '$lib/components/scheduled-tasks/McpServerPicker.svelte';
	import type { PendingUserQuestionFlow } from '$lib/stores/pendingUserQuestions';

	const i18n: any = getContext('i18n');

	export let flow: PendingUserQuestionFlow;
	export let chatId: string;
	export let defaultModelId = '';
	export let defaultReasoningEffort = '';

	let submitting = false;
	let errorMessage: string | null = null;
	// Keyed by question id so answers survive re-renders while the flow is open.
	let selectedOptionByQuestionId: Record<string, string> = {};
	let freeformByQuestionId: Record<string, string> = {};
	// componentSelections[questionId][componentId] = string[]
	let componentSelections: Record<string, Record<string, string[]>> = {};
	// Which question is on screen, and which ones were paged past unanswered.
	// Bindable so Messages.svelte can fold the on-screen question into its
	// auto-scroll key (a taller next question would otherwise clip below the
	// fold on Next/Back).
	export let currentIndex = 0;
	let skippedQuestionIds: Set<string> = new Set();
	let visitedQuestionIds: Set<string> = new Set();
	// Per-option picker buckets (modal parity): each revealing option keeps its
	// own selections, restored when the option is re-selected; the live
	// componentSelections map always holds the ACTIVE bucket.
	let bucketsByQuestionId: Record<string, Record<string, Record<string, string[]>>> = {};
	// "questionId|bucketKey" markers: catalog-dependent seeds landed (or were
	// deliberately seeded empty). A marked bucket is never re-seeded.
	let seededBucketKeys: Set<string> = new Set();

	// Curated picker catalogs. Loaded once per card, only when a picker is used.
	let skillOptions: any[] = [];
	let toolServerOptions: any[] = [];
	let catalogLoading = false;
	let catalogLoaded = false;
	// True once a load attempt finished either way; a failed attempt seeds
	// pending defaults EMPTY so Send never deadlocks on a broken catalog.
	let catalogAttempted = false;

	// Scans the whole flow, not just the visible question: paging to the picker
	// step should not be the first thing that starts the fetch.
	$: usesCatalogPicker = (flow?.questions ?? []).some((question) =>
		question.components.some(
			(component) =>
				component.type === 'skill_picker' || component.type === 'mcp_server_picker'
		)
	);

	const loadCatalog = async () => {
		if (catalogLoaded || catalogLoading) return;
		catalogLoading = true;
		try {
			const response = await listScheduledTaskCapabilities(localStorage.token);
			skillOptions = response?.skills ?? [];
			toolServerOptions = response?.tool_servers ?? [];
			catalogLoaded = true;
		} catch (error) {
			// Pickers degrade to empty lists rather than blocking the answer.
			console.warn('[UserQuestionPromptCard] capability catalog failed:', error);
		} finally {
			catalogLoading = false;
			catalogAttempted = true;
			applyPendingCatalogSeeds();
		}
	};
	onMount(() => {
		if (usesCatalogPicker) void loadCatalog();
	});
	$: if (usesCatalogPicker && !catalogLoaded && !catalogLoading) void loadCatalog();

	const selectionFor = (questionId: string, componentId: string): string[] =>
		componentSelections[questionId]?.[componentId] ?? [];

	const setSelection = (questionId: string, componentId: string, ids: string[]) => {
		componentSelections = {
			...componentSelections,
			[questionId]: { ...(componentSelections[questionId] ?? {}), [componentId]: ids }
		};
	};

	// The reasoning effort a model actually supports varies per model (the modal
	// derived this via buildReasoningEffortFieldState). A hardcoded list showed
	// efforts the chosen model may not accept, so resolve it from the model that
	// the question's own model_picker currently has selected.
	// The model_picker may live in this question or in an earlier question of the
	// same flow (the guided-flows wizard asks model and reasoning as separate
	// steps, which are now separate pages). Prefer a sibling picker, then fall
	// back to the flow, otherwise a separate reasoning step could never enable.
	const selectedModelIdFor = (
		question: PendingUserQuestionFlow['questions'][number]
	): string => {
		const readModelFrom = (source: PendingUserQuestionFlow['questions'][number]) => {
			const modelComponent = source.components.find(
				(component) => component.type === 'model_picker'
			);
			if (!modelComponent) return '';
			return componentSelections[source.id]?.[modelComponent.id]?.[0] ?? '';
		};
		const own = readModelFrom(question);
		if (own) return own;
		for (const candidate of flow?.questions ?? []) {
			if (candidate.id === question.id) continue;
			const modelId = readModelFrom(candidate);
			if (modelId) return modelId;
		}
		return '';
	};

	// Mirrors buildReasoningEffortFieldState from the modal: the control is always
	// rendered, but disabled with an explanatory placeholder until a base model
	// is chosen, and when the chosen model has no reasoning support.
	const reasoningFieldStateFor = (
		question: PendingUserQuestionFlow['questions'][number],
		selections: Record<string, Record<string, string[]>>
	): { options: string[]; disabled: boolean; placeholder: string } => {
		void selections; // referenced so this recomputes when the model changes
		const modelId = selectedModelIdFor(question);
		if (!modelId) {
			return { options: [], disabled: true, placeholder: $i18n.t('Select a base model first') };
		}
		// MODEL_CAPABILITIES is keyed by display name while the picker yields ids,
		// so try the id first and then the store's display name for that id.
		const displayName =
			($modelsStore ?? []).find((model: any) => model?.id === modelId)?.name ?? '';
		const capability = getModelCapability(modelId) ?? getModelCapability(displayName);
		const options = capability?.reasoningEffortOptions ?? [];
		if (capability?.supportsReasoning === false || options.length === 0) {
			return {
				options: [],
				disabled: true,
				placeholder: $i18n.t('Not supported by selected model')
			};
		}
		return { options, disabled: false, placeholder: $i18n.t('(default)') };
	};

	const reasoningControlModelFor = (
		question: PendingUserQuestionFlow['questions'][number],
		options: string[]
	) => {
		const id = selectedModelIdFor(question);
		const model = ($modelsStore ?? []).find((candidate: any) => candidate?.id === id);
		return {
			index: 0,
			id,
			name: model?.name || id || $i18n.t('Model'),
			baseModelName: null,
			options
		};
	};

	const reasoningEffortMapFor = (questionId: string, componentId: string) => ({
		'0': selectionFor(questionId, componentId)[0] ?? ''
	});

	// MODEL_CAPABILITIES is keyed by display name while the pickers yield ids,
	// so try the id first and then the store's display name for that id.
	const capabilityForModelId = (modelId: string) => {
		const displayName =
			($modelsStore ?? []).find((model: any) => model?.id === modelId)?.name ?? '';
		return getModelCapability(modelId) ?? getModelCapability(displayName);
	};

	const seedContextFor = (question: PendingUserQuestionFlow['questions'][number]) => ({
		models: $modelsStore ?? [],
		capabilityFor: capabilityForModelId,
		chatDefaultModelId: defaultModelId.trim(),
		chatDefaultEffort: defaultReasoningEffort,
		// A reasoning seed with no sibling model seed validates against the model
		// already picked elsewhere in the flow (guided flows split the two steps).
		effortFallbackModelId: selectedModelIdFor(question)
	});

	// Land a bucket's catalog-dependent seeds exactly once. Buckets without such
	// seeds settle immediately; the rest wait for loadCatalog's outcome (failure
	// seeds empty — the pickers are already degraded and Send must not deadlock).
	// Only ever called for the ACTIVE bucket, so writing the live map is safe:
	// while the catalog is loading the pickers have no options to edit with.
	const settleCatalogSeedsFor = (
		question: PendingUserQuestionFlow['questions'][number],
		bucketKey: string
	) => {
		const marker = seededKeyFor(question.id, bucketKey);
		if (seededBucketKeys.has(marker)) return;
		if (bucketHasCatalogSeeds(question, bucketKey)) {
			if (!catalogAttempted || catalogLoading) return; // lands via applyPendingCatalogSeeds
			const catalog = catalogLoaded ? { skills: skillOptions, toolServers: toolServerOptions } : null;
			componentSelections = {
				...componentSelections,
				[question.id]: applyCatalogSeedsToSlots(
					question,
					bucketKey,
					componentSelections[question.id] ?? {},
					catalog
				)
			};
		}
		seededBucketKeys = new Set(seededBucketKeys).add(marker);
	};

	const applyPendingCatalogSeeds = () => {
		for (const question of flow?.questions ?? []) {
			const key = bucketKeyFor(question, selectedOptionByQuestionId[question.id] || '');
			if (key) settleCatalogSeedsFor(question, key);
		}
	};

	// Reset when a different flow takes over this chat.
	let boundFlowId: string | null = null;
	$: if (flow?.flowId !== boundFlowId) {
		boundFlowId = flow?.flowId ?? null;
		selectedOptionByQuestionId = {};
		freeformByQuestionId = {};
		bucketsByQuestionId = {};
		seededBucketKeys = new Set();
		const initialModelId = defaultModelId.trim();
		// CapabilityPicker uses two-way `bind:selectedIds`, so every path must
		// already exist before it is bound. Each question starts on its ungated
		// bucket, seeded from default_selected where the agent supplied one and
		// from the chat's model/reasoning defaults otherwise; option-driven
		// questions hold the stock placeholder until an option reveals (their
		// real buckets are created in selectOption). Models seed before
		// reasoning so the effort default validates against the seeded model.
		let flowSeededModelId = '';
		componentSelections = Object.fromEntries(
			(flow?.questions ?? []).map((question) => {
				const built = buildBucketSlots(question, bucketKeyFor(question, ''), {
					models: $modelsStore ?? [],
					capabilityFor: capabilityForModelId,
					chatDefaultModelId: initialModelId,
					chatDefaultEffort: defaultReasoningEffort,
					effortFallbackModelId: flowSeededModelId
				});
				if (!flowSeededModelId && built.seededModelId) flowSeededModelId = built.seededModelId;
				return [question.id, built.slots];
			})
		);
		for (const question of flow?.questions ?? []) {
			const key = bucketKeyFor(question, '');
			if (key) settleCatalogSeedsFor(question, key);
		}
		// A new flow always opens on its first question.
		currentIndex = 0;
		skippedQuestionIds = new Set();
		visitedQuestionIds = new Set((flow?.questions ?? []).slice(0, 1).map((question) => question.id));
		errorMessage = null;
		submitting = false;
	}

	// Named so the stepper below depends on the answer maps: Svelte only tracks
	// what a reactive statement reads directly, and isQuestionAnswered is called
	// from inside a callback it cannot see into.
	$: answersByQuestionId = Object.fromEntries(
		(flow?.questions ?? []).map((question) => [
			question.id,
			{
				selectedOptionId: selectedOptionByQuestionId[question.id] || '',
				freeformText: freeformByQuestionId[question.id] ?? '',
				componentSelections: componentSelections[question.id] ?? {},
				// Recommended-set seeds that have not landed yet block answeredness
				// (and therefore Send) so an early submit can't ship empty pickers.
				seedPending: isSeedPending(
					question,
					selectedOptionByQuestionId[question.id] || '',
					seededBucketKeys
				)
			}
		])
	);

	// Answered-ness itself is the single source of truth in
	// tests/user-question-answered.unit.test.js; the stepper built on top of it
	// is covered by tests/user-question-pagination.unit.test.js.
	$: stepper = buildQuestionStepperModel(flow?.questions ?? [], {
		currentIndex,
		skippedIds: skippedQuestionIds,
		visitedIds: visitedQuestionIds,
		isAnswered: (question: any) =>
			isQuestionAnswered(question, answersByQuestionId[question.id] ?? {})
	});
	$: currentQuestion = (flow?.questions ?? [])[stepper.currentIndex] ?? null;
	$: currentFreeformRequired = Boolean(
		currentQuestion &&
			selectedOptionByQuestionId[currentQuestion.id] === NONE_OF_THE_ABOVE_OPTION_ID
	);

	const goToQuestion = (index: number) => {
		if (submitting) return;
		const questions = flow?.questions ?? [];
		const target = clampQuestionIndex(index, questions.length);
		if (target === stepper.currentIndex) return;
		// Leaving a question unanswered records it as skipped, so its pagination
		// dot invites a return trip instead of looking untouched.
		skippedQuestionIds = markQuestionSkipped(
			skippedQuestionIds,
			questions[stepper.currentIndex],
			stepper.currentStatus === QUESTION_STEP_ANSWERED
		);
		visitedQuestionIds = new Set(visitedQuestionIds).add(questions[target].id);
		currentIndex = target;
	};

	const stepStatusLabel = (status: string): string =>
		status === QUESTION_STEP_ANSWERED
			? $i18n.t('answered')
			: status === QUESTION_STEP_SKIPPED
				? $i18n.t('skipped')
				: $i18n.t('not answered yet');

	const selectOption = (questionId: string, optionId: string) => {
		const previousOptionId = selectedOptionByQuestionId[questionId] || '';
		selectedOptionByQuestionId = { ...selectedOptionByQuestionId, [questionId]: optionId };
		const question = (flow?.questions ?? []).find((candidate) => candidate.id === questionId);
		// Without a gate or defaults-bearing option, the single ungated bucket
		// rides along with option picks (legacy behavior).
		if (!question || !isComponentRevealOptionDriven(question)) return;
		const previousKey = bucketKeyFor(question, previousOptionId);
		const nextKey = bucketKeyFor(question, optionId);
		if (previousKey === nextKey || !nextKey) return;
		// Stash the outgoing bucket so re-selecting that option restores the
		// user's edits rather than reapplying raw defaults.
		if (previousKey) {
			bucketsByQuestionId = {
				...bucketsByQuestionId,
				[questionId]: {
					...(bucketsByQuestionId[questionId] ?? {}),
					[previousKey]: componentSelections[questionId] ?? {}
				}
			};
		}
		const stored = bucketsByQuestionId[questionId]?.[nextKey];
		componentSelections = {
			...componentSelections,
			[questionId]: stored ?? buildBucketSlots(question, nextKey, seedContextFor(question)).slots
		};
		settleCatalogSeedsFor(question, nextKey);
	};

	const complete = async (action: 'submitted' | 'dismissed') => {
		if (submitting) return;
		const hostApi = (window as any)?.webviewHost;
		if (typeof hostApi?.submitUserQuestion !== 'function') {
			errorMessage = $i18n.t('This build cannot answer questions inline.');
			return;
		}
		submitting = true;
		errorMessage = null;
		try {
			await hostApi.submitUserQuestion({
				flowId: flow.flowId,
				chatId,
				action,
				// Every question in the flow is sent, not just the visible page --
				// the host rejects an answer set that omits one.
				answers:
					action === 'submitted'
						? flow.questions.map((question) => ({
								question_id: question.id,
								selected_option_id: selectedOptionByQuestionId[question.id] || null,
								freeform_text: (freeformByQuestionId[question.id] ?? '').trim() || null,
								// Gated pickers only count while their gate is open.
								component_selections: areComponentsActive(question, selectedOptionByQuestionId[question.id] || '')
									? (componentSelections[question.id] ?? null)
									: null
							}))
						: []
			});
			// The host broadcasts a new snapshot, which removes this card.
		} catch (error: any) {
			submitting = false;
			errorMessage = error?.message || $i18n.t('Failed to send your answers');
		}
	};
</script>

<section
	class="my-3 overflow-hidden rounded-2xl border border-blue-200/80 bg-blue-50/75 shadow-sm dark:border-blue-400/20 dark:bg-blue-500/10"
	aria-label={$i18n.t('Questions waiting for your response')}
	data-testid="user-question-prompt-card"
	data-flow-id={flow.flowId}
>
	<div class="border-b border-blue-200/70 px-4 py-3 dark:border-blue-400/15">
		<div class="flex items-center gap-2 text-sm font-semibold text-blue-950 dark:text-blue-100">
			<span
				class="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white dark:bg-blue-400 dark:text-blue-950"
				aria-hidden="true"
			>
				<svg viewBox="0 0 20 20" fill="none" class="size-3.5" stroke="currentColor" stroke-width="2.4">
					<path d="M7.5 7.5a2.5 2.5 0 1 1 3.2 2.4c-.6.2-1.2.7-1.2 1.4v.4" stroke-linecap="round" />
					<circle cx="10" cy="15" r="0.9" fill="currentColor" stroke="none" />
				</svg>
			</span>
			<span class="min-w-0 flex-1">
				{stepper.total === 1
					? $i18n.t('A question needs your answer')
					: $i18n.t('{{count}} questions need your answer', { count: stepper.total })}
			</span>
			{#if stepper.paginated}
				<span
					class="shrink-0 text-xs font-medium tabular-nums text-blue-800 dark:text-blue-200"
					aria-live="polite"
				>
					{$i18n.t('Question {{current}} of {{total}}', {
						current: stepper.currentIndex + 1,
						total: stepper.total
					})}
				</span>
			{/if}
			<button
				type="button"
				disabled={submitting}
				class="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-blue-800 transition hover:bg-blue-500/15 disabled:opacity-60 dark:text-blue-200 dark:hover:bg-blue-400/15"
				aria-label={$i18n.t('Dismiss these questions without answering')}
				on:click={() => complete('dismissed')}
			>
				{$i18n.t('Dismiss')}
			</button>
		</div>

		{#if stepper.paginated}
			<!-- Pagination. Every question stays reachable in one click, so a
			     skipped one can be returned to at any point. -->
			<ol class="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="user-question-pagination">
				{#each stepper.steps as step (step.id)}
					<li>
						<button
							type="button"
							disabled={submitting}
							aria-current={step.active ? 'step' : undefined}
							aria-label={$i18n.t('Question {{number}}, {{status}}', {
								number: step.index + 1,
								status: stepStatusLabel(step.status)
							})}
							title={$i18n.t('Question {{number}}, {{status}}', {
								number: step.index + 1,
								status: stepStatusLabel(step.status)
							})}
							data-step-status={step.status}
							class="flex size-6 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums transition disabled:opacity-60
								{step.status === QUESTION_STEP_ANSWERED
								? 'border-blue-600 bg-blue-600 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-blue-950'
								: step.status === QUESTION_STEP_SKIPPED
									? 'border-dashed border-blue-500 bg-white/70 text-blue-800 dark:border-blue-400 dark:bg-black/20 dark:text-blue-200'
									: 'border-blue-200/80 bg-white/70 text-slate-500 hover:border-blue-400 dark:border-blue-400/20 dark:bg-black/10 dark:text-slate-400'}
								{step.active ? 'ring-2 ring-blue-500/35 dark:ring-blue-400/40' : ''}"
							on:click={() => goToQuestion(step.index)}
						>
							{step.index + 1}
						</button>
					</li>
				{/each}
			</ol>
		{/if}
	</div>

	{#if currentQuestion}
		<!-- Keyed so paging rebuilds the controls instead of rebinding them onto
		     the next question's state. -->
		{#key currentQuestion.id}
			<div class="px-4 py-4">
				{#if currentQuestion.header}
					<div
						class="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-200"
					>
						{currentQuestion.header}
					</div>
				{/if}
				<div class="mt-1.5 text-sm font-medium leading-6 text-slate-900 dark:text-slate-100">
					{currentQuestion.question}
				</div>

				{#if currentQuestion.options.length}
					<div
						class="mt-3 flex flex-col gap-1.5"
						role="radiogroup"
						aria-label={currentQuestion.question}
					>
						{#each currentQuestion.options as option (option.id)}
							<button
								type="button"
								role="radio"
								aria-checked={selectedOptionByQuestionId[currentQuestion.id] === option.id}
								disabled={submitting}
								class="flex w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition disabled:opacity-60
									{selectedOptionByQuestionId[currentQuestion.id] === option.id
									? 'border-blue-500 bg-white text-slate-900 dark:border-blue-400 dark:bg-black/25 dark:text-slate-100'
									: 'border-blue-200/80 bg-white/70 text-slate-800 hover:border-blue-400 dark:border-blue-400/15 dark:bg-black/10 dark:text-slate-200'}"
								on:click={() => selectOption(currentQuestion.id, option.id)}
							>
								<span class="mt-0.5 text-blue-600 dark:text-blue-300" aria-hidden="true">
									{selectedOptionByQuestionId[currentQuestion.id] === option.id ? '◉' : '○'}
								</span>
								<span>
									<span class="font-medium">{option.label}</span>
									{#if option.description}
										<span class="block text-xs text-slate-600 dark:text-slate-400"
											>{option.description}</span
										>
									{/if}
								</span>
							</button>
						{/each}
					</div>
				{/if}

				{#if areComponentsActive(currentQuestion, selectedOptionByQuestionId[currentQuestion.id] || '')}
					<div class="mt-3 flex flex-col gap-3">
						{#each currentQuestion.components as component (component.id)}
							{#if component.type === 'skill_picker'}
								<SkillPicker
									bind:selectedIds={componentSelections[currentQuestion.id][component.id]}
									options={skillOptions}
									loading={catalogLoading}
								/>
							{:else if component.type === 'mcp_server_picker'}
								<McpServerPicker
									bind:selectedIds={componentSelections[currentQuestion.id][component.id]}
									options={toolServerOptions}
									loading={catalogLoading}
									label={component.label || $i18n.t('MCP servers')}
								/>
							{:else if component.type === 'model_picker'}
								<div class="flex flex-col gap-1 text-sm">
									<span class="text-xs font-medium text-slate-700 dark:text-slate-300"
										>{component.label || $i18n.t('Model')}</span
									>
									<div
										class="rounded-xl border border-blue-200/80 bg-white/80 px-3 py-2.5 text-slate-900 dark:border-blue-400/15 dark:bg-black/15 dark:text-slate-100"
										class:opacity-60={submitting}
										class:pointer-events-none={submitting}
									>
										<ModelSelector
											bind:selectedModels={componentSelections[currentQuestion.id][component.id]}
											disabled={submitting}
											formField={true}
										/>
									</div>
								</div>
							{:else if component.type === 'reasoning_effort_picker'}
								{@const reasoning = reasoningFieldStateFor(currentQuestion, componentSelections)}
								<div class="flex flex-col gap-1 text-sm">
									<span class="text-xs font-medium text-slate-700 dark:text-slate-300"
										>{component.label || $i18n.t('Reasoning effort')}</span
									>
									<ReasoningEffortControl
										model={reasoningControlModelFor(currentQuestion, reasoning.options)}
										reasoningEffortByModel={reasoningEffortMapFor(currentQuestion.id, component.id)}
										standalone={true}
										includeDefault={true}
										disabled={submitting || reasoning.disabled}
										disabledLabel={reasoning.placeholder}
										onSelect={(selection: { value: string }) =>
											setSelection(
												currentQuestion.id,
												component.id,
												selection.value ? [selection.value] : []
											)}
									/>
								</div>
							{/if}
						{/each}
					</div>
				{/if}

				{#if !currentQuestion.components.some(
					(component) =>
						component.type === 'model_picker' || component.type === 'reasoning_effort_picker'
				)}
					<input
						type="text"
						bind:value={freeformByQuestionId[currentQuestion.id]}
						disabled={submitting}
						required={currentFreeformRequired}
						aria-required={currentFreeformRequired}
						placeholder={currentFreeformRequired
							? $i18n.t('Describe your answer (required)')
							: currentQuestion.options.length
								? $i18n.t('Add any extra context for this answer (optional).')
								: currentQuestion.freeform_placeholder || $i18n.t('Type your answer')}
						aria-label={currentQuestion.question}
						class="mt-2.5 w-full rounded-xl border border-blue-200/80 bg-white/80 px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 disabled:opacity-60 dark:border-blue-400/15 dark:bg-black/15 dark:text-slate-100"
					/>
				{/if}
			</div>
		{/key}
	{/if}

	{#if errorMessage}
		<div class="px-4 pt-1 text-xs text-red-600 dark:text-red-400" role="alert">{errorMessage}</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2 px-4 py-3">
		{#if stepper.paginated}
			<button
				type="button"
				disabled={submitting || !stepper.canGoBack}
				class="rounded-lg px-3 py-1.5 text-sm text-slate-600 transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-white/10"
				on:click={() => goToQuestion(stepper.currentIndex - 1)}
			>
				{$i18n.t('Back')}
			</button>
		{/if}
		<div class="flex-1"></div>
		{#if stepper.showSend && !stepper.sendEnabled && stepper.paginated}
			<!-- Send is visible but gated: the host rejects an answer set with a
			     hole in it, so say which questions are still outstanding. -->
			<span class="text-xs text-slate-600 dark:text-slate-300">
				{stepper.unansweredCount === 1
					? $i18n.t('1 question still needs an answer')
					: $i18n.t('{{count}} questions still need an answer', {
							count: stepper.unansweredCount
						})}
			</span>
		{/if}
		{#if stepper.canGoForward}
			<button
				type="button"
				disabled={submitting}
				class="rounded-lg border px-3.5 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50
					{stepper.showSend
					? 'border-blue-300/80 bg-white/70 text-blue-900 hover:bg-white dark:border-blue-400/25 dark:bg-black/20 dark:text-blue-100 dark:hover:bg-black/30'
					: 'border-transparent bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-400 dark:text-blue-950 dark:hover:bg-blue-300'}"
				on:click={() => goToQuestion(stepper.currentIndex + 1)}
			>
				{stepper.forwardAction === FORWARD_ACTION_NEXT ? $i18n.t('Next') : $i18n.t('Skip')}
			</button>
		{/if}
		{#if stepper.showSend}
			<button
				type="button"
				disabled={submitting || !stepper.sendEnabled}
				class="rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-400 dark:text-blue-950 dark:hover:bg-blue-300"
				on:click={() => complete('submitted')}
			>
				{submitting ? $i18n.t('Sending...') : $i18n.t('Send')}
			</button>
		{/if}
	</div>
</section>
