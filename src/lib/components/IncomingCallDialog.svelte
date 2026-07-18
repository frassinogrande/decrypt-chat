<script lang="ts">
    import { createEventDispatcher, onMount, onDestroy } from 'svelte';
    import { get } from 'svelte/store';
    import Icon from '$lib/components/icons/Icon.svelte';
    import type { Call } from '../types';
    import { translations as LL } from '$lib/i18n/runtime';
    import { uiStore } from '../stores/ui-store';

    export let call: Call;
    export let show: boolean = true;

    const dispatch = createEventDispatcher();

    let dialogElement: HTMLDialogElement;
    let callDuration = 0;
    let durationInterval: number | null = null;
    // Once the user accepts or rejects, lock both actions so a second tap during the (brief)
    // connection setup can't fire a duplicate accept/reject.
    let responded = false;

    $: caller = call.participants.find((p) => p.id === 'peer');
    $: callerName = caller?.name || $LL.incomingCallUnknownCaller();
    $: isVideoCall = call.type === 'video';

    onMount(() => {
        if (show && dialogElement) {
            dialogElement.showModal();
            document.body.classList.add('call-dialog-open');
            startRingingTimer();
        }
    });

    onDestroy(() => {
        cleanup();
    });

    $: if (show && dialogElement && !dialogElement.open) {
        dialogElement.showModal();
        document.body.classList.add('call-dialog-open');
        startRingingTimer();
    } else if (!show && dialogElement && dialogElement.open) {
        dialogElement.close();
        document.body.classList.remove('call-dialog-open');
        cleanup();
    }

    function startRingingTimer() {
        if (durationInterval) {
            clearInterval(durationInterval);
        }

        callDuration = 0;
        durationInterval = window.setInterval(() => {
            callDuration++;

            if (callDuration >= 60) {
                handleRingingTimeout();
            }
        }, 1000);
    }

    function handleRingingTimeout() {
        if (responded) return;
        // Announce the missed call via the app toast (role="status", polite live region in
        // +page.svelte). This component unmounts as soon as the call leaves the incoming
        // state, so an announcement inside the dialog would be torn down before assistive
        // technology could read it; the toast outlives the dialog.
        uiStore.showToast(get(LL).callToastMissedFrom({ name: callerName }), 'info');
        handleReject();
    }

    function cleanup() {
        if (durationInterval) {
            clearInterval(durationInterval);
            durationInterval = null;
        }
        document.body.classList.remove('call-dialog-open');
    }

    function handleAccept() {
        if (responded) return;
        responded = true;
        cleanup();
        dispatch('accept-call', { callId: call.id });
    }

    function handleReject() {
        if (responded) return;
        responded = true;
        cleanup();
        dispatch('reject-call', { callId: call.id });
    }

    // Enter and Space are intentionally NOT handled here: native button activation already
    // covers them for whichever action button has focus. A global handler would accept the
    // call even while focus is on the Reject button.
    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            handleReject();
        }
    }
</script>

<svelte:window on:keydown={handleKeydown} />

<dialog
    bind:this={dialogElement}
    class="incoming-call-dialog"
    class:video-call={isVideoCall}
    class:audio-call={!isVideoCall}
    role="alertdialog"
    aria-labelledby="call-dialog-title"
    aria-describedby="call-dialog-description"
    aria-modal="true"
