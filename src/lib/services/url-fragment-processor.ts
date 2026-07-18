import { get } from 'svelte/store';
import { tick } from 'svelte';
import type { AppView } from '$lib/types/app-view';
import type { appStore as AppStoreType, chatsStore as ChatsStoreType } from '$lib/stores/app';
import type { uiStore as UiStoreType } from '$lib/stores/ui-store';
import type { secureKeyManager as SecureKeyManagerType } from '$lib/utils/secure-key-manager';
import type { secureChatStorage as SecureChatStorageType } from '$lib/utils/secure-chat-storage';
import type { StoredMessage, Call } from '$lib/types';
import { clearUrlFragment, parseAndClearFragment } from '$lib/utils/url-hygiene';
import { buildShareCode } from '$lib/utils/share-link';
import { chatConnectionStore } from '$lib/stores/chat-connection-store';
import { decryptMessage, generateUUID } from '$lib/utils/crypto';
import { tutorialController } from '$lib/services/tutorial';
import { debug } from '$lib/utils/debug';
import { translations as LL } from '$lib/i18n/runtime';

interface UrlFragmentProcessorOptions {
    appStore: typeof AppStoreType;
    chatsStore: typeof ChatsStoreType;
    uiStore: typeof UiStoreType;
    secureKeyManager: typeof SecureKeyManagerType;
    secureChatStorage: typeof SecureChatStorageType;
    navigateTo: (view: AppView, options?: { allowUnlockDialog?: boolean }) => void;
    openChat: (chatId: string) => void;
}

function parseBase64UrlParameter(param: string): string {
    if (param.includes('%')) {
        return decodeURIComponent(param);
    }
    return param;
}

// Accepted age window for link-delivered messages, mirroring CryptoService.decryptMessage.
// Must not exceed the 30-day seen-uuids retention, or pruned UUIDs become replayable.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_PAST_WINDOW_MS = 30 * 24 * 3600 * 1000;

// Calls are immediate; an old invitation link should not pop an incoming-call UI.
const CALL_INVITATION_MAX_AGE_MS = 10 * 60 * 1000;

/** First byte of a binary share payload: 0x01 (legacy) or 0x02 (current). */
function isBinarySharePayload(encoded: string): boolean {
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const firstByte = atob(base64).charCodeAt(0);
    return firstByte === 0x01 || firstByte === 0x02;
}

/**
 * Universal marker for shared encrypted content — messages, calls, profile shares, etc.
 * Used both as a URL fragment (links: `https://host/#secure=…`) and as a standalone code
 * the recipient pastes into the app (`#secure=…`, no domain, so messengers won't turn it
 * into a tappable link). Detection keys off this exact prefix, so arbitrary pasted text —
 * including raw base64 — is never mistaken for incoming content.
 */
export const SECURE_FRAGMENT = '#secure=';

export class UrlFragmentProcessor {
    private incomingMessageData: string | null = null;
    private webrtcOfferData: string | null = null;
    private webrtcAnswerData: string | null = null;

    constructor(private readonly options: UrlFragmentProcessorOptions) {}

    captureFromHash(hash: string) {
        const { type, data } = parseAndClearFragment(hash);

        if (!data) {
            return;
        }

        switch (type) {
            case 'secure':
                this.incomingMessageData = parseBase64UrlParameter(data);
                break;
            case 'webrtc-offer':
                this.webrtcOfferData = data;
                break;
            case 'webrtc-answer':
                this.webrtcAnswerData = data;
                break;
            default:
                break;
        }
    }

    async processPending() {
        if (this.incomingMessageData) {
            await this.processIncomingMessage();
        }

        if (this.webrtcOfferData) {
            await this.processWebRTCOffer();
        }

        if (this.webrtcAnswerData) {
            await this.processWebRTCAnswer();
        }
    }

    async handleHashChange(hash: string) {
        this.captureFromHash(hash);
        await this.processPending();
    }

    private async addDecryptedMessage(conversationId: string, message: any) {
        const storedMessage: StoredMessage = {
            id: generateUUID(),
            from: message.from,
            body: message.body,
            timestamp: message.timestamp * 1000,
            isOwn: false,
            deliveryMethod: 'offline',
            remoteUuid: message.uuid,
        };

        debug.log('Adding message to conversation:', conversationId);
        await this.options.appStore.addMessage(conversationId, storedMessage);
        this.options.appStore.markUUIDAsUsed(message.uuid);
        await tutorialController.notifyReceived(conversationId);
        this.options.appStore.setCurrentChat(conversationId);

        await tick();
        this.options.navigateTo('chats');

        await tick();

        this.incomingMessageData = null;
        clearUrlFragment();
        debug.log('Successfully processed message, exiting function');
    }

