<script lang="ts">
    import { debug } from '$lib/utils/debug';
    import Icon from '$lib/components/icons/Icon.svelte';
    import MessageBubble, { HIDDEN_PLACEHOLDERS } from '../MessageBubble.svelte';
    import CallEventMessage from '../CallEventMessage.svelte';
    import MessageComposer from '../MessageComposer.svelte';
    import ConnectionPanel from './ConnectionPanel.svelte';
    import WhatsappImportDialog from '../WhatsappImportDialog.svelte';
    import type { Chat, StoredMessage } from '$lib/types';
    import { translations as LL, locale as localeStore } from '$lib/i18n/runtime';
    import { get } from 'svelte/store';
    import { onMount, tick } from 'svelte';

    export let chat: Chat;
    export let isOnline: boolean;
    export let messages: StoredMessage[];
    export let hasSessionLockedMessages: boolean;
    export let pendingReaction: { type: 'laugh' | 'heart' | '100' } | null;
    export let reactTargetMessageId: string | null;
    // The specific message the pending reaction was applied to. The highlight preview must follow
    // this id, not reactTargetMessageId (the latest non-own message), so a message that arrives
    // after the user reacts doesn't get a phantom reaction.
    export let pendingReactionMessageId: string | null = null;
    export let showWhatsappImport: boolean;
    export let hasMoreOlder = false;
    export let isLoadingOlder = false;

    export let onLoadOlder: () => void = () => {};
    export let onContainerReady: (node: HTMLDivElement) => void = () => {};
    export let onScroll: (event: Event) => void = () => {};
    export let onCloseWhatsappImport: () => void = () => {};
    export let onUnlockSession: () => void = () => {};
    export let onMessageDeleted: (event: CustomEvent) => void = () => {};
    export let onReact: (
        event: CustomEvent<{
            messageId?: string;
            remoteUuid?: string;
            type: 'laugh' | 'heart' | '100';
        }>
    ) => void = () => {};
    export let onUnreact: (
        event: CustomEvent<{ messageId: string; remoteUuid?: string }>
    ) => void = () => {};
    export let onSendMessage: (event: CustomEvent<{ message: string }>) => void = () => {};
    export let onTyping: (event: CustomEvent<{ isTyping: boolean }>) => void = () => {};

    // Inline WebRTC connection panel (docked above the composer)
    export let showConnectionPanel = false;
    export let connected = false;
    export let isConnecting = false;
    export let currentRole: 'sender' | 'receiver' | null = null;
    export let isGeneratingOffer = false;
    export let connectionUrl = '';
    export let generatedAnswerUrl = '';
    export let connectionFailed = false;
    export let canRetryConnection = false;
    export let onGenerateOffer: () => void = () => {};
    export let onDismissPanel: () => void = () => {};
    export let onRetryConnection: () => void = () => {};

    let container: HTMLDivElement | null = null;

    onMount(() => {
        if (container) {
            onContainerReady(container);
        }
    });

    // Roving tabindex over the messages (ARIA feed pattern): the whole list is a
    // single Tab stop. Exactly one message article is tabbable at a time; Arrow
    // Up/Down move between messages, Home/End jump to oldest/newest, Enter drills
    // into the focused message's controls and Escape returns to the message.
    let activeMessageId: string | null = null;
    // The message whose inline controls (menu, react, links) are currently tabbable.
    let drilledMessageId: string | null = null;
    // Until the user navigates, the tab stop follows the newest message.
    let hasUserNavigated = false;
    let lastChatId = chat.id;

    $: if (chat.id !== lastChatId) {
        lastChatId = chat.id;
        activeMessageId = null;
        drilledMessageId = null;
        hasUserNavigated = false;
    }

    $: {
        const newestId = messages.length ? messages[messages.length - 1].id : null;
        if (
            !hasUserNavigated ||
            !activeMessageId ||
            !messages.some((m) => m.id === activeMessageId)
        ) {
            activeMessageId = newestId;
        }
    }

    async function focusMessage(id: string) {
        activeMessageId = id;
        hasUserNavigated = true;
        drilledMessageId = null;
        await tick();
        document.getElementById('message-' + id)?.focus();
    }

    async function drillIntoMessage(id: string, article: HTMLElement) {
        drilledMessageId = id;
        await tick();
        // Drilled controls carry an explicit tabindex="0"; popover contents and
        // the article itself do not, so this finds the first inline control.
        article.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    }

    function handleArticleKeydown(event: KeyboardEvent, messageId: string) {
        const article = event.currentTarget as HTMLElement;
        const target = event.target as HTMLElement;

        if (event.key === 'Escape') {
            // Open popovers (message menu, reaction picker) handle Escape themselves.
            if (target.closest('[popover]')) return;
            if (drilledMessageId === messageId) {
                event.preventDefault();
                drilledMessageId = null;
                article.focus();
            }
            return;
        }

        // The remaining keys act on the article itself, not on drilled-in controls.
        if (target !== article) return;

        const index = messages.findIndex((m) => m.id === messageId);
        if (index === -1) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (index < messages.length - 1) focusMessage(messages[index + 1].id);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (index > 0) focusMessage(messages[index - 1].id);
        } else if (event.key === 'Home') {
            event.preventDefault();
            focusMessage(messages[0].id);
        } else if (event.key === 'End') {
            event.preventDefault();
            focusMessage(messages[messages.length - 1].id);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            drillIntoMessage(messageId, article);
        }
    }

    function handleListFocusOut(event: FocusEvent) {
        const next = event.relatedTarget as Node | null;
        if (drilledMessageId && (!next || !container?.contains(next))) {
            drilledMessageId = null;
        }
    }

    // Deleting a message unmounts the focused article, dropping focus to <body>.
    // Land it on the adjacent message instead so the keyboard and screen-reader
    // position is preserved.
    async function handleMessageDeletedLocal(event: CustomEvent) {
        const deletedId: string | undefined = event.detail?.messageId;
        const index = deletedId ? messages.findIndex((m) => m.id === deletedId) : -1;
        const neighbor = index === -1 ? null : (messages[index + 1] ?? messages[index - 1] ?? null);
        onMessageDeleted(event);
        if (neighbor) {
            await focusMessage(neighbor.id);
        }
    }

    // Persistent screen-reader announcer for genuinely new incoming messages. The
    // scrolling container itself is intentionally not a live region: paging can
    // prepend up to a full page of older messages, and the import dialog, the
    // session-locked banner and the loading row all mount inside it, which would
    // flood the announcement queue. Only messages appended at the tail that are
    // not the user's own are announced here.
    let announcerText = '';
    // A screen reader will not re-announce a live region whose text is byte-for-byte
    // identical to its previous value, so two consecutive identical messages (e.g. "ok"
    // then "ok") would go silent. Toggle a trailing zero-width space on each announcement
    // to guarantee the accessible text changes. U+200B is not spoken by NVDA/VoiceOver.
    let announceToggle = false;
    let announceChatId = chat.id;
    let announceNewestId: string | null = messages.length
        ? messages[messages.length - 1].id
        : null;

    $: trackIncomingMessages(messages, chat.id);

    function trackIncomingMessages(msgs: StoredMessage[], chatId: string) {
        const newestId = msgs.length ? msgs[msgs.length - 1].id : null;
        if (chatId !== announceChatId) {
            // Chat switch: the freshly loaded history is not a new arrival.
            announceChatId = chatId;
            announceNewestId = newestId;
            announcerText = '';
            return;
        }
        // Tail unchanged: no new message (older pages prepend, reactions replace in place).
        if (newestId === announceNewestId) return;
        const previousNewestId = announceNewestId;
        announceNewestId = newestId;
        // Initial load of the window (empty -> populated) is not a new arrival.
        if (previousNewestId === null) return;
        // The previous tail must still be present, otherwise the window was
        // replaced (reload, reset to latest page) rather than appended to.
        const index = msgs.findIndex((m) => m.id === previousNewestId);
        if (index === -1) return;
        const incoming = msgs.slice(index + 1).filter((m) => !m.isOwn && !m.callEvent);
        if (incoming.length === 0) return;
        const announcement = formatIncomingAnnouncement(incoming[incoming.length - 1]);
        if (announcement) {
            announceToggle = !announceToggle;
            announcerText = announceToggle ? announcement + '​' : announcement;
        }
    }

    function formatIncomingAnnouncement(message: StoredMessage): string {
        const t = get(LL);
        const sender = message.from && message.from.trim().length > 0 ? message.from : chat.name;
        let time: string;
        try {
            time = new Intl.DateTimeFormat(get(localeStore), {
                hour: '2-digit',
                minute: '2-digit',
            }).format(new Date(message.timestamp));
        } catch (error) {
            debug.debug('Failed to format announcement time:', error);
            time = new Date(message.timestamp).toLocaleTimeString();
        }
        const rawBody = message.body?.trim() ?? '';
        if (!rawBody) return '';
        const body = HIDDEN_PLACEHOLDERS.has(rawBody) ? t.a11yMessageLocked() : rawBody;
        return t.a11yNewMessageAnnouncement({ sender, time, body });
    }

    function isSameDay(a: number, b: number): boolean {
        const da = new Date(a);
        const db = new Date(b);
        return (
            da.getFullYear() === db.getFullYear() &&
            da.getMonth() === db.getMonth() &&
            da.getDate() === db.getDate()
        );
    }

    // Group consecutive messages by calendar day. Each group becomes its own
    // sticky containing block so the day chips push each other out of the way.
    type DayGroup = { key: string; label: string; spokenLabel: string; messages: StoredMessage[] };
    $: dayGroups = messages.reduce<DayGroup[]>((groups, message) => {
        const last = groups[groups.length - 1];
        const prev = last?.messages[last.messages.length - 1];
        if (!last || !prev || !isSameDay(message.timestamp, prev.timestamp)) {
            groups.push({
                key: message.id,
                ...getDayLabels(message.timestamp),
                messages: [message],
            });
        } else {
            last.messages.push(message);
        }
        return groups;
    }, []);

    // label is the visible chip ("Mon, Jul 13"); spokenLabel is the screen-reader
    // form ("Monday, July 13") — the abbreviated weekday/month read literally
    // ("mon jool") when spoken.
    function getDayLabels(ts: number): { label: string; spokenLabel: string } {
        const d = new Date(ts);
        const now = new Date();
        const startOfDay = (dt: Date) =>
            new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
        const todayStart = startOfDay(now);
        const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
        const dayStart = startOfDay(d);

        if (dayStart === todayStart) {
            const label = get(LL).chatInterfaceDayToday();
            return { label, spokenLabel: label };
        }
        if (dayStart === yesterdayStart) {
            const label = get(LL).chatInterfaceDayYesterday();
            return { label, spokenLabel: label };
        }

        const localeCode = get(localeStore);
        const options: Intl.DateTimeFormatOptions = {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
        };
        if (d.getFullYear() !== now.getFullYear()) {
            options.year = 'numeric';
        }

        try {
            return {
                label: new Intl.DateTimeFormat(localeCode, options).format(d),
                spokenLabel: new Intl.DateTimeFormat(localeCode, {
                    ...options,
                    weekday: 'long',
                    month: 'long',
                }).format(d),
            };
        } catch (error) {
            debug.debug('Failed to format day label:', error);
            const fallback = d.toLocaleDateString();
            return { label: fallback, spokenLabel: fallback };
        }
    }
