import { writable, derived, get } from 'svelte/store';
import type {
    AppState,
    Chat,
    StoredMessage,
    PeerConnection,
    CallSignalData,
    CallEventInfo,
    ContactMethod,
} from '../types';
import { storage } from '../utils/storage';
import { chatStorage } from '../utils/chat-storage';
import { generateUUID } from '../utils/crypto';
import { secureKeyManager } from '../utils/secure-key-manager';
import { messageStoreRegistry } from '../utils/lazy-message-store';
import { messageSearch } from '../utils/message-search';
import { WebRTCManager, ConnectionState } from '../utils/webrtc';
import { debug } from '../utils/debug';

function createAppStore() {
    const { subscribe, set, update } = writable<AppState>({
        currentChatId: null,
        isFirstTime: true,
        usedUUIDs: new Set(),
        peerConnections: new Map(),
        profile: undefined,
        profileSettings: {
            autoLockTimeout: -1, // Manual only by default
            hideMessagesOnHomepage: false, // Show messages by default
            showInstantLockButton: false, // Quick lock button hidden by default
            enterKeySendsMessage: true,
            use24HourTime: false,
            themePreference: 'system',
        },
        profileLockState: {
            isLocked: false,
        },
    });

    const { subscribe: subscribeChats, set: setChats, update: updateChats } = writable<Chat[]>([]);
    const { subscribe: subscribeTypingStatus, update: updateTypingStatusStore } = writable<
        Map<string, { isTyping: boolean; updatedAt: number }>
    >(new Map());
    const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
    const TYPING_TIMEOUT_MS = 5000;
    let latestTypingStatus = new Map<string, { isTyping: boolean; updatedAt: number }>();
    subscribeTypingStatus((value) => {
        latestTypingStatus = value;
    });

    const webrtcManagers = new Map<string, WebRTCManager>();

    // Auto-delete prune timers keyed by chatId
    const pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function clearPruneTimer(chatId: string) {
        const existing = pruneTimers.get(chatId);
        if (existing !== undefined) {
            clearTimeout(existing);
            pruneTimers.delete(chatId);
        }
    }

    async function scheduleNextPrune(chatId: string) {
        clearPruneTimer(chatId);
        // Scan raw storage records: autoDeleteAfter and timestamp are plaintext metadata,
        // and the in-memory store only holds the newest page, which could miss expiries
        // on older messages.
        const { dataStorage } = await import('../utils/indexeddb-storage');
        let messages: Array<{ timestamp: number; autoDeleteAfter?: number | null }> = [];
        try {
            messages = await dataStorage.getMessagesByChat(chatId);
        } catch (error) {
            debug.warn('Failed to scan messages for prune scheduling:', error);
            return;
        }
        const now = Date.now();
        let soonest = Infinity;
        for (const msg of messages) {
            if (msg.autoDeleteAfter) {
                const expiresAt = msg.timestamp + msg.autoDeleteAfter;
                if (expiresAt > now && expiresAt < soonest) {
                    soonest = expiresAt;
                }
            }
        }
        if (soonest !== Infinity) {
            const delay = soonest - now;
            const timer = setTimeout(async () => {
                pruneTimers.delete(chatId);
                const deleted = await chatStorage.deleteExpiredMessages(chatId);
                if (deleted > 0) {
                    await messageStoreRegistry.getStore(chatId).refresh();
                    messageSearch.invalidateChat(chatId);
                }
                scheduleNextPrune(chatId);
            }, delay);
            pruneTimers.set(chatId, timer);
        }
    }

    let _isPageUnloading = false;
    let _lastVisibilityChange = Date.now();

    function handleBeforeUnload(event: BeforeUnloadEvent) {
        // Show popup whenever a WebRTC manager exists (wizard open, connecting, or connected).
        // Managers are deleted from the map on explicit disconnect, so this won't fire spuriously.
        if (webrtcManagers.size > 0) {
            event.preventDefault();
            event.returnValue =
                'Active chat connections will be disconnected if you leave this page.';
        }
    }

    function handleVisibilityChange() {
        const now = Date.now();
        _lastVisibilityChange = now;

        if (document.hidden) {
            debug.info('Page hidden');
        } else {
            debug.info('Page visible');
        }
    }

    function handlePageHide() {
        debug.info('Page hiding - closing connections gracefully');
        _isPageUnloading = true;

        webrtcManagers.forEach(async (manager, chatId) => {
            if (manager.getConnectionState() === ConnectionState.CONNECTED) {
                debug.debug(`Closing connection for ${chatId} before unload`);
                await manager.disconnectGracefully('unload');
            } else {
                manager.disconnect();
            }
        });
    }

    function setPeerTypingStatusInternal(chatId: string, isTyping: boolean): void {
        if (typingTimeouts.has(chatId)) {
            const timeout = typingTimeouts.get(chatId);
            if (timeout) {
                clearTimeout(timeout);
            }
            typingTimeouts.delete(chatId);
        }

        updateTypingStatusStore((current) => {
            const next = new Map(current);
            if (isTyping) {
                next.set(chatId, { isTyping: true, updatedAt: Date.now() });
            } else {
                next.delete(chatId);
            }
            return next;
        });

        if (isTyping) {
            const timeoutId = setTimeout(() => {
                updateTypingStatusStore((current) => {
                    const next = new Map(current);
                    next.delete(chatId);
                    return next;
                });
                typingTimeouts.delete(chatId);
            }, TYPING_TIMEOUT_MS);
            typingTimeouts.set(chatId, timeoutId);
        }
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', handleBeforeUnload);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('pagehide', handlePageHide);
    }

    return {
        subscribe,
        set,
        update,

        subscribeChats,
        subscribeTypingStatus,

        isPeerTyping(chatId: string): boolean {
            return latestTypingStatus.get(chatId)?.isTyping ?? false;
        },

        async getChatWithMessages(id: string): Promise<Chat | null> {
            return await chatStorage.getChatWithMessages(id);
        },

        async init() {
            const state = await storage.loadAppState();

            // Ensure proper types for loaded data (handle JSON serialization/deserialization)
            const normalizedState: AppState = {
                currentChatId: state.currentChatId || null,
                isFirstTime: state.isFirstTime !== false, // Default to true if not set
                usedUUIDs:
                    state.usedUUIDs instanceof Set
                        ? state.usedUUIDs
                        : new Set(Array.isArray(state.usedUUIDs) ? state.usedUUIDs : []),
                // WebRTC connections don't survive page reloads — always start fresh
                peerConnections: new Map(),
                profile: state.profile || undefined,
                profileSettings: state.profileSettings || {
                    autoLockTimeout: -1,
                    hideMessagesOnHomepage: false,
                    enterKeySendsMessage: true,
                    use24HourTime: false,
                    themePreference: 'system',
                },
                profileLockState: state.profileLockState || {
                    isLocked: false,
                },
            };

            set(normalizedState);

            await this.loadChats();

            if (typeof window !== 'undefined') {
                setInterval(() => {
                    this.cleanupStaleConnections();
                }, 30000);
            }
        },

        async loadChats() {
            try {
                const chats = await chatStorage.getAllChats();
                setChats(chats);
                // Prune expired messages across all chats (messages carry their own autoDeleteAfter)
                for (const chat of chats) {
                    this.pruneExpiredMessages(chat.id);
                }
            } catch (error) {
                debug.error('Failed to load chats:', error);
                setChats([]);
            }
        },

        async save() {
            const state = await new Promise<AppState>((resolve) => {
                subscribe(resolve)();
            });

            // Convert Maps and Sets for JSON serialization
            const serializableState = {
                ...state,
                usedUUIDs: Array.from(state.usedUUIDs),
                peerConnections: Object.fromEntries(state.peerConnections),
            };

            await storage.saveAppState(serializableState as any);
        },

        async addChat(name: string, key: string) {
            try {
                const existingChats = await chatStorage.getAllChats();
                const existingChat = existingChats.find((chat) => chat.name === name);

                if (existingChat) {
                    debug.log(`Chat with name "${name}" already exists, using existing chat`);
                    update((state) => ({
                        ...state,
                        currentChatId: existingChat.id,
                        isFirstTime: false,
                    }));

                    await this.loadChats();

                    await this.save();

                    throw new Error(`Chat "${name}" already exists`);
                }

                if (secureKeyManager.isSessionLocked()) {
                    throw new Error(
                        'Please unlock your session with your passphrase before creating a chat'
                    );
                }

                const newChat = await chatStorage.createChat(name, key);

                update((state) => ({
                    ...state,
                    currentChatId: newChat.id,
                    isFirstTime: false,
                }));

                await this.loadChats();

                await this.save();
            } catch (error) {
                debug.error('Failed to add chat:', error);
                throw error;
            }
        },

        async updateChat(chatId: string, updates: { name?: string }): Promise<void> {
            try {
                const { dataStorage } = await import('../utils/indexeddb-storage');
                await dataStorage.updateChat(chatId, updates);

                updateChats((chats) =>
                    chats.map((chat) => (chat.id === chatId ? { ...chat, ...updates } : chat))
                );

                debug.log(`Chat ${chatId} updated successfully`, updates);
            } catch (error) {
                debug.error('Failed to update chat:', error);
                throw error;
            }
        },

        async updateChatProfile(
            chatId: string,
            profileData: { name?: string; contacts?: ContactMethod[]; createdAt: number }
        ): Promise<void> {
            try {
                const sharedProfile = {
                    name: profileData.name,
                    contacts: profileData.contacts,
                    createdAt: profileData.createdAt,
                };

                const { dataStorage } = await import('../utils/indexeddb-storage');
                await dataStorage.updateChat(chatId, { sharedProfile });

                updateChats((chats) =>
                    chats.map((chat) => (chat.id === chatId ? { ...chat, sharedProfile } : chat))
                );

                debug.log(`Chat ${chatId} profile updated successfully:`, sharedProfile);
            } catch (error) {
                debug.error('Failed to update chat profile:', error);
                throw error;
            }
        },

        async addMessage(chatId: string, message: StoredMessage) {
            try {
                // Stamp per-message autoDeleteAfter from the chat's current setting
                let stampedMessage = message;
                await new Promise<void>((resolve) => {
                    const unsub = subscribeChats((chats) => {
                        const chat = chats.find((c) => c.id === chatId);
                        if (chat?.autoDeleteAfter) {
                            stampedMessage = { ...message, autoDeleteAfter: chat.autoDeleteAfter };
                        }
                        resolve();
                    });
                    unsub();
                });

                await chatStorage.addMessage(chatId, stampedMessage);

                const messageStore = messageStoreRegistry.getStore(chatId);
                messageStore.addMessage(stampedMessage);
                messageSearch.invalidateChat(chatId);

                debug.log('Store addMessage: saved to IndexedDB and updated message store', {
                    chatId,
                    messageId: message.id,
                });

                updateChats((chats) =>
                    chats.map((conv) =>
                        conv.id === chatId ? { ...conv, lastActivity: Date.now() } : conv
                    )
                );

                if (stampedMessage.autoDeleteAfter) {
                    scheduleNextPrune(chatId);
                }
            } catch (error) {
                debug.error('Failed to add message:', error);
                throw error;
            }
        },

        removeMessage(chatId: string, messageId: string) {
            try {
                const messageStore = messageStoreRegistry.getStore(chatId);
                messageStore.removeMessage(messageId);
                messageSearch.invalidateChat(chatId);

                debug.log('Store removeMessage: removed from message store cache', {
                    chatId,
                    messageId,
                });
            } catch (error) {
                debug.error('Failed to remove message from store:', error);
                throw error;
            }
        },

        async applyReaction(
            chatId: string,
            targetRemoteUuid: string,
            reaction: 'laugh' | 'heart' | '100',
            reactedBy?: string
        ): Promise<boolean> {
            try {
                const { dataStorage } = await import('../utils/indexeddb-storage');
                const messageStore = messageStoreRegistry.getStore(chatId);
                const stored = await dataStorage.getMessagesByChat(chatId);
                const target = stored.find(
                    (m: any) => (m as any).remoteUuid && (m as any).remoteUuid === targetRemoteUuid
                );
                if (!target) {
                    debug.warn(
                        `Reaction target not found in chat ${chatId} for remoteUuid ${targetRemoteUuid}`
                    );
                    return false;
                }

                messageStore.updateMessageReaction(target.id, reaction, reactedBy);

                const updated: any = { ...target, reaction, reactionBy: reactedBy };
                await dataStorage.storeMessage(updated);
                return true;
            } catch (err) {
                debug.error('Failed to apply reaction:', err);
                return false;
            }
        },

        async applyReactionToLastOwn(
            chatId: string,
            reaction: 'laugh' | 'heart' | '100',
            reactedBy?: string
        ): Promise<boolean> {
            try {
                const { dataStorage } = await import('../utils/indexeddb-storage');
                const messageStore = messageStoreRegistry.getStore(chatId);

                const stored = await dataStorage.getMessagesByChat(chatId);
                let target: any | undefined;
                for (let i = stored.length - 1; i >= 0; i--) {
                    if (stored[i].isOwn) {
                        target = stored[i];
                        break;
                    }
                }
                if (!target) return false;

                messageStore.updateMessageReaction(target.id, reaction, reactedBy);

                const updated: any = { ...target, reaction, reactionBy: reactedBy };
                await dataStorage.storeMessage(updated);
                return true;
            } catch (err) {
                debug.error('Failed to apply reaction to last own message:', err);
                return false;
            }
        },

        async applyReactionByMessageId(
            chatId: string,
            messageId: string,
            reaction: 'laugh' | 'heart' | '100' | null,
            reactedBy?: string
        ): Promise<boolean> {
            try {
                const { dataStorage } = await import('../utils/indexeddb-storage');
                const messageStore = messageStoreRegistry.getStore(chatId);

                // Update UI in-place to avoid flicker
                messageStore.updateMessageReaction(messageId, reaction, reactedBy);

                const stored = await dataStorage.getMessagesByChat(chatId);
                const target = stored.find((m: any) => m.id === messageId);
                if (!target) return false;
                const updated: any = { ...target };
                if (reaction == null) {
                    delete updated.reaction;
                    delete updated.reactionBy;
                } else {
                    updated.reaction = reaction;
                    updated.reactionBy = reactedBy;
                }
                await dataStorage.storeMessage(updated);
                return true;
            } catch (err) {
                debug.error('Failed to apply reaction by message ID:', err);
                return false;
            }
        },

        setCurrentChat(id: string | null) {
            update((state) => ({
                ...state,
                currentChatId: id,
            }));
            if (id) {
                this.pruneExpiredMessages(id).then(() => scheduleNextPrune(id));
            }
        },

        markUUIDAsUsed(uuid: string) {
            storage.saveUsedUUID(uuid);
            update((state) => ({
                ...state,
                usedUUIDs: new Set([...state.usedUUIDs, uuid]),
            }));
        },

        isUUIDUsed(uuid: string): boolean {
            return storage.isUUIDUsed(uuid);
        },

        // True when the given message UUID belongs to one of our own sent messages in this
        // chat. Lets the share-code paste path tell "I pasted my own code" apart from a
        // genuine peer duplicate (both look identical to isUUIDUsed). remoteUuid/isOwn are
        // plaintext metadata, so this needs no body decryption.
        async isOwnSentUUID(chatId: string, uuid: string): Promise<boolean> {
            try {
                const { dataStorage } = await import('../utils/indexeddb-storage');
                const stored = await dataStorage.getMessagesByChat(chatId);
                return stored.some((m) => m.remoteUuid === uuid && m.isOwn === true);
            } catch {
                return false;
            }
        },

        async deleteChat(id: string) {
            debug.log('[DEBUG] Deleting chat:', id);

            try {
                await chatStorage.deleteChat(id);
                debug.log('[DEBUG] Deleted chat from IndexedDB:', id);
            } catch (error) {
                debug.error('Failed to delete chat:', error);
            }

            const manager = webrtcManagers.get(id);
            if (manager) {
                debug.log('[DEBUG] Disconnecting WebRTC manager during chat deletion');
                manager.disconnect();
                webrtcManagers.delete(id);
            }

            update((state) => {
                // Ensure peerConnections is a Map
                const existingConnections =
                    state.peerConnections instanceof Map
                        ? state.peerConnections
                        : new Map<string, PeerConnection>(
                              Object.entries(state.peerConnections || {}).map(([k, v]) => [
                                  k,
                                  v as PeerConnection,
                              ])
                          );
                const newPeerConnections = new Map<string, PeerConnection>(existingConnections);
                newPeerConnections.delete(id);

                return {
                    ...state,
                    currentChatId: state.currentChatId === id ? null : state.currentChatId,
                    peerConnections: newPeerConnections,
                };
            });

            await this.loadChats();

            await this.save();
        },

        async clearChat(id: string) {
            // Delete all messages from IndexedDB (keep chat record + key)
            await chatStorage.clearChatMessages(id);

            // Refresh the in-memory message store so the UI empties
            const messageStore = messageStoreRegistry.getStore(id);
            await messageStore.refresh();
            messageSearch.invalidateChat(id);
        },

        async setAutoDelete(chatId: string, duration: number | null): Promise<void> {
            const { dataStorage } = await import('../utils/indexeddb-storage');
            await dataStorage.updateChat(chatId, { autoDeleteAfter: duration });

            updateChats((chats) =>
                chats.map((chat) =>
                    chat.id === chatId ? { ...chat, autoDeleteAfter: duration } : chat
                )
            );
        },

        async pruneExpiredMessages(chatId: string): Promise<void> {
            const deleted = await chatStorage.deleteExpiredMessages(chatId);
            if (deleted > 0) {
                const messageStore = messageStoreRegistry.getStore(chatId);
                await messageStore.refresh();
                messageSearch.invalidateChat(chatId);
            }
        },

        async deleteConnectionData(chatId: string): Promise<void> {
            debug.log('Deleting connection data for chat:', chatId);

            this.disconnectWebRTC(chatId);
        },

        async initWebRTC(chatId: string, options?: { localOnly?: boolean }): Promise<string> {
            debug.log('[DEBUG] Initializing WebRTC for chat:', chatId);

            // Get chat from IndexedDB (without messages for efficiency)
            const chat = await chatStorage.getChat(chatId);

            if (!chat) {
                throw new Error('Chat not found');
            }

            debug.log('[DEBUG] Getting key from memory for chat:', chat.name);

            let chatKey = secureKeyManager.getConversationKey(chatId);
            if (!chatKey) {
                try {
                    chatKey = await secureKeyManager.unwrapConversationKey(chatId);
                } catch (error) {
                    throw new Error('Failed to unwrap conversation key');
                }
            }

            // Replacing a live manager (e.g. generating a second connection code while already
            // connected) used to orphan it: the old one kept its state callback and went on
            // reporting 'connected' for this chat, while every send routed to the new manager's
            // null data channel. Tear it down first so the store tracks the manager in use.
            const existing = webrtcManagers.get(chatId);
            if (existing) {
                debug.log('[DEBUG] Disconnecting existing WebRTC manager before replacing it');
                existing.disconnect();
                webrtcManagers.delete(chatId);
            }

            debug.log('[DEBUG] Creating WebRTC manager');
            const manager = new WebRTCManager(
                chatId,
                chatKey,
                (state) => this.updatePeerConnectionState(chatId, state),
                (payload) =>
                    this.handleRealTimeMessage(chatId, payload.message, payload.from, payload.uuid),
                (callData) => this.handleCallReceived(chatId, callData),
                (callId, state) => this.handleCallStateChanged(callId, state),
                (stream) => this.handleRemoteStreamReceived(chatId, stream),
                (emoji, target) => this.handleRealTimeReaction(chatId, emoji, target),
                (target) => this.handleRealTimeDelete(chatId, target),
                (isTyping) => this.handleRealTimeTyping(chatId, isTyping)
            );

            // The guided tutorial connects to a local stand-in, so it skips STUN entirely and
            // contacts no server. Real chats use the public STUN servers for NAT traversal.
            manager.localOnly = options?.localOnly ?? false;

            webrtcManagers.set(chatId, manager);
            debug.log('[DEBUG] WebRTC manager created and stored');

            const offer = await manager.createOffer();
            debug.log('[DEBUG] WebRTC offer created, length:', offer.length);

            // Don't save connection credentials immediately - wait for successful connection

            return offer;
        },

        async handleWebRTCOffer(
            encryptedOffer: string,
            onChatIdentified?: (chatId: string) => void
        ): Promise<{ chatId: string; answer: string }> {
            const chats = await chatStorage.getAllChats();

            debug.log('[DEBUG] Trying to decrypt WebRTC offer with', chats.length, 'chats');
            debug.log('[DEBUG] Chat storage unlocked:', chatStorage.isUnlocked());
            debug.log(
                '[DEBUG] SecureKeyManager session locked:',
                secureKeyManager.isSessionLocked()
            );

            if (chats.length === 0) {
                throw new Error(
                    'No chats available. You need to create a chat first before you can connect to someone.'
                );
            }

            if (secureKeyManager.isSessionLocked()) {
                throw new Error(
                    'Session is locked. Please unlock your chat storage first, then try the connection code again.'
                );
            }

            // Try to decrypt the offer with each chat's key
            for (const chat of chats) {
                debug.log(`[DEBUG] Attempting chat "${chat.name}" (${chat.id})`);
                try {
                    let chatKey = secureKeyManager.getConversationKey(chat.id);
                    if (!chatKey) {
                        debug.log(`[DEBUG] Key not in memory for ${chat.id}, attempting unwrap`);
                        try {
                            chatKey = await secureKeyManager.unwrapConversationKey(chat.id);
                            debug.log(`[DEBUG] Successfully unwrapped key for ${chat.id}`);
                        } catch (error) {
                            debug.log(
                                `[DEBUG] Failed to unwrap key for chat ${chat.id}:`,
                                error instanceof Error ? error.message : error
                            );
                            continue;
                        }
                        if (!chatKey) {
                            debug.log(`[DEBUG] Key not available for chat ${chat.id}, skipping`);
                            continue;
                        }
                    } else {
                        debug.log(`[DEBUG] Found key in memory for ${chat.id}`);
                    }

                    const manager = new WebRTCManager(
                        chat.id,
                        chatKey,
                        (state) => this.updatePeerConnectionState(chat.id, state),
                        (payload) =>
                            this.handleRealTimeMessage(
                                chat.id,
                                payload.message,
                                payload.from,
                                payload.uuid
                            ),
                        (callData) => this.handleCallReceived(chat.id, callData),
                        (callId, state) => this.handleCallStateChanged(callId, state),
                        (stream) => this.handleRemoteStreamReceived(chat.id, stream),
                        (emoji, target) => this.handleRealTimeReaction(chat.id, emoji, target),
                        (target) => this.handleRealTimeDelete(chat.id, target),
                        (isTyping) => this.handleRealTimeTyping(chat.id, isTyping)
                    );

                    // Try to handle the offer - this will throw if decryption fails.
                    // The callback fires once the chat is identified (offer decrypted),
                    // before ICE gathering, so the UI can show progress in the meantime.
                    const answer = await manager.handleOffer(encryptedOffer, () =>
                        onChatIdentified?.(chat.id)
                    );

                    // Same orphan risk as initWebRTC, but only once this chat is confirmed to be
                    // the offer's target: disconnecting during a failed decrypt attempt would kill
                    // a live connection belonging to an unrelated chat.
                    const previous = webrtcManagers.get(chat.id);
                    if (previous && previous !== manager) {
                        previous.disconnect();
                    }

                    webrtcManagers.set(chat.id, manager);
                    // disconnect() above reports DISCONNECTED for this chat, so re-assert the state
                    // of the manager actually in use rather than letting the UI latch that value.
                    this.updatePeerConnectionState(chat.id, manager.getConnectionState());
                    debug.log('Successfully processed WebRTC offer for chat:', chat.id);

                    // Don't save connection credentials immediately - wait for successful connection

                    return { chatId: chat.id, answer };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    debug.log(`Failed to process WebRTC offer with chat ${chat.id}:`, errorMessage);
                    continue;
                }
            }

            throw new Error(
                `Unable to decrypt WebRTC offer with any available chat key. This usually means:\n\n` +
                    `1. You and the sender don't have a chat with the same shared encryption key\n` +
                    `2. You need to create a chat with the same key as the sender first\n` +
                    `3. The sender should share their chat's encryption key with you offline\n\n` +
                    `WebRTC connections only work between people who have already established a shared encryption key.`
            );
        },

        async handleWebRTCAnswer(chatId: string, encryptedAnswer: string): Promise<void> {
            debug.log('[DEBUG] Handling WebRTC answer for chat:', chatId);

            let manager = webrtcManagers.get(chatId);
            if (!manager) {
                debug.error('[MANAGER DEBUG] Manager lookup failed! Attempting recovery...');

                try {
                    debug.log('[DEBUG] Attempting to recreate WebRTC manager...');
                    // Get chat from IndexedDB (without messages for efficiency)
                    const chat = await chatStorage.getChat(chatId);
                    if (!chat) {
                        throw new Error(`Chat ${chatId} not found for manager recovery`);
                    }

                    debug.log('[DEBUG] Getting key from memory for manager recovery...');
                    let chatKey = secureKeyManager.getConversationKey(chatId);
                    if (!chatKey) {
                        try {
                            chatKey = await secureKeyManager.unwrapConversationKey(chatId);
                        } catch (error) {
                            throw new Error('Failed to unwrap chat key for manager recovery');
                        }
                    }

                    manager = new WebRTCManager(
                        chatId,
                        chatKey,
                        (state) => this.updatePeerConnectionState(chatId, state),
                        (payload) =>
                            this.handleRealTimeMessage(
                                chatId,
                                payload.message,
                                payload.from,
                                payload.uuid
                            ),
                        (callData) => this.handleCallReceived(chatId, callData),
                        (callId, state) => this.handleCallStateChanged(callId, state),
                        (stream) => this.handleRemoteStreamReceived(chatId, stream),
                        (emoji, target) => this.handleRealTimeReaction(chatId, emoji, target),
                        (target) => this.handleRealTimeDelete(chatId, target),
                        (isTyping) => this.handleRealTimeTyping(chatId, isTyping)
                    );

                    webrtcManagers.set(chatId, manager);
                    debug.log('[DEBUG] WebRTC manager successfully recreated');
                } catch (error) {
                    debug.error('[DEBUG] Manager recovery failed:', error);
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    throw new Error(
                        `WebRTC manager not found for chat ${chatId} and recovery failed: ${errorMessage}. Available: ${Array.from(webrtcManagers.keys()).join(', ')}`
                    );
                }
            }

            debug.log('[DEBUG] Found WebRTC manager, processing answer...');
            await manager.handleAnswer(encryptedAnswer);
        },

        async sendRealTimeMessage(
            chatId: string,
            message: string,
            from: string
        ): Promise<{ ok: boolean; remoteUuid?: string }> {
            const manager = webrtcManagers.get(chatId);
            if (!manager || !manager.isReadyForMessaging()) {
                debug.log('Real-time messaging not available, using URL fallback');
                return { ok: false }; // Fall back to URL-based messaging
            }

            try {
                const remoteUuid = generateUUID();
                await manager.sendMessage(message, from, remoteUuid);
                debug.log('Real-time message sent successfully');
                return { ok: true, remoteUuid };
            } catch (error) {
                debug.error('Failed to send real-time message:', error);
                return { ok: false };
            }
        },

        async sendTypingStatus(chatId: string, isTyping: boolean): Promise<boolean> {
            const manager = webrtcManagers.get(chatId);
            if (!manager || !manager.isReadyForMessaging()) {
                return false;
            }

            try {
                await manager.sendTyping(isTyping);
                return true;
            } catch (error) {
                debug.error('Failed to send typing status:', error);
                return false;
            }
        },

        async sendRealTimeReaction(
            chatId: string,
            emoji: 'laugh' | 'heart' | '100',
            targetRemoteUuid?: string
        ): Promise<boolean> {
            const manager = webrtcManagers.get(chatId);
            if (!manager || !manager.isReadyForMessaging()) {
                return false;
            }
            try {
                await manager.sendReaction(emoji, targetRemoteUuid);
                return true;
            } catch (error) {
                debug.error('Failed to send real-time reaction:', error);
                return false;
            }
        },

        async sendRealTimeReactionClear(
            chatId: string,
            targetRemoteUuid?: string
        ): Promise<boolean> {
            const manager = webrtcManagers.get(chatId);
            if (!manager || !manager.isReadyForMessaging()) {
                return false;
            }
            try {
                await manager.sendReactionClear(targetRemoteUuid);
                return true;
            } catch (error) {
                debug.error('Failed to send real-time reaction clear:', error);
                return false;
            }
        },

        async sendRealTimeDelete(chatId: string, targetRemoteUuid: string): Promise<boolean> {
            const manager = webrtcManagers.get(chatId);
            if (!manager || !manager.isReadyForMessaging()) {
                return false;
            }
            try {
                await manager.sendDelete(targetRemoteUuid);
                return true;
            } catch (error) {
                debug.error('Failed to send real-time delete request:', error);
                return false;
            }
        },

        async disconnectWebRTC(chatId: string, graceful: boolean = false): Promise<void> {
            debug.log('[DEBUG] Disconnecting WebRTC for chat:', chatId);
            const manager = webrtcManagers.get(chatId);
            if (manager) {
                if (graceful && manager.getConnectionState() === ConnectionState.CONNECTED) {
                    await manager.disconnectGracefully('user');
                } else {
                    manager.disconnect();
                }
                webrtcManagers.delete(chatId);
                debug.log('[DEBUG] WebRTC disconnected and manager removed');
            } else {
                debug.log('[DEBUG] No WebRTC manager found to disconnect');
            }

            this.updatePeerConnectionState(chatId, ConnectionState.DISCONNECTED);
        },

        getPeerConnectionState(
            chatId: string
        ): 'disconnected' | 'connecting' | 'connected' | 'failed' {
            const manager = webrtcManagers.get(chatId);
            if (!manager) {
                return 'disconnected';
            }

            const state = manager.getConnectionState();
            const mappedState = (() => {
                switch (state) {
                    case ConnectionState.DISCONNECTED:
                        return 'disconnected';
                    case ConnectionState.CONNECTING:
                        return 'connecting';
                    case ConnectionState.CONNECTED:
                        return 'connected';
                    case ConnectionState.FAILED:
                        return 'failed';
                    default:
                        return 'disconnected';
                }
            })();

            return mappedState;
        },

        canRetryConnection(chatId: string): boolean {
            const manager = webrtcManagers.get(chatId);
            return manager ? manager.canRetry() : false;
        },

        getRemainingRetries(chatId: string): number {
            const manager = webrtcManagers.get(chatId);
            if (!manager) return 0;
            // retryCount/maxRetries are internal to the manager; read them directly so the
            // UI can show how many attempts remain.
            const retryCount = (manager as any).retryCount || 0;
            const maxRetries = (manager as any).maxRetries || 3;
            return Math.max(0, maxRetries - retryCount);
        },

        retryConnection(chatId: string): void {
            const manager = webrtcManagers.get(chatId);
            if (manager) {
                manager.retry();
            }
        },

        updatePeerConnectionState(chatId: string, state: ConnectionState) {
            update((appState) => {
                // Ensure peerConnections is a Map (handle loading from localStorage)
                const existingConnections =
                    appState.peerConnections instanceof Map
                        ? appState.peerConnections
                        : new Map<string, PeerConnection>(
                              Object.entries(appState.peerConnections || {}).map(([k, v]) => [
                                  k,
                                  v as PeerConnection,
                              ])
                          );

                const newPeerConnections = new Map<string, PeerConnection>(existingConnections);
                const currentConnection = newPeerConnections.get(chatId) as
                    | PeerConnection
                    | undefined;

                const peerState: 'disconnected' | 'connecting' | 'connected' | 'failed' =
                    state === ConnectionState.DISCONNECTED
                        ? 'disconnected'
                        : state === ConnectionState.CONNECTING
                          ? 'connecting'
                          : state === ConnectionState.CONNECTED
                            ? 'connected'
                            : 'failed';

                if (currentConnection?.state !== peerState) {
                    // For logging, we could fetch chat name from IndexedDB, but skip for performance
                    debug.log(
                        `Chat ${chatId}: ${currentConnection?.state || 'unknown'} → ${peerState}`
                    );
                }

                newPeerConnections.set(chatId, {
                    chatId,
                    state: peerState,
                    lastSeen:
                        peerState === 'connected'
                            ? Date.now()
                            : currentConnection?.lastSeen || null,
                });

                if (peerState === 'connected') {
                    // Stop persistent offers when connected
                } else {
                    setPeerTypingStatusInternal(chatId, false);
                }

                return {
                    ...appState,
                    peerConnections: newPeerConnections,
                };
            });
        },

        // Clean up stale connections that are marked as connected but don't have active managers
        cleanupStaleConnections() {
            update((state) => {
                const newPeerConnections = new Map(state.peerConnections);
                let cleanedCount = 0;

                for (const [chatId, connection] of newPeerConnections.entries()) {
                    if (connection.state === 'connected') {
                        const manager = webrtcManagers.get(chatId);
                        const managerState = manager?.getConnectionState();

                        if (!manager || managerState !== ConnectionState.CONNECTED) {
                            debug.log(
                                `Cleaning up stale connection for ${chatId}: manager=${!!manager}, state=${managerState}`
                            );
                            newPeerConnections.set(chatId, {
                                ...connection,
                                state: 'disconnected',
                                lastSeen: connection.lastSeen,
                            });
                            cleanedCount++;
                        }
                    }
                }

                if (cleanedCount > 0) {
                    debug.log(`Cleaned up ${cleanedCount} stale connection(s)`);
                    return {
                        ...state,
                        peerConnections: newPeerConnections,
                    };
                }

                return state;
            });
        },

        handleRealTimeMessage(chatId: string, message: string, from: string, remoteUuid?: string) {
            const storedMessage: StoredMessage = {
                id: generateUUID(),
                from,
                body: message,
                timestamp: Date.now(),
                isOwn: false, // Real-time messages are always from the peer
                deliveryMethod: 'online',
                remoteUuid,
            };

            this.addMessage(chatId, storedMessage);
        },

        handleRealTimeTyping(chatId: string, isTyping: boolean) {
            setPeerTypingStatusInternal(chatId, isTyping);
        },

        async handleRealTimeReaction(
            chatId: string,
            emoji: string | null,
            targetRemoteUuid?: string
        ) {
            if (emoji === null) {
                // Clear reaction on target or last-own
                const { dataStorage } = await import('../utils/indexeddb-storage');
                const stored = await dataStorage.getMessagesByChat(chatId);
                let targetMsg: any | undefined;
                if (targetRemoteUuid) {
                    targetMsg = stored.find((m: any) => (m as any).remoteUuid === targetRemoteUuid);
                } else {
                    for (let i = stored.length - 1; i >= 0; i--) {
                        if (stored[i].isOwn) {
                            targetMsg = stored[i];
                            break;
                        }
                    }
                }
                if (!targetMsg) return;
                const messageStore = messageStoreRegistry.getStore(chatId);
                messageStore.updateMessageReaction(targetMsg.id, null, undefined);
                const updated: any = { ...targetMsg };
                delete updated.reaction;
                delete updated.reactionBy;
                await dataStorage.storeMessage(updated);
                return;
            }
            if (emoji !== 'laugh' && emoji !== 'heart' && emoji !== '100') return;
            const peerName = get(chatsStore).find((c) => c.id === chatId)?.name || 'Peer';
            if (targetRemoteUuid) {
                await this.applyReaction(chatId, targetRemoteUuid, emoji as any, peerName);
            } else {
                await this.applyReactionToLastOwn(chatId, emoji as any, peerName);
            }
        },

        async handleRealTimeDelete(chatId: string, targetRemoteUuid: string) {
            if (!targetRemoteUuid) {
                return;
            }

            try {
                const { dataStorage } = await import('../utils/indexeddb-storage');
                const storedMessages = await dataStorage.getMessagesByChat(chatId);
                const target = storedMessages.find(
                    (msg: any) => (msg as any).remoteUuid === targetRemoteUuid
                );

                if (!target) {
                    debug.warn(`Real-time delete request received but target message not found`, {
                        chatId,
                        targetRemoteUuid,
                    });
                    return;
                }

                await chatStorage.deleteMessage(target.id);
                this.removeMessage(chatId, target.id);
            } catch (error) {
                debug.error('Failed to handle real-time delete:', error);
            }
        },

        // Record a call event (declined / missed / cancelled) as a system line in the chat.
        async addCallEventMessage(chatId: string, info: CallEventInfo): Promise<void> {
            const message: StoredMessage = {
                id: generateUUID(),
                from: '',
                timestamp: Date.now(),
                isOwn: info.direction === 'outgoing',
                deliveryMethod: 'online',
                callEvent: info,
            };
            await this.addMessage(chatId, message);
        },

        async handleCallReceived(chatId: string, callData: CallSignalData) {
            try {
                const chat = await chatStorage.getChat(chatId);
                const contactName = chat?.name || 'Unknown';

                // Import callStore dynamically to avoid circular imports
                const { callStore } = await import('./call-store');
                callStore.handleCallSignal(callData, contactName, chatId);
            } catch (error) {
                debug.error('AppStore: Failed to handle call signal:', error);
            }
        },

        async handleCallStateChanged(callId: string, state: string) {
            // The call store handles state changes internally
        },

        async handleRemoteStreamReceived(chatId: string, stream: MediaStream) {
            debug.log('AppStore: Remote stream received for chat:', chatId, stream);

            const { remoteStreams } = await import('./call-store');
            const { get } = await import('svelte/store');

            const currentStreams = new Map(get(remoteStreams));
            currentStreams.set(chatId, stream);
            remoteStreams.set(currentStreams);

            debug.log('AppStore: Remote stream stored for chat:', chatId);
        },

        async startCall(chatId: string, type: 'audio' | 'video'): Promise<void> {
            try {
                const chat = await chatStorage.getChat(chatId);
                if (!chat) {
                    throw new Error('Chat not found');
                }

                const manager = webrtcManagers.get(chatId);
                if (!manager) {
                    throw new Error('No WebRTC connection available. Please connect first.');
                }

                // The call button is gated on the peer-connection store, which can still read
                // 'connected' after the data channel has gone (an ICE drop, or a manager replaced
                // mid-session). Ask the manager itself before showing the caller a call UI that
                // cannot signal; ChatInterface treats this message as a connection error and
                // falls back to a call invitation.
                if (!manager.isReadyForMessaging()) {
                    throw new Error('WebRTC connection not established. Please reconnect.');
                }

                const { callStore } = await import('./call-store');
                const call = await callStore.startCall(chatId, chat.name, type);

                // Now start the actual WebRTC call. If this fails, the call object (and its
                // outgoing-call UI) already exists, so tear it down before rethrowing —
                // otherwise an orphaned call is left on screen while the caller falls back
                // (e.g. to a call invitation) on connection errors.
                try {
                    await manager.startCall(call.id, type);
                    if (type === 'video' && !manager.hasLocalVideo()) {
                        callStore.markCameraUnavailable(call.id);
                    }
                } catch (error) {
                    // Silent teardown: the call never rang, so don't log a "cancelled" event.
                    await callStore.endCall(call.id, { silent: true });
                    throw error;
                }
            } catch (error) {
                debug.error('AppStore: Failed to start call:', error);
                throw error;
            }
        },

        getMessageStore(chatId: string) {
            return messageStoreRegistry.getStore(chatId);
        },

        async refreshChatMessages(
            chatId: string,
            options: { decrypt?: boolean } = { decrypt: true }
        ) {
            const { decrypt = true } = options;
            const messageStore = this.getMessageStore(chatId);

            if (decrypt) {
                await messageStore.refreshAndDecrypt();
            } else {
                await messageStore.refresh();
            }
        },

        async lockApp() {
            secureKeyManager.lockSession();
            await messageStoreRegistry.clearAllStores();
            messageSearch.clearCache();

            for (const manager of webrtcManagers.values()) {
                manager.disconnect();
            }
            webrtcManagers.clear();

            debug.log('App locked - all sensitive data cleared from memory');
        },

        async unlockApp(password: string) {
            try {
                await secureKeyManager.unlockSession(password);
                debug.log('App unlocked - conversation keys available');

                // Reload chats to load wrapped keys now that session is unlocked
                await this.loadChats();

                await messageStoreRegistry.refreshAndDecryptAllStores();

                return true;
            } catch (error) {
                debug.error('Failed to unlock app:', error);
                return false;
            }
        },

        async hasSessionLockedMessages(chatId: string): Promise<boolean> {
            const messageStore = this.getMessageStore(chatId);
            const messages = get(messageStore);
            return messages.some((msg) => msg.body === '[Encrypted message - session locked]');
        },

        async getChatUnlockState(
            chatId: string
        ): Promise<'unlocked' | 'session_locked' | 'key_missing'> {
            const keyState = await secureKeyManager.getKeyAvailabilityState(chatId);
            switch (keyState) {
                case 'available':
                    return 'unlocked';
                case 'locked':
                    return 'session_locked';
                default:
                    return 'key_missing';
            }
        },

        isAppLocked(): boolean {
            return secureKeyManager.isSessionLocked();
        },

        getRemoteStream(chatId: string): MediaStream | null {
            const manager = webrtcManagers.get(chatId);
            if (!manager) {
                debug.warn('No WebRTC manager found for chat:', chatId);
                return null;
            }
            const stream = manager.getRemoteStream();
            debug.log('AppStore: getRemoteStream for chat', chatId, ':', stream);
            return stream;
        },

        getWebRTCManager(chatId: string): any {
            return webrtcManagers.get(chatId);
        },
    };
}

export const appStore = createAppStore();

export const chatsStore = writable<Chat[]>([]);

appStore.subscribeChats((chats) => {
    chatsStore.set(chats);
});

export const currentChat = derived([appStore, chatsStore], ([$appStore, $chats]) => {
    if (!$appStore.currentChatId) return null;

    const chat = $chats.find((conv) => conv.id === $appStore.currentChatId) || null;

    // Note: Messages will be loaded separately when needed by components
    // This keeps the derived store lightweight

    return chat;
});

export const sortedChats = derived(chatsStore, ($chats) =>
    [...$chats].sort((a, b) => b.lastActivity - a.lastActivity)
);