    /** Returns true when the profile was applied, so callers only burn the
     *  payload's replay UUID on success and a transient storage failure
     *  doesn't leave the sender's code permanently unusable. */
    private async handleProfileShare(chatId: string, profileData: any): Promise<boolean> {
        let applied = false;
        try {
            const chats = get(this.options.chatsStore);
            const conversation = chats.find((c) => c.id === chatId);
            if (!conversation) {
                debug.error?.('Chat not found for profile share:', chatId);
                this.options.uiStore.showToast('Chat not found for profile share', 'error');
                return false;
            }

            await this.options.appStore.updateChatProfile(chatId, profileData);
            applied = true;
            this.options.appStore.setCurrentChat(chatId);
            this.options.navigateTo('chats');
            this.options.uiStore.showToast(`Received profile from ${conversation.name}`, 'success');
            debug.log('Profile share processed successfully:', profileData);
        } catch (error) {
            debug.error('Failed to process profile share:', error);
            this.options.uiStore.showToast('Failed to process profile share', 'error');
        }

        this.incomingMessageData = null;
        clearUrlFragment();
        return applied;
    }

    private async processIncomingMessage() {
        if (!this.incomingMessageData) return;

        const chats = get(this.options.chatsStore);

        if (this.options.secureKeyManager.isSessionLocked()) {
            debug.log('Session is locked - prompting user to unlock before message decryption');
            this.options.uiStore.showToast(get(LL).toastUnlockAccountToDecryptMessage(), 'info');
            this.options.navigateTo('unlock', { allowUnlockDialog: true });
            return;
        }

        if (typeof window !== 'undefined' && (window as any).secureChatStorage) {
            try {
                if (isBinarySharePayload(this.incomingMessageData)) {
                    debug.log('Detected SharePayload format (binary or JSON)');

                    const finalizeShareSuccess = () => {
                        this.incomingMessageData = null;
                        clearUrlFragment();
                    };

                    const deliverDecryptedShare = async (
                        targetChatId: string,
                        decryptedMessage: any
                    ) => {
                        let parsedMessage = decryptedMessage;
                        if (typeof decryptedMessage === 'string') {
                            try {
                                parsedMessage = JSON.parse(decryptedMessage);
                            } catch (e) {
                                parsedMessage = { body: decryptedMessage, from: 'Unknown' };
                            }
                        }

                        // Every payload type (message, call invitation, profile share) passes
                        // the same gates before it is dispatched. Dispatching first would let
                        // an old code lifted from the carrier thread be replayed: invitations
                        // and profile shares would otherwise skip the magic, replay and
                        // freshness checks entirely.

                        // GCM already guarantees authenticity, but validate the envelope's
                        // magic string (as the legacy path does) so a malformed or wrong-type
                        // authentic payload is rejected rather than acted on.
                        if (parsedMessage?.magic !== 'trusted-chat') {
                            debug.log('Rejecting payload without valid magic string');
                            finalizeShareSuccess();
                            return true;
                        }

                        // Self-paste: the pasted code reproduces one of our own sent
                        // messages (e.g. via a message's "copy code" action, or pasting
                        // back the code we just generated). Nudge the user to send it to
                        // the recipient instead of storing it as an incoming message.
                        // Checked independently of the replay store because real-time
                        // (WebRTC) sends record remoteUuid but don't mark the UUID as used.
                        if (
                            parsedMessage.uuid &&
                            (await this.options.appStore.isOwnSentUUID(
                                targetChatId,
                                parsedMessage.uuid
                            ))
                        ) {
                            debug.log('Own sent message pasted back, nudging:', parsedMessage.uuid);
                            const ownChat = chats.find((c) => c.id === targetChatId);
                            this.options.uiStore.showToast(
                                get(LL).toastPastedOwnShareCode({
                                    name: ownChat?.name || '',
                                }),
                                'info'
                            );
                            finalizeShareSuccess();
                            return true;
                        }

                        // Replay protection: skip messages whose UUID we've already processed
                        if (
                            parsedMessage.uuid &&
                            this.options.appStore.isUUIDUsed(parsedMessage.uuid)
                        ) {
                            debug.log(
                                'Duplicate message (UUID already used), skipping:',
                                parsedMessage.uuid
                            );
                            finalizeShareSuccess();
                            return true;
                        }

                        const rawTs =
                            typeof parsedMessage.timestamp === 'string'
                                ? Number.parseInt(parsedMessage.timestamp, 10)
                                : parsedMessage.timestamp;
                        if (typeof rawTs !== 'number' || Number.isNaN(rawTs)) {
                            debug.log('Rejecting message without a valid timestamp');
                            this.options.uiStore.showToast(
                                'Message rejected: invalid timestamp.',
                                'error'
                            );
                            finalizeShareSuccess();
                            return true;
                        }
                        const resolvedTimestamp = rawTs < 1e12 ? rawTs * 1000 : rawTs;

                        // Same freshness window CryptoService enforces on the legacy path.
                        if (
                            resolvedTimestamp > Date.now() + MAX_FUTURE_SKEW_MS ||
                            resolvedTimestamp < Date.now() - MAX_PAST_WINDOW_MS
                        ) {
                            debug.log(
                                'Rejecting message outside acceptable timestamp window:',
                                resolvedTimestamp
                            );
                            this.options.uiStore.showToast(
                                'Message rejected: link has expired.',
                                'error'
                            );
                            finalizeShareSuccess();
                            return true;
                        }

                        // Gates passed. Dispatch by decrypted shape. Each branch burns the
                        // UUID only after it has actually handled the payload, so a transient
                        // failure doesn't leave the sender's code permanently unusable.
                        const consumeUUID = () => {
                            if (parsedMessage.uuid) {
                                this.options.appStore.markUUIDAsUsed(parsedMessage.uuid);
                            }
                        };

                        // Call invitations ride the same encrypted envelope as messages;
                        // they're identified by their decrypted shape (callId + callType).
                        // presentIncomingCall applies its own, stricter 10-minute window.
                        if (
                            typeof parsedMessage.callId === 'string' &&
                            (parsedMessage.callType === 'audio' ||
                                parsedMessage.callType === 'video')
                        ) {
                            debug.log('Call invitation detected:', parsedMessage);
                            await this.presentIncomingCall(targetChatId, parsedMessage);
                            consumeUUID();
                            finalizeShareSuccess();
                            return true;
                        }

                        if (parsedMessage.type === 'profile-share' && parsedMessage.profileData) {
                            debug.log('Profile share detected:', parsedMessage);
                            if (
                                await this.handleProfileShare(
                                    targetChatId,
                                    parsedMessage.profileData
                                )
                            ) {
                                consumeUUID();
                            }
                            finalizeShareSuccess();
                            return true;
                        }

                        // Profile share JSON is sent as the body of a standard message envelope
                        if (parsedMessage.body) {
                            try {
                                const bodyData = JSON.parse(parsedMessage.body);
                                if (bodyData.type === 'profile-share' && bodyData.profileData) {
                                    debug.log('Profile share detected in message body:', bodyData);
                                    if (
                                        await this.handleProfileShare(
                                            targetChatId,
                                            bodyData.profileData
                                        )
                                    ) {
                                        consumeUUID();
                                    }
                                    finalizeShareSuccess();
                                    return true;
                                }
                            } catch (_e) {
                                // body is not JSON, continue as regular message
                            }
                        }

                        debug.log('Regular secure message:', parsedMessage);

                        const storedMessage: StoredMessage = {
                            id: generateUUID(),
                            from: parsedMessage.from || 'Unknown',
                            body: parsedMessage.body || '',
                            timestamp: resolvedTimestamp,
                            isOwn: false,
                            deliveryMethod: 'offline',
                            remoteUuid: parsedMessage.uuid,
                        };

                        try {
                            const meta = (parsedMessage as any).meta;
                            if (meta && meta.emoji) {
                                await this.options.appStore.applyReactionToLastOwn(
                                    targetChatId,
                                    meta.emoji,
                                    parsedMessage.from || 'Unknown'
                                );
                            }
                        } catch (e) {
                            debug.warn('Failed to apply reaction metadata:', e);
                        }

                        await this.options.appStore.addMessage(targetChatId, storedMessage);
                        if (parsedMessage.uuid) {
                            this.options.appStore.markUUIDAsUsed(parsedMessage.uuid);
                        }
                        await tutorialController.notifyReceived(targetChatId);
                        this.options.appStore.setCurrentChat(targetChatId);
                        this.options.navigateTo('chats');
                        finalizeShareSuccess();
                        return true;
                    };

                    const candidateChatIds: string[] = [];
                    const appState = get(this.options.appStore);
                    if (typeof appState.currentChatId === 'string' && appState.currentChatId) {
                        candidateChatIds.push(appState.currentChatId);
                    }

                    for (const conversation of chats) {
                        if (!candidateChatIds.includes(conversation.id)) {
                            candidateChatIds.push(conversation.id);
                        }
                    }

                    for (const chatId of candidateChatIds) {
                        let keyReady = this.options.secureKeyManager.hasConversationKey(chatId);
                        if (!keyReady) {
                            try {
                                await this.options.secureKeyManager.unwrapConversationKey(chatId);
                                keyReady = true;
                            } catch (unwrapError) {
                                debug.log(`Key unavailable for chat ${chatId}:`, unwrapError);
                            }
                        }

                        if (!keyReady) {
                            continue;
                        }

                        try {
                            const decryptedMessage = await (
                                this.options.secureChatStorage as any
                            ).openSharePayload(chatId, this.incomingMessageData);

                            if (await deliverDecryptedShare(chatId, decryptedMessage)) {
                                return;
                            }
                        } catch (error) {
                            debug.log(
                                'Failed to decrypt share payload with secure storage for chat',
                                chatId,
                                error
                            );
                        }
                    }
                }
            } catch (error) {
                debug.log('Not a SharePayload format, trying old format:', error);
            }
        }

        const encryptedData = this.incomingMessageData;
        if (!encryptedData) {
            debug.log('No encrypted message data available to process.');
            return;
        }

        let decryptedWithAnyKey = false;

        for (const conversation of chats) {
            try {
                debug.log('Trying to decrypt message with conversation:', conversation.name);
                // Forward secrecy: trial-decrypt against the retained daily keys (newest first).
                // The GCM auth tag identifies the right day; a code older than the retained
                // window simply fails to authenticate against any of them.
                let messageKeys: CryptoKey[] = [];
                try {
                    messageKeys = await this.options.secureKeyManager.getReceiveMessageKeys(
                        conversation.id
                    );
                } catch (error) {
                    debug.log(
                        `Failed to get keys from secure manager for ${conversation.name}:`,
                        error
                    );
                    continue;
                }

                if (!messageKeys.length) {
                    debug.log('No crypto keys available for conversation:', conversation.name);
                    continue;
                }

                let message = null;
                for (const dailyKey of messageKeys) {
                    message = await decryptMessage(encryptedData, dailyKey);
                    if (message) break;
                }

                if (message && !this.options.appStore.isUUIDUsed(message.uuid)) {
                    debug.log('Successfully decrypted message:', message);
                    decryptedWithAnyKey = true;

                    if (message.body) {
                        try {
                            const bodyData = JSON.parse(message.body);
                            if (bodyData.type === 'profile-share' && bodyData.profileData) {
                                debug.log(
                                    'Profile share detected in old format message:',
                                    bodyData
                                );
                                // Burn the UUID on success; without this the legacy path
                                // returned before addDecryptedMessage (the only place that
                                // marks UUIDs), leaving the share replayable forever.
                                if (
                                    await this.handleProfileShare(
                                        conversation.id,
                                        bodyData.profileData
                                    )
                                ) {
                                    this.options.appStore.markUUIDAsUsed(message.uuid);
                                }
                                return;
                            }
                        } catch (e) {
                            // ignore non JSON
                        }
                    }

                    try {
                        const meta = (message as any).meta;
                        if (meta && meta.emoji) {
                            await this.options.appStore.applyReactionToLastOwn(
                                conversation.id,
                                meta.emoji,
                                message.from || 'Unknown'
                            );
                        }
                    } catch (e) {
                        debug.warn('Failed to apply reaction metadata:', e);
                    }

                    await this.addDecryptedMessage(conversation.id, message);
                    return;
                }
            } catch (error) {
                debug.log(`Error trying to decrypt with conversation ${conversation.name}:`, error);
                continue;
            }
        }

        if (!decryptedWithAnyKey) {
            debug.log('Failed to decrypt with any key');
            debug.error('Unable to decrypt message. Make sure you have the correct key saved.');

            let errorMessage = 'Cannot decrypt message.';
            if (chats.length === 0) {
                errorMessage += ' No conversations found. Set up a conversation first.';
            } else {
                const hasKeys = chats.some((conv) =>
                    this.options.secureKeyManager.hasConversationKey(conv.id)
                );
                if (!hasKeys) {
                    errorMessage += ` ${get(LL).errorNoEncryptionKeysUnlockAccount()}`;
                } else {
                    errorMessage +=
                        ' Message was encrypted with a different key. Verify you have the correct conversation key.';
                }
            }

            this.options.uiStore.showToast(errorMessage, 'error');
            this.incomingMessageData = null;
            clearUrlFragment();
        }
    }