</script>

<!-- Always-mounted announcer, fed only curated strings for new incoming messages. -->
<div class="sr-only" role="log" aria-live="polite">{announcerText}</div>

<div
    class="messages-container"
    bind:this={container}
    aria-label={$LL.chatInterfaceMessagesAria({ name: chat.name })}
    tabindex="-1"
    on:scroll={onScroll}
    on:focusout={handleListFocusOut}
>
    {#if showWhatsappImport}
        <WhatsappImportDialog {chat} on:close={onCloseWhatsappImport} />
    {/if}

    {#if hasSessionLockedMessages}
        <div class="session-locked-banner">
            <div class="banner-icon">
                <Icon name="padlock" size={24} className="banner-icon-graphic" />
            </div>
            <div class="banner-content">
                <div class="banner-title">{$LL.chatInterfaceBannerTitle()}</div>
                <div class="banner-subtitle">{$LL.chatInterfaceBannerSubtitle()}</div>
            </div>
            <button
                type="button"
                class="btn btn--primary unlock-button-banner"
                on:click={onUnlockSession}
            >
                <Icon name="padlock" size={18} />
                {$LL.sessionUnlockSubmit()}
            </button>
        </div>
    {/if}

    <div class="messages-list">
        {#if messages.length === 0}
            <div class="empty-state">
                <div class="empty-icon">
                    <Icon name="chat" size={48} className="empty-icon-graphic" />
                </div>
                <p>{$LL.chatListPreviewNoMessages()}</p>
                <p class="empty-subtitle">{$LL.chatInterfaceEmptySubtitle()}</p>
            </div>
        {:else}
            {#if isLoadingOlder}
                <div class="load-older-row">
                    <span class="load-older-spinner" aria-hidden="true"></span>
                    {$LL.chatInterfaceLoadingOlder()}
                </div>
            {:else if hasMoreOlder}
                <div class="load-older-row">
                    <button
                        type="button"
                        class="btn btn--secondary load-older-button"
                        on:click={onLoadOlder}
                    >
                        {$LL.chatInterfaceLoadOlder()}
                    </button>
                </div>
            {/if}
            {#each dayGroups as group (group.key)}
                <div class="day-group">
                    <!-- The compact chip text is aria-hidden and replaced by an sr-only
                         long form: abbreviated dates read literally when spoken, and
                         sr-only text is announced reliably in linear reading where an
                         aria-label on a non-interactive div is often skipped. -->
                    <div class="day-separator">
                        <span class="day-chip">
                            <span aria-hidden="true">{group.label}</span>
                            <span class="sr-only">{group.spokenLabel}</span>
                        </span>
                    </div>
                    {#each group.messages as message (message.id)}
                        <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
                        <div
                            id={'message-' + message.id}
                            class="message-anchor"
                            role="article"
                            tabindex={activeMessageId === message.id ? 0 : -1}
                            aria-label={message.callEvent
                                ? undefined
                                : message.isOwn
                                  ? $LL.chatMessageOwnSenderAria()
                                  : chat.name}
                            on:keydown={(event) => handleArticleKeydown(event, message.id)}
                        >
                            {#if message.callEvent}
                                <div class="call-event-row">
                                    <CallEventMessage
                                        callEvent={message.callEvent}
                                        timestamp={message.timestamp}
                                    />
                                </div>
                            {:else}
                                <MessageBubble
                                    {message}
                                    chatId={chat.id}
                                    {isOnline}
                                    controlsTabbable={drilledMessageId === message.id}
                                    on:messageDeleted={handleMessageDeletedLocal}
                                    on:react={onReact}
                                    on:unreact={onUnreact}
                                    highlightReaction={!isOnline &&
                                    pendingReaction &&
                                    pendingReactionMessageId === message.id
                                        ? pendingReaction.type
                                        : null}
                                    canReact={isOnline
                                        ? !message.isOwn
                                        : message.id === reactTargetMessageId}
                                />
                            {/if}
                        </div>
                    {/each}
                </div>
            {/each}
        {/if}
    </div>
</div>

{#if showConnectionPanel}
    <ConnectionPanel
        conversationName={chat.name}
        {connected}
        {isConnecting}
        role={currentRole}
        {isGeneratingOffer}
        {connectionUrl}
        {generatedAnswerUrl}
        {connectionFailed}
        {canRetryConnection}
        on:generate-offer={onGenerateOffer}
        on:dismiss={onDismissPanel}
        on:retry={onRetryConnection}
    />
{/if}

<!-- chatId scopes the composer's unsent draft per conversation, so switching chats
     keeps each chat's draft in place instead of carrying one into the next. -->
<MessageComposer chatId={chat.id} on:send-message={onSendMessage} on:typing={onTyping} {isOnline} />

<style>
    .messages-container {
        flex: 1;
        overflow-y: auto;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        background: var(--color-chat-bg);
        position: relative;
        /* Older pages prepend above the viewport; scroll position is compensated
           manually, so native scroll anchoring must not also shift it. */
        overflow-anchor: none;
    }

    .messages-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        flex: 1;
    }

    .load-older-row {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0 1rem;
        color: var(--color-text-muted);
        font-size: 0.85rem;
    }

    .load-older-button {
        --btn-padding: 0.4rem 1rem;
        --btn-radius: 999px;
        font-size: 0.85rem;
    }

    .load-older-spinner {
        width: 1rem;
        height: 1rem;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-accent-text);
        border-radius: 50%;
        animation: load-older-spin 0.8s linear infinite;
    }

    @media (prefers-reduced-motion: reduce) {
        .load-older-spinner {
            animation-duration: 2s;
        }
    }

    @keyframes load-older-spin {
        to {
            transform: rotate(360deg);
        }
    }

    .message-anchor {
        border-radius: 12px;
    }

    .message-anchor:focus-visible {
        outline: 2px solid var(--color-accent-text);
        outline-offset: 2px;
    }

    .call-event-row {
        display: flex;
        justify-content: center;
        margin: 0.25rem 0;
    }

    .empty-state {
        text-align: center;
        color: var(--color-text-muted);
        padding: 2rem 1rem;
        margin: auto 0;
    }

    .empty-icon {
        margin-bottom: 1rem;
    }

    .empty-subtitle {
        font-size: 0.95rem;
        color: var(--color-text-subtle);
    }

    /* One containing block per day: confines each sticky chip to its own day, so
       the incoming day's chip pushes the previous one up instead of overlapping. */
    .day-group {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .day-separator {
        display: flex;
        justify-content: center;
        position: sticky;
        top: 0;
        z-index: 2;
    }

    .day-chip {
        background: var(--color-bg-muted);
        color: var(--color-text-muted);
        font-weight: 600;
        font-size: 0.75rem;
        padding: 0.25rem 0.6rem;
        border-radius: 999px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
    }

    .session-locked-banner {
        display: flex;
        align-items: center;
        gap: 1rem;
        background: color-mix(in srgb, #fbbf24 12%, var(--color-bg));
        border: 1px solid #fbbf24;
        border-radius: 12px;
        padding: 1rem;
        margin-bottom: 1rem;
    }

    .banner-icon {
        background: rgba(251, 191, 36, 0.2);
        border-radius: 999px;
        padding: 0.4rem;
    }

    .banner-title {
        font-weight: 600;
        color: var(--color-text);
    }

    .banner-subtitle {
        font-size: 0.9rem;
        color: var(--color-text-muted);
    }

    .unlock-button-banner {
        margin-left: auto;
        --btn-padding: 0.5rem 1rem;
        --btn-radius: 999px;
        font-weight: 600;
    }
</style>
