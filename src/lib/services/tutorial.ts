import { get, writable } from 'svelte/store';
import { appStore, chatsStore } from '$lib/stores/app';
import { uiStore } from '$lib/stores/ui-store';
import { chatConnectionStore } from '$lib/stores/chat-connection-store';
import { generateMnemonic, generateUUID } from '$lib/utils/crypto';
import { secureChatStorage } from '$lib/utils/secure-chat-storage';
import { buildShareCode } from '$lib/utils/share-link';
import { copyToClipboard } from '$lib/utils/web-share';
import { TutorialPeer } from '$lib/services/tutorial-online-sim';
import { translations as LL } from '$lib/i18n/runtime';
import { debug } from '$lib/utils/debug';
import type { StoredMessage } from '$lib/types';

/**
 * Guided "Tutorial" onboarding.
 *
 * The tour is a real, normal chat (its own key, deletable like any other) driven by a fake
 * contact named "Tutorial". The offline section is fully scripted: nothing the user sends in
 * the Tutorial chat runs the real send or receive pipeline, so a pasted code is never actually
 * decrypted or imported; the stand-in simply replies as if it had (see {@link handleScriptedSend}).
 * The user's very first message is still genuinely encrypted to a `#secure=` code so the
 * "code on your clipboard" lesson is real, but that is the only crypto the offline section does.
 * Going online is the exception that stays live: it completes a genuine (loopback) WebRTC
 * connection to a local stand-in. The controller injects bot messages and advances a small state
 * machine in response to the user's actions.
 *
 * Offered once at first run (gated by the `tutorial-offered` flag); progress persists so a
 * mid-tour reload resumes without re-injecting the bot messages that already live in storage.
 * The live online steps are the exception: WebRTC state does not survive a reload, so they are
 * wound up on hydrate rather than resumed.
 */

export type TutorialStep =
    | 'idle'
    | 'await-send'
    | 'await-paste'
    | 'await-reaction'
    | 'await-online'
    | 'await-offer-send'
    | 'await-connect'
    | 'online'
    | 'done';

const CHAT_ID_KEY = 'tutorial-chat-id';
const STEP_KEY = 'tutorial-step';
const OFFERED_KEY = 'tutorial-offered';

// Pause before each bot message so a burst of messages arrives one at a time, the way a person
// would type them, rather than all at once.
const MESSAGE_DELAY_MS = 3000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Current step, readable by the UI. */
export const tutorialStep = writable<TutorialStep>('idle');

function lsGet(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function lsSet(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Best-effort persistence; tour still works in-memory this session.
    }
}

function lsRemove(key: string): void {
    try {
        localStorage.removeItem(key);
    } catch {
        // ignore
    }
}

class TutorialController {
    // Strictly-increasing timestamp source so rapidly injected bot messages keep their order
    // even when several land within the same millisecond.
    private lastTimestamp = 0;
    // The local stand-in that answers the user's offer during the online step.
    private peer: TutorialPeer | null = null;
    // The encrypted WebRTC offer captured when the user taps "Go online", held until the user
    // actually sends their invite into the box so the stand-in can answer it.
    private pendingOffer: string | null = null;
    // Unsubscribe handle for the connection watcher armed during the online step.
    private connectWatcher: (() => void) | null = null;
    // Backstop timer for the online step: if the loopback connection neither completes nor
    // reports a failure within the window (e.g. a VPN silently stalling ICE in 'checking'),
    // wind the step up gracefully instead of leaving the panel pinned on "Connecting...".
    private connectTimeout: ReturnType<typeof setTimeout> | null = null;
    // Guards against handleConnectFailed running twice (e.g. the 'failed' watcher and the
    // backstop timer both firing) — it has awaits before it advances the step.
    private handlingConnectFailure = false;

    getTutorialChatId(): string | null {
        return lsGet(CHAT_ID_KEY);
    }

    isTutorialChat(chatId: string): boolean {
        const id = this.getTutorialChatId();
        return !!id && id === chatId;
    }

    /** True once the tour has been offered (started or skipped); enforces first-run-only. */
    hasBeenOffered(): boolean {
        return lsGet(OFFERED_KEY) === 'true';
    }

