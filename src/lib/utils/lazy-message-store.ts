import { writable, type Readable, type Writable } from 'svelte/store';
import { chatStorage } from './chat-storage';
import { dataStorage, type MessagePageCursor } from './indexeddb-storage';
import type { StoredMessage } from '../types';
import { secureKeyManager } from './secure-key-manager';
import { debug } from './debug';

// Messages loaded and decrypted per page: the newest page on open, one more per
// "load older" trigger. Anything not loaded stays encrypted in IndexedDB.
export const MESSAGE_PAGE_SIZE = 100;

// Larger pages while walking back to a jump target (search result deep in history),
// so the walk needs fewer round trips.
const JUMP_PAGE_SIZE = 500;

const PLACEHOLDER_BODIES = new Set([
    '[Encrypted]',
    '[Encrypted message - session locked]',
    '[Encrypted message - key not found]',
    '[Encrypted message - decryption failed]',
]);

const FINAL_PLACEHOLDERS = new Set(['[Message content unavailable]']);

function isPlaceholderBody(body: string | undefined | null): boolean {
    if (typeof body !== 'string') {
        return true;
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
        return true;
    }
    if (FINAL_PLACEHOLDERS.has(trimmed)) {
        return false;
    }
    return PLACEHOLDER_BODIES.has(trimmed);
}

async function manualDecryptBody(message: StoredMessage, chatId: string): Promise<string | null> {
    try {
        if (
            !(message.encryptedBody instanceof ArrayBuffer) ||
            !(message.iv instanceof ArrayBuffer)
        ) {
            return null;
        }

        if (message.storedWithDWK) {
            if (!secureKeyManager.hasDWK()) return null;
            const decrypted = await secureKeyManager.decryptWithDWK(
                message.encryptedBody,
                message.iv
            );
            return new TextDecoder().decode(decrypted);
        }

        // Legacy: encrypted with conversation key
        const keyState = await secureKeyManager.getKeyAvailabilityState(chatId);
        if (keyState !== 'available') {
            return null;
        }

        const cipherBytes = new Uint8Array(message.encryptedBody);
        const ivBytes = new Uint8Array(message.iv);
        const payload = {
            v: 1,
            keyId: chatId,
            c: Array.from(cipherBytes),
            n: Array.from(ivBytes),
            ts: message.timestamp || Date.now(),
        } as const;

        const decrypted = await secureKeyManager.openSharePayload(payload);
        return new TextDecoder().decode(decrypted);
    } catch (error) {
        return null;
    }
}

export interface MessagePagingState {
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
}

export class LazyMessageStore {
    private chatId: string;
    private messageStore: Writable<StoredMessage[]> = writable([]);
    // Ascending by timestamp; always the newest suffix of the chat's history.
    private loadedMessages: StoredMessage[] = [];
    private hasMoreOlder = false;
    private isLoadingOlder = false;
    private subscriberCount = 0;
    // Bumped by resetToLatestPage; in-flight ensureMessageLoaded walks abort when it
    // changes, so an orphaned deep-history walk cannot regrow a just-reset window.
    private resetGeneration = 0;
    private lastAccessTime: number = Date.now();
    private pagingStore: Writable<MessagePagingState> = writable({
        hasMoreOlder: false,
        isLoadingOlder: false,
    });
    // Resolves when the constructor's initial load has settled. addMessage awaits this so a
    // message added immediately after the store is created cannot race the load's array assignment.
    private initialLoadPromise: Promise<void>;

    constructor(chatId: string) {
        this.chatId = chatId;
        this.initialLoadPromise = this.loadInitialMessages();
    }

    /**
     * Load the newest page of messages from storage (decrypted when the session allows).
     */
    private async loadInitialMessages(limit: number = MESSAGE_PAGE_SIZE) {
        try {
            const page = await chatStorage.getMessagesPaged(this.chatId, { limit });
            this.loadedMessages = await this.resolvePlaceholders(page.messages);
            this.hasMoreOlder = page.hasMore;
            this.emit();
        } catch (error) {
            debug.error('Failed to load messages:', error);
            // Fallback: try to load raw messages from IndexedDB as placeholders
            // so messages are never silently wiped from the UI on a decryption error.
            try {
                const rawPage = await dataStorage.getMessagesByChatPaged(this.chatId, { limit });
                if (rawPage.messages.length > 0) {
                    this.loadedMessages = rawPage.messages.map((m) => ({
                        ...m,
                        body: m.body || '[Encrypted]',
                    }));
                    this.hasMoreOlder = rawPage.hasMore;
                    this.emit();
                    return;
                }
            } catch (fallbackError) {
                debug.error('Fallback message load also failed:', fallbackError);
            }
            // Only set empty if we truly have no data at all
            this.messageStore.set([]);
        }
    }

