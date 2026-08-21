<script lang="ts">
	import { onMount, tick, getContext } from 'svelte';

	import Textarea from '$lib/components/common/Textarea.svelte';
	import { toast } from 'svelte-sonner';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import PromptIcon from './PromptIcon.svelte';
	import { showSidebar } from '$lib/stores';

	export let onSubmit: Function;
	export let edit = false;
	export let prompt = null;
	export let clone = false;
	export let onBack: null | Function = null;

	const i18n = getContext('i18n');

	let loading = false;
	let loaded = false;

	let title = '';
	let command = '';
	let content = '';

	let accessControl = {};
	let hasManualEdit = false;

	$: if (!edit && !hasManualEdit) {
		command = title !== '' ? slugify(title) : '';
	}

	$: primaryActionLabel = edit ? $i18n.t('Save changes') : $i18n.t('Create prompt');
	$: editorHeading = clone
		? $i18n.t('Create a copy')
		: edit
			? $i18n.t('Edit prompt')
			: $i18n.t('Create a reusable prompt');
	$: editorDescription = clone
		? $i18n.t(
				'Start from an existing prompt, then give this copy its own title and slash command.'
			)
		: edit
			? $i18n.t('Keep the instruction clear, useful, and ready to drop into any conversation.')
			: $i18n.t('Turn a great instruction into a shortcut you can use in any chat.');
	$: normalizedCommand = command.trim();
	$: commandPreview = normalizedCommand ? `/${normalizedCommand}` : $i18n.t('/your-command');

	function handleCommandInput() {
		hasManualEdit = true;
	}

	const validateCommandString = (inputString) => {
		const regex = /^[a-zA-Z0-9-_]+$/;
		return regex.test(inputString);
	};

	const submitHandler = async () => {
		if (!validateCommandString(command)) {
			toast.error(
				$i18n.t('Only letters, numbers, hyphens, and underscores are allowed in the command string.')
			);
			return;
		}

		loading = true;
		try {
			await onSubmit({
				title,
				command,
				content,
				access_control: accessControl
			});
		} finally {
			loading = false;
		}
	};

	onMount(async () => {
		if (prompt) {
			title = prompt.title;
			await tick();

			command = prompt.command.at(0) === '/' ? prompt.command.slice(1) : prompt.command;
			content = prompt.content;

			accessControl = prompt?.access_control === undefined ? {} : prompt?.access_control;
		}

		loaded = true;
	});

	function slugify(text) {
		return text
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\s-_]/g, '')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-');
	}
</script>

{#if loaded}
	<div
		class="prompts-editor-page transition-transform duration-200 ease-in-out {$showSidebar
			? ''
			: 'md:-translate-x-[1.625rem]'}"
		data-portico-rail-compensated={$showSidebar ? 'false' : 'true'}
	>
		{#if onBack}
			<button
				class="prompts-editor-back"
				type="button"
				on:click={() => {
					onBack();
				}}
			>
				<svg viewBox="0 0 20 20" fill="currentColor" class="size-4" aria-hidden="true">
					<path
						fill-rule="evenodd"
						d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
						clip-rule="evenodd"
					/>
				</svg>
				<span>{$i18n.t('Back to prompts')}</span>
			</button>
		{/if}

		<section class="prompts-editor-hero">
			<div class="prompts-editor-hero-icon">
				<PromptIcon className="size-7" />
			</div>
			<div>
				<div class="prompts-editor-kicker">{$i18n.t('Prompt library')}</div>
				<h1>{editorHeading}</h1>
				<p>{editorDescription}</p>
			</div>
			<div class="prompts-editor-command-preview">
				<span>{$i18n.t('Slash command')}</span>
				<code>{commandPreview}</code>
			</div>
		</section>

		<form
			class="prompts-editor-form"
			on:submit|preventDefault={() => {
				submitHandler();
			}}
		>
			<section class="prompts-editor-surface">
				<div class="prompts-editor-section">
					<div class="prompts-editor-section-heading">
						<div class="prompts-editor-step">1</div>
						<div>
							<h2>{$i18n.t('Name your prompt')}</h2>
							<p>{$i18n.t('Choose a clear title and a shortcut that will be easy to remember.')}</p>
						</div>
					</div>

					<div class="prompts-editor-fields-grid">
						<label class="prompts-editor-field" for="prompt-title">
							<span>{$i18n.t('Prompt title')}</span>
							<input
								id="prompt-title"
								placeholder={$i18n.t('Weekly project update')}
								bind:value={title}
								required
							/>
						</label>

						<label class="prompts-editor-field" for="prompt-command">
							<span>{$i18n.t('Slash command')}</span>
							<div class="prompts-editor-command-field" class:is-disabled={edit}>
								<span aria-hidden="true">/</span>
								<input
									id="prompt-command"
									placeholder={$i18n.t('weekly-update')}
									bind:value={command}
									on:input={handleCommandInput}
									required
									disabled={edit}
								/>
							</div>
							<small>
								{edit
									? $i18n.t('Slash commands cannot be changed after a prompt is created.')
									: $i18n.t('Use letters, numbers, hyphens, or underscores.')}
							</small>
						</label>
					</div>
				</div>

				<div class="prompts-editor-divider"></div>

				<div class="prompts-editor-section">
					<div class="prompts-editor-section-heading">
						<div class="prompts-editor-step">2</div>
						<div>
							<h2>{$i18n.t('Write the instruction')}</h2>
							<p>{$i18n.t('This is the reusable content that will be inserted into chat.')}</p>
						</div>
					</div>

					<label class="prompts-editor-field prompts-editor-content-field">
						<span>{$i18n.t('Prompt content')}</span>
						<Textarea
							className="prompts-editor-textarea"
							placeholder={$i18n.t('Summarize the latest project updates, decisions, risks, and next steps.')}
							bind:value={content}
							rows={12}
							required
						/>
						<small class="prompts-editor-variable-tip">
							{$i18n.t('Use double braces for variables, for example')}
							<code>{'{{topic}}'}</code>.
						</small>
					</label>
				</div>

				<footer class="prompts-editor-actions">
					{#if onBack}
						<button
							class="prompts-button prompts-button-secondary"
							type="button"
							on:click={() => {
								onBack();
							}}
						>
							{$i18n.t('Cancel')}
						</button>
					{:else}
						<a class="prompts-button prompts-button-secondary" href="/workspace/prompts">
							{$i18n.t('Cancel')}
						</a>
					{/if}

					<button
						class="prompts-button prompts-button-primary"
						type="submit"
						disabled={loading}
					>
						<span>{primaryActionLabel}</span>
						{#if loading}<Spinner className="size-4" />{/if}
					</button>
				</footer>
			</section>
		</form>
	</div>
{:else}
	<div
		class="prompts-management-loading transition-transform duration-200 ease-in-out {$showSidebar
			? ''
			: 'md:-translate-x-[1.625rem]'}"
		data-portico-rail-compensated={$showSidebar ? 'false' : 'true'}
	>
		<Spinner className="size-5" />
	</div>
{/if}