    markOffered(): void {
        lsSet(OFFERED_KEY, 'true');
    }

    private setStep(step: TutorialStep): void {
        if (step === 'idle' || step === 'done') {
            lsRemove(STEP_KEY);
        } else {
            lsSet(STEP_KEY, step);
        }
        tutorialStep.set(step);
    }

    /** Wind up the tour: the chat becomes an ordinary chat with no further bot reactions. */
    private endTour(): void {
        this.stopConnectWatcher();
        this.pendingOffer = null;
        lsRemove(CHAT_ID_KEY);
        lsRemove(STEP_KEY);
        tutorialStep.set('done');
    }

    /**
     * Restore the in-progress step after a reload. Call once chats are loaded. If the tutorial
     * chat was deleted out from under us, clear the stale state. The live online steps can't
     * resume (WebRTC state is gone after a reload), so they are wound up instead.
     */
    hydrate(): void {
        const chatId = this.getTutorialChatId();
        const step = lsGet(STEP_KEY) as TutorialStep | null;
        if (!chatId || !step) {
            tutorialStep.set('idle');
            return;
        }
        const exists = get(chatsStore).some((c) => c.id === chatId);
        if (!exists) {
            this.endTour();
            return;
        }
        if (
            step === 'await-online' ||
            step === 'await-offer-send' ||
            step === 'await-connect' ||
            step === 'online'
        ) {
            this.endTour();
            return;
        }
        tutorialStep.set(step);
    }

    private nextTimestamp(): number {
        const now = Date.now();
        this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
        return this.lastTimestamp;
    }

    private isChatOnline(chatId: string): boolean {
        const connections = get(appStore).peerConnections;
        const conn = connections instanceof Map ? connections.get(chatId) : undefined;
        return conn?.state === 'connected';
    }

    private async injectBot(chatId: string, body: string, immediate = false): Promise<void> {
        const online = this.isChatOnline(chatId);
        // The first message of a burst lands immediately; later ones are staggered with a short
        // pause, showing the live "typing" indicator during it while connected so it reads like
        // the stand-in is composing a reply.
        if (!immediate) {
            if (online) appStore.handleRealTimeTyping(chatId, true);
            await delay(MESSAGE_DELAY_MS);
            if (online) appStore.handleRealTimeTyping(chatId, false);
        }

        const message: StoredMessage = {
            id: generateUUID(),
            from: get(LL).tutorialContactName(),
            body,
            timestamp: this.nextTimestamp(),
            isOwn: false,
            deliveryMethod: online ? 'online' : 'offline',
        };
        await appStore.addMessage(chatId, message);
    }

    /** Create the Tutorial chat and post the opening messages. */
    async start(): Promise<void> {
        const t = get(LL);
        this.markOffered();

        try {
            await appStore.addChat(t.tutorialContactName(), generateMnemonic());
        } catch (error) {
            debug.error('Failed to create tutorial chat:', error);
            uiStore.showToast(t.tutorialErrorCreate(), 'error');
            return;
        }

        const chatId = get(appStore).currentChatId;
        if (!chatId) {
            uiStore.showToast(t.tutorialErrorCreate(), 'error');
            return;
        }

        lsSet(CHAT_ID_KEY, chatId);
        appStore.setCurrentChat(chatId);

        // Return now that the chat exists and is current so the caller can navigate into it
        // immediately (on mobile the list and chat are separate screens). The intro messages
        // are staggered with delays, so they play in the background while the user watches.
        void this.playIntro(chatId);
    }

    /** Stream the opening tour messages into the chat (staggered; runs in the background). */
    private async playIntro(chatId: string): Promise<void> {
        const t = get(LL);
        try {
            await this.injectBot(chatId, t.tutorialMsgIntro1(), true);
            await this.injectBot(chatId, t.tutorialMsgIntro2());
            await this.injectBot(chatId, t.tutorialMsgPromptSend());
            this.setStep('await-send');
        } catch (error) {
            debug.error('Failed to play tutorial intro:', error);
        }
    }

