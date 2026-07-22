<script lang="ts">
    import { createEventDispatcher, onMount } from 'svelte';
    import { copyToClipboard } from '$lib/utils/web-share';
    import { translations as LL } from '$lib/i18n/runtime';

    export let conversationName: string;
    export let isGeneratingOffer = false;
    export let connectionUrl = '';
    export let generatedAnswerUrl = '';
    export let connectionFailed = false;
    export let canRetryConnection = false;
    export let connected = false;
    export let isConnecting = false;
    export let role: 'sender' | 'receiver' | null = null;
    // True when the store's gesture-anchored auto-copy already landed the code
    // on the clipboard (the only path that works on Safari, where the copy
    // attempts below run outside a user gesture and fail).
    export let autoCopied = false;

    const dispatch = createEventDispatcher();

    // Determine which face of the panel to show. `connected` wins over everything so the
    // success line shows regardless of any lingering offer/role state during teardown.
    // An explicit receiver role keeps the panel in receiver mode while its answer code is
    // still being built (generatedAnswerUrl not set yet).
    type Mode = 'connected' | 'failed' | 'receiver' | 'sender';
    $: mode = (
        connected
            ? 'connected'
            : connectionFailed
              ? 'failed'
              : generatedAnswerUrl || role === 'receiver'
                ? 'receiver'
                : 'sender'
    ) as Mode;

    // Show the generating spinner while the active code is still being produced, for both
    // the sender (offer) and the receiver (answer).
    $: isGenerating =
        (mode === 'sender' && (isGeneratingOffer || !connectionUrl)) ||
        (mode === 'receiver' && !generatedAnswerUrl);
    $: activeCode = mode === 'receiver' ? generatedAnswerUrl : connectionUrl;

    let copySuccess = false;
    let receiverWaiting = false;
    // Whether this panel's own copy attempts put the active code on the clipboard.
    // They can silently fail (clipboard writes often need a user gesture /
    // permission), so combined with the store's flag the instruction only claims
    // "copied" once a copy has genuinely succeeded.
    let selfCopied = false;
    $: codeOnClipboard = autoCopied || selfCopied;

    let hasRequestedOffer = false;
    $: if (mode === 'sender' && !connectionUrl && !isGeneratingOffer && !hasRequestedOffer) {
        hasRequestedOffer = true;
        dispatch('generate-offer');
    }

    let hasAutoCopiedSender = false;
    $: if (mode === 'sender' && connectionUrl && !hasAutoCopiedSender) {
        hasAutoCopiedSender = true;
        void copyToClipboard(connectionUrl).then((result) => {
            selfCopied = result;
        });
    }

    let hasAutoCopiedReceiver = false;
    $: if (mode === 'receiver' && generatedAnswerUrl && !hasAutoCopiedReceiver) {
        hasAutoCopiedReceiver = true;
        void copyToClipboard(generatedAnswerUrl).then((result) => {
            selfCopied = result;
        });
    }

    $: instruction =
        mode === 'receiver'
            ? codeOnClipboard
                ? $LL.connectionPanelReceiverInstruction({ name: conversationName })
                : $LL.connectionPanelReceiverInstructionUncopied({ name: conversationName })
            : codeOnClipboard
              ? $LL.connectionPanelSenderInstruction({ name: conversationName })
              : $LL.connectionPanelSenderInstructionUncopied({ name: conversationName });

    function flashCopied() {
        copySuccess = true;
        setTimeout(() => (copySuccess = false), 5000);
    }

    async function copyCode() {
        if (!activeCode) return;
        if (mode === 'receiver') receiverWaiting = true;
        const result = await copyToClipboard(activeCode);
        if (result) {
            selfCopied = true;
            flashCopied();
            dispatch('copy');
        }
    }

    function dismiss() {
        dispatch('dismiss');
    }

    // Spoken connect-flow state. The panel mounts with content, so a live region
    // rendered directly with text would not be announced; instead this region
    // mounts empty and is filled shortly after mount, so both the initial state
    // ("Generating a secure code...") and every later transition (copied,
    // connected, failed) are announced politely.
    let announcerReady = false;
    onMount(() => {
        const timer = setTimeout(() => (announcerReady = true), 150);
        return () => clearTimeout(timer);
    });

    $: liveStatusText = isConnecting
        ? $LL.connectionPanelConnectingStatus()
        : mode === 'connected'
          ? $LL.connectionPanelConnectedTitle({ name: conversationName })
          : mode === 'failed'
            ? $LL.connectionPanelFailedTitle()
            : isGenerating
              ? $LL.connectionWizardGenerating()
              : copySuccess
                ? $LL.connectionPanelCopied()
                : mode === 'receiver' && receiverWaiting
                  ? $LL.connectionWizardWaitingStatus({ name: conversationName })
                  : instruction;
    $: announcedStatus = announcerReady ? liveStatusText : '';

    function retry() {
        dispatch('retry');
    }
</script>

