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

    function ok() {
        dispatch('ok');
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    style="--modal-width: min(460px, 92vw);"
    aria-labelledby="tutorial-deferred-title"
    aria-describedby="tutorial-deferred-body"
    on:cancel|preventDefault={ok}
    aria-modal="true"
>
    <div class="dialog__header">
        <h3 id="tutorial-deferred-title" class="dialog__title">{$LL.tutorialDeferredTitle()}</h3>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={ok}
            aria-label={$LL.chatSetupCloseButton()}>×</button
        >
    </div>
    <div class="dialog__body">
        <p id="tutorial-deferred-body">{$LL.tutorialDeferredBody()}</p>
    </div>
    <div class="dialog__footer">
        <button type="button" class="btn btn--primary" on:click={ok}>
            {$LL.tutorialDeferredOk()}
        </button>
    </div>
</dialog>