    /** Replay the tour from scratch (from the settings "Redo tutorial" action). */
    async restart(): Promise<void> {
        this.stopConnectWatcher();
        this.peer?.close();
        this.peer = null;

        // Remove the existing Tutorial chat (tracked, plus any leftover by the same name) so
        // start()'s name-based de-dupe creates a fresh one rather than reopening the old.
        const name = get(LL).tutorialContactName();
        const ids = new Set<string>();
        const tracked = this.getTutorialChatId();
        if (tracked) ids.add(tracked);
        for (const c of get(chatsStore)) {
            if (c.name === name) ids.add(c.id);
        }
        for (const id of ids) {
            try {
                await appStore.deleteChat(id);
            } catch (error) {
                debug.error('Failed to remove existing tutorial chat:', error);
            }
        }

        lsRemove(CHAT_ID_KEY);
        lsRemove(STEP_KEY);
        tutorialStep.set('idle');

        await this.start();
    }

    /**
     * Single entry point for anything the user "sends" in the Tutorial chat. The chat is a
     * scripted dummy account: we never run the real send/receive pipeline here, so a pasted code
     * is not decrypted or imported and a typed message is not really transmitted. We just show the
     * message and let the scripted stand-in reply. (The live "Go online" WebRTC handshake is the
     * one genuine exchange and is handled separately by the caller.)
     */
    async handleScriptedSend(
        chatId: string,
        message: string,
        senderName: string,
        isCode: boolean
    ): Promise<void> {
        if (!this.isTutorialChat(chatId)) return;
        const step = get(tutorialStep);

        // Connected easter-egg mode: fake the live send so the stand-in always reacts and replies.
        if (step === 'online') {
            const sent = await this.addOwnMessage(chatId, message, senderName, 'online');
            await this.notifyOnlineMessage(chatId, sent.id);
            return;
        }

        // First message: show it and run the send demo. We still encrypt it for real and drop it
        // on the clipboard so the "code on your clipboard" line holds; that is the actual lesson.
        if (step === 'await-send' && !isCode) {
            // The copy is kicked off before any await: Safari drops the send
            // gesture's transient activation at the first one, and the
            // clipboard write must begin while it is still live.
            const copied = this.copyOwnCode(chatId, message, senderName);
            await this.addOwnMessage(chatId, message, senderName, 'offline');
            await copied;
            await this.onUserSentMessage(chatId);
            return;
        }

        // Receive demo: the user pasted their own clipboard code (or anything else). Reply as if
        // we decrypted it, showing their message coming back; no real decryption happens.
        if (step === 'await-paste') {
            const t = get(LL);
            await this.injectBot(chatId, t.tutorialSecretMessage(), true);
            await this.notifyReceived(chatId);
            return;
        }

        // Any other moment: the message is inert. Show plain text so the chat isn't a dead end;
        // swallow stray codes so a pasted blob never lands as an ugly bubble.
        if (!isCode && message.trim()) {
            await this.addOwnMessage(chatId, message, senderName, 'offline');
        }
    }

    private async addOwnMessage(
        chatId: string,
        body: string,
        from: string,
        deliveryMethod: 'online' | 'offline'
    ): Promise<StoredMessage> {
        const message: StoredMessage = {
            id: generateUUID(),
            from,
            body,
            timestamp: this.nextTimestamp(),
            isOwn: true,
            deliveryMethod,
        };
        await appStore.addMessage(chatId, message);
        return message;
    }

    /** Encrypt the user's first message to a real share code and copy it, for the send demo. */
    private copyOwnCode(chatId: string, message: string, senderName: string): Promise<void> {
        const code = secureChatStorage
            .createSharePayload(chatId, message, senderName)
            .then((payload) => buildShareCode(`#secure=${payload}`));
        return copyToClipboard(code).then(
            () => undefined,
            (error) => {
                debug.error('Failed to prepare tutorial share code:', error);
            }
        );
    }

