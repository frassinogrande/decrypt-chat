<script lang="ts">
    import { onMount, onDestroy, createEventDispatcher } from 'svelte';
    import { get } from 'svelte/store';
    import type { Call } from '../types';
    import { debug } from '../utils/debug';
    import { mediaManager } from '../services/MediaManager';
    import { appStore } from '../stores/app';
    import { remoteStreams } from '../stores/call-store';
    import { translations as LL, locale } from '$lib/i18n/runtime';
    import CallControls from './CallControls.svelte';
    import Icon from '$lib/components/icons/Icon.svelte';

    export let call: Call;

    const dispatch = createEventDispatcher();

    let localVideoElement: HTMLVideoElement;
    let remoteVideoElement: HTMLVideoElement;
    let remoteAudioElement: HTMLAudioElement;
    let callDuration = 0;
    let durationInterval: number | null = null;
    let isFullscreen = false;
    let showControls = true;
    let controlsTimeout: number | null = null;
    let streamSetupPromise: Promise<void> | null = null;
    // Timers/listeners tracked so they can be torn down on destroy. Without this the 200ms
    // deferred setup can re-acquire getUserMedia after the component unmounts (camera turns
    // back on with no UI), the local-preview interval keeps poking a detached element, and a
    // fullscreenchange listener leaks on every mount. NOTE: we intentionally do NOT stop the
    // media tracks here — a call keeps running in the activeCall store while this component
    // unmounts on a chat switch, and CallService.endCall/cleanupCallLocally already release
    // media when the call actually ends.
    let setupTimeout: number | null = null;
    let streamCheckInterval: number | null = null;
    let streamCheckClearTimeout: number | null = null;
    let fullscreenHandler: (() => void) | null = null;
    let destroyed = false;
    // Root element of the overlay, for focus placement inside the call UI.
    let callInterfaceElement: HTMLElement;
    // Element that had focus before the call UI opened. Restored ONLY when the call
    // actually ends (ended/failed): the component also unmounts on a chat switch while
    // the call keeps running, and yanking focus around then would be wrong.
    let previouslyFocusedElement: HTMLElement | null = null;
    // Text of the persistent polite live region announcing call state transitions.
    let callAnnouncement = '';
    // Whether the device has more than one camera. The "Switch" button is only useful then;
    // on a single-camera device (most laptops) switching just restarts the same camera.
    let hasMultipleCameras = false;

    $: selfParticipant = call.participants.find((p) => p.id === 'self');
    $: peerParticipant = call.participants.find((p) => p.id === 'peer');
    $: isVideoCall = call.type === 'video';
    $: isConnected = call.state === 'connected';
    $: isAudioMuted = selfParticipant?.isAudioMuted || false;
    $: isVideoMuted = selfParticipant?.isVideoMuted || false;
    $: peerAudioMuted = peerParticipant?.isAudioMuted || false;
    $: peerVideoMuted = peerParticipant?.isVideoMuted || false;
    $: peerName = peerParticipant?.name || $LL.callParticipantUnknown();

    // Announce peer mute/unmute changes in the live region. The first observed value is
    // only recorded (announcing the initial state on mount would be noise).
    let prevPeerAudioMuted: boolean | null = null;
    $: {
        if (prevPeerAudioMuted === null) {
            prevPeerAudioMuted = peerAudioMuted;
        } else if (peerAudioMuted !== prevPeerAudioMuted) {
            prevPeerAudioMuted = peerAudioMuted;
            callAnnouncement = peerAudioMuted
                ? get(LL).callAnnouncePeerMuted({ name: peerName })
                : get(LL).callAnnouncePeerUnmuted({ name: peerName });
        }
    }

    // Route remote audio through the dedicated <audio> element for BOTH audio and video
    // calls. The remote <video> element is muted (video-only), so this is the single audio
    // sink. This keeps audio-only calls working — they have no <video> element, so the old
    // video-gated setup path never attached their stream — and avoids the doubled/echoed
    // audio you'd get from the video element also playing sound.
    $: {
        const audioStream = $remoteStreams.get(call.chatId);
        if (remoteAudioElement && audioStream && remoteAudioElement.srcObject !== audioStream) {
            debug.log('CallInterface: Attaching remote audio stream');
            remoteAudioElement.srcObject = audioStream;
            remoteAudioElement.play().catch((error) => {
                debug.warn('CallInterface: Remote audio autoplay blocked:', error);
            });
        }
    }

    // Attach the remote video stream reactively, mirroring the audio block above.
    // The stream can arrive at very different times on each peer: the callee gets the
    // caller's track early (it sets the remote offer immediately), while the caller only
    // gets the callee's track after the callee accepts. A reactive attach handles both,
    // where the older fixed-delay timeout setup would miss the late-arriving caller-side
    // stream and leave one direction of video blank. Idempotent via the srcObject check.
    $: {
        const videoStream = $remoteStreams.get(call.chatId);
        if (
            isVideoCall &&
            remoteVideoElement &&
            videoStream &&
            remoteVideoElement.srcObject !== videoStream
        ) {
            debug.log('CallInterface: Attaching remote video stream (reactive)');
            remoteVideoElement.srcObject = videoStream;
            remoteVideoElement.muted = true;
            remoteVideoElement.play().catch((error) => {
                debug.warn('CallInterface: Remote video autoplay blocked:', error);
            });
        }
    }

    // Track call state to trigger setup only on specific transitions
    let previousCallState = call.state;
    $: {
        if (call.state !== previousCallState) {
            debug.log(
                'CallInterface: Call state changed from',
                previousCallState,
                'to',
                call.state
            );
            if (
                (call.state === 'outgoing' || call.state === 'connected') &&
                previousCallState !== 'outgoing' &&
                previousCallState !== 'connected'
            ) {
                // Only trigger setup on entry to call state, not on every reactive update.
                // Tracked so it can be cancelled on destroy (prevents a post-unmount
                // getUserMedia that would silently re-enable the camera).
                if (setupTimeout) clearTimeout(setupTimeout);
                setupTimeout = window.setTimeout(() => {
                    setupTimeout = null;
                    setupMediaStreams();
                }, 200);
            }

            if (call.state === 'connected' && previousCallState !== 'connected') {
                debug.log('CallInterface: Call connected - starting timer');

                // The remote video/audio streams attach themselves via the reactive
                // blocks above as soon as they arrive in the store.
                startDurationTimer();
            }

            announceCallState(call.state);
            previousCallState = call.state;
        }
    }

    function announceCallState(state: Call['state']) {
        const t = get(LL);
        switch (state) {
            case 'incoming':
                callAnnouncement = t.callInterfaceStatusIncoming();
                break;
            case 'outgoing':
                callAnnouncement = t.chatInterfaceCallStatusOutgoing();
                break;
            case 'connected':
                callAnnouncement = t.chatInterfaceCallStatusConnected();
                break;
            case 'ended':
                callAnnouncement = t.callInterfaceStatusEnded();
                break;
            case 'failed':
                callAnnouncement = t.callInterfaceStatusFailed();
                break;
        }
    }

    $: durationText = formatDuration(callDuration);
    // Spoken form for assistive technology ("3 minutes, 42 seconds"), localized via
    // Intl unit formatting so no translation strings are needed. Not live: it is read
    // on demand, never announced every second.
    $: durationAriaLabel = formatDurationSpoken(callDuration, $locale);

    onMount(() => {
        debug.log('CallInterface: Component mounted');

        // Seed the live region with the current state so the first announcement does not
        // wait for a transition.
        announceCallState(call.state);

        // The overlay is a modal dialog for assistive technology: remember where focus
        // was and move it to the first call control so keyboard users land on the
        // actionable controls instead of being stranded behind the overlay.
        previouslyFocusedElement =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const firstControl = callInterfaceElement?.querySelector<HTMLElement>(
            '.controls-container button'
        );
        firstControl?.focus();

        setupMediaStreams();
        startDurationTimer();
        setupFullscreenListener();
        resetControlsTimeout();

        if (isVideoCall) {
            detectCameras();
        }

        // Keep the local self-preview attached AND playing. A single attach + play() can lose
        // the race (stream not ready yet) or have play() rejected by the browser's autoplay
        // policy — seen on Firefox for Android, where the element then sits black with a stream
        // that never started. The old check stopped as soon as srcObject was set, so a failed
        // play() was never retried. Retry every tick until the element is actually playing, then
        // stop. Bounded by the 10s clear below.
        streamCheckInterval = window.setInterval(async () => {
            if (call.type !== 'video' || !localVideoElement) return;

            const localStream = mediaManager.getLocalStream();
            if (!localStream) return;

            if (localVideoElement.srcObject !== localStream) {
                debug.log('CallInterface: Attaching local stream to preview');
                localVideoElement.srcObject = localStream;
                localVideoElement.muted = true;
            }

            if (localVideoElement.paused) {
                try {
                    await localVideoElement.play();
                } catch (playError) {
                    debug.warn('CallInterface: Local video play retry blocked:', playError);
                    return; // leave the interval running and try again on the next tick
                }
            }

            // Attached to the current stream and actually playing — nothing left to do.
            debug.log('CallInterface: Local video playing');
            if (streamCheckInterval) clearInterval(streamCheckInterval);
            streamCheckInterval = null;
        }, 500);

        // Clear interval after 10 seconds to avoid infinite checking
        streamCheckClearTimeout = window.setTimeout(() => {
            if (streamCheckInterval) clearInterval(streamCheckInterval);
            streamCheckInterval = null;
        }, 10000);
    });

    onDestroy(() => {
        cleanup();
    });

    async function setupMediaStreams() {
        if (streamSetupPromise) {
            debug.log('CallInterface: Already setting up streams, awaiting existing...');
            return await streamSetupPromise;
        }

        streamSetupPromise = performStreamSetup();
        try {
            await streamSetupPromise;
        } finally {
            streamSetupPromise = null;
        }
    }

    async function performStreamSetup() {
        if (destroyed) return;
        debug.log('CallInterface: Setting up media streams...');

        try {
            let localStream = mediaManager.getLocalStream();
            debug.log('CallInterface: Local stream from MediaManager:', localStream);

            if (!localStream) {
                debug.log('CallInterface: No local stream for call, requesting media access...');
                try {
                    const constraints = {
                        audio: true,
                        video: call.type === 'video',
                    };
                    localStream = await mediaManager.getUserMedia(constraints);
                    debug.log(
                        'CallInterface: Local stream after requesting media:',
                        localStream
                    );
                } catch (error) {
                    debug.error('CallInterface: Failed to get media for call:', error);
                }
            }

            // If the component was torn down while getUserMedia was in flight, don't attach
            // to now-detached elements. (The stream itself is owned by MediaManager and is
            // released by CallService when the call actually ends.)
            if (destroyed) return;

            if (localStream && localVideoElement && call.type === 'video') {
                debug.log('CallInterface: Setting local video element srcObject');
                localVideoElement.srcObject = localStream;
                localVideoElement.muted = true; // Always mute local video to prevent feedback

                localVideoElement.addEventListener('loadedmetadata', () => {
                    debug.log('CallInterface: Video metadata loaded:', {
                        videoWidth: localVideoElement.videoWidth,
                        videoHeight: localVideoElement.videoHeight,
                        duration: localVideoElement.duration,
                    });
                });

                localVideoElement.addEventListener('canplay', () => {
                    debug.log('CallInterface: Video can start playing');
                });

                localVideoElement.addEventListener('playing', () => {
                    debug.log('CallInterface: Video started playing');
                });

                try {
                    await localVideoElement.play();
                    debug.log('CallInterface: Local video playing successfully');
                } catch (playError) {
                    debug.warn('CallInterface: Could not auto-play local video:', playError);
                }

                debug.log('CallInterface: Local video element:', {
                    srcObject: localVideoElement.srcObject,
                    muted: localVideoElement.muted,
                    width: localVideoElement.videoWidth,
                    height: localVideoElement.videoHeight,
                    paused: localVideoElement.paused,
                    readyState: localVideoElement.readyState,
                });
            } else if (call.type === 'video') {
                debug.warn(
                    'CallInterface: No local stream or video element available for video call:',
                    {
                        localStream: !!localStream,
                        localVideoElement: !!localVideoElement,
                    }
                );
            }

            // For audio calls, we still need the stream available for WebRTC
            if (localStream && call.type === 'audio') {
                debug.log('CallInterface: Audio call - local stream ready for WebRTC');
            } else if (call.type === 'audio' && !localStream) {
                debug.warn('CallInterface: No local stream available for audio call');
            }

            // Remote audio/video attach via the reactive store blocks at the top of the script.
        } catch (error) {
            debug.error('CallInterface: Failed to setup media streams:', error);
        }
    }

    function startDurationTimer() {
        // Counts from when the peer answered, not from call.startTime: that is stamped when the
        // call starts ringing, so it would show the ringing seconds as talk time.
        if (call.connectedAt && call.state === 'connected') {
            callDuration = Math.max(0, Math.floor((Date.now() - call.connectedAt) / 1000));
            durationInterval = window.setInterval(() => {
                if (call.connectedAt) {
                    callDuration = Math.max(0, Math.floor((Date.now() - call.connectedAt) / 1000));
                }
            }, 1000);
        }
    }

    function formatDuration(seconds: number): string {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    function formatDurationSpoken(totalSeconds: number, localeCode: string): string {
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        try {
            const minutePart = new Intl.NumberFormat(localeCode, {
                style: 'unit',
                unit: 'minute',
                unitDisplay: 'long',
            }).format(mins);
            const secondPart = new Intl.NumberFormat(localeCode, {
                style: 'unit',
                unit: 'second',
                unitDisplay: 'long',
            }).format(secs);
            return `${minutePart}, ${secondPart}`;
        } catch {
            // Very old engines without unit formatting: fall back to the visible text.
            return formatDuration(totalSeconds);
        }
    }

    function handleMuteAudio() {
        dispatch('toggle-audio', { callId: call.id });
    }

    function handleMuteVideo() {
        dispatch('toggle-video', { callId: call.id });
    }

    function handleEndCall() {
        dispatch('end-call', { callId: call.id });
    }

    async function detectCameras() {
        // Show the switch button when the device can plausibly switch cameras. enumerateDevices
        // is the ideal signal, but some mobile browsers (Firefox for Android) under-report the
        // camera count even with permission. So on touch devices we also offer it whenever a
        // camera exists and let the facingMode toggle in MediaManager.switchCamera flip
        // front/back. On desktop (fine pointer) we keep the strict "more than one" check so a
        // single-webcam laptop does not show a useless button.
        try {
            await mediaManager.enumerateDevices();
            const count = mediaManager.getVideoDevices().length;
            const isTouchDevice = window.matchMedia?.('(pointer: coarse)').matches === true;
            hasMultipleCameras = count > 1 || (isTouchDevice && count >= 1);
        } catch (error) {
            debug.warn('CallInterface: Failed to enumerate cameras:', error);
        }
    }

    async function handleSwitchCamera() {
        // Switching must go through the WebRTC manager, not MediaManager alone: it replaces the
        // track on the peer connection's sender too, otherwise the peer keeps the old (stopped)
        // track and freezes — and locally only the preview would have changed.
        const manager = appStore.getWebRTCManager(call.chatId);
        if (!manager) {
            debug.warn('CallInterface: Cannot switch camera - no WebRTC manager');
            return;
        }

        try {
            await manager.switchCamera();
        } catch (error) {
            debug.error('Failed to switch camera:', error);
        } finally {
            // Refresh the preview whether the switch succeeded or failed: either way the local
            // stream's video track was replaced (new camera, or the restored original), and the
            // stream object is reused, so re-assigning srcObject forces the element to pick up
            // the new track instead of freezing on the last frame of the old one.
            const stream = mediaManager.getLocalStream();
            if (localVideoElement && stream) {
                localVideoElement.srcObject = null;
                localVideoElement.srcObject = stream;
                localVideoElement.muted = true;
                await localVideoElement.play().catch((error) => {
                    debug.warn('CallInterface: Local preview play after switch blocked:', error);
                });
            }
        }
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement
                .requestFullscreen()
                .then(() => {
                    isFullscreen = true;
                })
                .catch((err) => {
                    debug.error('Failed to enter fullscreen:', err);
                });
        } else {
            document
                .exitFullscreen()
                .then(() => {
                    isFullscreen = false;
                })
                .catch((err) => {
                    debug.error('Failed to exit fullscreen:', err);
                });
        }
    }

    function setupFullscreenListener() {
        fullscreenHandler = () => {
            isFullscreen = !!document.fullscreenElement;
        };
        document.addEventListener('fullscreenchange', fullscreenHandler);
    }

    function handleMouseMove() {
        showControls = true;
        resetControlsTimeout();
    }

    // Keyboard focus or typing inside the overlay re-shows the auto-hidden controls,
    // mirroring what mousemove does for pointer users. The controls are only faded out
    // (opacity), never display:none, so they stay in the accessibility tree throughout.
    function handleOverlayInteraction() {
        showControls = true;
        resetControlsTimeout();
    }

    function resetControlsTimeout() {
        if (controlsTimeout) {
            clearTimeout(controlsTimeout);
        }

        controlsTimeout = window.setTimeout(() => {
            if (isConnected) {
                showControls = false;
            }
        }, 3000);
    }

    function cleanup() {
        destroyed = true;
        if (durationInterval) {
            clearInterval(durationInterval);
            durationInterval = null;
        }
        if (controlsTimeout) {
            clearTimeout(controlsTimeout);
            controlsTimeout = null;
        }
        if (setupTimeout) {
            clearTimeout(setupTimeout);
            setupTimeout = null;
        }
        if (streamCheckInterval) {
            clearInterval(streamCheckInterval);
            streamCheckInterval = null;
        }
        if (streamCheckClearTimeout) {
            clearTimeout(streamCheckClearTimeout);
            streamCheckClearTimeout = null;
        }
        if (fullscreenHandler) {
            document.removeEventListener('fullscreenchange', fullscreenHandler);
            fullscreenHandler = null;
        }
        // Hand focus back only when the call is actually over. On a chat switch the
        // component unmounts while the call keeps running in the background, and moving
        // focus then would fight the navigation the user just performed.
        if (
            (call.state === 'ended' || call.state === 'failed') &&
            previouslyFocusedElement &&
            document.contains(previouslyFocusedElement)
        ) {
            previouslyFocusedElement.focus();
        }
        previouslyFocusedElement = null;
    }

    function handleKeydown(event: KeyboardEvent) {
        // Single-letter shortcuts must not fire while the user is typing, when another
        // handler already consumed the event, or when a modifier chord (browser/OS
        // shortcut) is being pressed.
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        const target = event.target;
        if (target instanceof HTMLElement) {
            const tag = target.tagName;
            if (
                tag === 'INPUT' ||
                tag === 'TEXTAREA' ||
                tag === 'SELECT' ||
                target.isContentEditable
            ) {
                return;
            }
        }
        switch (event.key) {
            case 'm':
            case 'M':
                handleMuteAudio();
                break;
            case 'v':
            case 'V':
                if (isVideoCall) {
                    handleMuteVideo();
                }
                break;
            case 'f':
            case 'F':
                toggleFullscreen();
                break;
            case 'Escape':
                if (isFullscreen) {
                    toggleFullscreen();
                }
                break;
        }
    }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<div
    bind:this={callInterfaceElement}
    class="call-interface"
    class:fullscreen={isFullscreen}
    class:video-call={isVideoCall}
    class:audio-call={!isVideoCall}
    on:mousemove={handleMouseMove}
    on:focusin={handleOverlayInteraction}
    on:keydown={handleOverlayInteraction}
    role="dialog"
    aria-modal="true"
    aria-label={$LL.callInterfaceAriaLabel({ name: peerName })}
