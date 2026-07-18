<script lang="ts">
    import { debug } from '$lib/utils/debug';
    import { createEventDispatcher, onMount } from 'svelte';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { calculateContactStorageUsage, formatStorageSize } from '../utils/contact-stats';
    import { translations as LL } from '$lib/i18n/runtime';
    import { resolveAppLabel } from '$lib/config/contact-apps';
    import type { ContactStorageStats } from '../utils/contact-stats';

    export let contactName: string;
    export let contactId: string;
    export let sharedProfile: any = null;

    const dispatch = createEventDispatcher();

    let dialogRef: HTMLDialogElement;
    let deleteDialogRef: HTMLDialogElement;
    let clearDialogRef: HTMLDialogElement;
    const titleId = `contact-info-title-${Math.random().toString(36).slice(2, 10)}`;
    const deleteTitleId = `contact-delete-title-${Math.random().toString(36).slice(2, 10)}`;
    const deleteDescriptionId = `contact-delete-description-${Math.random().toString(36).slice(2, 10)}`;
    const clearTitleId = `contact-clear-title-${Math.random().toString(36).slice(2, 10)}`;
    const clearDescriptionId = `contact-clear-description-${Math.random().toString(36).slice(2, 10)}`;

    let isEditingName = false;
    let editedName = contactName;
    let storageStats: ContactStorageStats | null = null;
    let isLoadingStats = true;
    let showDeleteConfirm = false;
    let showClearConfirm = false;

    onMount(async () => {
        if (dialogRef && !dialogRef.open) {
            dialogRef.showModal();
        }
        await loadStorageStats();
    });

    $: if (deleteDialogRef) {
        if (showDeleteConfirm && !deleteDialogRef.open) {
            try {
                deleteDialogRef.showModal();
            } catch (error) {
                debug.error('Failed to open delete chat dialog', error);
            }
        } else if (!showDeleteConfirm && deleteDialogRef.open) {
            deleteDialogRef.close();
        }
    }

    $: if (clearDialogRef) {
        if (showClearConfirm && !clearDialogRef.open) {
            try {
                clearDialogRef.showModal();
            } catch (error) {
                debug.error('Failed to open clear chat dialog', error);
            }
        } else if (!showClearConfirm && clearDialogRef.open) {
            clearDialogRef.close();
        }
    }

    async function loadStorageStats() {
        isLoadingStats = true;
        try {
            storageStats = await calculateContactStorageUsage(contactId);
        } catch (error) {
            debug.error('Failed to load storage stats:', error);
        } finally {
            isLoadingStats = false;
        }
    }

    function handleClose() {
        showDeleteConfirm = false;
        showClearConfirm = false;
        deleteDialogRef?.close();
        clearDialogRef?.close();
        dialogRef?.close();
        dispatch('close');
    }

    function startEditingName() {
        isEditingName = true;
        editedName = contactName;
    }

    function cancelEditingName() {
        isEditingName = false;
        editedName = contactName;
    }

    function saveName() {
        if (editedName.trim() && editedName.trim() !== contactName) {
            dispatch('update-name', { newName: editedName.trim() });
        }
        isEditingName = false;
    }

    function handleNameKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            saveName();
        } else if (event.key === 'Escape') {
            cancelEditingName();
        }
    }

    function showDeleteChat() {
        showDeleteConfirm = true;
    }

    function confirmDeleteChat() {
        deleteDialogRef?.close();
        showDeleteConfirm = false;
        dispatch('delete-chat');
    }

    function cancelDeleteChat(event?: Event) {
        event?.preventDefault();
        showDeleteConfirm = false;
        deleteDialogRef?.close();
    }

    function showClearChat() {
        showClearConfirm = true;
    }

    function confirmClearChat() {
        clearDialogRef?.close();
        showClearConfirm = false;
        dispatch('clear-chat');
    }

    function cancelClearChat(event?: Event) {
        event?.preventDefault();
        showClearConfirm = false;
        clearDialogRef?.close();
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

    function handleDeleteDialogPointerDown(event: PointerEvent) {
        if (event.target === deleteDialogRef) {
            cancelDeleteChat(event);
        }
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    aria-labelledby={titleId}
    on:cancel|preventDefault={handleDialogCancel}
    on:pointerdown={handleDialogPointerDown}
    aria-modal="true"
>
    <div class="dialog__header">
        <h3 id={titleId} class="dialog__title">{$LL.contactInfoTitle()}</h3>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={handleClose}
            aria-label={$LL.contactInfoCloseAria()}>×</button
        >
    </div>

    <div class="dialog__body">
        <div class="section">
            <div class="section-header">
                <h4>{$LL.contactInfoDetailsHeading()}</h4>
            </div>
            <div class="name-container">
                {#if isEditingName}
                    <input
                        type="text"
                        bind:value={editedName}
                        on:keydown={handleNameKeydown}
                        on:blur={saveName}
                        class="input"
                        placeholder={$LL.contactInfoNamePlaceholder()}
                        aria-label={$LL.contactInfoNameLabel()}
                        maxlength="50"
                    />
                    <div class="name-actions">
                        <button type="button" class="btn btn--primary" on:click={saveName}
                            >{$LL.contactInfoSaveNameButton()}</button
                        >
                        <button
                            type="button"
                            class="btn btn--secondary"
                            on:click={cancelEditingName}>{$LL.contactInfoCancelEditButton()}</button
                        >
                    </div>
                {:else}
                    <div class="name-display">
                        <span class="contact-name">{contactName}</span>
                        <button
                            type="button"
                            class="btn btn--secondary"
                            on:click={startEditingName}
                            title={$LL.contactInfoEditNameTooltip()}
                            aria-label={$LL.contactInfoEditNameTooltip()}
                            ><Icon name="edit" size={18} /></button
                        >
                    </div>
                {/if}
            </div>
        </div>

        {#if sharedProfile}
            <div class="section">
                <div class="section-header">
                    <h4>{$LL.contactInfoSharedHeading()}</h4>
                </div>
                <div class="shared-info-container">
                    {#if sharedProfile.contacts && sharedProfile.contacts.length > 0}
                        {#each sharedProfile.contacts as contact}
                            <div class="shared-field">
                                <div class="field-label">{resolveAppLabel(contact, $LL)}</div>
                                <div class="field-value">{contact.value}</div>
                            </div>
                        {/each}
                    {:else}
                        <div class="shared-field">
                            <div class="field-value">
                                <span class="not-shared">{$LL.contactInfoNoContactsShared()}</span>
                            </div>
                        </div>
                    {/if}
                </div>
            </div>
        {/if}

        <div class="section">
            <div class="section-header">
                <h4>{$LL.contactInfoStorageHeading()}</h4>
                {#if !isLoadingStats}
                    <button
                        type="button"
                        class="btn btn--secondary"
                        on:click={loadStorageStats}
                        title={$LL.contactInfoRefreshTooltip()}
                        aria-label={$LL.contactInfoRefreshTooltip()}
                    >
                        <Icon name="refresh" size={16} className="refresh-icon" />
                    </button>
                {/if}
            </div>

            <!-- role="status" makes Refresh give audible feedback: the loading
                 and loaded states are announced as they replace each other. -->
            <div role="status">
                {#if isLoadingStats}
                    <div class="loading-state">
                        <div class="loading-spinner"></div>
                        <p>{$LL.contactInfoLoadingStats()}</p>
                    </div>
                {:else if storageStats}
                    <div class="stats-grid">
                        <div class="stat-item">
                            <div class="stat-value">
                                {formatStorageSize(storageStats.totalBytes)}
                                {#if storageStats.totalQuota > 0}
                                    <span class="quota-info"
                                        >{$LL.contactInfoQuotaOf({
                                            size: formatStorageSize(storageStats.totalQuota),
                                        })}</span
                                    >
                                {/if}
                            </div>
                            <div class="stat-label">{$LL.contactInfoStatTotalSpace()}</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">{storageStats.messageCount}</div>
                            <div class="stat-label">{$LL.contactInfoStatTotalMessages()}</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">{storageStats.sentCount}</div>
                            <div class="stat-label">{$LL.contactInfoStatMessagesSent()}</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">{storageStats.receivedCount}</div>
                            <div class="stat-label">{$LL.contactInfoStatMessagesReceived()}</div>
                        </div>
                    </div>
                {:else}
                    <div class="error-state">
                        <p>{$LL.contactInfoErrorStats()}</p>
                        <button
                            type="button"
                            class="btn btn--secondary"
                            on:click={loadStorageStats}
                        >
                            {$LL.contactInfoRetry()}
                        </button>
                    </div>
                {/if}
            </div>
        </div>

        <div class="section danger-section">
            <div class="section-header">
                <h4>{$LL.contactInfoDangerHeading()}</h4>
            </div>
            <div class="danger-content">
                <p>{$LL.contactInfoDangerDescription()}</p>
                <div class="danger-actions">
                    <button type="button" class="btn btn--secondary" on:click={showClearChat}>
                        {$LL.clearChat()}
                    </button>
                    <button type="button" class="btn btn--warning" on:click={showDeleteChat}>
                        {$LL.contactInfoDeleteChatButton()}
                    </button>
                </div>
            </div>
        </div>
    </div>
</dialog>

<dialog
    bind:this={deleteDialogRef}
    class="dialog"
    aria-labelledby={deleteTitleId}
    aria-describedby={deleteDescriptionId}
    on:cancel|preventDefault={cancelDeleteChat}
    on:pointerdown={handleDeleteDialogPointerDown}
    aria-modal="true"
>
    <div class="dialog__header">
        <h3 id={deleteTitleId} class="dialog__title dialog__title--danger">
            {$LL.contactInfoDeleteChatTitle()}
        </h3>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={cancelDeleteChat}
            aria-label={$LL.chatSetupCloseButton()}>×</button
        >
    </div>
    <div class="dialog__body">
        <p id={deleteDescriptionId}>{$LL.contactInfoDeleteChatBody({ name: contactName })}</p>
        <p class="warning">{$LL.chatInterfaceDeleteWarning()}</p>
    </div>
    <div class="dialog__footer">
        <button type="button" class="btn btn--secondary" on:click={cancelDeleteChat}>
            {$LL.profileSetupCancel()}
        </button>
        <button type="button" class="btn btn--warning" on:click={confirmDeleteChat}>
            {$LL.chatInterfaceConfirmDelete()}
        </button>
    </div>
</dialog>

<dialog
    bind:this={clearDialogRef}
    class="dialog"
    aria-labelledby={clearTitleId}
    aria-describedby={clearDescriptionId}
    on:cancel|preventDefault={cancelClearChat}
    aria-modal="true"
>
    <div class="dialog__header">
        <h3 id={clearTitleId} class="dialog__title">{$LL.clearChatConfirmTitle()}</h3>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={cancelClearChat}
            aria-label={$LL.chatSetupCloseButton()}>×</button
        >
    </div>
    <div class="dialog__body">
        <p id={clearDescriptionId}>{$LL.clearChatConfirmBody({ name: contactName })}</p>
        <p class="warning">{$LL.chatInterfaceDeleteWarning()}</p>
    </div>
    <div class="dialog__footer">
        <button type="button" class="btn btn--secondary" on:click={cancelClearChat}>
            {$LL.profileSetupCancel()}
        </button>
        <button type="button" class="btn btn--warning" on:click={confirmClearChat}>
            {$LL.clearChatButton()}
        </button>
    </div>
</dialog>

<style>
    .section {
        margin-bottom: 2rem;
    }

    .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1rem;
    }

    .section-header h4 {
        margin: 0;
        color: var(--color-text);
        font-size: 1rem;
        font-weight: 600;
    }

    .section-header > :global(.btn) {
        --btn-padding: 0.25rem;
        --btn-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .section-header > :global(.btn) :global(.refresh-icon) {
        width: 1rem;
        height: 1rem;
    }

    .name-container {
        background: var(--color-bg-subtle);
        border-radius: 8px;
        padding: 1rem;
    }

    .name-display {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .contact-name {
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--color-text);
    }

    .name-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.75rem;
    }

    .name-display > :global(.btn) {
        --btn-padding: 0.25rem;
        --btn-radius: 6px;
        width: 2rem;
        height: 2rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 2rem;
        color: var(--color-text-muted);
    }

    .loading-spinner {
        width: 2rem;
        height: 2rem;
        border: 3px solid var(--color-input-border);
        border-top: 3px solid var(--color-accent-text);
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin-bottom: 1rem;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .error-state {
        text-align: center;
        padding: 2rem;
        color: var(--color-text-muted);
    }

    .error-state :global(.btn) {
        margin-top: 1rem;
    }

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 1rem;
        margin-bottom: 1.5rem;
    }

    .stat-item {
        background: var(--color-bg-subtle);
        border-radius: 8px;
        padding: 1rem;
        text-align: center;
    }

    .stat-value {
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--color-accent-text);
        margin-bottom: 0.25rem;
        line-height: 1.2;
    }

    .quota-info {
        display: block;
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--color-text-muted);
        margin-top: 0.25rem;
    }

    .stat-label {
        font-size: 0.8rem;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 0.5rem;
    }

    .danger-section {
        border-top: 1px solid var(--color-border);
        padding-top: 1.5rem;
    }

    .danger-content {
        background: var(--color-error-bg);
        border: 1px solid var(--color-error-border);
        border-radius: 8px;
        padding: 1rem;
    }

    .danger-content p {
        margin: 0 0 1rem 0;
        color: var(--color-error-text);
        font-size: 0.9rem;
    }

    .danger-actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
    }

    .warning {
        color: var(--color-danger-text);
        font-weight: 600;
        font-size: 0.9rem;
    }

    .shared-info-container {
        background: var(--color-bg-subtle);
        border-radius: 8px;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .shared-field {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .field-label {
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--color-text);
    }

    .field-value {
        font-size: 1rem;
        color: var(--color-text-muted);
        background: var(--color-bg);
        padding: 0.75rem;
        border-radius: 6px;
        border: 1px solid var(--color-input-border);
        word-break: break-all;
    }

    .not-shared {
        color: var(--color-text-muted);
        font-style: italic;
    }

    @media (max-width: 600px) {
        .dialog__header,
        .dialog__body {
            padding-left: 1rem;
            padding-right: 1rem;
        }

        .stats-grid {
            grid-template-columns: repeat(2, 1fr);
        }
    }
</style>