    /** Called after the user sends a message; advances the send demo into the receive demo. */
    async onUserSentMessage(chatId: string): Promise<void> {
        if (!this.isTutorialChat(chatId)) return;
        if (get(tutorialStep) !== 'await-send') return;

        const t = get(LL);
        // The user already saw their own message land, so the stand-in takes a beat before
        // replying (not instant) and then invites them to paste that same code back into the chat.
        // The code is already on the clipboard from copyOwnCode.
        await this.injectBot(chatId, t.tutorialMsgAfterSend1());
        this.setStep('await-paste');
    }

    /** Called after a code is decrypted into the Tutorial chat; moves on to the reaction step. */
    async notifyReceived(chatId: string): Promise<void> {
        if (!this.isTutorialChat(chatId)) return;
        if (get(tutorialStep) !== 'await-paste') return;

        const t = get(LL);
        // The reveal message (tutorialSecretMessage) is the instant reply to the paste; these two
        // follow-ups stagger after it like every other burst, so the cadence stays even.
        await this.injectBot(chatId, t.tutorialMsgComplete());
        await this.injectBot(chatId, t.tutorialMsgReactPrompt());
        this.setStep('await-reaction');
    }

    /** Called when the user reacts to a message; a little easter egg, then on to the online step. */
    async notifyReaction(chatId: string, type: 'laugh' | 'heart' | '100'): Promise<void> {
        if (!this.isTutorialChat(chatId)) return;
        if (get(tutorialStep) !== 'await-reaction') return;

        const t = get(LL);
        const reply =
            type === 'heart'
                ? t.tutorialMsgReactionHeart()
                : type === '100'
                  ? t.tutorialMsgReactionHundred()
                  : t.tutorialMsgReactionLaugh();
        // The user already saw their reaction land, so the stand-in takes a beat before replying.
        await this.injectBot(chatId, reply);
        await this.injectBot(chatId, t.tutorialMsgOnlinePrompt());
        this.setStep('await-online');
    }

    /**
     * Called when the user generates a WebRTC offer (taps "Go online") in the Tutorial chat.
     * Rather than answering immediately, we hold the offer and ask the user to send their invite
     * into the box first, matching the connection panel's banner. The stand-in only answers once
     * the user actually sends it (see {@link notifyOfferSent}).
     */
    async notifyWentOnline(chatId: string, encryptedOffer: string): Promise<void> {
        if (!this.isTutorialChat(chatId)) return;
        if (get(tutorialStep) !== 'await-online') return;

        const t = get(LL);
        this.pendingOffer = encryptedOffer;
        this.setStep('await-offer-send');
        await this.injectBot(chatId, t.tutorialMsgOnlinePromptSend(), true);
    }

    /**
     * Called when the user sends their invite (the WebRTC offer code) into the box during the
     * online step. The local stand-in answers the held offer; the answer is posted back as a code
     * for the user to paste, which completes a real loopback connection. Returns true when it
     * consumed the send (so the caller skips the normal receiver path).
     */
    async notifyOfferSent(chatId: string): Promise<boolean> {
        if (!this.isTutorialChat(chatId)) return false;
        if (get(tutorialStep) !== 'await-offer-send') return false;
        if (!this.pendingOffer) return false;

        const t = get(LL);
        const offer = this.pendingOffer;
        this.pendingOffer = null;
        this.handlingConnectFailure = false;
        this.setStep('await-connect');
        try {
            this.peer = new TutorialPeer();
            const answer = await this.peer.answerOffer(chatId, offer);
            const code = buildShareCode(`#webrtc-answer=${encodeURIComponent(answer)}`);
            // Instruction and code share one bubble: prose as text, code as a copy card.
            await this.injectBot(chatId, `${t.tutorialMsgOnlineResponse()}\n\n${code}`, true);
            this.watchForConnection(chatId);
            // Backstop in case ICE stalls without ever reporting 'failed' (a VPN or strict
            // firewall silently dropping connectivity checks). ~20s is comfortably longer than
            // the same-machine loopback needs, but short enough not to feel like a hang.
            this.connectTimeout = setTimeout(() => {
                this.connectTimeout = null;
                void this.handleConnectFailed(chatId);
            }, 20000);
        } catch (error) {
            debug.error('Tutorial online simulation failed:', error);
            // Couldn't stand in as a peer; wrap up gracefully so the user isn't left waiting.
            await this.injectBot(chatId, t.tutorialMsgDeleteHint(), true);
            this.peer?.close();
            this.peer = null;
            this.endTour();
        }
        return true;
    }

