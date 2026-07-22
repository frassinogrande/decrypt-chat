<script lang="ts">
    import { createEventDispatcher, afterUpdate, onDestroy, onMount, tick } from 'svelte';
    import { get } from 'svelte/store';
    import ConnectionNoticeDialog from './ConnectionNoticeDialog.svelte';
    import SessionUnlockDialog from './SessionUnlockDialog.svelte';
    import ContactInfoDialog from './ContactInfoDialog.svelte';
    import ProfileShare from './ProfileShare.svelte';
    import RegenerateChatKeyDialog from './RegenerateChatKeyDialog.svelte';
    import ChatHeader from '$lib/components/chat/ChatHeader.svelte';
    import ChatMessagesPane from '$lib/components/chat/ChatMessagesPane.svelte';
    import ChatConfirmDialogs from '$lib/components/chat/ChatConfirmDialogs.svelte';
    import CallInterface from './CallInterface.svelte';
    import IncomingCallDialog from './IncomingCallDialog.svelte';
    import type { Chat, StoredMessage } from '../types';
    import { appStore } from '../stores/app';
    import { tutorialController, tutorialStep } from '../services/tutorial';
    import { chatConnectionStore } from '../stores/chat-connection-store';
    import { copyToClipboard } from '../utils/web-share';
    import type { LazyMessageStore } from '../utils/lazy-message-store';
    import { callStore, activeCall, incomingCall } from '../stores/call-store';
    import { uiStore } from '../stores/ui-store';
    import { debug } from '../utils/debug';
    import { isConnectionNoticeDismissed, dismissConnectionNotice } from '../utils/connection-notice';
    import { generateCallInvitation } from '../utils/call-invitation';
    import { translations as LL } from '$lib/i18n/runtime';
    import type { ChatConnectionState } from '../stores/chat-connection-store';

    export let chat: Chat;
    export let targetMessageId: string | null = null;

    const dispatch = createEventDispatcher();
    let messagesContainer: HTMLDivElement;
    let shouldAutoScroll = true;
    // Track highlight timers so repeated clicks can retrigger animation cleanly
    const highlightTimers = new Map<string, number>();

    function escapeForId(id: string): string {
        try {
            // @ts-ignore
            if (typeof CSS !== 'undefined' && (CSS as any).escape) return (CSS as any).escape(id);
        } catch {
            /* CSS.escape unavailable; fall through to manual escaping */
        }
        // Fallback minimal escaping for common special characters used in CSS selectors
        return id.replace(/([#.;:,[\]()>'"\s])/g, '\\$1');
    }
    let showDeleteConfirm = false;
    let showClearConfirm = false;
    let showAutoDeleteDialog = false;
    let selectedAutoDelete: number = chat.autoDeleteAfter ?? 0;
    let showConnectionNotice = false;
    let pendingConnectionAction: (() => void | Promise<void>) | null = null;
    // Loop guard for the receiver's reactive gate below only, never consulted by the button
    // paths. That gate is driven by store state rather than a click, so without a latch it
    // re-fires the moment the dialog closes (the persisted flag only moves when the user ticks
    // "don't show again"), re-hiding the panel and reopening the notice forever, leaving the
    // answer unproduced and the sender stuck on "Connecting...".
    let connectionNoticeAcked = false;
    let receiverPendingWizard = false;

    let showDisconnectConfirm = false;
    let showContactInfo = false;
    let showProfileShare = false;
    let showWhatsappImport = false;
    let showRegenerateKey = false;

    let connectionStateStore = chatConnectionStore.state(chat.id);
    let connectionState: ChatConnectionState;

    let showConnectionPanel = false;
    // Brief "Connected to [name]" confirmation shown in the panel slot before it collapses.
    let connectedAck = false;
    let connectedAckTimer: ReturnType<typeof setTimeout> | null = null;
    let connectionUrl = '';
    let isGeneratingOffer = false;
    let generatedAnswerUrl = '';
    let connectionFailed = false;
    let canRetryConnection = false;

    $: connectionStateStore = chatConnectionStore.state(chat.id);
    $: connectionState = $connectionStateStore;
    $: connectionUrl = connectionState.connectionUrl;
    $: isGeneratingOffer = connectionState.isGeneratingOffer;
    $: generatedAnswerUrl = connectionState.generatedAnswerUrl;
    $: connectionFailed = connectionState.connectionFailed;
    $: canRetryConnection = connectionState.canRetryConnection;
    $: currentRole = connectionState.currentRole;
    $: showConnectionPanel =
        (connectionState.showPanel && !receiverPendingWizard) || connectionFailed || connectedAck;

    $: if (
        connectionState.showPanel &&
        connectionState.currentRole === 'receiver' &&
        connectionNoticeNeeded(chat.id) &&
        !connectionNoticeAcked &&
        !showConnectionNotice
    ) {
        receiverPendingWizard = true;
        showConnectionNotice = true;
    }

    $: peerState = $appStore.peerConnections.get(chat.id)?.state ?? 'disconnected';
    $: isOnline = peerState === 'connected';
    $: isConnecting = peerState === 'connecting';
    // Tutorial-only signal driving the connection panel's "Connecting..." face. The real peer
    // state only reports "connecting" once the answer has been applied, but in the guided tour the
    // user has already sent their invite by the time the stand-in posts its response
    // ("...paste it back to finish connecting"), so the await-connect step counts as connecting.
    // Scoped to the Tutorial chat so the real two-person flow's panel is completely unaffected.
    $: tutorialConnecting =
        tutorialController.isTutorialChat(chat.id) &&
        (peerState === 'connecting' || $tutorialStep === 'await-connect');

    $: currentCall = $activeCall && $activeCall.chatId === chat.id ? $activeCall : null;
    $: currentIncomingCall =
        $incomingCall && $incomingCall.chatId === chat.id ? $incomingCall : null;
    $: showCallInterface =
        currentCall && (currentCall.state === 'connected' || currentCall.state === 'outgoing');
    $: showIncomingCallDialog = currentIncomingCall && currentIncomingCall.state === 'incoming';

    // Spoken end-of-call feedback has to live here, not in CallInterface: the same
    // store flush that flips the state to ended/failed also unmounts CallInterface,
    // destroying any live region inside it before assistive tech reads it. Guarded
    // on the call actually ending, so backgrounding a live call by switching chats
    // (currentCall becomes null) stays silent.
    let callEndAnnouncement = '';
    let wasCallActive = false;
    $: {
        const active = !!showCallInterface;
        if (wasCallActive && !active && currentCall) {
            callEndAnnouncement =
                currentCall.state === 'failed'
                    ? $LL.callInterfaceStatusFailed()
                    : $LL.callInterfaceStatusEnded();
        }
        wasCallActive = active;
    }

    // The connection notice covers both risks of going online: we can't verify who is on the
    // other end, and the direct connection reveals each side's IP address to the other. Both are
    // disclosed by the ICE exchange in connection setup, not by placing a call — a call over an
    // already-established connection tells the peer nothing new — so this gates going online only
    // and the call buttons carry no notice of their own. It hangs off the go-online action rather
    // than off entering the chat: every press prompts until the user opts out, and merely opening
    // or revisiting a chat prompts for nothing.
    // The tutorial's stand-in peer never leaves the device (WebRTCManager.localOnly), so neither
    // risk applies there and the tour is not interrupted.
    function connectionNoticeNeeded(chatId: string): boolean {
        return !isConnectionNoticeDismissed() && !tutorialController.isTutorialChat(chatId);
    }

    // Gate an action that would set up a fresh peer connection. Runs straight away once the
    // notice is not needed, otherwise stashes the action, which resumes on confirm and is
    // dropped on cancel.
    function withConnectionNotice(chatId: string, action: () => void | Promise<void>) {
        if (!connectionNoticeNeeded(chatId)) {
            void action();
            return;
        }
        pendingConnectionAction = action;
        showConnectionNotice = true;
    }

    type SmartButtonState = 'offline' | 'connected' | 'connecting';
    let smartButtonState: SmartButtonState = 'offline';

    $: {
        if (isConnecting) {
            smartButtonState = 'connecting';
        } else if (isOnline) {
            smartButtonState = 'connected';
        } else {
            smartButtonState = 'offline';
        }
    }

    $: smartButtonText = (() => {
        switch (smartButtonState) {
            case 'connecting':
                return get(LL).chatInterfaceSmartWaiting({ name: chat.name });
            case 'connected':
                return get(LL).chatInterfaceSmartGoOffline();
            case 'offline':
                return get(LL).chatInterfaceSmartInvite();
            default:
                return '';
        }
    })();

    $: smartButtonHoverText = (() => {
        switch (smartButtonState) {
            case 'offline':
                return get(LL).chatInterfaceSmartGoOnline();
            case 'connected':
                return get(LL).chatInterfaceSmartGoOffline();
            case 'connecting':
                return get(LL).chatInterfaceSmartConnecting();
            default:
                return '';
        }
    })();

    $: smartButtonTooltip =
        smartButtonState === 'connecting' ? smartButtonText : smartButtonHoverText;
    $: {
        const failed = peerState === 'failed';
        const retry = failed ? appStore.canRetryConnection(chat.id) : false;
        chatConnectionStore.markConnectionFailure(chat.id, failed, retry);
    }

    $: backButtonLabel = $LL.chatInterfaceBackToChats
        ? $LL.chatInterfaceBackToChats()
        : 'Back to chats';

    let messages: StoredMessage[] = [];
    let messageStoreUnsubscribe: (() => void) | null = null;
    let currentMessageStore: LazyMessageStore | null = null;
    let messageStoreChatId: string | null = null;
    let pagingUnsubscribe: (() => void) | null = null;
    let hasMoreOlder = false;
    let isLoadingOlder = false;
    // Local re-entrancy guard for the scroll-triggered older-page load; the store's own
    // isLoadingOlder flag updates asynchronously, too late for rapid scroll events.
    let loadOlderInFlight = false;

    let showSessionUnlockPrompt = false;
    let hasSessionLockedMessages = false;

    // Determine the most recent message sent by the other person (non-own)
    let reactTargetMessageId: string | null = null;
    $: {
        let target: string | null = null;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].isOwn && !messages[i].callEvent) {
                target = messages[i].id;
                break;
            }
        }
        reactTargetMessageId = target;
    }

    // Pending emoji reaction to embed in next offline share link
    let pendingReaction: { type: 'laugh' | 'heart' | '100' } | null = null;
    // The message that pending reaction was applied to, so its highlight preview stays put even
    // if a newer non-own message arrives before the user sends.
    let pendingReactionMessageId: string | null = null;

    const LOCAL_TYPING_IDLE_MS = 4000;
    let typingStopTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTypingStateSent = false;
    let typingStatusUnsubscribe: (() => void) | null = null;
    let typingStatusMap = new Map<string, { isTyping: boolean; updatedAt: number }>();
    let isPeerTyping = false;
    let activeChatId: string | null = null;

    function cancelTypingTimer() {
        if (typingStopTimer) {
            clearTimeout(typingStopTimer);
            typingStopTimer = null;
        }
    }

    function scheduleTypingTimeout() {
        cancelTypingTimer();
        typingStopTimer = setTimeout(() => {
            sendTypingUpdate(false, true);
        }, LOCAL_TYPING_IDLE_MS);
    }

    function sendTypingUpdate(isTyping: boolean, triggeredByTimeout = false) {
        if (!chat || !chat.id) {
            return;
        }

        if (!isOnline) {
            if (lastTypingStateSent) {
                void appStore.sendTypingStatus(chat.id, false);
                lastTypingStateSent = false;
            }
            cancelTypingTimer();
            return;
        }

        if (lastTypingStateSent === isTyping) {
            if (isTyping && !triggeredByTimeout) {
                scheduleTypingTimeout();
            }
            return;
        }

        lastTypingStateSent = isTyping;
        void appStore.sendTypingStatus(chat.id, isTyping).then((success) => {
            if (!success && lastTypingStateSent === isTyping) {
                lastTypingStateSent = false;
            }
        });

        if (isTyping) {
            scheduleTypingTimeout();
        } else {
            cancelTypingTimer();
        }
    }

    function handleTyping(event: CustomEvent<{ isTyping: boolean }>) {
        const { isTyping } = event.detail;
        sendTypingUpdate(isTyping);
    }

    onMount(() => {
        typingStatusUnsubscribe = appStore.subscribeTypingStatus((map) => {
            typingStatusMap = map;
        });
    });

    $: if (chat && chat.id && chat.id !== messageStoreChatId) {
        messageStoreChatId = chat.id;

        if (messageStoreUnsubscribe) {
            messageStoreUnsubscribe();
        }
        if (pagingUnsubscribe) {
            pagingUnsubscribe();
        }

        // Subscribe to lazy message store (loads and decrypts only the newest page)
        const messageStore = appStore.getMessageStore(chat.id);
        currentMessageStore = messageStore;
        // Entering a chat starts at the newest page; without this, a window grown by
        // a deep search jump would re-render thousands of bubbles on the next visit.
        // Must run before subscribing so the first render is the small window.
        messageStore.resetToLatestPage();
        // Retry locked placeholders once keys are available; no-op when already decrypted
        void messageStore.ensureDecrypted().catch((error) => {
            debug.warn('Failed to pre-decrypt chat messages', error);
        });
        messageStoreUnsubscribe = messageStore.subscribe((newMessages) => {
            messages = newMessages;
        });
        pagingUnsubscribe = messageStore.paging.subscribe((paging) => {
            hasMoreOlder = paging.hasMoreOlder;
            isLoadingOlder = paging.isLoadingOlder;
        });
        // Entering a chat always starts pinned to the newest messages, even if the
        // previous chat was left scrolled up.
        shouldAutoScroll = true;
    }

    // A jump target (search result) may live beyond the loaded page window; walk older
    // pages until it is loaded so the retry loop below can find its anchor in the DOM.
    $: if (targetMessageId && currentMessageStore) {
        shouldAutoScroll = false;
        void currentMessageStore.ensureMessageLoaded(targetMessageId).catch((error) => {
            debug.warn('Failed to load jump target message', error);
        });
    }

    $: isPeerTyping = chat && chat.id ? Boolean(typingStatusMap.get(chat.id)?.isTyping) : false;

    $: {
        const newChatId = chat && chat.id ? chat.id : null;
        if (newChatId !== activeChatId) {
            if (activeChatId && lastTypingStateSent) {
                void appStore.sendTypingStatus(activeChatId, false);
            }
            activeChatId = newChatId;
            cancelTypingTimer();
            lastTypingStateSent = false;
            resetPerChatTransientState();
        }
    }

    // ChatInterface is a single instance reused across chats (not keyed by chat.id), and
    // connection/message state is re-derived from per-chat stores. Any state held in plain
    // local vars, however, would otherwise bleed into the chat we switch to. Clear it here so,
    // e.g., a reaction picked-but-not-sent in the previous chat can't be attached to the next
    // message sent in THIS one, a connected-ack timer bound to the old chat can't dismiss the
    // new chat's connection panel, and a confirm/connection-notice action can't fire against the
    // wrong chat/contact. The notice is driven by a separate reactive block that reads
    // showConnectionNotice; if it opened the prompt for the new chat in the same tick this reset
    // clears it, that block re-evaluates (showConnectionNotice changed) and re-opens for the current
    // chat, converging within the reactive flush before paint — so a legitimately-needed prompt
    // is not lost.
    function resetPerChatTransientState() {
        pendingReaction = null;
        pendingReactionMessageId = null;
        reactTargetMessageId = null;

        if (connectedAckTimer != null) {
            clearTimeout(connectedAckTimer);
            connectedAckTimer = null;
        }
        connectedAck = false;

        showConnectionNotice = false;
        pendingConnectionAction = null;
        connectionNoticeAcked = false;
        receiverPendingWizard = false;

        // Transient confirm/action dialogs must not survive a chat switch and act on the
        // wrong chat (delete/clear/regenerate-key/disconnect/whatsapp-import/auto-delete).
        showDeleteConfirm = false;
        showClearConfirm = false;
        showAutoDeleteDialog = false;
        showDisconnectConfirm = false;
        showRegenerateKey = false;
        showWhatsappImport = false;
        showSessionUnlockPrompt = false;
    }

    $: if (!isOnline && lastTypingStateSent) {
        sendTypingUpdate(false);
    }

    $: hasSessionLockedMessages = messages.some(
        (msg) => msg.body === '[Encrypted message - session locked]'
    );

    function handleMessageDeleted(event: CustomEvent) {
        const { messageId } = event.detail;

        messages = messages.filter((msg) => msg.id !== messageId);
    }

    onDestroy(() => {
        if (messageStoreUnsubscribe) {
            messageStoreUnsubscribe();
        }
        if (pagingUnsubscribe) {
            pagingUnsubscribe();
        }
        if (scrollRetryTimer != null) {
            clearTimeout(scrollRetryTimer);
            scrollRetryTimer = null;
        }
        if (connectedAckTimer != null) {
            clearTimeout(connectedAckTimer);
            connectedAckTimer = null;
        }
        if (typingStatusUnsubscribe) {
            typingStatusUnsubscribe();
            typingStatusUnsubscribe = null;
        }
        if (chat && chat.id && lastTypingStateSent) {
            void appStore.sendTypingStatus(chat.id, false);
        }
        cancelTypingTimer();
        lastTypingStateSent = false;
        chatConnectionStore.reset(chat.id);
    });

    // Sync panel state with uiStore when opened externally
    $: if ($uiStore.connectionWizard.chatId === chat.id) {
        chatConnectionStore.applyUiWizardState(chat.id);
    }

    // On success, briefly confirm "Connected to [name]" in the panel slot, then collapse it.
    // Leave the offer/role/url in place until the final teardown so the panel doesn't flip
    // into the "Generating..." spinner during the window; the `connected` prop overrides it.
    $: if (peerState === 'connected' && connectionState.showPanel && !connectedAck) {
        connectedAck = true;
        if ($uiStore.connectionWizard.isOpen) {
            uiStore.closeConnectionWizard();
        }
        connectedAckTimer = setTimeout(() => {
            chatConnectionStore.dismissPanel(chat.id);
            chatConnectionStore.setRole(chat.id, null);
            chatConnectionStore.setConnectionUrl(chat.id, '');
            chatConnectionStore.setHasActiveOffer(chat.id, false);
            connectedAck = false;
            connectedAckTimer = null;
        }, 3000);
    }

    $: if (messages && messages.length > 0) {
        // Use setTimeout to ensure DOM has updated
        setTimeout(() => {
            if (shouldAutoScroll) {
                scrollToBottom();
            }
        }, 0);
    }

    // Retry helper for jump-to-message when container is hidden (e.g., on mobile)
    let scrollRetryTimer: number | null = null;
    let scrollRetryStart = 0;
    const SCROLL_RETRY_INTERVAL_MS = 100;
    // Covers mount/layout plus paging in older history for deep jump targets
    const SCROLL_RETRY_WINDOW_MS = 10000;

    function isContainerVisible(): boolean {
        return !!(
            messagesContainer &&
            messagesContainer.offsetParent !== null &&
            messagesContainer.clientHeight > 0 &&
            messagesContainer.getClientRects().length > 0
        );
    }

    async function handleMessageReaction(
        event: CustomEvent<{
            messageId?: string;
            remoteUuid?: string;
            type: 'laugh' | 'heart' | '100';
        }>
    ) {
        const { type } = event.detail;
        // Determine target: any non-own message in online mode, or latest in offline mode
        const targetId = isOnline ? event.detail.messageId : reactTargetMessageId;
        if (targetId) {
            try {
                await appStore.applyReactionByMessageId(chat.id, targetId, type, 'You');
            } catch (e) {
                debug.warn('Failed to persist reaction locally:', e);
            }
        }
        // Guided tour: reacting triggers a closing easter-egg reply.
        void tutorialController.notifyReaction(chat.id, type);
        // Track for embedding into the next offline share link, pinned to the reacted message.
        pendingReaction = { type };
        pendingReactionMessageId = targetId ?? null;
        if (isOnline) {
            const sent = await appStore.sendRealTimeReaction(
                chat.id,
                type,
                event.detail.remoteUuid
            );
            if (sent) {
                pendingReaction = null;
                pendingReactionMessageId = null;
            }
        }
    }

    async function handleMessageUnreact(
        event: CustomEvent<{ messageId: string; remoteUuid?: string }>
    ) {
        const { messageId, remoteUuid } = event.detail;
        try {
            await appStore.applyReactionByMessageId(chat.id, messageId, null);
        } catch (e) {
            debug.warn('Failed to clear reaction locally:', e);
        }
        // If we had a pending reaction to embed, clear it to avoid sending
        pendingReaction = null;
        pendingReactionMessageId = null;
        if (isOnline) {
            try {
                await appStore.sendRealTimeReactionClear(chat.id, remoteUuid);
            } catch (e) {
                debug.warn('Failed to send real-time reaction clear:', e);
            }
        }
    }

    function scheduleRetry() {
        if (scrollRetryTimer == null) {
            scrollRetryTimer = window.setTimeout(() => {
                scrollRetryTimer = null;
                tryScrollToTarget();
            }, SCROLL_RETRY_INTERVAL_MS);
        }
    }

    function tryScrollToTarget() {
        if (!targetMessageId || !messagesContainer) return;
        if (!scrollRetryStart) scrollRetryStart = Date.now();
        const elapsed = Date.now() - scrollRetryStart;
        if (elapsed > SCROLL_RETRY_WINDOW_MS) {
            // Give up gracefully after the window to avoid infinite retries
            scrollRetryStart = 0;
            return;
        }
        const el = messagesContainer.querySelector(
            `#message-${escapeForId(targetMessageId)}`
        ) as HTMLElement | null;
        if (!el) {
            // Message not rendered yet; try again shortly
            scheduleRetry();
            return;
        }

        if (!isContainerVisible()) {
            // Container hidden (e.g., mobile list view). Retry shortly.
            scheduleRetry();
            return;
        }

        scrollToMessage(targetMessageId);
        targetMessageId = null;
        scrollRetryStart = 0;
    }

    afterUpdate(() => {
        if (targetMessageId && messagesContainer) {
            tryScrollToTarget();
            return; // avoid competing with auto-scroll in the same frame
        }
        if (messages.length > 0 && shouldAutoScroll) {
            scrollToBottom();
        }
    });

    function scrollToBottom() {
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    function scrollToMessage(messageId: string) {
        if (!messagesContainer) return;
        const anchor = messagesContainer.querySelector(
            `#message-${escapeForId(messageId)}`
        ) as HTMLElement | null;
        if (anchor) {
            // Disable auto-scroll so it doesn't fight us
            shouldAutoScroll = false;
            // Compute offset relative to the scroll container to avoid browser-specific issues
            const containerRect = messagesContainer.getBoundingClientRect();
            const anchorRect = anchor.getBoundingClientRect();
            const currentScroll = messagesContainer.scrollTop;
            const absoluteTop = anchorRect.top - containerRect.top + currentScroll;
            const targetTop = Math.max(
                0,
                absoluteTop - Math.max(40, (messagesContainer.clientHeight - anchorRect.height) / 2)
            );
            // Force set first (more reliable across browsers), then smooth if changed
            messagesContainer.scrollTop = targetTop;
            const afterSet = messagesContainer.scrollTop;
            if (Math.abs(afterSet - targetTop) > 2) {
                try {
                    messagesContainer.scrollTo({ top: targetTop, behavior: 'auto' });
                } catch {
                    /* scrollTo unsupported; verification fallback below handles it */
                }
            }
            // Also schedule a verification + last-resort fallback
            window.setTimeout(() => {
                const post = messagesContainer.scrollTop;
                if (Math.abs(post - targetTop) > 2) {
                    try {
                        anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
                    } catch {
                        /* best-effort scroll; ignore if unsupported */
                    }
                }
            }, 120);

            // Target the actual bubble for highlight so we can re-trigger reliably
            const bubble = anchor.querySelector('.message-bubble') as HTMLElement | null;
            if (bubble) {
                // Retrigger highlight even if already active
                bubble.classList.remove('jump-highlight');
                // Force reflow across frames to ensure transition restarts
                requestAnimationFrame(() => {
                    // double RAF to be extra safe in some browsers
                    requestAnimationFrame(() => {
                        bubble.classList.add('jump-highlight');
                    });
                });

                const prev = highlightTimers.get(messageId);
                if (prev) clearTimeout(prev);
                const tid = window.setTimeout(() => {
                    bubble.classList.remove('jump-highlight');
                    highlightTimers.delete(messageId);
                }, 1800);
                highlightTimers.set(messageId, tid);
            }
        }
    }

    function isNearBottom(): boolean {
        if (!messagesContainer) return true;
        const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
        return scrollHeight - scrollTop - clientHeight < 100;
    }

    function handleScroll() {
        shouldAutoScroll = isNearBottom();

        // Nearing the top of the loaded window: pull in the next page of older messages
        if (
            messagesContainer &&
            messagesContainer.scrollTop < 200 &&
            hasMoreOlder &&
            !isLoadingOlder
        ) {
            void loadOlderAnchored();
        }
    }

    // Load an older page and keep the messages currently on screen visually in place:
    // measure the container height before the prepend and shift scrollTop by the growth.
    async function loadOlderAnchored() {
        if (!currentMessageStore || !messagesContainer || loadOlderInFlight) {
            return;
        }
        loadOlderInFlight = true;
        try {
            const container = messagesContainer;
            const prevHeight = container.scrollHeight;
            const prevTop = container.scrollTop;
            const added = await currentMessageStore.loadOlder();
            if (added > 0) {
                await tick();
                container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
            }
        } catch (error) {
            debug.warn('Failed to load older messages', error);
        } finally {
            loadOlderInFlight = false;
        }
    }

    function handleSendMessage(event: CustomEvent<{ message: string }>) {
        shouldAutoScroll = true;
        dispatch('send-message', {
            chatId: chat.id,
            message: event.detail.message,
            reaction: pendingReaction ? { ...pendingReaction } : null,
        });
        pendingReaction = null;
        pendingReactionMessageId = null;
        sendTypingUpdate(false);
    }

    function goBack() {
        dispatch('go-back');
    }

    function handleConnect() {
        withConnectionNotice(chat.id, () => openConnectionPanel());
    }

    async function openConnectionPanel() {
        chatConnectionStore.openPanel(chat.id, { quickMode: false, role: 'sender' });

        if (!isOnline && !isConnecting) {
            const snapshot = get(connectionStateStore);
            if (snapshot.connectionUrl) {
                chatConnectionStore.setHasActiveOffer(chat.id, true);
                // Reopening with an existing code: copy it within this gesture.
                void copyToClipboard(snapshot.connectionUrl).then((ok) => {
                    if (ok) chatConnectionStore.setAutoCopied(chat.id, true);
                });
            } else if (!snapshot.isGeneratingOffer) {
                try {
                    await chatConnectionStore.generateOffer(chat.id);
                } catch (e) {
                    // Errors handled inside generateOffer
                }
            }
        }
    }

    function handleConnectionNoticeConfirmed(event: CustomEvent<{ dontShowAgain: boolean }>) {
        if (event.detail.dontShowAgain) dismissConnectionNotice();
        connectionNoticeAcked = true;
        showConnectionNotice = false;
        const action = pendingConnectionAction;
        pendingConnectionAction = null;
        if (receiverPendingWizard) {
            receiverPendingWizard = false;
            // Panel now shows automatically; connectionState.showPanel is already true
        }
        if (action) void action();
    }

    function handleConnectionNoticeCancelled() {
        showConnectionNotice = false;
        pendingConnectionAction = null;
        if (receiverPendingWizard) {
            receiverPendingWizard = false;
            chatConnectionStore.dismissPanel(chat.id); // clear store state set by url-fragment-processor
        }
    }

    async function handleDisconnect() {
        await appStore.disconnectWebRTC(chat.id, true); // Use graceful disconnect
        chatConnectionStore.setHasActiveOffer(chat.id, false);
        chatConnectionStore.setConnectionUrl(chat.id, '');
    }

    function handleDeleteChat() {
        showDeleteConfirm = true;
    }

    async function handleGenerateOffer() {
        await chatConnectionStore.generateOffer(chat.id);
    }

    function handleDismissPanel() {
        chatConnectionStore.dismissPanel(chat.id);
        if ($uiStore.connectionWizard.isOpen) {
            uiStore.closeConnectionWizard();
        }
    }

    function handleRetryConnection() {
        if (!connectionState.canRetryConnection) return;
        void chatConnectionStore.retryConnection(chat.id);
    }

    async function handleSmartButton() {
        switch (smartButtonState) {
            case 'offline':
                handleConnect();
                break;

            case 'connected':
                showDisconnectConfirm = true;
                break;

            case 'connecting':
                // Do nothing - button is disabled
                break;
        }
    }

    async function handleDisconnectTemporary() {
        await appStore.disconnectWebRTC(chat.id, true); // Use graceful disconnect
        chatConnectionStore.setHasActiveOffer(chat.id, false);
        chatConnectionStore.setConnectionUrl(chat.id, '');
    }

    function confirmDisconnect() {
        showDisconnectConfirm = false;
        handleDisconnectTemporary();
    }

    function cancelDisconnect() {
        showDisconnectConfirm = false;
    }

    function confirmDelete() {
        dispatch('delete-chat', { id: chat.id });
        showDeleteConfirm = false;
    }

    function cancelDelete() {
        showDeleteConfirm = false;
    }

    function handleClearChat() {
        showClearConfirm = true;
    }

    async function confirmClear() {
        showClearConfirm = false;
        try {
            await appStore.clearChat(chat.id);
        } catch (error) {
            debug.error('Failed to clear chat:', error);
            dispatch('show-toast', { message: $LL.chatInterfaceErrorClearChat(), type: 'error' });
        }
    }

    function cancelClear() {
        showClearConfirm = false;
    }

    function handleAutoDelete() {
        selectedAutoDelete = chat.autoDeleteAfter ?? 0;
        showAutoDeleteDialog = true;
    }

    async function confirmAutoDelete() {
        showAutoDeleteDialog = false;
        await appStore.setAutoDelete(chat.id, selectedAutoDelete || null);
    }

    function cancelAutoDelete() {
        showAutoDeleteDialog = false;
    }

    async function handleUnlockSession() {
        sessionUnlockError = '';
        showSessionUnlockPrompt = true;
    }

    let sessionUnlockError = '';

    async function handleSessionUnlocked(event: CustomEvent<{ password: string }>) {
        const { password } = event.detail;
        sessionUnlockError = '';

        try {
            const success = await appStore.unlockApp(password);
            if (success) {
                showSessionUnlockPrompt = false;

                // Reload messages to trigger decryption
                if (chat && chat.id) {
                    await appStore.refreshChatMessages(chat.id);
                }
            } else {
                sessionUnlockError = get(LL).unlockErrorInvalidPassword();
            }
        } catch (error) {
            debug.error('Failed to unlock session:', error);
            sessionUnlockError =
                error instanceof Error ? error.message : get(LL).unlockErrorGeneric();
        }
    }

    function handleSessionUnlockCancel() {
        showSessionUnlockPrompt = false;
        sessionUnlockError = '';
    }

    function showContactInfoDialog() {
        showContactInfo = true;
    }

    function handleContactInfoClose() {
        showContactInfo = false;
    }

    async function handleContactNameUpdate(event: CustomEvent<{ newName: string }>) {
        const { newName } = event.detail;
        try {
            await appStore.updateChat(chat.id, { name: newName });
        } catch (error) {
            debug.error('Failed to update chat name:', error);
            alert(get(LL).contactInfoErrorUpdateName());
        }
    }

    function handleContactInfoDeleteChat() {
        showContactInfo = false;
        dispatch('delete-chat', { id: chat.id });
    }

    async function handleContactInfoClearChat() {
        showContactInfo = false;
        try {
            await appStore.clearChat(chat.id);
        } catch (error) {
            debug.error('Failed to clear chat:', error);
            dispatch('show-toast', { message: $LL.chatInterfaceErrorClearChat(), type: 'error' });
        }
    }

    function showProfileShareDialog() {
        showProfileShare = true;
    }

    function handleProfileShareClose() {
        showProfileShare = false;
    }

    function handleProfileShareSuccess() {
        showProfileShare = false;
    }

    function handleDropdownAction(action: string) {
        if (action === 'share-profile') {
            showProfileShareDialog();
        } else if (action === 'regenerate-key') {
            showRegenerateKey = true;
        } else if (action === 'import-whatsapp') {
            showWhatsappImport = true;
        } else if (action === 'export-chat') {
            performChatExport();
        } else if (action === 'auto-delete') {
            handleAutoDelete();
        } else if (action === 'clear-chat') {
            handleClearChat();
        } else if (action === 'delete-chat') {
            handleDeleteChat();
        }
    }

    function handleDropdownEvent(event: CustomEvent<{ action: string }>) {
        handleDropdownAction(event.detail.action);
    }

    // Direct download of this chat's history as a .txt file, no dialog. The
    // multi-chat picker with the same format lives in Settings > Storage.
    async function performChatExport() {
        try {
            const { exportChats, downloadBlob } = await import('../utils/chat-export');
            const { profileManager } = await import('../utils/profile-manager');
            const profile = get(profileManager.profile);
            const ownName = profile?.name?.trim() || get(LL).exportChatsOwnSenderFallback();
            const { blob, fileName } = await exportChats([chat], ownName);
            downloadBlob(blob, fileName);
        } catch (error) {
            debug.error('Chat export failed:', error);
            alert(get(LL).exportChatsError());
        }
    }

    // Calling someone we're already online with reuses a connection they've already seen our IP
    // over, so it needs no notice. Calling while offline builds a call invitation, which is a
    // fresh ICE exchange, so that path is gated like any other connection setup.
    function handleStartAudioCall() {
        if (isOnline) {
            void performStartAudioCall();
            return;
        }
        withConnectionNotice(chat.id, () => performStartAudioCall());
    }

    // True when the failure is a missing/not-yet-ready P2P link rather than a media-device
    // problem, so we fall back to a call invitation. `isOnline` can read true while the data
    // channel isn't actually open yet (e.g. right after a prior call or an ICE blip), in which
    // case startCall throws "WebRTC connection not established"; without this it slipped
    // through to the generic camera/mic alert.
    function isConnectionError(message: string): boolean {
        return (
            message.includes('No WebRTC connection available') ||
            message.includes('Data channel not available') ||
            message.includes('WebRTC connection not established')
        );
    }

    async function performStartAudioCall() {
        try {
            if (isOnline) {
                await appStore.startCall(chat.id, 'audio');
            } else {
                await generateCallInvitation(chat, 'audio');
            }
        } catch (error) {
            debug.error('Failed to start audio call:', error);
            const message = error instanceof Error ? error.message : '';
            if (isConnectionError(message)) {
                await generateCallInvitation(chat, 'audio');
            } else {
                // Surface the real cause (e.g. device-in-use) rather than always
                // blaming permissions, which misleads when the mic/camera are fine.
                alert(message || get(LL).chatInterfaceErrorStartCallAudio());
            }
        }
    }

    function handleStartVideoCall() {
        if (isOnline) {
            void performStartVideoCall();
            return;
        }
        withConnectionNotice(chat.id, () => performStartVideoCall());
    }

    async function performStartVideoCall() {
        debug.log('ChatInterface: Video call button clicked', {
            chatId: chat.id,
            chatName: chat.name,
            isOnline,
        });

        try {
            if (isOnline) {
                debug.log('ChatInterface: Starting video call...');
                await appStore.startCall(chat.id, 'video');
                debug.log('ChatInterface: Video call started successfully');
            } else {
                await generateCallInvitation(chat, 'video');
            }
        } catch (error) {
            debug.error('ChatInterface: Failed to start video call:', error);
            const message = error instanceof Error ? error.message : '';
            if (isConnectionError(message)) {
                await generateCallInvitation(chat, 'video');
            } else {
                // Surface the real cause (e.g. device-in-use) rather than always
                // blaming permissions, which misleads when the mic/camera are fine.
                alert(message || get(LL).chatInterfaceErrorStartCallVideo());
            }
        }
    }

    function handleAcceptCall(event: CustomEvent) {
        const { callId } = event.detail;
        if (isOnline) {
            void performAcceptCall(callId);
            return;
        }
        withConnectionNotice(chat.id, () => performAcceptCall(callId));
    }

    async function performAcceptCall(callId: string) {
        try {
            await callStore.acceptCall(callId);
        } catch (error) {
            debug.error('Failed to accept call:', error);
            // Surface the real cause (e.g. no camera/mic on this device) rather than a generic
            // message that leaves the user guessing why the call just disappeared.
            const message = error instanceof Error ? error.message : '';
            alert(message || get(LL).chatInterfaceErrorAcceptCall());
        }
    }

    async function handleRejectCall(event: CustomEvent) {
        const { callId } = event.detail;
        try {
            await callStore.rejectCall(callId);
        } catch (error) {
            debug.error('Failed to reject call:', error);
        }
    }

    async function handleEndCall(event: CustomEvent) {
        const { callId } = event.detail;
        try {
            await callStore.endCall(callId);
        } catch (error) {
            debug.error('Failed to end call:', error);
        }
    }

    function handleToggleCallAudio(event: CustomEvent) {
        const { callId } = event.detail;
        callStore.toggleCallAudio(callId);
    }

    function handleToggleCallVideo(event: CustomEvent) {
        const { callId } = event.detail;
        callStore.toggleCallVideo(callId);
    }
</script>

<div class="chat-container">
    <ChatHeader
        {chat}
        {isOnline}
        {isConnecting}
        {connectionFailed}
        {currentCall}
        {smartButtonState}
        {smartButtonHoverText}
        {smartButtonTooltip}
        {isPeerTyping}
        {backButtonLabel}
        on:goBack={goBack}
        on:startAudioCall={handleStartAudioCall}
        on:startVideoCall={handleStartVideoCall}
        on:smartButton={handleSmartButton}
        on:dropdownAction={handleDropdownEvent}
        on:showContactInfo={showContactInfoDialog}
    />

    <ChatMessagesPane
        {chat}
        {isOnline}
        {messages}
        {hasSessionLockedMessages}
        {pendingReaction}
        {reactTargetMessageId}
        {pendingReactionMessageId}
        {showWhatsappImport}
        {hasMoreOlder}
        {isLoadingOlder}
        onLoadOlder={loadOlderAnchored}
        onContainerReady={(node) => (messagesContainer = node)}
        onScroll={handleScroll}
        onCloseWhatsappImport={() => (showWhatsappImport = false)}
        onUnlockSession={handleUnlockSession}
        onMessageDeleted={handleMessageDeleted}
        onReact={handleMessageReaction}
        onUnreact={handleMessageUnreact}
        onSendMessage={handleSendMessage}
        onTyping={handleTyping}
        {showConnectionPanel}
        connected={connectedAck}
        isConnecting={tutorialConnecting}
        {currentRole}
        {isGeneratingOffer}
        {connectionUrl}
        {generatedAnswerUrl}
        {connectionFailed}
        {canRetryConnection}
        connectionAutoCopied={connectionState.autoCopied}
        onGenerateOffer={handleGenerateOffer}
        onDismissPanel={handleDismissPanel}
        onRetryConnection={handleRetryConnection}
    />
</div>

<ChatConfirmDialogs
    chatName={chat.name}
    {showDeleteConfirm}
    {showClearConfirm}
    {showAutoDeleteDialog}
    {showDisconnectConfirm}
    bind:selectedAutoDelete
    onConfirmDelete={confirmDelete}
    onCancelDelete={cancelDelete}
    onConfirmClear={confirmClear}
    onCancelClear={cancelClear}
    onConfirmAutoDelete={confirmAutoDelete}
    onCancelAutoDelete={cancelAutoDelete}
    onConfirmDisconnect={confirmDisconnect}
    onCancelDisconnect={cancelDisconnect}
/>

{#if showConnectionNotice}
    <ConnectionNoticeDialog
        on:confirm={handleConnectionNoticeConfirmed}
        on:cancel={handleConnectionNoticeCancelled}
    />
{/if}

{#if showSessionUnlockPrompt}
    <SessionUnlockDialog
        error={sessionUnlockError}
        on:session-unlocked={handleSessionUnlocked}
        on:cancel={handleSessionUnlockCancel}
    />
{/if}

{#if showContactInfo}
    <ContactInfoDialog
        contactName={chat.name}
        contactId={chat.id}
        sharedProfile={chat.sharedProfile}
        on:close={handleContactInfoClose}
        on:update-name={handleContactNameUpdate}
        on:delete-chat={handleContactInfoDeleteChat}
        on:clear-chat={handleContactInfoClearChat}
    />
{/if}

{#if showProfileShare}
    <ProfileShare
        chatId={chat.id}
        on:close={handleProfileShareClose}
        on:shared={handleProfileShareSuccess}
    />
{/if}

{#if showRegenerateKey}
    <RegenerateChatKeyDialog
        chatId={chat.id}
        on:key-rotated={() => {
            showRegenerateKey = false;
        }}
        on:close={() => {
            showRegenerateKey = false;
        }}
        on:show-toast={(e) => dispatch('show-toast', e.detail)}
    />
{/if}

<!-- Permanently mounted so the end-of-call announcement survives CallInterface
     unmounting; see the callEndAnnouncement comment in the script. -->
<div class="sr-only" role="status">{callEndAnnouncement}</div>

{#if showCallInterface && currentCall}
    <CallInterface
        call={currentCall}
        on:end-call={handleEndCall}
        on:toggle-audio={handleToggleCallAudio}
        on:toggle-video={handleToggleCallVideo}
    />
{/if}

{#if showIncomingCallDialog && currentIncomingCall}
    <IncomingCallDialog
        call={currentIncomingCall}
        show={showIncomingCallDialog}
        on:accept-call={handleAcceptCall}
        on:reject-call={handleRejectCall}
    />
{/if}

<style>
    .chat-container {
        display: flex;
        flex-direction: column;
        height: 100vh;
        height: 100svh;
        background: var(--color-chat-bg);
    }
</style>
