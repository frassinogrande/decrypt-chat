<script context="module" lang="ts">
    import { debug } from '$lib/utils/debug';
    let bubbleCount = 0;

    // Placeholder bodies for messages that cannot be shown (session locked or
    // undecryptable). Exported so ChatMessagesPane's incoming-message announcer
    // can substitute a spoken locked-message string for them.
    export const HIDDEN_PLACEHOLDERS = new Set([
        '[Encrypted]',
        '[Encrypted message - session locked]',
        '[Encrypted message - key not found]',
        '[Encrypted message - decryption failed]',
    ]);
</script>

<script lang="ts">
    import { tick, createEventDispatcher } from 'svelte';
    import { get } from 'svelte/store';
    import type { StoredMessage } from '../types';
    import { appStore } from '../stores/app';
    import { profileManager } from '../utils/profile-manager';
    const profileSettings = profileManager.settings;
    import { copyToClipboard } from '../utils/web-share';
    import { buildShareCode } from '../utils/share-link';
    import { linkMessageOverageChars } from '../utils/secure-chat-storage';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { translations as LL, locale as localeStore } from '$lib/i18n/runtime';
    import { anchorFallback } from '$lib/actions/anchor-fallback';

    const dispatch = createEventDispatcher();

    export let message: StoredMessage;
    export let chatId: string;
    // Optional highlight to preview a pending (unsent) reaction selection
    export let highlightReaction: 'laugh' | 'heart' | '100' | null = null;
    export let canReact: boolean = false;
    export let isOnline: boolean = false;
    // Roving-tabindex feed pattern: inline controls stay out of the tab order
    // until the user drills into this message (Enter on the focused article).
    export let controlsTabbable: boolean = false;

    $: controlTabindex = controlsTabbable ? 0 : -1;

    $: autoDeleteAfter = message.autoDeleteAfter ?? null;

    type MessageSegment =
        | { type: 'text'; content: string }
        | { type: 'link'; content: string; href: string }
        | { type: 'bold'; content: string }
        | { type: 'italic'; content: string }
        | { type: 'bolditalic'; content: string };

    // Basic inline markdown: ***both***, **bold**, *italic*, _italic_.
    // Markers must hug non-space content (no `* spaced *`) to avoid matching
    // stray asterisks/underscores in ordinary prose. No nesting is supported.
    const INLINE_MD_PATTERN =
        /\*\*\*(\S(?:[^*]*\S)?)\*\*\*|\*\*(\S(?:[^*]*\S)?)\*\*|\*(\S(?:[^*]*\S)?)\*|_(\S(?:[^_]*\S)?)_/g;

    function parseInlineMarkdown(text: string): MessageSegment[] {
        const out: MessageSegment[] = [];
        const regex = new RegExp(INLINE_MD_PATTERN.source, 'g');
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                out.push({ type: 'text', content: text.slice(lastIndex, match.index) });
            }

            if (match[1] !== undefined) {
                out.push({ type: 'bolditalic', content: match[1] });
            } else if (match[2] !== undefined) {
                out.push({ type: 'bold', content: match[2] });
            } else if (match[3] !== undefined) {
                out.push({ type: 'italic', content: match[3] });
            } else if (match[4] !== undefined) {
                out.push({ type: 'italic', content: match[4] });
            }

            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < text.length) {
            out.push({ type: 'text', content: text.slice(lastIndex) });
        }

        return out;
    }

    const URL_PATTERN = /(https?:\/\/[^\s<>()[\]{}"']+|www\.[^\s<>()[\]{}"']+)/gi;
    const TRAILING_PUNCTUATION = /[)\]}>,.;!?:"']+$/;

    function hasVisibleTextContent(msg: StoredMessage): boolean {
        const body = msg.body;
        if (!body) return false;
        const trimmed = body.trim();
        if (!trimmed) return false;
        if (HIDDEN_PLACEHOLDERS.has(trimmed)) return false;
        return true;
    }

    function getLocaleCode(): string {
        try {
            return get(localeStore);
        } catch (
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            _error
        ) {
            return 'en';
        }
    }

    function normalizeUrlForHref(raw: string): string {
        return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    }

    function splitMessageIntoSegments(body?: string | null): MessageSegment[] {
        if (!body) return [];

        const segments: MessageSegment[] = [];
        const regex = new RegExp(URL_PATTERN.source, 'gi');
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(body)) !== null) {
            const matchText = match[0];
            const matchStart = match.index;

            if (matchStart > lastIndex) {
                segments.push({ type: 'text', content: body.slice(lastIndex, matchStart) });
            }

            let linkText = matchText;
            let trailing = '';
            const punctuationMatch = linkText.match(TRAILING_PUNCTUATION);
            if (punctuationMatch) {
                const trimmed = linkText.slice(0, -punctuationMatch[0].length);
                if (trimmed) {
                    linkText = trimmed;
                    trailing = punctuationMatch[0];
                }
            }

            if (linkText) {
                segments.push({
                    type: 'link',
                    content: linkText,
                    href: normalizeUrlForHref(linkText),
                });
            } else {
                segments.push({ type: 'text', content: matchText });
            }

            if (trailing) {
                segments.push({ type: 'text', content: trailing });
            }

            lastIndex = matchStart + matchText.length;
        }

        if (lastIndex < body.length) {
            segments.push({ type: 'text', content: body.slice(lastIndex) });
        }

        // Expand plain-text runs into inline-markdown segments. Links are left
        // untouched (a URL never contains markdown we want to interpret).
        const expanded: MessageSegment[] = [];
        for (const seg of segments) {
            if (seg.type === 'text') {
                expanded.push(...parseInlineMarkdown(seg.content));
            } else {
                expanded.push(seg);
            }
        }

        return expanded;
    }

    let messageSegments: MessageSegment[] = [];

    $: messageSegments = splitMessageIntoSegments(message?.body);

    let hasTextContent = false;
    $: hasTextContent = hasVisibleTextContent(message);

    // Hidden-placeholder bodies render as an empty bubble; give screen readers an
    // explanatory body instead of silence.
    $: isHiddenPlaceholder = !!message?.body && HIDDEN_PLACEHOLDERS.has(message.body.trim());

    // A message body may carry a bare share/connection code (e.g. the guided tour's sample
    // message or its connection answer). Any leading prose is shown as normal text and the code
    // itself is rendered as a compact card with a copy button, rather than a wall of base64.
    const SHARE_CODE_RE = /#(?:secure|webrtc-offer|webrtc-answer)=\S+/;
    let shareCodeText = '';
    let shareCodePrefix = '';
    $: {
        const match = message?.body ? message.body.match(SHARE_CODE_RE) : null;
        shareCodeText = match ? match[0] : '';
        shareCodePrefix = match ? message.body!.slice(0, match.index).trim() : '';
    }
    $: isShareCode = shareCodeText.length > 0;

    // Imported history is a local record of a conversation that happened elsewhere.
    // Re-sharing it would mint a brand-new code stamped with today's timestamp, so
    // the action is hidden rather than offered on messages that were never ours to send.
    $: isImported = /^(?:imported )?via\s+/i.test(message?.deliveryMethod ?? '');

    let codeCopied = false;
    let codeCopiedTimer: ReturnType<typeof setTimeout> | undefined;
    async function copyShareCode() {
        if (!shareCodeText) return;
        const ok = await copyToClipboard(shareCodeText);
        if (ok) {
            codeCopied = true;
            clearTimeout(codeCopiedTimer);
            codeCopiedTimer = setTimeout(() => (codeCopied = false), 2000);
        }
    }

    $: use24HourTime = $profileSettings.use24HourTime;

    function formatShortTime(timestamp: number, use24Hour: boolean): string {
        const date = new Date(timestamp);
        const localeCode = getLocaleCode();
        try {
            return new Intl.DateTimeFormat(localeCode, {
                hour: '2-digit',
                minute: '2-digit',
                hour12: !use24Hour,
            }).format(date);
        } catch (error) {
            debug.debug('Failed to format time:', error);
            return date.toLocaleTimeString();
        }
    }

    function formatFullDateTimeTitle(timestamp: number, use24Hour: boolean): string {
        const date = new Date(timestamp);
        const localeCode = getLocaleCode();
        try {
            return new Intl.DateTimeFormat(localeCode, {
                dateStyle: 'full',
                timeStyle: 'short',
                hour12: !use24Hour,
            }).format(date);
        } catch (error) {
            debug.debug('Failed to format date/time title:', error);
            return date.toLocaleString();
        }
    }

    function formatExpiryDate(timestamp: number, deleteAfter: number, use24Hour: boolean): string {
        const expiresAt = new Date(timestamp + deleteAfter);
        const localeCode = getLocaleCode();
        try {
            return new Intl.DateTimeFormat(localeCode, {
                dateStyle: 'full',
                timeStyle: 'short',
                hour12: !use24Hour,
            }).format(expiresAt);
        } catch (error) {
            debug.debug('Failed to format expiry date:', error);
            return expiresAt.toLocaleString();
        }
    }

    function formatAutoDeleteDuration(ms: number, t: typeof import('$paraglide/messages')): string {
        if (ms === 3600000) return t.autoDeleteDurationHour();
        if (ms === 86400000) return t.autoDeleteDurationDay();
        if (ms === 604800000) return t.autoDeleteDurationWeek();
        if (ms === 2592000000) return t.autoDeleteDurationMonth();
        return '';
    }

    function shareMessage() {
        messageMenuRef?.hidePopover();

        if (typeof window === 'undefined' || !window.secureChatStorage) {
            alert(get(LL).messageBubbleShareUnavailable());
            return;
        }

        const messageBody =
            message.body && message.body.trim().length > 0
                ? message.body
                : get(LL).messageBubbleShareEmpty();
        const overageChars = linkMessageOverageChars(messageBody);
        if (overageChars > 0) {
            alert(get(LL).errorMessageTooLongForLink({ count: overageChars }));
            return;
        }

        // The copy starts synchronously with a pending promise; Safari drops the
        // click's transient activation at the first await, so building the code
        // first and copying after would fail there.
        copyToClipboard(buildShareText(window.secureChatStorage, messageBody)).catch((error) => {
            debug.error('Failed to share message:', error);
            alert(get(LL).messageBubbleShareError());
        });
    }

    async function buildShareText(
        storage: NonNullable<typeof window.secureChatStorage>,
        messageBody: string
    ): Promise<string> {
        // Determine if there is a reaction on the latest non-own message to embed (last-only)
        let meta: any = undefined;
        try {
            const { dataStorage } = await import('../utils/indexeddb-storage');
            const msgs = await dataStorage.getMessagesByChat(chatId);
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m: any = msgs[i];
                if (!m.isOwn) {
                    if (m.reaction) {
                        meta = { emoji: m.reaction };
                    }
                    break;
                }
            }
        } catch (e) {
            // ignore meta lookup failures
        }

        // Reuse the original message's UUID so the regenerated code is the
        // same identity as the message it came from. Without this a fresh
        // UUID is minted, so pasting your own copied code back into your own
        // chat sidesteps the "your own share code" self-paste check and gets
        // stored as an incoming message from the other side.
        const shareOptions: { meta?: any; forceMessageUuid?: string } = {};
        if (meta) shareOptions.meta = meta;
        if (message.remoteUuid) shareOptions.forceMessageUuid = message.remoteUuid;
        const encodedPayload = await storage.createSharePayload(
            chatId,
            messageBody,
            message.from && message.from.trim().length > 0
                ? message.from
                : get(LL).messageBubbleShareAnonymous(),
            Object.keys(shareOptions).length > 0 ? shareOptions : undefined
        );
        return buildShareCode(`#secure=${encodedPayload}`);
    }

    async function removeMessageLocally() {
        // Delete the message from storage
        const { chatStorage } = await import('../utils/chat-storage');
        await chatStorage.deleteMessage(message.id);

        // Remove from cache to prevent it from reappearing
        (appStore as any).removeMessage(chatId, message.id);

        // Trigger UI removal
        dispatch('messageDeleted', { messageId: message.id });
    }

    async function deleteMessageForMe() {
        if (isDeletingForMe || isDeletingForEveryone) return;

        messageMenuRef?.hidePopover();

        const confirmed = confirm(get(LL).messageBubbleConfirmDeleteMessage());

        if (!confirmed) return;

        try {
            isDeletingForMe = true;
            await removeMessageLocally();
        } catch (error) {
            debug.error('Failed to delete message:', error);
            alert(get(LL).messageBubbleErrorDeleteMessage());
        } finally {
            isDeletingForMe = false;
        }
    }

    async function deleteMessageForEveryone() {
        if (isDeletingForMe || isDeletingForEveryone) return;
        if (!message.isOwn) return;
        if (!isOnline) {
            alert(get(LL).messageBubbleDeleteForEveryoneOffline());
            return;
        }
        if (!message.remoteUuid) {
            alert(get(LL).messageBubbleDeleteForEveryoneUnsynced());
            return;
        }

        messageMenuRef?.hidePopover();

        const confirmed = confirm(get(LL).messageBubbleConfirmDeleteEveryone());

        if (!confirmed) return;

        try {
            isDeletingForMe = true;
            isDeletingForEveryone = true;

            const success = await appStore.sendRealTimeDelete(chatId, message.remoteUuid);
            if (!success) {
                alert(get(LL).messageBubbleErrorDeleteEveryoneConnectivity());
                return;
            }

            await removeMessageLocally();
        } catch (error) {
            debug.error('Failed to delete message for everyone:', error);
            alert(get(LL).messageBubbleErrorDeleteEveryone());
        } finally {
            isDeletingForMe = false;
            isDeletingForEveryone = false;
        }
    }

    function getDeliveryMethodLabel(): string {
        const raw = message.deliveryMethod;
        if (!raw) {
            return get(LL).messageBubbleDeliverySentOffline();
        }
        const normalized = raw.toLowerCase();
        if (normalized === 'online') {
            return get(LL).messageBubbleDeliverySentOnline();
        }
        if (normalized === 'offline') {
            return get(LL).messageBubbleDeliverySentOffline();
        }
        if (normalized.startsWith('imported via ')) {
            const source = raw.slice('imported via '.length).trim();
            return get(LL).messageBubbleDeliveryImportedVia({ source });
        }
        if (/^via\s+/i.test(raw)) {
            const source = raw.replace(/^via\s+/i, '').trim();
            return get(LL).messageBubbleDeliveryImportedVia({ source });
        }
        return raw;
    }

    let showMenu = false;
    let isDeletingForMe = false;
    let isDeletingForEveryone = false;
    let messageMenuRef: HTMLDivElement;
    let menuTriggerRef: HTMLButtonElement;
    let reactionTriggerRef: HTMLButtonElement;
    let expiryTriggerRef: HTMLButtonElement;

    function handleMessageMenuKeydown(event: KeyboardEvent) {
        if (!messageMenuRef) return;
        const items = Array.from(
            messageMenuRef.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])')
        );
        const idx = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            items[(idx + 1) % items.length]?.focus();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            items[(idx - 1 + items.length) % items.length]?.focus();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            messageMenuRef?.hidePopover();
            menuTriggerRef?.focus();
        }
    }

    function handlePopoverToggle(event: ToggleEvent) {
        showMenu = event.newState === 'open';
        if (showMenu) {
            tick().then(() => {
                messageMenuRef
                    ?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')
                    ?.focus();
            });
        }
    }

    let showReactionPicker = false;
    let reactionPickerRef: HTMLDivElement;
    const reactionEmoji: Record<'laugh' | 'heart' | '100', string> = {
        laugh: '😂',
        heart: '❤️',
        '100': '💯',
    };

    // Resolve which reaction to show (persisted or pending preview)
    let currentReaction: 'laugh' | 'heart' | '100' | null = null;
    $: currentReaction = (message.reaction ?? highlightReaction) || null;

    function getReactionEmoji(r: 'laugh' | 'heart' | '100' | null): string {
        return r ? reactionEmoji[r] : '';
    }

    function triggerReaction(type: 'laugh' | 'heart' | '100') {
        reactionPickerRef?.hidePopover();
        dispatch('react', { messageId: message.id, remoteUuid: message.remoteUuid, type });
    }

    function clearReaction() {
        reactionPickerRef?.hidePopover();
        dispatch('unreact', { messageId: message.id, remoteUuid: message.remoteUuid });
    }

    function handleReactionPickerToggle(event: ToggleEvent) {
        showReactionPicker = event.newState === 'open';
    }

    const bubbleId = ++bubbleCount;
    const anchorName = `--menu-${bubbleId}`;
    const popoverId = `menu-popup-${bubbleId}`;
    const reactionAnchorName = `--react-${bubbleId}`;
    const reactionPopoverId = `react-popup-${bubbleId}`;
    const expiryAnchorName = `--expiry-${bubbleId}`;
    const expiryPopoverId = `expiry-popup-${bubbleId}`;
