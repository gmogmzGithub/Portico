<!--
	PORTICO PATCH (N-012 / Phase 3): per-chip prompt rendered above the chat
	input frame. Originally a tool-confirmation chip; now also handles
	generic clarification chips (e.g. scheduled-run out-of-scope decisions)
	with caller-supplied option sets.

	The chip carries:
	  * ``kind`` — "tool_confirmation" | "clarification"
	  * ``options`` — declarative button list (id / label / style)
	  * ``allow_freeform`` — whether to render the textarea fallback
	  * ``prompt`` — clarification question (clarification kind only)

	Tool-confirmation chips keep the historical Yes / No / Reply-with-
	changes layout because that's what the default option set carries.
	Clarification chips render the proposer-supplied buttons and (if
	allow_freeform) a textarea for a freeform answer.

	Each click goes to the generic REST endpoint
	``POST /api/v1/utils/chip/resolve`` so stacked chips can be resolved
	in parallel without firing a chat completion per click. The parent
	(Chat.svelte) auto-fires ONE batch-send chat turn once every chip on
	screen has reached a terminal state.

	Cross-references:
	- src/patches/backend/open_webui/utils/tool_confirmation_gate.py
	  (Card / ChipOption / propose_clarification / resolve_via_chip_click)
	- src/patches/backend/open_webui/routers/utils.py
	  (POST /api/v1/utils/chip/resolve)
	- src/patches/backend/open_webui/utils/middleware.py
	  (_inject_batch_resolution_note, _resolve_pending_tool_confirmations)
	- docs/security-tool-confirmation.md (catalogue)
	- docs/testing/plan/security/tool-confirmation-gate.md (L-22)
	- docs/testing/plan/mcp/tool-confirmation.md (G-30, G-31)
	- tests/test_tool_confirmation_chip.node.test.js (smoke)