    private watchForConnection(chatId: string): void {
        this.stopConnectWatcher();
        this.connectWatcher = appStore.subscribe((state) => {
            const connections = state.peerConnections;
            const conn = connections instanceof Map ? connections.get(chatId) : undefined;
            if (conn?.state === 'connected') {
                void this.onConnected(chatId);
            } else if (conn?.state === 'failed') {
                // The real manager gave up on ICE (fast path — no need to wait out the backstop).
                void this.handleConnectFailed(chatId);
            }
        });
    }

    private stopConnectWatcher(): void {
        if (this.connectWatcher) {
            this.connectWatcher();
            this.connectWatcher = null;
        }
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }
    }

    /**
     * The online step couldn't complete the loopback connection (ICE failed, or stalled long
     * enough to trip the backstop timer). Rather than leave the panel spinning on
     * "Connecting...", tear the attempt down, close the panel, and post a friendly explanation
     * so the user can carry on. Retrying through a VPN/firewall would just fail again, so we
     * wind the online step up instead of offering a retry.
     */
    private async handleConnectFailed(chatId: string): Promise<void> {
        if (get(tutorialStep) !== 'await-connect' || this.handlingConnectFailure) return;
        this.handlingConnectFailure = true;
        this.stopConnectWatcher();
        this.peer?.close();
        this.peer = null;

        // Tear down the real manager so peerState leaves 'connecting' — otherwise the panel's
        // "Connecting..." face (tutorialConnecting) would stay pinned even after the step ends.
        await appStore.disconnectWebRTC(chatId);
        if (uiStore.getCurrentState().connectionWizard.isOpen) {
            uiStore.closeConnectionWizard();
        }
        chatConnectionStore.dismissPanel(chatId);

        const t = get(LL);
        await this.injectBot(chatId, t.tutorialMsgOnlineFailed(), true);
        await this.injectBot(chatId, t.tutorialMsgDeleteHint());
        await this.injectBot(chatId, t.tutorialMsgAddFriend());
        this.endTour();
    }

    /** Loopback connection established; post the closing guidance and switch to online mode. */
    private async onConnected(chatId: string): Promise<void> {
        if (get(tutorialStep) !== 'await-connect') return;
        this.stopConnectWatcher();

        const t = get(LL);
        await this.injectBot(chatId, t.tutorialMsgConnected(), true);
        await this.injectBot(chatId, t.tutorialMsgOnlineDisclosure());
        await this.injectBot(chatId, t.tutorialMsgOptionsHint());
        await this.injectBot(chatId, t.tutorialMsgDeleteHint());
        await this.injectBot(chatId, t.tutorialMsgAddFriend());
        // Stay tracked in a playful "online" mode: each message the user now sends gets a random
        // reaction and a fake reply from the stand-in. The chat is otherwise normal and can be
        // deleted anytime. (This mode can't survive a reload, so hydrate winds it up.)
        this.setStep('online');
    }

    /**
     * Easter egg: while connected, react to each message the user sends with a random emoji and
     * fire back a playful reply.
     */
    async notifyOnlineMessage(chatId: string, messageId: string): Promise<void> {
        if (!this.isTutorialChat(chatId)) return;
        if (get(tutorialStep) !== 'online') return;

        const t = get(LL);
        const emojis: Array<'laugh' | 'heart' | '100'> = ['laugh', 'heart', '100'];
        const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        // Hold off a few seconds before the reaction lands, like a person reacting.
        await delay(MESSAGE_DELAY_MS);
        await appStore.applyReactionByMessageId(chatId, messageId, emoji, t.tutorialContactName());

        const replies = [
            t.tutorialMsgOnlineReply1(),
            t.tutorialMsgOnlineReply2(),
            t.tutorialMsgOnlineReply3(),
            t.tutorialMsgOnlineReply4(),
        ];
        const reply = replies[Math.floor(Math.random() * replies.length)];
        await this.injectBot(chatId, reply);
    }
}

export const tutorialController = new TutorialController();
