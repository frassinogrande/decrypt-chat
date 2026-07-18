<script lang="ts">
    import { translations as LL } from '$lib/i18n/runtime';

    export let chatName: string;

    export let showDeleteConfirm = false;
    export let showClearConfirm = false;
    export let showAutoDeleteDialog = false;
    export let showDisconnectConfirm = false;

    export let selectedAutoDelete = 0;

    export let onConfirmDelete: () => void = () => {};
    export let onCancelDelete: () => void = () => {};
    export let onConfirmClear: () => void = () => {};
    export let onCancelClear: () => void = () => {};
    export let onConfirmAutoDelete: () => void = () => {};
    export let onCancelAutoDelete: () => void = () => {};
    export let onConfirmDisconnect: () => void = () => {};
    export let onCancelDisconnect: () => void = () => {};

    let deleteDialogRef: HTMLDialogElement;
    let clearDialogRef: HTMLDialogElement;
    let autoDeleteDialogRef: HTMLDialogElement;
    let disconnectDialogRef: HTMLDialogElement;

    $: if (deleteDialogRef) showDeleteConfirm ? deleteDialogRef.showModal() : deleteDialogRef.close();
    $: if (clearDialogRef) showClearConfirm ? clearDialogRef.showModal() : clearDialogRef.close();
    $: if (autoDeleteDialogRef) showAutoDeleteDialog ? autoDeleteDialogRef.showModal() : autoDeleteDialogRef.close();
    $: if (disconnectDialogRef) showDisconnectConfirm ? disconnectDialogRef.showModal() : disconnectDialogRef.close();
</script>