-->
<script lang="ts">
	import { createEventDispatcher, getContext, tick } from 'svelte';
	import { WEBUI_BASE_URL } from '$lib/constants';

	const i18n = getContext('i18n');

	type ChipKind = 'tool_confirmation' | 'clarification';
	type ChipOption = { id: string; label: string; style?: 'primary' | 'secondary' | 'danger' };

	export let card: {
		hash: string;
		// tool-confirmation fields (kept for back-compat with old payloads)
		tool_name?: string;
		mcp?: string;
		summary?: string;
		args_preview?: Record<string, unknown>;
		modify_payload?: string;
		// generic chip fields (Phase 3 — optional so old payloads still work)
		kind?: ChipKind;
		prompt?: string;
		options?: ChipOption[];
		allow_freeform?: boolean;
		context?: Record<string, unknown>;
		// renderer-side state machine (managed by Chat.svelte)
		state?: 'pending' | 'approved' | 'cancelled' | 'modify-submitted' | 'resolved';
		// resolved option id for clarification chips so the resolved badge
		// can show the user which button they picked
		resolved_option_id?: string;
		freeform_payload?: string;
	};
	export let chatId: string;
	export let index: number = 1;
	export let total: number = 1;
	export let disabled: boolean = false;

	const dispatch = createEventDispatcher<{
		decision: {
			// Legacy field — present for old listeners that branch on
			// approve/cancel/modify. For clarification chips it is empty.
			decision: 'approve' | 'cancel' | 'modify' | '';
			// Generic field — always populated, mirrors the chip's
			// declared option id.
			option_id: string;
			hash: string;
			payload?: string;
			ok: boolean;
		};
	}>();

	let argsExpanded = false;
	let modifyOpen = false;
	let modifyText = '';
	let inflight = false;
	let modifyTextarea: HTMLTextAreaElement | null = null;

	// ----- Derived view-model ---------------------------------------------
	// The data layer is permissive: callers may omit ``kind`` / ``options``
	// when they're sending the historical tool-confirmation payload. Fill
	// in defaults that mirror the gate's backend defaults so the renderer
	// always has a complete option set to iterate over.

	$: chipKind = (card.kind ?? 'tool_confirmation') as ChipKind;
	$: defaultToolConfirmationOptions = [
		{ id: 'approve', label: $i18n.t('Yes, do it'), style: 'primary' as const },
		{ id: 'cancel', label: $i18n.t('No'), style: 'secondary' as const },
		{ id: 'modify', label: $i18n.t('Reply with changes'), style: 'secondary' as const }
	];
	$: chipOptions = (card.options && card.options.length > 0
		? card.options
		: defaultToolConfirmationOptions) as ChipOption[];
	$: allowFreeform = card.allow_freeform ?? chipKind === 'tool_confirmation';
	$: chipPrompt = card.prompt || card.summary || '';

	// For tool-confirmation chips, the "modify" button opens an inline
	// textarea instead of immediately resolving. For clarification chips,
	// the freeform textarea (if allowed) is a separate option distinct
	// from any of the declared buttons.
	$: hasModifyButton =
		chipKind === 'tool_confirmation' && chipOptions.some((opt) => opt.id === 'modify');

	function previewEntries() {
		if (!card.args_preview || typeof card.args_preview !== 'object') {
			return [] as Array<[string, unknown]>;
		}
		return Object.entries(card.args_preview).slice(0, 24);
	}

	function formatPreviewValue(value: unknown): string {
		if (value === null || value === undefined) {
			return '\u2014';
		}
		if (typeof value === 'string') {
			return value;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	async function postResolve(optionId: string, freeformPayload?: string): Promise<boolean> {
		// Per-chip resolve through the dedicated REST endpoint. Side effects:
		// the gate updates ``_approved`` / drops from ``_pending`` and records
		// a ``ResolutionRecord`` to be drained on the next batch-send chat
		// turn (which the parent fires once every chip is in a terminal
		// state). Threat model: the endpoint requires an authenticated user
		// AND verifies chat ownership via ``Chats.get_chat_by_id_and_user_id``,
		// so a forged ``chat_id`` cannot land an approval against another
		// user's pending action.
		try {
			const token =
				typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
			const res = await fetch(`${WEBUI_BASE_URL}/api/v1/utils/chip/resolve`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {})
				},
				body: JSON.stringify({
					chat_id: chatId,
					hash: card.hash,
					option_id: optionId,
					...(freeformPayload ? { freeform_payload: freeformPayload } : {})
				})
			});
			if (!res.ok) {
				console.error('[ToolConfirmationChip] resolve failed', res.status, await res.text());
				return false;
			}
			const body = await res.json().catch(() => null);
			return Boolean(body && body.ok);
		} catch (error) {
			console.error('[ToolConfirmationChip] resolve fetch threw', error);
			return false;
		}
	}

	function legacyDecisionFor(optionId: string): 'approve' | 'cancel' | 'modify' | '' {
		// Translate canonical tool-confirmation option ids into the legacy
		// ``decision`` vocabulary so old listeners that branch on it still
		// work. Generic chips emit ``''`` and listeners are expected to
		// read ``option_id`` instead.
		if (chipKind !== 'tool_confirmation') return '';
		if (optionId === 'approve' || optionId === 'cancel' || optionId === 'modify') {
			return optionId;
		}
		return '';
	}

	async function selectOption(option: ChipOption) {
		if (disabled || inflight || card.state !== 'pending') return;
		// Tool-confirmation "modify" opens the inline textarea instead of
		// resolving — lets the user type a freeform tweak before posting.
		if (chipKind === 'tool_confirmation' && option.id === 'modify') {
			await openModify();
			return;
		}
		inflight = true;
		const ok = await postResolve(option.id);
		inflight = false;
		dispatch('decision', {
			decision: legacyDecisionFor(option.id),
			option_id: option.id,
			hash: card.hash,
			ok
		});
	}

	async function openModify() {
		if (disabled || inflight || card.state !== 'pending') return;
		modifyOpen = true;
		await tick();
		modifyTextarea?.focus();
	}

	function closeModify() {
		modifyOpen = false;
		modifyText = '';
	}

	async function submitModify() {
		const trimmed = modifyText.trim();
		if (!trimmed || disabled || inflight || card.state !== 'pending') return;
		inflight = true;
		// On a tool-confirmation chip, the textarea always represents the
		// "modify" option. On a clarification chip with allow_freeform, the
		// freeform answer is a special id "freeform" that the proposer
		// declared in its option set OR (if the proposer didn't declare it)
		// we fall back to the first option in the set as the freeform
		// carrier — clarifications that need freeform should declare an
		// explicit option for it.
		const optionId =
			chipKind === 'tool_confirmation'
				? 'modify'
				: chipOptions.find((opt) => opt.id === 'freeform')?.id ?? chipOptions[0]?.id ?? 'freeform';
		const ok = await postResolve(optionId, trimmed);
		inflight = false;
		if (ok) {
			modifyOpen = false;
		}
		dispatch('decision', {
			decision: legacyDecisionFor(optionId),
			option_id: optionId,
			hash: card.hash,
			payload: trimmed,
			ok
		});
	}

	function onKeydown(event: KeyboardEvent, action: () => void) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			action();
		}
	}

	function onModifyKeydown(event: KeyboardEvent) {
		// Cmd/Ctrl+Enter sends; bare Enter inserts newline (multi-line edits
		// are common — "make it shorter and friendlier").
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submitModify();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			closeModify();
		}
	}

	function buttonClassFor(style: ChipOption['style']): string {
		// Map style hints to Tailwind classes. ``primary`` keeps the
		// historical emerald approve-button look; ``danger`` (e.g.
		// out-of-scope "Block") is rendered red so it visually screams
		// caution; ``secondary`` is the neutral outlined button.
		if (style === 'primary') {
			return 'rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50';
		}
		if (style === 'danger') {
			return 'rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50';
		}
		return 'rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-white/15 dark:text-slate-200 dark:hover:bg-white/5';
	}