    private async processWebRTCOffer() {
        if (!this.webrtcOfferData) return;

        try {
            // As soon as the offer is decrypted, the chat is known but the answer is still
            // being built (ICE gathering takes a couple of seconds). Open the panel right
            // away in a "generating" receiver state so the progress shows in the same place
            // as the rest of the connection messages, not as a separate toast.
            const result = await this.options.appStore.handleWebRTCOffer(
                this.webrtcOfferData,
                (chatId) => {
                    this.options.openChat(chatId);
                    this.options.uiStore.openConnectionWizard({
                        isOpen: true,
                        quickMode: true,
                        chatId,
                        currentRole: 'receiver',
                        generatedAnswerUrl: '',
                        hasActiveOffer: false,
                    });
                    chatConnectionStore.openPanel(chatId, {
                        quickMode: true,
                        role: 'receiver',
                        generatedAnswerUrl: '',
                        hasActiveOffer: false,
                    });
                }
            );
            const answerUrl = buildShareCode(`#webrtc-answer=${encodeURIComponent(result.answer)}`);

            this.options.openChat(result.chatId);
            await tick();

            // Answer is ready: fill it into the panel, which flips from "generating" to the
            // copy/share instructions.
            this.options.uiStore.openConnectionWizard({
                isOpen: true,
                quickMode: true,
                chatId: result.chatId,
                currentRole: 'receiver',
                generatedAnswerUrl: answerUrl,
                hasActiveOffer: false,
            });
            chatConnectionStore.openPanel(result.chatId, {
                quickMode: true,
                role: 'receiver',
                generatedAnswerUrl: answerUrl,
                hasActiveOffer: false,
            });
        } catch (error) {
            debug.error('Failed to process WebRTC offer:', error);
            this.options.uiStore.showToast(
                'Connection failed. Please check you have the correct conversation key.',
                'error'
            );
        }

        this.webrtcOfferData = null;
        clearUrlFragment();
    }

