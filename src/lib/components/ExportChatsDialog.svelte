<script lang="ts">
    import { createEventDispatcher, onMount } from 'svelte';
    import { get } from 'svelte/store';
    import { translations as LL } from '$lib/i18n/runtime';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { chatsStore } from '../stores/app';
    import { profileManager } from '../utils/profile-manager';
    import { exportChats, downloadBlob } from '../utils/chat-export';
    import { debug } from '../utils/debug';

    const dispatch = createEventDispatcher();

    let dialogRef: HTMLDialogElement;
    const titleId = `export-chats-title-${Math.random().toString(36).slice(2, 10)}`;
    const descriptionId = `export-chats-description-${Math.random().toString(36).slice(2, 10)}`;

    let selectedIds = new Set<string>();
    let isExporting = false;
    let exportError = '';

    $: chats = $chatsStore;
    $: selectedCount = selectedIds.size;
    $: allSelected = chats.length > 0 && selectedCount === chats.length;

    onMount(() => {
        if (dialogRef && !dialogRef.open) {
            dialogRef.showModal();
        }
    });

    function toggleChat(chatId: string) {
        if (selectedIds.has(chatId)) {
            selectedIds.delete(chatId);
        } else {
            selectedIds.add(chatId);
        }
        selectedIds = selectedIds;
    }

    function toggleAll() {
        selectedIds = allSelected ? new Set() : new Set(chats.map((c) => c.id));
    }

    async function performExport() {
        if (selectedCount === 0 || isExporting) return;
        exportError = '';
        isExporting = true;
        try {
            const selectedChats = chats.filter((c) => selectedIds.has(c.id));
            const profile = get(profileManager.profile);
            const ownName = profile?.name?.trim() || get(LL).exportChatsOwnSenderFallback();
            const { blob, fileName } = await exportChats(selectedChats, ownName);
            downloadBlob(blob, fileName);
            dispatch('exported');
            handleClose();
        } catch (error) {
            debug.error('Chat export failed:', error);
            exportError = get(LL).exportChatsError();
        } finally {
            isExporting = false;
        }
    }

    function handleClose() {
        if (isExporting) return;
        dialogRef?.close();
        dispatch('close');
    }

    function handleDialogCancel(event: Event) {
        event.preventDefault();
        handleClose();
    }

    function handleDialogPointerDown(event: PointerEvent) {
        if (event.target === dialogRef) {
            handleClose();
        }
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    on:cancel|preventDefault={handleDialogCancel}
    on:pointerdown={handleDialogPointerDown}
    aria-modal="true"
    style="--modal-width: min(520px, 92vw)"
>
    <div class="dialog__header">
        <h3 id={titleId} class="dialog__title">{$LL.exportChatsTitle()}</h3>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={handleClose}
            aria-label={$LL.exportChatsCloseAria()}>×</button
        >
    </div>

    <div class="dialog__body">
        <p class="export-description" id={descriptionId}>{$LL.exportChatsDescription()}</p>

        {#if exportError}
            <div class="error-message" role="alert">{exportError}</div>
        {/if}

        {#if chats.length === 0}
            <div class="no-chats">
                <div class="no-chats-icon">
                    <Icon name="chat" size={56} className="no-chats-icon-graphic" />
                </div>
                <p>{$LL.exportChatsEmpty()}</p>
            </div>
        {:else}
            <div class="selection-toolbar">
                <button
                    type="button"
                    class="btn btn--secondary select-all-btn"
                    on:click={toggleAll}
                    disabled={isExporting}
                >
                    {allSelected ? $LL.exportChatsDeselectAll() : $LL.exportChatsSelectAll()}
                </button>
                <span class="selection-count" aria-live="polite">
                    {$LL.exportChatsSelectedCount({
                        selected: selectedCount,
                        total: chats.length,
                    })}
                </span>
            </div>

            <div class="chat-list" role="group" aria-labelledby={titleId}>
                {#each chats as chat (chat.id)}
                    <label class="chat-option" class:selected={selectedIds.has(chat.id)}>
                        <input
                            type="checkbox"
                            checked={selectedIds.has(chat.id)}
                            on:change={() => toggleChat(chat.id)}
                            disabled={isExporting}
                        />
                        <span class="chat-avatar" aria-hidden="true">
                            {chat.name.charAt(0).toUpperCase()}
                        </span>
                        <span class="chat-name">{chat.name}</span>
                    </label>
                {/each}
            </div>
        {/if}
    </div>

    <div class="dialog__footer">
        <button
            type="button"
            class="btn btn--secondary"
            on:click={handleClose}
            disabled={isExporting}>{$LL.profileSetupCancel()}</button
        >
        <button
            type="button"
            class="btn btn--primary"
            on:click={performExport}
            disabled={isExporting || selectedCount === 0}
        >
            {isExporting ? $LL.exportChatsExporting() : $LL.exportChatsAction()}
        </button>
    </div>
</dialog>

<style lang="scss">
    .error-message {
        background: var(--color-error-bg);
        border: 1px solid var(--color-error-border);
        color: var(--color-error-text);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        margin-bottom: 1rem;
        font-size: 0.9rem;
    }

    .export-description {
        margin: 0 0 1.5rem;
        line-height: 1.5;
    }

    .selection-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1.25rem;
    }

    .selection-toolbar :global(.select-all-btn) {
        --btn-padding: 0.4rem 0.9rem;
    }

    .selection-count {
        font-size: 0.85rem;
        color: var(--color-text-muted);
        font-variant-numeric: tabular-nums;
    }

    .chat-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        max-height: 300px;
        overflow-y: auto;
    }

    .chat-option {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.75rem 1rem;
        border: 1px solid var(--color-border);
        border-radius: 12px;
        background: var(--color-bg-subtle);
        cursor: pointer;

        &:hover {
            background: color-mix(in srgb, var(--color-accent-text) 8%, var(--color-bg));
        }

        &.selected {
            border-color: #006de2;
            background: color-mix(in srgb, #006de2 10%, var(--color-bg));
        }

        input[type='checkbox'] {
            flex-shrink: 0;
            width: 1.1rem;
            height: 1.1rem;
            accent-color: #006de2;
            cursor: pointer;
        }
    }

    .chat-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #006de2;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 1.1rem;
        flex-shrink: 0;
    }

    .chat-name {
        font-weight: 600;
        color: var(--color-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .no-chats {
        text-align: center;
        padding: 2rem;
        color: var(--color-text-muted);
    }

    .no-chats-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 3.5rem;
        height: 3.5rem;
        margin: 0 auto 1rem;
        opacity: 0.5;
    }

    .no-chats-icon :global(.no-chats-icon-graphic) {
        width: 100%;
        height: 100%;
    }
</style>