</script>

<div class="message-wrapper" class:own={message.isOwn}>
    <div
        class="message-bubble"
        class:own={message.isOwn}
        class:has-reaction={canReact || !!currentReaction}
    >
        <div class="message-contents">
            {#if hasTextContent}
                {#if isShareCode}
                    <div class="message-content">
                        {#if shareCodePrefix}
                            <span class="share-code-prefix">{shareCodePrefix}</span>
                        {/if}
                        <div class="share-code-block">
                            <!-- The raw code is a wall of base64 that screen readers would
                                 spell out character by character; hide it and provide a
                                 short spoken label instead. -->
                            <code class="share-code-text" aria-hidden="true">{shareCodeText}</code>
                            <span class="sr-only">{$LL.a11yShareCode()}</span>
                            <button
                                type="button"
                                class="btn btn--secondary share-code-copy"
                                tabindex={controlTabindex}
                                on:click={copyShareCode}
                            >
                                <Icon name="copy" size={14} />
                                <span>
                                    {codeCopied
                                        ? $LL.messageBubbleCodeCopied()
                                        : $LL.messageBubbleCopyCode()}
                                </span>
                            </button>
                        </div>
                    </div>
                {:else}
                    <div class="message-content">
                        {#each messageSegments as segment, index}
                            {#if segment.type === 'link'}
                                <a
                                    class="message-link"
                                    href={segment.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    tabindex={controlTabindex}
                                >
                                    {segment.content}
                                </a>
                            {:else if segment.type === 'bold'}
                                <strong>{segment.content}</strong>
                            {:else if segment.type === 'italic'}
                                <em>{segment.content}</em>
                            {:else if segment.type === 'bolditalic'}
                                <strong><em>{segment.content}</em></strong>
                            {:else}
                                <span>{segment.content}</span>
                            {/if}
                        {/each}
                    </div>
                {/if}
            {:else if isHiddenPlaceholder}
                <span class="sr-only">{$LL.a11yMessageLocked()}</span>
            {/if}

            <div class="message-menu">
                <button
                    type="button"
                    class="btn btn--secondary menu-trigger"
                    tabindex={controlTabindex}
                    bind:this={menuTriggerRef}
                    popovertarget={popoverId}
                    popovertargetaction="toggle"
                    style="anchor-name: {anchorName}"
                    title={$LL.messageBubbleMenuTitle()}
                    aria-label={$LL.messageBubbleMenuTitle()}
                    aria-haspopup="menu"
                    aria-expanded={showMenu}
                >
                    <Icon name="more-horiz" size={16} />
                </button>

                <div
                    id={popoverId}
                    popover="auto"
                    class="menu-dropdown"
                    role="menu"
                    tabindex="0"
                    aria-label={$LL.messageBubbleMenuTitle()}
                    bind:this={messageMenuRef}
                    on:keydown={handleMessageMenuKeydown}
                    on:toggle={handlePopoverToggle}
                    use:anchorFallback={{ trigger: menuTriggerRef, placement: 'top-end' }}
                    style="position-anchor: {anchorName}"
                >
                    {#if message.isOwn && !isImported}
                        <button
                            type="button"
                            class="btn btn--secondary menu-item"
                            role="menuitem"
                            on:click={shareMessage}
                        >
                            <span class="menu-icon">
                                <Icon name="copy" size={14} className="menu-icon-graphic" />
                            </span>
                            <span class="menu-text">{$LL.messageBubbleCopyLink()}</span>
                        </button>
                    {/if}
                    <button
                        type="button"
                        class="btn btn--warning menu-item delete"
                        role="menuitem"
                        on:click={deleteMessageForMe}
                        disabled={isDeletingForMe || isDeletingForEveryone}
                    >
                        <span class="menu-icon">
                            <Icon name="bin" size={14} className="menu-icon-graphic" />
                        </span>
                        <span class="menu-text">
                            {#if isDeletingForMe || isDeletingForEveryone}
                                {$LL.messageBubbleMenuDeleting()}
                            {:else}
                                {$LL.messageBubbleMenuDeleteMe()}
                            {/if}
                        </span>
                    </button>
                    {#if message.isOwn && isOnline && message.remoteUuid}
                        <button
                            type="button"
                            class="btn btn--warning menu-item delete"
                            role="menuitem"
                            on:click={deleteMessageForEveryone}
                            disabled={isDeletingForMe || isDeletingForEveryone}
                        >
                            <span class="menu-icon">
                                <Icon name="group" size={14} className="menu-icon-graphic" />
                            </span>
                            <span class="menu-text">
                                {#if isDeletingForEveryone}
                                    {$LL.messageBubbleMenuDeleting()}
                                {:else}
                                    {$LL.messageBubbleMenuDeleteEveryone()}
                                {/if}
                            </span>
                        </button>
                    {/if}
                </div>
            </div>
        </div>

        <!-- Reaction trigger on bottom-left for latest non-own message only.
		     The button shows the selected emoji (if any) or a plus sign. Clicking it opens the picker. -->
        {#if canReact}
            <div class="reaction-trigger">
                <button
                    type="button"
                    class="btn btn--secondary reaction-plus"
                    tabindex={controlTabindex}
                    title={message.reactionBy
                        ? $LL.messageBubbleReactionBy({ name: message.reactionBy })
                        : $LL.messageBubbleReactionDefault()}
                    aria-label={currentReaction
                        ? $LL.messageBubbleReactionChangeAria({
                              emoji: getReactionEmoji(currentReaction),
                          })
                        : $LL.messageBubbleReactionDefault()}
                    aria-expanded={showReactionPicker}
                    bind:this={reactionTriggerRef}
                    popovertarget={reactionPopoverId}
                    popovertargetaction="toggle"
                    style="anchor-name: {reactionAnchorName}"
                >
                    {#if currentReaction}
                        {getReactionEmoji(currentReaction)}
                    {:else}
                        +
                    {/if}
                </button>
                <div
                    id={reactionPopoverId}
                    popover="auto"
                    class="reaction-picker"
                    bind:this={reactionPickerRef}
                    on:toggle={handleReactionPickerToggle}
                    use:anchorFallback={{ trigger: reactionTriggerRef, placement: 'right-start' }}
                    style="position-anchor: {reactionAnchorName}"
                >
                    <div
                        class="reaction-picker__inner"
                        role="group"
                        aria-label={$LL.messageBubbleReactionPickerLabel()}
                    >
                        {#if currentReaction}
                            <button
                                type="button"
                                class="btn btn--secondary reaction-option"
                                title={$LL.messageBubbleReactionRemove()}
                                aria-label={$LL.messageBubbleReactionRemove()}
                                on:click={clearReaction}
                            >
                                −
                            </button>
                        {/if}
                        <button
                            type="button"
                            class="btn btn--secondary reaction-option"
                            aria-label={$LL.messageBubbleReactionLaughAria()}
                            on:click={() => triggerReaction('laugh')}
                        >
                            😂
                        </button>
                        <button
                            type="button"
                            class="btn btn--secondary reaction-option"
                            aria-label={$LL.messageBubbleReactionHeartAria()}
                            on:click={() => triggerReaction('heart')}
                        >
                            ❤️
                        </button>
                        <button
                            type="button"
                            class="btn btn--secondary reaction-option"
                            aria-label={$LL.messageBubbleReactionHundredAria()}
                            on:click={() => triggerReaction('100')}
                        >
                            💯
                        </button>
                    </div>
                </div>
            </div>
        {/if}

        {#if !canReact && currentReaction}
            <div
                class="reaction-badge"
                role="img"
                aria-label={message.reactionBy
                    ? $LL.messageBubbleReactionByWithEmoji({
                          name: message.reactionBy,
                          emoji: getReactionEmoji(currentReaction),
                      })
                    : $LL.messageBubbleReactionBadgeWithEmoji({
                          emoji: getReactionEmoji(currentReaction),
                      })}
                title={message.reactionBy
                    ? $LL.messageBubbleReactionBy({ name: message.reactionBy })
                    : $LL.messageBubbleReactionBadge()}
            >
                {getReactionEmoji(currentReaction)}
            </div>
        {/if}

        <div class="message-meta">
            <span class="delivery-method"
                >{getDeliveryMethodLabel()} <span aria-hidden="true">•</span>
                <time
                    datetime={new Date(message.timestamp).toISOString()}
                    title={formatFullDateTimeTitle(message.timestamp, use24HourTime)}
                >
                    {formatShortTime(message.timestamp, use24HourTime)}
                </time>{#if autoDeleteAfter} <span aria-hidden="true">•</span> <button
                        type="button"
                        class="expiry-trigger"
                        tabindex={controlTabindex}
                        bind:this={expiryTriggerRef}
                        popovertarget={expiryPopoverId}
                        popovertargetaction="toggle"
                        style="anchor-name: {expiryAnchorName}"
                        title={$LL.autoDeleteExpiresOn({ date: formatExpiryDate(message.timestamp, autoDeleteAfter, use24HourTime) })}
                        aria-label={$LL.autoDeleteExpiresOn({ date: formatExpiryDate(message.timestamp, autoDeleteAfter, use24HourTime) })}
                    >{formatAutoDeleteDuration(autoDeleteAfter, $LL)}</button>
                    <div
                        id={expiryPopoverId}
                        popover="auto"
                        class="expiry-popover"
                        use:anchorFallback={{ trigger: expiryTriggerRef, placement: 'top-end' }}
                        style="position-anchor: {expiryAnchorName}"
                    >
                        <Icon name="timer" size={16} className="expiry-icon" />
                        <span>{$LL.autoDeleteExpiresOn({ date: formatExpiryDate(message.timestamp, autoDeleteAfter, use24HourTime) })}</span>
                    </div>{/if}</span
            >
        </div>
    </div>
</div>

<style>
    .message-wrapper {
        display: flex;
    }

    .message-wrapper.own {
        justify-content: flex-end;
    }

    .message-bubble {
        max-width: 70%;
        padding: 0.75rem 1rem;
        border-radius: 18px;
        background: var(--color-surface);
        color: var(--color-text);
        --bubble-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
        --bubble-highlight-shadow:
            0 0 0 4px rgba(56, 189, 248, 0.18), 0 12px 28px rgba(15, 23, 42, 0.2);
        box-shadow: var(--bubble-shadow);
        position: relative;
        will-change: transform;
        transform-origin: center left;
        transition:
            background-color 0.25s ease,
            color 0.25s ease,
            transform 0.15s ease,
            box-shadow 0.25s ease;
    }

    .message-bubble.has-reaction {
        padding-bottom: 1.25rem;
        margin-bottom: 0.75rem;
    }

    .message-bubble.own {
        background: #006de2;
        color: white;
        --bubble-shadow: 0 1px 2px rgba(6, 95, 212, 0.4);
        --bubble-highlight-shadow:
            0 0 0 4px rgba(255, 255, 255, 0.32), 0 14px 34px rgba(15, 23, 42, 0.35);
        transform-origin: center right;
    }

    .message-contents {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .message-content {
        word-wrap: break-word;
        line-height: 1.4;
        margin-bottom: 0.25rem;
        white-space: pre-wrap;
        flex: 1 1 auto;
        min-width: 0;
    }

    .message-content strong {
        font-weight: 700;
    }

    .message-content em {
        font-style: italic;
    }

    .message-link {
        color: inherit;
        text-decoration: underline;
        word-break: break-word;
        cursor: pointer;
    }

    .share-code-prefix {
        display: block;
        margin-bottom: 0.5rem;
        white-space: pre-wrap;
    }

    .share-code-block {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        align-items: flex-start;
    }

    .share-code-text {
        display: block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.85rem;
        padding: 0.4rem 0.6rem;
        border-radius: 6px;
        background: var(--color-bg-subtle);
        color: var(--color-text-muted);
        border: 1px solid var(--color-border);
    }

    .share-code-copy {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        flex: 0 0 auto;
    }

    .message-meta {
        display: flex;
        align-items: center;
        font-size: 0.75rem;
        opacity: 0.7;
        margin-top: 0.25rem;
        gap: 0.5rem;
    }

    .message-bubble.own .message-meta {
        color: rgba(255, 255, 255, 0.8);
    }

    .delivery-method {
        font-weight: 500;
    }

    .message-menu {
        margin-left: auto;
        opacity: 1;
    }

    .menu-trigger {
        --btn-padding: 0;
        --btn-radius: 50%;
        --btn-bg: rgba(0, 0, 0, 0.08);
        --btn-hover-bg: var(--color-border);
        --btn-border: transparent;
        --btn-color: var(--color-text-muted);
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.875rem;
        font-weight: bold;
        line-height: 1;
    }

    .message-bubble.own .menu-trigger {
        --btn-bg: rgba(255, 255, 255, 0.2);
        --btn-hover-bg: rgba(255, 255, 255, 0.28);
        --btn-hover-border: rgba(255, 255, 255, 0.55);
        --btn-color: rgba(255, 255, 255, 0.85);
        --btn-hover-color: white;
    }

    .expiry-trigger {
        all: unset;
        cursor: pointer;
        color: inherit;
        font: inherit;
    }

    .expiry-trigger:focus-visible {
        outline: 2px solid var(--color-accent-text);
        border-radius: 2px;
    }

    .expiry-popover {
        inset: unset;
        margin: 0;
        padding: 0.5rem 0.75rem;
        border: none;
        position: fixed;
        bottom: anchor(top);
        right: anchor(right);
        margin-bottom: 6px;
        position-try-fallbacks: --expiry-above-left;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        font-size: 0.8rem;
        color: var(--color-text-muted);
        white-space: nowrap;
    }

    .expiry-popover:popover-open {
        display: flex;
        align-items: center;
        gap: 0.4rem;
    }

    @position-try --expiry-above-left {
        bottom: anchor(top);
        left: anchor(left);
        right: unset;
        margin-bottom: 6px;
    }

    @position-try --menu-above-left {
        bottom: anchor(top);
        left: anchor(left);
        right: unset;
        margin-bottom: 4px;
    }

    @position-try --menu-below-right {
        top: anchor(bottom);
        bottom: unset;
        right: anchor(right);
        margin-top: 4px;
        margin-bottom: 0;
    }

    @position-try --menu-below-left {
        top: anchor(bottom);
        bottom: unset;
        left: anchor(left);
        right: unset;
        margin-top: 4px;
        margin-bottom: 0;
    }

    .menu-dropdown {
        inset: unset;
        margin: 0;
        padding: 0;
        border: none;

        position: fixed;
        bottom: anchor(top);
        right: anchor(right);
        margin-bottom: 4px;
        position-try-fallbacks: --menu-above-left, --menu-below-right, --menu-below-left;

        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        min-width: 150px;
        overflow: hidden;
    }

    .reaction-trigger,
    .reaction-badge {
        position: absolute;
        bottom: -11px;
        left: 11px;
    }

    .reaction-plus {
        --btn-padding: 0;
        --btn-radius: 50%;
        --btn-bg: var(--color-bg-muted);
        --btn-hover-bg: var(--color-border);
        --btn-border: transparent;
        --btn-color: var(--color-text);
        width: 24px;
        height: 24px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 1rem;
    }

    .message-bubble.own .reaction-trigger {
        left: 8px;
    }

    @position-try --reaction-flip-left {
        left: unset;
        right: anchor(left);
        margin-left: 0;
        margin-right: 4px;
    }

    .reaction-picker {
        inset: unset;
        margin: 0;
        border: none;

        position: fixed;
        left: anchor(right);
        top: anchor(top);
        margin-left: 4px;
        position-try-fallbacks: --reaction-flip-left;

        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 12px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
    }

    .reaction-picker__inner {
        display: flex;
        gap: 6px;
        padding: 6px 8px;
    }

    .reaction-option {
        --btn-padding: 0.15rem 0.4rem;
        --btn-radius: 6px;
        --btn-bg: transparent;
        --btn-hover-bg: rgba(0, 0, 0, 0.05);
        --btn-border: transparent;
        font-size: 1rem;
        line-height: 1;
    }

    .reaction-badge {
        background: var(--color-surface);
        border-radius: 12px;
        padding: 2px 6px;
        font-size: 0.875rem;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
    }

    .menu-item {
        --btn-padding: 8px 12px;
        --btn-radius: 8px;
        --btn-border: transparent;
        --btn-bg: var(--color-surface);
        --btn-hover-bg: var(--color-bg-subtle);
        --btn-color: var(--color-text);
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.875rem;
        text-align: left;
        justify-content: flex-start;
    }

    .menu-item:hover {
        --btn-color: var(--color-text);
    }

    .menu-item:disabled {
        color: var(--color-text-subtle);
        cursor: not-allowed;
    }

    .menu-item.delete {
        --btn-color: #dc3545;
        --btn-hover-bg: #fff5f5;
        --btn-hover-color: red;
    }

    .menu-item.delete:hover {
        --btn-color: #dc3545;
    }

    .menu-icon {
        font-size: 0.875rem;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .menu-icon :global(.menu-icon-graphic) {
        width: 1rem;
        height: 1rem;
    }

    .menu-text {
        flex: 1;
        white-space: nowrap;
    }

    :global(.jump-highlight) {
        box-shadow: var(--bubble-highlight-shadow);
        animation: bubble-jump-highlight 1s cubic-bezier(0.19, 1, 0.22, 1);
    }

    @keyframes bubble-jump-highlight {
        0% {
            transform: scale(1);
            box-shadow: var(--bubble-shadow);
        }

        28% {
            transform: scale(1.12);
            box-shadow: var(--bubble-highlight-shadow);
        }

        55% {
            transform: scale(0.95);
        }

        100% {
            transform: scale(1);
            box-shadow: var(--bubble-shadow);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        :global(.jump-highlight) {
            animation: none;
            box-shadow: var(--bubble-highlight-shadow);
        }
    }

    @media (max-width: 600px) {
        .message-bubble {
            max-width: 85%;
            padding: 0.6rem 0.8rem;
        }

        .message-meta {
            font-size: 0.7rem;
            gap: 0.5rem;
        }

        .menu-trigger {
            width: 20px;
            height: 20px;
            font-size: 0.625rem;
        }

        .menu-dropdown {
            min-width: 140px;
        }
    }
</style>
