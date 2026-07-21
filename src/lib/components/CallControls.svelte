<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import Icon from '$lib/components/icons/Icon.svelte';
    import type { Call } from '../types';
    import { translations as LL } from '$lib/i18n/runtime';

    export let call: Call;
    export let isAudioMuted: boolean = false;
    export let isVideoMuted: boolean = false;
    export let isVideoCall: boolean = false;
    export let isFullscreen: boolean = false;
    export let hasMultipleCameras: boolean = false;
    export let cameraUnavailable: boolean = false;

    const dispatch = createEventDispatcher();

    function handleMuteAudio() {
        dispatch('mute-audio');
    }

    function handleMuteVideo() {
        dispatch('mute-video');
    }

    function handleEndCall() {
        dispatch('end-call');
    }

    function handleSwitchCamera() {
        dispatch('switch-camera');
    }

    function handleToggleFullscreen() {
        dispatch('toggle-fullscreen');
    }
</script>

<div class="call-controls" role="group" aria-label={$LL.callControlsAria()}>
    <div class="controls-row">
        <!-- Audio mute/unmute. No aria-pressed: the action-verb label already flips with the
         state, and pairing it with a pressed state reads contradictorily in screen readers
         ("Unmute microphone, pressed"). -->
        <button
            type="button"
            class="btn btn--secondary btn--icon call-control"
            class:is-engaged={isAudioMuted}
            on:click={handleMuteAudio}
            title={isAudioMuted ? $LL.callControlsUnmuteMic() : $LL.callControlsMuteMic()}
            aria-label={isAudioMuted ? $LL.callControlsUnmuteMic() : $LL.callControlsMuteMic()}
        >
            {#if isAudioMuted}
                <Icon name="mic-disabled" size={24} className="call-control-icon" />
            {:else}
                <Icon name="mic" size={24} className="call-control-icon" />
            {/if}
        </button>

        {#if isVideoCall}
            <button
                type="button"
                class="btn btn--secondary btn--icon call-control"
                class:is-engaged={isVideoMuted}
                disabled={cameraUnavailable}
                on:click={handleMuteVideo}
                title={cameraUnavailable
                    ? $LL.callControlsNoCamera()
                    : isVideoMuted
                      ? $LL.callControlsCameraOn()
                      : $LL.callControlsCameraOff()}
                aria-label={cameraUnavailable
                    ? $LL.callControlsNoCamera()
                    : isVideoMuted
                      ? $LL.callControlsCameraOn()
                      : $LL.callControlsCameraOff()}
            >
                {#if isVideoMuted}
                    <Icon name="videocam-disabled" size={24} className="call-control-icon" />
                {:else}
                    <Icon name="videocam" size={24} className="call-control-icon" />
                {/if}
            </button>

            {#if hasMultipleCameras}
                <button
                    type="button"
                    class="btn btn--secondary btn--icon call-control"
                    on:click={handleSwitchCamera}
                    title={$LL.callControlsSwitchCamera()}
                    aria-label={$LL.callControlsSwitchCamera()}
                >
                    <Icon name="flip-camera" size={24} className="call-control-icon" />
                </button>
            {/if}

            <button
                type="button"
                class="btn btn--secondary btn--icon call-control"
                class:is-engaged={isFullscreen}
                on:click={handleToggleFullscreen}
                title={isFullscreen
                    ? $LL.callControlsExitFullscreen()
                    : $LL.callControlsEnterFullscreen()}
                aria-label={isFullscreen
                    ? $LL.callControlsExitFullscreen()
                    : $LL.callControlsEnterFullscreen()}
            >
                {#if isFullscreen}
                    <Icon name="fullscreen-exit" size={24} className="call-control-icon" />
                {:else}
                    <Icon name="fullscreen" size={24} className="call-control-icon" />
                {/if}
            </button>
        {/if}

        <button
            type="button"
            class="btn btn--warning btn--icon call-control"
            on:click={handleEndCall}
            title={$LL.callControlsEndCall()}
            aria-label={$LL.callControlsEndCall()}
        >
            <Icon name="call" size={24} className="call-control-icon" />
        </button>
    </div>

    <div class="call-info-row">
        <div class="call-type">
            {#if call.type === 'video'}
                <Icon name="videocam" size={18} className="call-type-icon" />
                <span>{$LL.callTypeVideo()}</span>
            {:else}
                <Icon name="call" size={18} className="call-type-icon" />
                <span>{$LL.callTypeVoice()}</span>
            {/if}
        </div>
    </div>
</div>

<style>
    .call-controls {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        padding: 1rem;
        background: rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(10px);
        border-radius: 16px;
        margin: 0 auto;
        max-width: 600px;
    }

    .controls-row {
        display: flex;
        gap: 1rem;
        align-items: center;
        justify-content: center;
    }

    /* Circular icon buttons, matching the app's btn--icon controls. */
    .call-control {
        --btn-padding: 0.6rem;
        --btn-radius: 50%;
        width: 3.25rem;
        height: 3.25rem;
    }

    /* Light-on-dark treatment for the secondary controls over the video. */
    .btn--secondary.call-control {
        --btn-bg: rgba(255, 255, 255, 0.12);
        --btn-color: #ffffff;
        --btn-border: transparent;
        --btn-hover-bg: rgba(255, 255, 255, 0.22);
        --btn-hover-color: #ffffff;
        --btn-hover-border: transparent;
    }

    /* No camera at all, as opposed to one merely switched off: still shows the disabled-camera
       icon, but dimmed and non-interactive rather than an actionable toggle. */
    .btn--secondary.call-control:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    /* Engaged state (mic muted, camera off, fullscreen): solid so it reads as active. */
    .btn--secondary.call-control.is-engaged {
        --btn-bg: #ffffff;
        --btn-color: #0f172a;
        --btn-hover-bg: #f1f5f9;
        --btn-hover-color: #0f172a;
    }

    .call-control :global(.call-control-icon) {
        width: 1.5rem;
        height: 1.5rem;
    }

    .call-info-row {
        display: flex;
        align-items: center;
        gap: 1rem;
        font-size: 0.9rem;
        opacity: 0.8;
        color: white;
    }

    .call-type {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.5rem 1rem;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 20px;
        backdrop-filter: blur(10px);
    }

    .call-type :global(.call-type-icon) {
        width: 1.1rem;
        height: 1.1rem;
    }

    /* Mobile: shrink the controls so all five fit on a single row. */
    @media (max-width: 768px) {
        .call-controls {
            padding: 0.75rem;
            gap: 0.75rem;
            max-width: none;
            margin: 0;
        }

        .controls-row {
            gap: 0.6rem;
            flex-wrap: nowrap;
        }

        .call-control {
            width: 2.75rem;
            height: 2.75rem;
            --btn-padding: 0.5rem;
        }

        .call-info-row {
            display: none;
        }
    }

    @media (max-width: 360px) {
        .controls-row {
            gap: 0.4rem;
        }

        .call-control {
            width: 2.5rem;
            height: 2.5rem;
        }
    }
</style>
