<script lang="ts">
    import { get } from 'svelte/store';
    import { createEventDispatcher, onMount } from 'svelte';
    import { generateMnemonic, validateMnemonic } from '../utils/crypto';
    import { copyToClipboard } from '../utils/web-share';
    import { translations as LL } from '$lib/i18n/runtime';

    const dispatch = createEventDispatcher<{
        'create-chat': { name: string; key: string };
        'go-back': void;
        'show-toast': { message: string; type?: 'info' | 'success' | 'error' };
    }>();

    let dialogRef: HTMLDialogElement;
    const titleId = `chat-setup-title-${Math.random().toString(36).slice(2)}`;
    const descriptionId = `chat-setup-description-${Math.random().toString(36).slice(2)}`;

    let contactName = '';
    let keyMode: 'generate' | 'manual' = 'generate';
    let generatedMnemonic = generateMnemonic();
    let manualKey = '';

    $: isValid =
        contactName.trim() &&
        (keyMode === 'generate' || (keyMode === 'manual' && validateMnemonic(manualKey.trim())));

    onMount(() => {
        if (dialogRef && !dialogRef.open) {
            dialogRef.showModal();
        }
    });

    function regenerateKey() {
        generatedMnemonic = generateMnemonic();
    }

    async function copyMnemonic(text: string) {
        const result = await copyToClipboard(text);
        if (result) {
            dispatch('show-toast', { message: get(LL).chatSetupCopySuccess(), type: 'success' });
        } else {
            dispatch('show-toast', { message: get(LL).chatSetupCopyError(), type: 'error' });
        }
    }

    function createChat() {
        if (!isValid) return;

        const key = keyMode === 'generate' ? generatedMnemonic : manualKey.trim();
        dispatch('create-chat', {
            name: contactName.trim(),
            key,
        });
    }

    function goBack() {
        if (dialogRef?.open) {
            dialogRef.close();
        }
        dispatch('go-back');
    }

    function handleDialogCancel(event: Event) {
        event.preventDefault();
        goBack();
    }

    function handleDialogPointerDown(event: PointerEvent) {
        if (event.target === dialogRef) {
            goBack();
        }
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    aria-modal="true"
    on:cancel|preventDefault={handleDialogCancel}
    on:pointerdown={handleDialogPointerDown}
>
    <div class="dialog__header">
        <h2 id={titleId} class="dialog__title">{$LL.chatSetupTitle()}</h2>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={goBack}
            aria-label={$LL.chatSetupCloseButton()}
        >
            ×
        </button>
    </div>
    <div class="dialog__body">
        <p class="description" id={descriptionId}>{$LL.chatSetupDescription()}</p>

        <div class="form-group">
            <label for="contact-name">{$LL.chatSetupContactLabel()}</label>
            <input
                id="contact-name"
                type="text"
                bind:value={contactName}
                placeholder={$LL.chatSetupContactPlaceholder()}
                class="input"
            />
        </div>

        <div class="form-group">
            <fieldset>
                <legend>{$LL.chatSetupKeyLegend()}</legend>
                <div class="key-options">
                    <label class="radio-option" class:active={keyMode === 'generate'}>
                        <input type="radio" bind:group={keyMode} value="generate" />
                        <span class="radio-content">
                            <span class="radio-title">{$LL.chatSetupGenerateLabel()}</span>
                            <span class="radio-description"
                                >{$LL.chatSetupGenerateDescription()}</span
                            >
                        </span>
                    </label>
                    <label class="radio-option" class:active={keyMode === 'manual'}>
                        <input type="radio" bind:group={keyMode} value="manual" />
                        <span class="radio-content">
                            <span class="radio-title">{$LL.chatSetupManualLabel()}</span>
                            <span class="radio-description">{$LL.chatSetupManualDescription()}</span
                            >
                        </span>
                    </label>
                </div>
            </fieldset>
        </div>

        {#if keyMode === 'generate'}
            <div class="key-display">
                <div class="key-header">
                    <span>{$LL.chatSetupBackupLabel()}</span>
                </div>

                <div class="mnemonic-display" aria-live="polite">
                    {generatedMnemonic}
                </div>
                <div class="key-actions">
                    <button
                        type="button"
                        class="btn btn--secondary"
                        on:click={() => copyMnemonic(generatedMnemonic)}
                    >
                        {$LL.chatSetupCopySecondary()}
                    </button>
                    <button type="button" class="btn btn--secondary" on:click={regenerateKey}>
                        {$LL.chatSetupGenerateButton()}
                    </button>
                </div>

                <div class="warning">
                    {$LL.chatSetupWarning()}
                </div>
            </div>
        {:else}
            <div class="form-group">
                <label for="manual-key">{$LL.chatSetupManualPhraseLabel()}</label>
                <textarea
                    id="manual-key"
                    bind:value={manualKey}
                    placeholder={$LL.chatSetupManualPlaceholder()}
                    class="input"
                    rows="3"
                ></textarea>
                {#if manualKey.trim() && !validateMnemonic(manualKey.trim())}
                    <div class="error" role="alert">{$LL.chatSetupManualError()}</div>
                {/if}
            </div>
        {/if}
    </div>
    <div class="dialog__footer">
        <button type="button" class="btn btn--primary" disabled={!isValid} on:click={createChat}>
            {$LL.chatSetupSubmit()}
        </button>
    </div>
</dialog>

<style>
    .dialog__body {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .description {
        color: var(--color-text-muted);
        margin: 0;
    }

    label {
        display: block;
        font-weight: 600;
        margin-bottom: 0.5rem;
        color: var(--color-text);
    }

    fieldset {
        border: none;
        padding: 0;
        margin: 0;
    }

    legend {
        font-weight: 600;
        margin-bottom: 0.5rem;
        color: var(--color-text);
        padding: 0;
    }

    .key-options {
        display: flex;
        gap: 1rem;
        margin-top: 0.5rem;
    }

    .radio-option {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.75rem 1rem;
        border: 2px solid var(--color-border);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s;
        flex: 1;
    }

    .radio-option.active {
        border-color: #006de2;
        background: color-mix(in srgb, #006de2 8%, var(--color-bg));
    }

    .radio-option input[type='radio'] {
        margin: 0.2rem 0 0;
    }

    .radio-content {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }

    .radio-title {
        font-weight: 600;
        color: var(--color-text);
    }

    .radio-description {
        color: var(--color-text-muted);
        font-size: 0.9rem;
        line-height: 1.4;
    }

    .key-display {
        background: var(--color-bg-subtle);
        border-radius: 8px;
        padding: 1rem;
    }

    .key-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
    }

    .mnemonic-display {
        background: var(--color-bg);
        border: 2px solid var(--color-border);
        border-radius: 8px;
        padding: 1rem;
        font-family: 'Courier New', monospace;
        word-spacing: 0.5rem;
        line-height: 1.5;
        margin-bottom: 1rem;
    }

    .key-actions {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 1rem;
    }

    .key-actions :global(.btn) {
        font-size: 0.9rem;
    }

    .warning {
        background: color-mix(in srgb, #fbbf24 12%, var(--color-bg));
        color: var(--color-text);
        padding: 0.75rem;
        border-radius: 6px;
        border-left: 4px solid #ffc107;
        font-size: 0.9rem;
    }

    .error {
        color: var(--color-danger-text);
        font-size: 0.9rem;
        margin-top: 0.25rem;
    }

    @media (max-width: 600px) {
        .key-options {
            flex-direction: column;
        }

        .key-actions {
            flex-direction: column;
        }
    }
</style>