{#if showDeleteConfirm}
    <dialog
        class="dialog"
        bind:this={deleteDialogRef}
        on:cancel|preventDefault={onCancelDelete}
        style="--dialog-title-color: #dc3545; --dialog-header-border: #fecdd3"
        aria-modal="true"
        aria-labelledby="delete-chat-dialog-title"
    >
        <div class="dialog__header">
            <h3 id="delete-chat-dialog-title" class="dialog__title">{$LL.chatInterfaceDeleteTitle()}</h3>
            <button type="button" class="btn btn--secondary" data-modal-close on:click={onCancelDelete} aria-label={$LL.dialogClose()}>×</button>
        </div>
        <div class="dialog__body">
            <p>{$LL.chatInterfaceDeleteBody({ name: chatName })}</p>
            <p class="warning">{$LL.chatInterfaceDeleteWarning()}</p>
        </div>
        <div class="dialog__footer">
            <button type="button" class="btn btn--secondary" on:click={onCancelDelete}>
                {$LL.profileSetupCancel()}
            </button>
            <button type="button" class="btn btn--warning" on:click={onConfirmDelete}>
                {$LL.chatInterfaceConfirmDelete()}
            </button>
        </div>
    </dialog>
{/if}

{#if showClearConfirm}
    <dialog
        class="dialog"
        bind:this={clearDialogRef}
        on:cancel|preventDefault={onCancelClear}
        aria-modal="true"
        aria-labelledby="clear-chat-dialog-title"
    >
        <div class="dialog__header">
            <h3 id="clear-chat-dialog-title" class="dialog__title">{$LL.clearChatConfirmTitle()}</h3>
            <button type="button" class="btn btn--secondary" data-modal-close on:click={onCancelClear} aria-label={$LL.dialogClose()}>×</button>
        </div>
        <div class="dialog__body">
            <p>{$LL.clearChatConfirmBody({ name: chatName })}</p>
            <p class="warning">{$LL.chatInterfaceDeleteWarning()}</p>
        </div>
        <div class="dialog__footer">
            <button type="button" class="btn btn--secondary" on:click={onCancelClear}>
                {$LL.profileSetupCancel()}
            </button>
            <button type="button" class="btn btn--warning" on:click={onConfirmClear}>
                {$LL.clearChatButton()}
            </button>
        </div>
    </dialog>
{/if}

{#if showAutoDeleteDialog}
    <dialog
        class="dialog"
        bind:this={autoDeleteDialogRef}
        on:cancel|preventDefault={onCancelAutoDelete}
        aria-modal="true"
        aria-labelledby="auto-delete-dialog-title"
    >
        <div class="dialog__header">
            <h3 id="auto-delete-dialog-title" class="dialog__title">{$LL.autoDeleteLabel()}</h3>
            <button type="button" class="btn btn--secondary" data-modal-close on:click={onCancelAutoDelete} aria-label={$LL.dialogClose()}>×</button>
        </div>
        <div class="dialog__body">
            <p class="auto-delete-note">{$LL.autoDeleteLocalOnlyNote()}</p>
            <div class="auto-delete-options">
                <label class="auto-delete-option">
                    <input type="radio" name="auto-delete" value={0} bind:group={selectedAutoDelete} />
                    <span>{$LL.autoDeleteOff()}</span>
                </label>
                <label class="auto-delete-option">
                    <input type="radio" name="auto-delete" value={3600000} bind:group={selectedAutoDelete} />
                    <span>{$LL.autoDeleteOneHour()}</span>
                </label>
                <label class="auto-delete-option">
                    <input type="radio" name="auto-delete" value={86400000} bind:group={selectedAutoDelete} />
                    <span>{$LL.autoDeleteOneDay()}</span>
                </label>
                <label class="auto-delete-option">
                    <input type="radio" name="auto-delete" value={604800000} bind:group={selectedAutoDelete} />
                    <span>{$LL.autoDeleteOneWeek()}</span>
                </label>
                <label class="auto-delete-option">
                    <input type="radio" name="auto-delete" value={2592000000} bind:group={selectedAutoDelete} />
                    <span>{$LL.autoDeleteOneMonth()}</span>
                </label>
            </div>
        </div>
        <div class="dialog__footer">
            <button type="button" class="btn btn--secondary" on:click={onCancelAutoDelete}>
                {$LL.profileSetupCancel()}
            </button>
            <button type="button" class="btn btn--primary" on:click={onConfirmAutoDelete}>
                {$LL.autoDeleteSave()}
            </button>
        </div>
    </dialog>
{/if}

{#if showDisconnectConfirm}
    <dialog
        class="dialog"
        bind:this={disconnectDialogRef}
        on:cancel|preventDefault={onCancelDisconnect}
        aria-modal="true"
        aria-labelledby="disconnect-dialog-title"
    >
        <div class="dialog__header">
            <h3 id="disconnect-dialog-title" class="dialog__title">{$LL.chatInterfaceOfflineTitle()}</h3>
            <button type="button" class="btn btn--secondary" data-modal-close on:click={onCancelDisconnect} aria-label={$LL.dialogClose()}>×</button>
        </div>
        <div class="dialog__body">
            <p>{$LL.chatInterfaceOfflineBody({ name: chatName })}</p>
            {#if $LL.chatInterfaceOfflineNote()}
                <p>{$LL.chatInterfaceOfflineNote()}</p>
            {/if}
        </div>
        <div class="dialog__footer">
            <button type="button" class="btn btn--secondary" on:click={onCancelDisconnect}>
                {$LL.profileSetupCancel()}
            </button>
            <button type="button" class="btn btn--primary" on:click={onConfirmDisconnect}>
                {$LL.chatInterfaceConfirmGoOffline()}
            </button>
        </div>
    </dialog>
{/if}

<style>
    .warning {
        color: #dc3545;
        font-weight: 600;
        font-size: 0.9rem;
    }

    .auto-delete-note {
        margin: 0 0 1rem;
        font-size: 0.85rem;
        color: var(--color-text-muted);
    }

    .auto-delete-options {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .auto-delete-option {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.6rem 0.75rem;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.95rem;
        color: var(--color-text);
    }

    .auto-delete-option:hover {
        background: var(--color-bg-muted);
    }

    .auto-delete-option input[type='radio'] {
        accent-color: #006de2;
        width: 1rem;
        height: 1rem;
        cursor: pointer;
        flex-shrink: 0;
    }
</style>