<div class="connection-panel" role="region" aria-label={$LL.connectionWizardTitle({ name: conversationName })}>
    <div class="sr-only" role="status">{announcedStatus}</div>
    {#if isConnecting}
        <!-- Tutorial-only "Connecting..." face (the parent passes isConnecting only for the guided
             tour). Checked first so it shows while the tour is finishing the handshake. Like the
             generating state, it is its own buttonless face: just a live status line, no
             copy/cancel. The real app never sets isConnecting, so its panel is unaffected. -->
        <p class="panel-line">
            <span class="pulse-dot"></span>
            {$LL.connectionPanelConnectingStatus()}
        </p>
    {:else if mode === 'connected'}
        <p class="panel-title panel-title--connected">
            <span class="success-dot"></span>
            {$LL.connectionPanelConnectedTitle({ name: conversationName })}
        </p>
    {:else if mode === 'failed'}
        <p class="panel-title panel-title--failed">{$LL.connectionPanelFailedTitle()}</p>
        <details class="failed-details">
            <summary>{$LL.connectionPanelDetailsSummary()}</summary>
            <p>{$LL.connectionPanelFailedIntro()}</p>
            <ul>
                <li>{$LL.connectionPanelFailedBrowser()}</li>
                <li>{$LL.connectionPanelFailedVpn()}</li>
                <li>{$LL.connectionPanelFailedFirewall()}</li>
                <li>{$LL.connectionPanelFailedNat()}</li>
            </ul>
        </details>
        <div class="panel-actions">
            {#if canRetryConnection}
                <button type="button" class="btn btn--primary" on:click={retry}>
                    {$LL.connectionPanelRetry()}
                </button>
            {/if}
            <button type="button" class="btn btn--secondary" on:click={dismiss}>
                {$LL.connectionPanelDismiss()}
            </button>
        </div>
    {:else if isGenerating}
        <p class="panel-line">
            <span class="pulse-dot"></span>
            {$LL.connectionWizardGenerating()}
        </p>
    {:else}
        <p class="panel-title">
            {mode === 'receiver'
                ? $LL.connectionPanelReceiverTitle({ name: conversationName })
                : $LL.connectionPanelSenderTitle({ name: conversationName })}
        </p>

        {#if mode === 'receiver' && receiverWaiting}
            <p class="panel-instruction waiting">
                <span class="pulse-dot"></span>
                {$LL.connectionWizardWaitingStatus({ name: conversationName })}
            </p>
        {:else}
            <p class="panel-instruction">
                {instruction}
            </p>
        {/if}

        <div class="panel-actions">
            <button
                type="button"
                class="btn btn--primary"
                class:copied={copySuccess}
                on:click={copyCode}
            >
                {copySuccess ? $LL.connectionPanelCopied() : $LL.connectionWizardCopyAction()}
            </button>
            <button type="button" class="btn btn--secondary" on:click={dismiss}>
                {$LL.connectionPanelCancel()}
            </button>
        </div>
    {/if}
</div>

<style>
    .connection-panel {
        padding: 1rem;
        background: var(--color-bg-subtle);
        border-top: 1px solid var(--color-border);
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .panel-title {
        margin: 0;
        font-weight: 600;
        font-size: 0.9rem;
        color: var(--color-text);
    }

    .panel-title--failed {
        color: var(--color-error-text);
    }

    .panel-title--connected {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--color-success-text);
    }

    .success-dot {
        width: 10px;
        height: 10px;
        flex-shrink: 0;
        background: #16a34a;
        border-radius: 50%;
    }

    .panel-line {
        margin: 0;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
        color: var(--color-text-muted);
    }

    .panel-instruction {
        margin: 0;
        font-size: 0.85rem;
        line-height: 1.4;
        color: var(--color-text-muted);
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .panel-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.15rem;
    }

    .panel-actions .btn {
        --btn-padding: 0.4rem 0.85rem;
        font-size: 0.85rem;
    }

    .pulse-dot {
        width: 10px;
        height: 10px;
        flex-shrink: 0;
        background: #3b82f6;
        border-radius: 50%;
        animation: pulse 2s infinite;
    }

    .copied {
        --btn-bg: #16a34a;
        --btn-hover-bg: #15803d;
        --btn-border: #16a34a;
    }

    .failed-details {
        font-size: 0.85rem;
        color: var(--color-text-muted);
    }

    .failed-details summary {
        cursor: pointer;
        color: var(--color-accent-text);
        font-weight: 600;
    }

    .failed-details p {
        margin: 0.6rem 0 0.4rem 0;
        line-height: 1.5;
    }

    .failed-details ul {
        margin: 0;
        padding-left: 1.25rem;
        line-height: 1.5;
    }

    .failed-details li {
        margin-bottom: 0.35rem;
    }

    @keyframes pulse {
        0% {
            opacity: 1;
            transform: scale(1);
        }
        50% {
            opacity: 0.5;
            transform: scale(1.2);
        }
        100% {
            opacity: 1;
            transform: scale(1);
        }
    }
</style>