>
    <!-- Persistent polite live region: announces call state transitions and peer
         mute/unmute changes for screen reader users. Lives for the whole life of the
         overlay so announcements are not lost to remounts of conditional blocks. -->
    <div class="sr-only" role="status" aria-live="polite">{callAnnouncement}</div>

    {#if isVideoCall}
        <div class="remote-video-container">
            <video
                bind:this={remoteVideoElement}
                class="remote-video"
                data-remote-video
                autoplay
                muted
                playsinline
                aria-label={$LL.callInterfaceRemoteVideoAria({ name: peerName })}
            >
                <track kind="captions" />
            </video>

            {#if peerVideoMuted}
                <div class="video-muted-overlay">
                    <div class="muted-avatar">
                        {peerParticipant?.name?.charAt(0) || '?'}
                    </div>
                    <div class="muted-text">{$LL.callInterfaceCameraOff()}</div>
                </div>
            {/if}

            {#if peerAudioMuted}
                <div class="audio-muted-indicator">
                    <Icon name="mic-disabled" size={20} />
                    <span class="sr-only">{$LL.callInterfacePeerMicMuted({ name: peerName })}</span>
                </div>
            {/if}
        </div>

        <div class="local-video-container" class:minimized={!showControls && isConnected}>
            <video
                bind:this={localVideoElement}
                class="local-video"
                autoplay
                muted
                playsinline
                aria-label={$LL.callInterfaceLocalVideoAria()}
            >
                <track kind="captions" />
            </video>

            {#if isVideoMuted}
                <div class="local-video-muted">
                    <Icon name="videocam" size={32} className="local-video-muted-icon" />
                </div>
            {/if}
        </div>
    {/if}

    <audio bind:this={remoteAudioElement} data-remote-audio autoplay></audio>

    <div class="call-info" class:hidden={!showControls && isConnected}>
        <div class="call-header">
            <h2 class="participant-name">{peerName}</h2>
            <div class="call-status">
                {#if call.state === 'incoming'}
                    <span class="status-text connecting">{$LL.callInterfaceStatusIncoming()}</span>
                {:else if call.state === 'outgoing'}
                    <span class="status-text outgoing">{$LL.chatInterfaceCallStatusOutgoing()}</span
                    >
                {:else if call.state === 'connected'}
                    <span class="status-text connected" aria-label={durationAriaLabel}
                        >{durationText}</span
                    >
                {:else if call.state === 'ended'}
                    <span class="status-text ended">{$LL.callInterfaceStatusEnded()}</span>
                {/if}
            </div>
        </div>
    </div>

    <div class="controls-container" class:hidden={!showControls && isConnected}>
        <CallControls
            {call}
            {isAudioMuted}
            {isVideoMuted}
            {isVideoCall}
            {isFullscreen}
            {hasMultipleCameras}
            on:mute-audio={handleMuteAudio}
            on:mute-video={handleMuteVideo}
            on:end-call={handleEndCall}
            on:switch-camera={handleSwitchCamera}
            on:toggle-fullscreen={toggleFullscreen}
        />
    </div>

    {#if call.state === 'outgoing'}
        <div class="connection-indicator">
            <div class="spinner"></div>
        </div>
    {/if}
</div>

<style>
    .call-interface {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        /* 100vh on mobile includes the area behind the browser toolbar, pushing the
           bottom-anchored controls below the fold. dvh tracks the actually-visible height. */
        height: 100vh;
        height: 100dvh;
        background: #000;
        display: flex;
        flex-direction: column;
        z-index: 1000;
        overflow: hidden;
    }

    .call-interface.fullscreen {
        z-index: 10000;
    }

    .video-call {
        background: #000;
    }

    .remote-video-container {
        flex: 1;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .remote-video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        background: #1a1a1a;
    }

    .video-muted-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: #1a1a1a;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: white;
    }

    .muted-avatar {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: #333;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 2rem;
        font-weight: bold;
        margin-bottom: 1rem;
    }

    .muted-text {
        font-size: 1.1rem;
        opacity: 0.8;
    }

    .audio-muted-indicator {
        position: absolute;
        top: 20px;
        left: 20px;
        background: rgba(0, 0, 0, 0.6);
        color: white;
        padding: 8px 12px;
        border-radius: 20px;
        font-size: 1.2rem;
    }

    .local-video-container {
        position: absolute;
        top: 20px;
        right: 20px;
        width: 150px;
        height: 100px;
        border-radius: 12px;
        overflow: hidden;
        background: #333;
        border: 2px solid rgba(255, 255, 255, 0.3);
        transition: all 0.3s ease;
        z-index: 10;
    }

    .local-video-container.minimized {
        transform: scale(0.7);
        opacity: 0.8;
    }

    .local-video {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .local-video-muted {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: #333;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.5rem;
    }

    .local-video-muted :global(.local-video-muted-icon) {
        width: 2rem;
        height: 2rem;
    }

    .call-info {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        padding: 20px;
        background: rgba(0, 0, 0, 0.5);
        color: white;
        z-index: 20;
        transition: opacity 0.3s ease;
    }

    .call-info.hidden {
        opacity: 0;
        pointer-events: none;
    }

    .call-header {
        text-align: center;
    }

    .participant-name {
        margin: 0 0 0.5rem 0;
        font-size: 1.5rem;
        font-weight: 600;
    }

    .call-status {
        font-size: 1rem;
        opacity: 0.9;
    }

    .status-text {
        padding: 4px 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
    }

    .status-text.connecting {
        background: rgba(255, 193, 7, 0.2);
        color: #ffc107;
    }

    .status-text.outgoing {
        background: rgba(0, 123, 255, 0.2);
        color: #006de2;
    }

    .status-text.connected {
        background: rgba(40, 167, 69, 0.2);
        color: #28a745;
    }

    .status-text.ended {
        background: rgba(220, 53, 69, 0.2);
        color: #dc3545;
    }

    .controls-container {
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        padding: 20px;
        /* Keep controls clear of the home indicator / gesture bar on notched phones. */
        padding-bottom: calc(20px + env(safe-area-inset-bottom));
        background: rgba(0, 0, 0, 0.5);
        z-index: 20;
        transition: opacity 0.3s ease;
    }

    .controls-container.hidden {
        opacity: 0;
        pointer-events: none;
    }

    .connection-indicator {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 30;
    }

    .spinner {
        width: 40px;
        height: 40px;
        border: 4px solid rgba(255, 255, 255, 0.3);
        border-top: 4px solid white;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    @media (max-width: 768px) {
        .local-video-container {
            width: 100px;
            height: 75px;
            top: 10px;
            right: 10px;
        }

        .call-info {
            padding: 15px;
        }

        .participant-name {
            font-size: 1.3rem;
        }

        .controls-container {
            padding: 15px;
            padding-bottom: calc(15px + env(safe-area-inset-bottom));
        }

        .audio-muted-indicator {
            top: calc(10px + env(safe-area-inset-top));
            left: 10px;
            padding: 6px 8px;
            font-size: 1rem;
        }
    }
</style>