    private async processWebRTCAnswer() {
        if (!this.webrtcAnswerData) return;

        const chats = get(this.options.chatsStore);
        let processedWithAnyKey = false;

        for (const conversation of chats) {
            try {
                await this.options.appStore.handleWebRTCAnswer(
                    conversation.id,
                    this.webrtcAnswerData
                );
                this.options.openChat(conversation.id);
                await tick();
                // Leave the connection panel up: when the peer state reaches "connected",
                // ChatInterface briefly shows "Connected to <name>" in the panel slot and
                // then collapses it. No top toast, so the confirmation stays where the
                // setup instructions were.
                processedWithAnyKey = true;
                break;
            } catch (error) {
                debug.error(`Failed to process WebRTC answer for chat ${conversation.id}:`, error);
                continue;
            }
        }

        if (!processedWithAnyKey) {
            this.options.uiStore.showToast(
                'Connection failed. Please check you have the correct conversation key.',
                'error'
            );
        }

        this.webrtcAnswerData = null;
        clearUrlFragment();
    }

    /**
     * Present an incoming call from a decrypted invitation that arrived in a #secure=
     * payload. Enforces the short freshness window so a stale/replayed invitation never
     * pops the incoming-call UI.
     */
    private async presentIncomingCall(
        chatId: string,
        invitation: { callType: 'audio' | 'video'; callId: string; timestamp?: number }
    ) {
        const chats = get(this.options.chatsStore);
        const chat = chats.find((c) => c.id === chatId);
        if (!chat) return;

        if (
            typeof invitation.timestamp !== 'number' ||
            Date.now() - invitation.timestamp > CALL_INVITATION_MAX_AGE_MS
        ) {
            this.options.uiStore.showToast('This call invitation has expired', 'info');
            return;
        }

        const { callType, callId } = invitation;
        this.options.appStore.setCurrentChat(chatId);
        await tick();
        this.options.navigateTo('chats');

        const { callStore } = await import('$lib/stores/call-store');
        const callData: Call = {
            id: callId,
            chatId,
            type: callType,
            state: 'incoming',
            participants: [
                {
                    id: 'peer',
                    name: chat.name,
                    isAudioMuted: false,
                    isVideoMuted: callType === 'audio',
                },
                {
                    id: 'self',
                    name: 'You',
                    isAudioMuted: false,
                    isVideoMuted: callType === 'audio',
                },
            ],
            startTime: Date.now(),
            isInitiator: false,
        };

        callStore.setIncomingCall(callData);
        this.options.uiStore.showToast(`Incoming ${callType} call from ${chat.name}`, 'info');
    }
}
