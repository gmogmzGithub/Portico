<script lang="ts">
	type ComponentSelectionGroup = {
		label: string;
		values: string[];
	};

	type QuestionAnswer = {
		questionId: string;
		header: string;
		question: string;
		selectedOptionId: string | null;
		selectedOptionLabel: string | null;
		componentSelections: ComponentSelectionGroup[] | null;
		freeformText: string | null;
	};

	export let record: {
		toolCallId: string;
		flowId: string | null;
		questions: QuestionAnswer[];
	};
</script>

<section
	class="my-3 overflow-hidden rounded-2xl border border-blue-200/80 bg-blue-50/75 shadow-sm dark:border-blue-400/20 dark:bg-blue-500/10"
	aria-label="Your responses to requested questions"
	data-testid="user-question-answer-card"
	data-tool-call-id={record.toolCallId}
>
	<div class="border-b border-blue-200/70 px-4 py-3 dark:border-blue-400/15">
		<div class="flex items-center gap-2 text-sm font-semibold text-blue-950 dark:text-blue-100">
			<span
				class="flex size-6 items-center justify-center rounded-full bg-blue-600 text-white dark:bg-blue-400 dark:text-blue-950"
				aria-hidden="true"
			>
				<svg viewBox="0 0 20 20" fill="none" class="size-3.5" stroke="currentColor" stroke-width="2.4">
					<path d="m5 10 3 3 7-7" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</span>
			<span>{record.questions.length === 1 ? 'Your response' : 'Your responses'}</span>
		</div>
	</div>

	<div class="divide-y divide-blue-200/70 dark:divide-blue-400/15">
		{#each record.questions as answer (answer.questionId)}
			{@const componentGroups = answer.componentSelections ?? []}
			{@const hasSelections = Boolean(answer.selectedOptionLabel) || componentGroups.length > 0}
			<div class="px-4 py-4">
				<div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-200">
					{answer.header}
				</div>
				<div class="mt-1.5 text-sm font-medium leading-6 text-slate-900 dark:text-slate-100">
					{answer.question}
				</div>
				<div class="mt-3 rounded-xl border border-blue-200/80 bg-white/80 px-3 py-2.5 text-sm text-slate-900 dark:border-blue-400/15 dark:bg-black/15 dark:text-slate-100">
					{#if answer.selectedOptionLabel}
						<div class="flex items-start gap-2">
							<span class="mt-0.5 text-blue-600 dark:text-blue-300" aria-hidden="true">✓</span>
							<span class="font-medium">{answer.selectedOptionLabel}</span>
						</div>
					{/if}
					{#each componentGroups as group, groupIndex}
						<div
							class="flex items-start gap-2"
							class:mt-2={Boolean(answer.selectedOptionLabel) || groupIndex > 0}
						>
							<span class="mt-0.5 text-blue-600 dark:text-blue-300" aria-hidden="true">✓</span>
							<span class="min-w-0">
								<span class="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
									{group.label}
								</span>
								<span class="mt-0.5 block font-medium">
									{group.values.length ? group.values.join(', ') : 'None selected'}
								</span>
							</span>
						</div>
					{/each}
					{#if answer.freeformText}
						<div class={hasSelections ? 'mt-2 border-t border-slate-200/80 pt-2 dark:border-white/10' : ''}>
							<div class="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
								Additional context
							</div>
							<div class="mt-1 whitespace-pre-wrap leading-6 text-slate-700 dark:text-slate-200">
								{answer.freeformText}
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</section>
