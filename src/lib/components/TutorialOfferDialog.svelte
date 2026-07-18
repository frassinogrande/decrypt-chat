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

    function start() {
        dispatch('start');
    }

    function skip() {
        dispatch('skip');
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    style="--modal-width: min(460px, 92vw);"
    aria-labelledby="tutorial-offer-title"
    aria-describedby="tutorial-offer-body"
    on:cancel|preventDefault={skip}
    aria-modal="true"
>
    <div class="dialog__header">
        <h3 id="tutorial-offer-title" class="dialog__title">{$LL.tutorialOfferTitle()}</h3>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={skip}
            aria-label={$LL.chatSetupCloseButton()}>×</button
        >
    </div>
    <div class="dialog__body">
        <p id="tutorial-offer-body">{$LL.tutorialOfferBody()}</p>
    </div>
    <div class="dialog__footer">
        <button type="button" class="btn btn--secondary" on:click={skip}>
            {$LL.tutorialOfferSkip()}
        </button>
        <button type="button" class="btn btn--primary" on:click={start}>
            {$LL.tutorialOfferStart()}
        </button>
    </div>
</dialog>