    /**
     * Retry placeholder bodies that still carry an encrypted payload (legacy-key records
     * that the bulk decrypt path could not open). Messages without any payload settle on
     * a final placeholder.
     */
    private async resolvePlaceholders(messages: StoredMessage[]): Promise<StoredMessage[]> {
        const resolved: StoredMessage[] = [];
        for (const message of messages) {
            if (!isPlaceholderBody(message.body)) {
                resolved.push(message);
                continue;
            }
            const hasPayload =
                message.encryptedBody instanceof ArrayBuffer && message.iv instanceof ArrayBuffer;
            if (!hasPayload) {
                resolved.push({ ...message, body: '[Message content unavailable]' });
                continue;
            }
            const manual = await manualDecryptBody(message, this.chatId);
            resolved.push(manual ? { ...message, body: manual } : message);
        }
        return resolved;
    }

    private emit() {
        this.messageStore.set([...this.loadedMessages]);
        this.pagingStore.set({
            hasMoreOlder: this.hasMoreOlder,
            isLoadingOlder: this.isLoadingOlder,
        });
        this.lastAccessTime = Date.now();
    }

    subscribe(callback: (messages: StoredMessage[]) => void) {
        this.subscriberCount++;
        this.lastAccessTime = Date.now();
        const unsubscribe = this.messageStore.subscribe(callback);
        let released = false;
        return () => {
            if (!released) {
                released = true;
                this.subscriberCount--;
            }
            unsubscribe();
        };
    }

    get paging(): Readable<MessagePagingState> {
        return { subscribe: this.pagingStore.subscribe };
    }

    /**
     * Load one more page of older messages before the current window.
     * Returns the number of messages prepended.
     */
    async loadOlder(limit: number = MESSAGE_PAGE_SIZE): Promise<number> {
        await this.initialLoadPromise;
        if (this.isLoadingOlder || !this.hasMoreOlder || this.loadedMessages.length === 0) {
            return 0;
        }

        this.isLoadingOlder = true;
        this.pagingStore.set({ hasMoreOlder: this.hasMoreOlder, isLoadingOlder: true });
        const generation = this.resetGeneration;

        try {
            const oldest = this.loadedMessages[0];
            const before: MessagePageCursor = { timestamp: oldest.timestamp, id: oldest.id };
            const page = await chatStorage.getMessagesPaged(this.chatId, { before, limit });
            const resolved = await this.resolvePlaceholders(page.messages);

            // The window was reset while this page was in flight (user re-entered the
            // chat); drop the fetched page instead of regrowing the fresh window.
            if (this.resetGeneration !== generation) {
                return 0;
            }

            const loadedIds = new Set(this.loadedMessages.map((m) => m.id));
            const fresh = resolved.filter((m) => !loadedIds.has(m.id));

            this.hasMoreOlder = page.hasMore;
            if (fresh.length > 0) {
                this.loadedMessages = [...fresh, ...this.loadedMessages];
            }
            return fresh.length;
        } catch (error) {
            debug.warn('Failed to load older messages:', error);
            return 0;
        } finally {
            this.isLoadingOlder = false;
            this.emit();
        }
    }

    /**
     * Make sure a specific message is inside the loaded window (for jump-to-message
     * from search results). Walks older pages until the message is loaded.
     * Returns false if the message does not exist in this chat.
     */
    async ensureMessageLoaded(messageId: string): Promise<boolean> {
        await this.initialLoadPromise;
        if (this.loadedMessages.some((m) => m.id === messageId)) {
            return true;
        }

        const record = await dataStorage.getMessageById(messageId);
        if (!record || record.chatId !== this.chatId) {
            return false;
        }

        const generation = this.resetGeneration;
        while (
            this.resetGeneration === generation &&
            this.hasMoreOlder &&
            !this.loadedMessages.some((m) => m.id === messageId)
        ) {
            const added = await this.loadOlder(JUMP_PAGE_SIZE);
            if (added === 0) {
                if (this.isLoadingOlder) {
                    // Another loadOlder is in flight; let it settle before looping again.
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    continue;
                }
                // No progress and nothing in flight: bail rather than spin.
                break;
            }
        }

        return this.loadedMessages.some((m) => m.id === messageId);
    }

    /**
     * Shrink the loaded window back to the newest page. Called on chat entry: a deep
     * search jump can leave thousands of messages loaded, and re-rendering all of
     * them on the next visit is exactly the cost paging exists to avoid. Purely an
     * in-memory slice; the messages stay in storage and load again on scroll-up.
     */
    resetToLatestPage() {
        this.resetGeneration++; // abort any in-flight deep-history walk
        if (this.loadedMessages.length > MESSAGE_PAGE_SIZE) {
            this.loadedMessages = this.loadedMessages.slice(-MESSAGE_PAGE_SIZE);
            this.hasMoreOlder = true; // we just dropped older loaded messages
            this.emit();
        }
    }