>
    <div class="dialog-backdrop" on:click={handleReject} role="presentation"></div>

    <div class="dialog-content">
        <div class="caller-info">
            <div class="caller-details">
                <h2 id="call-dialog-title" class="caller-name">
                    {callerName}
                </h2>
                <div id="call-dialog-description" class="call-type">
                    {#if isVideoCall}
                        <Icon name="videocam" size={24} className="call-type-icon" />
                        <span>{$LL.incomingCallVideoLabel()}</span>
                    {:else}
                        <Icon name="call" size={24} className="call-type-icon" />
                        <span>{$LL.incomingCallVoiceLabel()}</span>
                    {/if}
                </div>
                <div class="call-duration">{$LL.incomingCallRinging()}</div>
            </div>
        </div>

        <div class="call-actions">
            <button
                type="button"
                class="btn btn--warning"
                data-call-action="reject"
                on:click={handleReject}
                disabled={responded}
                title={$LL.incomingCallRejectAria()}
                aria-label={$LL.incomingCallRejectAria()}
            >
                <span class="button-icon">
                    <Icon name="call" size={28} className="incoming-call-icon" />
                </span>
                <span class="button-label">{$LL.incomingCallReject()}</span>
            </button>

            <button
                type="button"
                class="btn btn--primary"
                data-call-action="accept"
                on:click={handleAccept}
                disabled={responded}
                title={isVideoCall
                    ? $LL.incomingCallAcceptVideoAria()
                    : $LL.incomingCallAcceptVoiceAria()}
                aria-label={isVideoCall
                    ? $LL.incomingCallAcceptVideoAria()
                    : $LL.incomingCallAcceptVoiceAria()}
            >
                <span class="button-icon">
                    {#if isVideoCall}
                        <Icon name="videocam" size={30} className="incoming-call-icon" />
                    {:else}
                        <Icon name="call" size={30} className="incoming-call-icon" />
                    {/if}
                </span>
                <span class="button-label">{$LL.incomingCallAccept()}</span>
            </button>
        </div>
    </div>
</dialog>

<style>
    :global(body.call-dialog-open) {
        overflow: hidden;
    }

    .incoming-call-dialog {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        height: 100svh;
        max-width: none;
        max-height: none;
        border: none;
        padding: 0;
        margin: 0;
        background: transparent;
        z-index: 10000;
    }

    .incoming-call-dialog::backdrop {
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(10px);
    }

    .dialog-backdrop {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(10px);
    }

    .dialog-content {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100vh;
        height: 100svh;
        padding: 2rem;
        color: white;
        z-index: 1;
    }

    .caller-info {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        margin-bottom: 3rem;
    }

    .caller-details {
        text-align: center;
    }

    .caller-name {
        margin: 0 0 0.5rem 0;
        font-size: 2rem;
        font-weight: 600;
        color: white;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
    }

    .call-type {
        font-size: 1.2rem;
        margin-bottom: 0.5rem;
        opacity: 0.9;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
    }

    .call-type :global(.call-type-icon) {
        width: 1.4rem;
        height: 1.4rem;
    }

    .call-duration {
        font-size: 0.9rem;
        opacity: 0.7;
        color: #ffc107;
    }

    .call-actions {
        display: flex;
        gap: 2rem;
        margin-bottom: 2rem;
        align-items: center;
    }

    .call-actions :global(.btn) {
        --btn-padding: 1.5rem;
        --btn-radius: 50%;
        width: 80px;
        height: 80px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.15rem;
        font-size: 1rem;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        transition:
            transform 0.3s ease,
            box-shadow 0.3s ease;
    }

    .call-actions :global(.btn):not(:disabled):hover {
        transform: scale(1.05);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    }

    .button-icon {
        font-size: 1.8rem;
        display: flex;
        align-items: center;
        justify-content: center;
        transform: rotate(0deg);
        transition: transform 0.3s ease;
    }

    .button-icon :global(.incoming-call-icon) {
        width: 2rem;
        height: 2rem;
    }

    .call-actions :global(.btn[data-call-action='reject'] .button-icon) {
        transform: rotate(135deg);
    }

    .button-label {
        font-size: 0.8rem;
        font-weight: 500;
        opacity: 0.9;
    }

    @media (max-width: 768px) {
        .dialog-content {
            padding: 1.5rem;
        }

        .caller-name {
            font-size: 1.8rem;
        }

        .call-type {
            font-size: 1.1rem;
        }

        .call-actions {
            gap: 1.5rem;
        }

        .call-actions :global(.btn) {
            width: 70px;
            height: 70px;
            --btn-padding: 1.25rem;
        }

        .button-icon {
            font-size: 1.5rem;
        }

        .button-label {
            font-size: 0.7rem;
        }
    }

    @media (max-width: 480px) {
        .dialog-content {
            padding: 1rem;
        }

        .caller-name {
            font-size: 1.5rem;
        }

        .call-type {
            font-size: 1rem;
        }

        .call-actions {
            gap: 1rem;
        }

        .call-actions :global(.btn) {
            width: 60px;
            height: 60px;
            --btn-padding: 1rem;
        }

        .button-icon {
            font-size: 1.3rem;
        }

        .button-label {
            display: none;
        }
    }

    @media (prefers-contrast: high) {
        .call-actions :global(.btn[data-call-action='accept']) {
            --btn-bg: #28a745;
            --btn-hover-bg: #1f8f3a;
        }

        .call-actions :global(.btn[data-call-action='reject']) {
            --btn-bg: #dc3545;
            --btn-hover-bg: #c82333;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .call-actions :global(.btn):not(:disabled):hover {
            transform: none;
        }
    }

    .call-actions :global(.btn):focus-visible {
        outline: 2px solid #4dabf7;
        outline-offset: 2px;
    }
</style>
