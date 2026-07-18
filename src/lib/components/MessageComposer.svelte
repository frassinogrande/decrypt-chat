<script context="module" lang="ts">
    // Unsent drafts, scoped per chat and kept in memory only (never written to
    // disk) so an unsent private message isn't persisted. Switching chats keeps
    // each chat's draft in place; a full reload clears them.
    const chatDrafts = new Map<string, string>();
</script>

<script lang="ts">
    import { createEventDispatcher, onDestroy } from 'svelte';
    import { profileManager } from '../utils/profile-manager';
    import Icon from './icons/Icon.svelte';
    import { translations as LL } from '$lib/i18n/runtime';

    const dispatch = createEventDispatcher();

    export let isOnline = false;
    export let chatId: string;

    // When both peers are online, messages flow live, so share codes are irrelevant.
    $: placeholder = isOnline
        ? $LL.messageComposerPlaceholderOnline()
        : $LL.messageComposerPlaceholder();

    // Markers that identify a pasted share/connection code. Kept in sync with
    // RECEIVABLE_MARKERS in +page.svelte, which actually imports the code on send.
    const RECEIVABLE_MARKERS = ['#secure=', '#webrtc-offer=', '#webrtc-answer='];
    // 'none' = normal message; 'valid' = a well-formed share code; 'invalid' = text that
    // starts with a known marker but whose payload is empty/garbled (e.g. a truncated
    // paste). We can only sanity-check the format here, not decrypt it.
    function shareCodeStatus(text: string): 'none' | 'valid' | 'invalid' {
        const hashIndex = text.indexOf('#');
        if (hashIndex === -1) return 'none';
        const hash = text.slice(hashIndex);
        const marker = RECEIVABLE_MARKERS.find((m) => hash.startsWith(m));
        if (!marker) return 'none';
        const payload = hash.slice(marker.length);
        // Codes are long base64url blobs (optionally percent-encoded) with no internal
        // whitespace; anything shorter or with stray characters is a broken paste.
        const wellFormed = payload.length >= 12 && /^[A-Za-z0-9\-_%]+$/.test(payload);
        return wellFormed ? 'valid' : 'invalid';
    }
    // When the composer holds a share code, sending imports it rather than sending a
    // message, so the button reflects that with a distinct icon and label.
    $: codeStatus = shareCodeStatus(message.trim());
    $: sendIconName =
        codeStatus === 'invalid'
            ? 'warning'
            : codeStatus === 'valid'
              ? 'check'
              : isOnline
                ? 'send'
                : 'copy';
    $: sendLabel =
        codeStatus === 'invalid'
            ? $LL.messageComposerInvalidCodeTooltip()
            : codeStatus === 'valid'
              ? $LL.messageComposerReceiveCodeTooltip()
              : isOnline
                ? $LL.messageComposerSendTooltipOnline()
                : $LL.messageComposerSendTooltipOffline();

    const textareaId = `message-input-${Math.random().toString(36).slice(2, 8)}`;
    const codeStatusId = `${textareaId}-code-status`;

    // Spoken feedback for a pasted share code. The visual cue is only a swapped
    // send-button icon/label, which a screen reader on the textarea never hears;
    // this always-mounted status region announces the same state politely.
    $: codeStatusText =
        codeStatus === 'invalid'
            ? $LL.messageComposerInvalidCodeTooltip()
            : codeStatus === 'valid'
              ? $LL.messageComposerReceiveCodeTooltip()
              : '';

    let message = chatDrafts.get(chatId) ?? '';
    // Track which chat `message` currently belongs to. When the composer is reused
    // for a different chat, save the outgoing draft and load the incoming one.
    let activeChatId = chatId;
    $: if (chatId !== activeChatId) {
        chatDrafts.set(activeChatId, message);
        activeChatId = chatId;
        message = chatDrafts.get(chatId) ?? '';
    }

    let enterSends = true;
    const unsubscribeSettings = profileManager.settings.subscribe((s) => {
        enterSends = s?.enterKeySendsMessage ?? true;
    });

    onDestroy(() => {
        // Preserve the draft if the composer unmounts without a chat switch.
        chatDrafts.set(activeChatId, message);
        unsubscribeSettings();
    });

    function handleSubmit() {
        const trimmed = message.trim();
        if (!trimmed) return;

        dispatch('send-message', { message: trimmed });
        message = '';
        chatDrafts.delete(activeChatId);
        dispatch('typing', { isTyping: false });
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' && !event.shiftKey) {
            if (enterSends) {
                event.preventDefault();
                handleSubmit();
            } else {
                // Allow newline insertion; height will adjust on input
            }
        }
    }

    function onInput() {
        chatDrafts.set(activeChatId, message);
        dispatch('typing', { isTyping: message.trim().length > 0 });
    }

    function handleBlur() {
        dispatch('typing', { isTyping: false });
    }
</script>

<div class="composer-container">
    <div class="composer">
        <div class="input-container">
            <label class="sr-only" for={textareaId}>
                {$LL.messageComposerTextareaLabel
                    ? $LL.messageComposerTextareaLabel()
                    : $LL.messageComposerSendTooltipOnline()}
            </label>
            <textarea
                id={textareaId}
                bind:value={message}
                on:keydown={handleKeydown}
                on:input={onInput}
                on:blur={handleBlur}
                {placeholder}
                aria-label={$LL.messageComposerTextareaLabel
                    ? $LL.messageComposerTextareaLabel()
                    : placeholder}
                aria-describedby={codeStatusId}
                class="input"
                rows="1"
            ></textarea>
            <div id={codeStatusId} class="sr-only" role="status">{codeStatusText}</div>
        </div>
        <div class="button-group">
            <button
                type="button"
                class="btn btn--primary btn--icon send-button"
                disabled={!message.trim()}
                on:click={handleSubmit}
                title={sendLabel}
                aria-label={sendLabel}
            >
                <Icon name={sendIconName} size={22} className="send-icon" />
            </button>
        </div>
    </div>
</div>

<style>
    .composer-container {
        background: var(--color-bg);
        border-top: 1px solid var(--color-border);
        padding: 1rem;
    }

    .composer {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin: 0 auto;
    }

    .input-container {
        display: flex;
        flex: 1;
        position: relative;
        min-width: 0;
    }

    textarea {
        max-height: 120px;
    }

    .button-group {
        display: flex;
        gap: 0.5rem;
        align-items: center;
    }

    .send-button {
        width: 48px;
        height: 48px;
        --btn-padding: 0;
        --btn-radius: 50%;
        flex-shrink: 0;
    }

    @media (max-width: 600px) {
        .composer-container {
            padding: 0.75rem;
        }

        .composer {
            gap: 0.5rem;
        }

        .send-button {
            width: 44px;
            height: 44px;
        }
    }
</style>