    /**
     * Reload the current window only if it still shows locked/undecrypted placeholders
     * and the session can now decrypt them. Cheap no-op in the common case; replaces
     * the old unconditional full refresh on chat open.
     */
    async ensureDecrypted(): Promise<void> {
        await this.initialLoadPromise;
        const hasRetryablePlaceholders = this.loadedMessages.some((m) => isPlaceholderBody(m.body));
        if (hasRetryablePlaceholders && chatStorage.isUnlocked()) {
            await this.reloadWindow();
        }
    }

    /**
     * Reload from storage, preserving the currently loaded window depth so a
     * scrolled-up reader does not lose their place.
     */
    private async reloadWindow(): Promise<void> {
        await this.loadInitialMessages(Math.max(MESSAGE_PAGE_SIZE, this.loadedMessages.length));
    }

    /**
     * Add a new message (already decrypted from real-time sources)
     */
    async addMessage(message: StoredMessage) {
        // Let the constructor's initial load finish first, so a message added right after the
        // store is created lands on top of the loaded array rather than racing its assignment.
        await this.initialLoadPromise;
        // Guard against double-insertion: the initial load assigns loadedMessages from storage,
        // which already contains a just-persisted message. Without this check that produces a
        // duplicate entry and crashes the keyed {#each} in the message list.
        if (this.loadedMessages.some((m) => m.id === message.id)) {
            return;
        }
        this.loadedMessages.push(message);
        this.emit();
    }

    /**
     * Update reaction fields for a specific message by ID (in-place, no reload)
     */
    updateMessageReaction(
        messageId: string,
        reaction: 'laugh' | 'heart' | '100' | null,
        reactionBy?: string
    ) {
        let changed = false;
        this.loadedMessages = this.loadedMessages.map((m) => {
            if (m.id === messageId) {
                changed = true;
                return { ...m, reaction: reaction ?? undefined, reactionBy } as StoredMessage;
            }
            return m;
        });
        if (changed) {
            this.emit();
        }
    }

    removeMessage(messageId: string) {
        const initialLength = this.loadedMessages.length;
        this.loadedMessages = this.loadedMessages.filter((msg) => msg.id !== messageId);

        if (this.loadedMessages.length !== initialLength) {
            this.emit();
        }
    }

    /**
     * Check if the store has been inactive for too long. A store with live subscribers
     * (an open chat) is never stale: trimming it back to one page would yank loaded
     * history out from under the reader.
     */
    isStale(maxInactiveMinutes: number = 5): boolean {
        if (this.subscriberCount > 0) {
            return false;
        }
        const inactiveTime = Date.now() - this.lastAccessTime;
        return inactiveTime > maxInactiveMinutes * 60 * 1000;
    }

    /**
     * Reset to what storage holds (used on lock, when decrypted state must be dropped)
     */
    async clearDecryptedMessages() {
        debug.debug(`Clearing decrypted messages for chat ${this.chatId}`);
        await this.reloadWindow();
    }

    async refresh() {
        await this.reloadWindow();
    }

    async refreshAndDecrypt() {
        await this.reloadWindow();
    }

    getLastAccessTime(): number {
        return this.lastAccessTime;
    }
}

class MessageStoreRegistry {
    private stores = new Map<string, LazyMessageStore>();
    private cleanupInterval: number | null = null;

    constructor() {
        if (typeof window !== 'undefined') {
            this.startCleanupTimer();
        }
    }

    getStore(chatId: string): LazyMessageStore {
        if (!this.stores.has(chatId)) {
            const store = new LazyMessageStore(chatId);
            this.stores.set(chatId, store);
        }
        return this.stores.get(chatId)!;
    }

    removeStore(chatId: string) {
        this.stores.delete(chatId);
    }

    private startCleanupTimer() {
        this.cleanupInterval = window.setInterval(
            () => {
                this.cleanupStaleStores();
            },
            5 * 60 * 1000
        );
    }

    private async cleanupStaleStores() {
        const staleStores: string[] = [];

        for (const [chatId, store] of this.stores.entries()) {
            if (store.isStale()) {
                await store.clearDecryptedMessages();
                staleStores.push(chatId);
            }
        }

        for (const chatId of staleStores) {
            this.removeStore(chatId);
        }

        if (staleStores.length > 0) {
            debug.info(`Cleaned up ${staleStores.length} stale message stores`);
        }
    }

    /**
     * Clear all stores (on logout/lock)
     */
    async clearAllStores() {
        debug.info('Clearing all message stores');

        for (const store of this.stores.values()) {
            await store.clearDecryptedMessages();
        }

        this.stores.clear();
    }

    async refreshAndDecryptAllStores() {
        debug.info('Refreshing and decrypting all message stores');

        const refreshPromises = Array.from(this.stores.values()).map((store) =>
            store.refreshAndDecrypt().catch((error) => {
                debug.warn('Failed to refresh message store:', error);
            })
        );

        await Promise.all(refreshPromises);
    }

    getActiveStoreCount(): number {
        return this.stores.size;
    }
}

export const messageStoreRegistry = new MessageStoreRegistry();
