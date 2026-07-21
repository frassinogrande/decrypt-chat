<script lang="ts">
    import { debug } from '$lib/utils/debug';
    import { get } from 'svelte/store';
    import { createEventDispatcher, onMount } from 'svelte';
    import { generateMnemonic, validateMnemonic } from '../utils/crypto';
    import { chatStorage } from '../utils/chat-storage';
    import { copyToClipboard as copyTextToClipboard } from '../utils/web-share';
    import { translations as LL } from '$lib/i18n/runtime';

    export let chatId: string;

    const dispatch = createEventDispatcher<{
        'key-rotated': void;
        close: void;
        'show-toast': { message: string; type?: 'info' | 'success' | 'error' };
    }>();

    let dialogRef: HTMLDialogElement;
    const titleId = `regen-key-title-${Math.random().toString(36).slice(2)}`;

    let keyMode: 'generate' | 'manual' = 'generate';
    let generatedMnemonic = generateMnemonic();
    let manualKey = '';
    let isRotating = false;
    let rotationDone = 0;
    let rotationTotal = 0;
    // Screen-reader progress line. Announced at most every 10 items (or on
    // completion) so assistive tech isn't flooded during long rotations.
    let progressAnnouncement = '';

    $: isValid =
        !isRotating &&
        (keyMode === 'generate' || (keyMode === 'manual' && validateMnemonic(manualKey.trim())));

    onMount(() => {
        if (dialogRef && !dialogRef.open) {
            dialogRef.showModal();
        }
    });

    function regenerateKey() {
        generatedMnemonic = generateMnemonic();
    }

    async function copyToClipboard(text: string) {
        const ok = await copyTextToClipboard(text);
        if (ok) {
            dispatch('show-toast', { message: get(LL).chatSetupCopySuccess(), type: 'success' });
        } else {
            dispatch('show-toast', { message: get(LL).chatSetupCopyError(), type: 'error' });
        }
    }

    async function useNewKey() {
        if (!isValid) return;
        const mnemonic = keyMode === 'generate' ? generatedMnemonic : manualKey.trim();
        isRotating = true;
        rotationDone = 0;
        rotationTotal = 0;
        progressAnnouncement = '';
        try {
            await chatStorage.rotateConversationKey(chatId, mnemonic, (done, total) => {
                rotationDone = done;
                rotationTotal = total;
                if (done === total || done % 10 === 0) {
                    progressAnnouncement = get(LL).regenKeyProgress({ done, total });
                }
            });
            dispatch('show-toast', { message: get(LL).regenKeySuccess(), type: 'success' });
            dispatch('key-rotated');
        } catch (error) {
            debug.error('Key rotation failed:', error);
            dispatch('show-toast', { message: get(LL).regenKeyError(), type: 'error' });
        } finally {
            isRotating = false;
        }
    }

    function close() {
        if (dialogRef?.open) dialogRef.close();
        dispatch('close');
    }

    function handleDialogCancel(event: Event) {
        event.preventDefault();
        if (!isRotating) close();
    }

    function handleDialogPointerDown(event: PointerEvent) {
        if (event.target === dialogRef && !isRotating) close();
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    aria-labelledby={titleId}
    aria-modal="true"
    style="--modal-width: min(560px, 92vw);"
    on:cancel|preventDefault={handleDialogCancel}
    on:pointerdown={handleDialogPointerDown}
>
    <div class="dialog__header">
        <h2 id={titleId} class="dialog__title">{$LL.regenKeyTitle()}</h2>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={close}
            disabled={isRotating}
            aria-label={$LL.regenKeyCloseButton()}
        >
            ×
        </button>
    </div>
    <div class="dialog__body" aria-busy={isRotating}>
        <div class="warning-banner" role="alert">
            <strong class="warning-title">{$LL.regenKeyWarningTitle()}</strong>
            <p class="warning-body">{$LL.regenKeyWarningBody()}</p>
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
                        on:click={() => copyToClipboard(generatedMnemonic)}
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
                <label for="regen-manual-key">{$LL.chatSetupManualPhraseLabel()}</label>
                <textarea
                    id="regen-manual-key"
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

        <p class="sr-only" aria-live="polite">{progressAnnouncement}</p>
    </div>
    <div class="dialog__footer">
        <button type="button" class="btn btn--primary" disabled={!isValid} on:click={useNewKey}>
            {isRotating && rotationTotal > 0
                ? `${rotationDone}/${rotationTotal}`
                : isRotating
                  ? '…'
                  : $LL.regenKeySubmit()}
        </button>
        <button type="button" class="btn btn--secondary" on:click={close} disabled={isRotating}>
            {$LL.regenKeyCancel()}
        </button>
    </div>
</dialog>

<style>
    .dialog__body {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .warning-banner {
        background: var(--color-error-bg);
        border-left: 4px solid var(--color-error-border);
        border-radius: 6px;
        padding: 1rem 1.25rem;
    }

    .warning-title {
        display: block;
        color: var(--color-error-text);
        font-size: 0.95rem;
        margin-bottom: 0.4rem;
    }

    .warning-body {
        color: var(--color-error-text);
        font-size: 0.9rem;
        margin: 0;
        line-height: 1.5;
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

    .warning {
        background: #fff3cd;
        color: #856404;
        padding: 0.75rem;
        border-radius: 6px;
        border-left: 4px solid #ffc107;
        font-size: 0.9rem;
    }

    .error {
        color: #dc3545;
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