</script>

<div
	class="tool-confirmation-chip rounded-2xl border border-amber-300/80 bg-white/85 px-3 py-2 text-left text-slate-900 transition dark:border-amber-500/30 dark:bg-gray-900/55 dark:text-slate-100"
	data-state={card.state ?? 'pending'}
	data-hash={card.hash}
	data-kind={chipKind}
	data-test-id="tool-confirmation-chip"
	role="region"
	aria-label={chipKind === 'clarification'
		? $i18n.t('Action needed')
		: $i18n.t('Tool action awaiting confirmation')}
>
	<div class="tool-confirmation-chip__header flex items-center justify-between gap-3">
		<div class="min-w-0 flex-1">
			<div
				class="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400"
			>
				{#if chipKind === 'clarification'}
					<span class="text-amber-700 dark:text-amber-200">{$i18n.t('Action needed')}</span>
				{:else}
					<span class="text-amber-700 dark:text-amber-200">{$i18n.t('Confirm action')}</span>
					<span class="flex flex-wrap items-center gap-1 normal-case tracking-normal">
						<span>{card.mcp || $i18n.t('unknown')}</span>
						<span class="text-slate-400 dark:text-slate-500">·</span>
						<code class="rounded bg-slate-100/80 px-1 py-0.5 text-[10px] dark:bg-black/30"
							>{card.tool_name}</code
						>
					</span>
				{/if}
			</div>
		</div>
		<div
			class="tool-confirmation-chip__count rounded-full border border-amber-200/80 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
		>
			{total > 1 ? `${index} / ${total}` : '1'}
		</div>
	</div>

	<p
		class="tool-confirmation-chip__summary mt-2 text-sm leading-snug text-slate-800 dark:text-slate-200"
		style="white-space: pre-wrap;"
	>
		{chipPrompt}
	</p>

	{#if chipKind === 'tool_confirmation' && previewEntries().length > 0}
		<button
			type="button"
			class="tool-confirmation-chip__toggle mt-1 text-[11px] text-slate-500 underline dark:text-slate-400"
			aria-expanded={argsExpanded}
			on:click={() => (argsExpanded = !argsExpanded)}
		>
			{argsExpanded ? $i18n.t('Hide arguments') : $i18n.t('Show arguments')}
		</button>
		{#if argsExpanded}
			<dl
				class="tool-confirmation-chip__args mt-1 rounded-lg bg-slate-100/60 px-2 py-1 text-[11px] dark:bg-black/20"
			>
				{#each previewEntries() as [key, value]}
					<div class="grid grid-cols-[minmax(6rem,max-content)_1fr] items-baseline gap-x-2">
						<dt class="font-semibold text-slate-600 dark:text-slate-300">{key}</dt>
						<dd class="break-words"><code>{formatPreviewValue(value)}</code></dd>
					</div>
				{/each}
			</dl>
		{/if}
	{/if}

	{#if modifyOpen && card.state === 'pending'}
		<!--
			Inline per-chip "Reply with changes" textarea. This is bound to the
			specific chip via closure; typing here does NOT touch the global
			chat input. Cmd/Ctrl+Enter submits (sends the modify payload to
			the gate via REST); Escape cancels and reopens the Yes/No buttons.
		-->
		<div class="tool-confirmation-chip__modify mt-2 flex flex-col gap-1">
			<textarea
				bind:this={modifyTextarea}
				bind:value={modifyText}
				placeholder={$i18n.t(
					'Describe the change (e.g. "use #different-channel instead", "make it shorter")'
				)}
				disabled={inflight}
				rows={2}
				class="rounded-md border border-amber-300/70 bg-white/80 px-2 py-1 text-sm text-slate-900 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50 dark:border-amber-400/30 dark:bg-gray-800/60 dark:text-slate-100"
				on:keydown={onModifyKeydown}
				data-test-id="tool-confirmation-chip-modify-textarea"
			/>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="rounded-full bg-amber-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-amber-500 disabled:opacity-50"
					disabled={inflight || !modifyText.trim()}
					on:click={submitModify}
					data-test-id="tool-confirmation-chip-modify-submit"
				>
					{$i18n.t('Send changes')}
				</button>
				<button
					type="button"
					class="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-white/5"
					disabled={inflight}
					on:click={closeModify}
					data-test-id="tool-confirmation-chip-modify-cancel"
				>
					{$i18n.t('Back')}
				</button>
				<span class="text-[11px] text-slate-500 dark:text-slate-400">
					{$i18n.t('⌘/Ctrl + Enter to send')}
				</span>
			</div>
		</div>
	{:else}
		<div class="tool-confirmation-chip__actions mt-2 flex flex-wrap items-center gap-2">
			{#if card.state === 'approved'}
				<span
					class="tool-confirmation-chip__status tool-confirmation-chip__status--approved rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-100"
				>
					{$i18n.t('Approved')}
				</span>
			{:else if card.state === 'cancelled'}
				<span
					class="tool-confirmation-chip__status tool-confirmation-chip__status--cancelled rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-500/20 dark:text-slate-200"
				>
					{$i18n.t('Cancelled')}
				</span>
			{:else if card.state === 'modify-submitted'}
				<span
					class="tool-confirmation-chip__status tool-confirmation-chip__status--modified rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-100"
					title={card.modify_payload || card.freeform_payload || ''}
				>
					{$i18n.t('Modify')}{(card.modify_payload || card.freeform_payload)
						? `: ${card.modify_payload || card.freeform_payload}`
						: ''}
				</span>
			{:else if card.state === 'resolved'}
				<!--
					Generic terminal state used by clarification chips. The
					option label is looked up from the chip's own option set
					so the tooltip / display always matches what the user
					clicked, even after the chip is locked.
				-->
				<span
					class="tool-confirmation-chip__status tool-confirmation-chip__status--resolved rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-100"
				>
					{$i18n.t('Resolved')}: {chipOptions.find((o) => o.id === card.resolved_option_id)?.label ??
						card.resolved_option_id ??
						''}
				</span>
			{:else}
				{#each chipOptions as option, optIdx (option.id)}
					<button
						type="button"
						class={`tool-confirmation-chip__btn tool-confirmation-chip__btn--${option.id} ${buttonClassFor(
							option.style ?? (optIdx === 0 ? 'primary' : 'secondary')
						)}`}
						disabled={disabled || inflight}
						on:click={() => selectOption(option)}
						on:keydown={(e) => onKeydown(e, () => selectOption(option))}
						data-option-id={option.id}
						data-test-id={`tool-confirmation-chip-option-${option.id}`}
					>
						{option.label}
					</button>
				{/each}
				{#if chipKind === 'clarification' && allowFreeform}
					<button
						type="button"
						class="tool-confirmation-chip__btn tool-confirmation-chip__btn--edit rounded-full px-2 py-1 text-xs font-medium text-slate-500 underline transition hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-100"
						disabled={disabled || inflight}
						on:click={openModify}
						data-test-id="tool-confirmation-chip-freeform"
					>
						{$i18n.t('Custom answer')}
					</button>
				{/if}
			{/if}
		</div>
	{/if}
</div>
