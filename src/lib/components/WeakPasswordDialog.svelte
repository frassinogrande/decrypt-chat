<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import { translations as LL } from '$lib/i18n/runtime';

    export let show: boolean = false;

    const dispatch = createEventDispatcher();
    let dialogRef: HTMLDialogElement;

    $: if (dialogRef) {
        if (show && !dialogRef.open) {
            dialogRef.showModal();
        } else if (!show && dialogRef.open) {
            dialogRef.close();
        }
    }

    function confirm() {
        dispatch('confirm');
    }

    function changeIt() {
        dispatch('cancel');
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    style="--modal-width: min(440px, 92vw);"
    aria-labelledby="weak-password-title"
    aria-describedby="weak-password-body"
    on:cancel|preventDefault={changeIt}
    aria-modal="true"
>
    <div class="dialog__header">
        <h3 id="weak-password-title" class="dialog__title">{$LL.weakPasswordTitle()}</h3>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={changeIt}
            aria-label={$LL.chatSetupCloseButton()}>×</button
        >
    </div>
    <div class="dialog__body">
        <p id="weak-password-body">{$LL.weakPasswordBody()}</p>
    </div>
    <div class="dialog__footer">
        <button type="button" class="btn btn--secondary" on:click={confirm}>
            {$LL.weakPasswordConfirm()}
        </button>
        <button type="button" class="btn btn--primary" on:click={changeIt}>
            {$LL.weakPasswordChange()}
        </button>
    </div>
</dialog>
