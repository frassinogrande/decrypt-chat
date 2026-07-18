<script lang="ts">
    import { createEventDispatcher, onDestroy, onMount } from 'svelte';
    import { translations as LL } from '$lib/i18n/runtime';

    const dispatch = createEventDispatcher<{
        confirm: { dontShowAgain: boolean };
        cancel: void;
    }>();

    let dialogRef: HTMLDialogElement;
    let dontShowAgain = false;
    const suffix = Math.random().toString(36).slice(2, 10);
    const titleId = `connection-notice-title-${suffix}`;
    const descriptionId = `connection-notice-description-${suffix}`;

    onMount(() => {
        if (dialogRef && !dialogRef.open) {
            dialogRef.showModal();
        }
    });

    onDestroy(() => {
        if (dialogRef?.open) dialogRef.close();
    });

    function handleConfirm() {
        if (dialogRef?.open) dialogRef.close();
        dispatch('confirm', { dontShowAgain });
    }

    function handleCancel() {
        if (dialogRef?.open) dialogRef.close();
        dispatch('cancel');
    }

    function handleNativeCancel(event: Event) {
        event.preventDefault();
        handleCancel();
    }

    function handlePointerDown(event: PointerEvent) {
        if (event.target === dialogRef) {
            handleCancel();
        }
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    style="--modal-width: min(480px, 92vw);"
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    aria-modal="true"
    on:cancel={handleNativeCancel}
    on:pointerdown={handlePointerDown}
>
    <div class="dialog__header">
        <h3 id={titleId} class="dialog__title">{$LL.connectionNoticeTitle()}</h3>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={handleCancel}
            aria-label={$LL.dialogClose()}>×</button
        >
    </div>

    <div class="dialog__body">
        <div id={descriptionId}>
            <p>{$LL.connectionNoticeTrust()}</p>
            <p>{$LL.connectionNoticeIp()}</p>
        </div>

        <label class="checkbox-label">
            <input type="checkbox" bind:checked={dontShowAgain} />
            <span class="checkbox-text">{$LL.connectionNoticeDontShowAgain()}</span>
        </label>
    </div>

    <div class="dialog__footer">
        <button type="button" class="btn btn--primary" on:click={handleConfirm}
            >{$LL.connectionNoticeConfirm()}</button
        >
    </div>
</dialog>

<style>
    p {
        margin: 0 0 1rem;
        line-height: 1.6;
    }

    p:last-child {
        margin-bottom: 0;
    }

    .checkbox-label {
        margin-top: 1.5rem;
    }

    .dialog__footer {
        display: flex;
        justify-content: flex-end;
    }
</style>
