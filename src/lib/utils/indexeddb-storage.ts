import { debug } from './debug';
import type { StoredMessage as AppStoredMessage, SharedProfile } from '../types';
import { Buffer } from 'buffer';
import { secureKeyManager } from './secure-key-manager';

const DB_NAME = 'decrypt-chat-data';
// v6: some v5 databases were created without the compound index and must be upgraded.
const DB_VERSION = 6;
const CONVERSATION_STORE = 'conversations'; // Keep store name for backward compatibility
const MESSAGE_STORE = 'messages';
const UUID_STORE = 'seen-uuids';

export interface StoredConversation {
    id: string;
    name: string;
    key?: string; // Legacy field for backward compatibility
    encryptedKey?: ArrayBuffer; // New encrypted key field
    keyIv?: ArrayBuffer; // Initialization vector for key encryption
    lastActivity: number;
    isOnlineMode?: boolean;
    sharedProfile?: SharedProfile;
    autoDeleteAfter?: number | null; // ms; the currently active setting for new messages
}

export interface StoredMessageWithConversation extends AppStoredMessage {
    chatId: string; // Required for storage
}

// Keyset cursor for paged message reads. Timestamp alone is not enough: WhatsApp-imported
// messages have minute granularity, so many messages share one timestamp and the id is
// needed to resume exactly where the previous page ended.
export interface MessagePageCursor {
    timestamp: number;
    id: string;
}

export interface MessagePage {
    messages: StoredMessageWithConversation[];
    hasMore: boolean;
}

export class IndexedDBStorage {
    private db: IDBDatabase | null = null;
    private initPromise: Promise<void> | null = null;

    constructor() {
        if (typeof window !== 'undefined' && 'indexedDB' in window) {
            this.initPromise = this.initDB();
        }
    }

    private async initDB(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                reject(new Error('IndexedDB not supported'));
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onblocked = () => {
                // Another connection is open at an older version; wait for it to close
            };
            request.onsuccess = () => {
                this.db = request.result;
                // Close gracefully when a future version upgrade is requested
                this.db.onversionchange = () => {
                    this.db?.close();
                    this.db = null;
                    this.initPromise = null;
                };
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                const oldVersion = event.oldVersion;

                // Full schema rebuild only for the initial creation (version 0→N).
                // Upgrading from v3 and beyond: add missing stores, never delete existing ones.
                if (oldVersion < 3) {
                    const existingStores = Array.from(db.objectStoreNames);
                    for (const storeName of existingStores) {
                        db.deleteObjectStore(storeName);
                    }
                }

                if (!db.objectStoreNames.contains(CONVERSATION_STORE)) {
                    const conversationStore = db.createObjectStore(CONVERSATION_STORE, {
                        keyPath: 'id',
                    });
                    conversationStore.createIndex('lastActivity', 'lastActivity', {
                        unique: false,
                    });
                }

                if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
                    const messageStore = db.createObjectStore(MESSAGE_STORE, {
                        keyPath: 'id',
                    });
                    messageStore.createIndex('chatId', 'chatId', { unique: false });
                    messageStore.createIndex('timestamp', 'timestamp', { unique: false });
                    messageStore.createIndex('chatId_timestamp', ['chatId', 'timestamp'], {
                        unique: false,
                    });
                }

                // v4: replay-protection store for message UUIDs
                if (!db.objectStoreNames.contains(UUID_STORE)) {
                    const uuidStore = db.createObjectStore(UUID_STORE, { keyPath: 'uuid' });
                    uuidStore.createIndex('seenAt', 'seenAt', { unique: false });
                }

                // Ensure the chatId_timestamp compound index exists on messages (runs on
                // every upgrade; idempotent). Some existing databases were created without
                // it and paged reads depend on it. This schema must stay in lockstep with
                // StorageService.ts, which opens the same database.
                const upgradeTx = (event.target as IDBOpenDBRequest).transaction;
                if (upgradeTx) {
                    const messageStore = upgradeTx.objectStore(MESSAGE_STORE);
                    if (!messageStore.indexNames.contains('chatId_timestamp')) {
                        messageStore.createIndex('chatId_timestamp', ['chatId', 'timestamp'], {
                            unique: false,
                        });
                    }
                }
            };
        });
    }

    private async ensureDB(): Promise<IDBDatabase> {
        if (!this.initPromise) {
            throw new Error('IndexedDB not available');
        }

        await this.initPromise;

        if (!this.db) {
            throw new Error('Failed to initialize IndexedDB');
        }

        return this.db;
    }

    // Clear all object stores without dropping the database (prevents delete race conditions)
    async clearAllStores(): Promise<void> {
        const db = await this.ensureDB();
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction([CONVERSATION_STORE, MESSAGE_STORE], 'readwrite');
                tx.objectStore(CONVERSATION_STORE).clear();
                tx.objectStore(MESSAGE_STORE).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    async getStorageUsage(): Promise<{ used: number; quota: number }> {
        if ('navigator' in window && 'storage' in navigator && 'estimate' in navigator.storage) {
            const estimate = await navigator.storage.estimate();
            return {
                used: estimate.usage || 0,
                quota: estimate.quota || 0,
            };
        }

        // Fallback when the Storage API is unavailable
        return {
            used: 0,
            quota: 50 * 1024 * 1024, // 50MB estimate
        };
    }

    async storeChat(conversation: StoredConversation): Promise<void> {
        const db = await this.ensureDB();

        if (conversation.key) {
            await secureKeyManager.wrapConversationKey(conversation.id, conversation.key);
        }

        // Store chat without plaintext key - keys are handled by SecureKeyManager
        const chatToStore: StoredConversation = {
            ...conversation,
            key: undefined, // Never store plaintext keys
        };

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([CONVERSATION_STORE], 'readwrite');
            const store = transaction.objectStore(CONVERSATION_STORE);
            const request = store.put(chatToStore);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async getChat(id: string): Promise<StoredConversation | null> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([CONVERSATION_STORE], 'readonly');
            const store = transaction.objectStore(CONVERSATION_STORE);
            const request = store.get(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                resolve(request.result || null);
            };
        });
    }

    async getAllChats(): Promise<StoredConversation[]> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction([CONVERSATION_STORE], 'readonly');
                const store = transaction.objectStore(CONVERSATION_STORE);

                let request: IDBRequest;
                try {
                    const index = store.index('lastActivity');
                    request = index.getAll();
                } catch (indexError) {
                    // If index doesn't exist, fall back to getting all records directly
                    request = store.getAll();
                }

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const conversations = request.result || [];
                    conversations.sort((a: any, b: any) => b.lastActivity - a.lastActivity);
                    resolve(conversations);
                };

                transaction.onerror = () => reject(transaction.error);
            } catch (error) {
                // If there's any error with the transaction, return empty array for new users
                debug.warn('IndexedDB transaction error, returning empty chats array:', error);
                resolve([]);
            }
        });
    }

    async deleteChat(id: string): Promise<void> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([CONVERSATION_STORE, MESSAGE_STORE], 'readwrite');

            const conversationStore = transaction.objectStore(CONVERSATION_STORE);
            const deleteConvRequest = conversationStore.delete(id);

            const messageStore = transaction.objectStore(MESSAGE_STORE);
            const messageIndex = messageStore.index('chatId');
            const deleteMessagesRequest = messageIndex.openCursor(IDBKeyRange.only(id));

            let deletedMessages = 0;

            deleteMessagesRequest.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor) {
                    cursor.delete();
                    deletedMessages++;
                    cursor.continue();
                }
            };

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    async updateChat(id: string, updates: Partial<StoredConversation>): Promise<void> {
        const db = await this.ensureDB();

        // eslint-disable-next-line no-async-promise-executor -- the executor body is fully wrapped in try/catch and rejects on any error
        return new Promise(async (resolve, reject) => {
            try {
                const existingConversation = await this.getChat(id);
                if (!existingConversation) {
                    reject(new Error(`Chat with id ${id} not found`));
                    return;
                }

                const updatedConversation: StoredConversation = {
                    ...existingConversation,
                    ...updates,
                    id, // Ensure ID cannot be changed
                };

                const transaction = db.transaction([CONVERSATION_STORE], 'readwrite');
                const store = transaction.objectStore(CONVERSATION_STORE);
                const request = store.put(updatedConversation);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            } catch (error) {
                reject(error);
            }
        });
    }

    async loadChatKeyIntoMemory(chatId: string): Promise<boolean> {
        const conversation = await this.getChat(chatId);
        if (!conversation) {
            return false;
        }

        if (secureKeyManager.hasConversationKey(chatId)) {
            return true;
        }

        if (conversation.encryptedKey && conversation.keyIv) {
            try {
                await secureKeyManager.unwrapConversationKey(chatId);
                return true;
            } catch (error) {
                debug.warn('Failed to unwrap conversation key:', error);
                return false;
            }
        }

        debug.warn(`No encrypted key found for conversation: ${chatId}`);
        return false;
    }

    /**
     * Load all conversation keys into memory (call after master password is set)
     */
    async loadAllChatKeysIntoMemory(): Promise<{
        loaded: number;
        failed: number;
    }> {
        const conversations = await this.getAllChats();
        let loaded = 0;
        let failed = 0;

        for (const conversation of conversations) {
            const success = await this.loadChatKeyIntoMemory(conversation.id);
            if (success) {
                loaded++;
            } else {
                failed++;
            }
        }

        debug.log(`Loaded ${loaded} conversation keys, ${failed} failed`);
        return { loaded, failed };
    }

    async storeMessage(message: StoredMessageWithConversation): Promise<void> {
        const db = await this.ensureDB();

        let messageToStore: StoredMessageWithConversation;

        // Encrypt the message body before storing. Prefer DWK (device-local key) so that
        // a leaked conversation key cannot decrypt stored history. Fall back to the
        // conversation key only if the session is somehow unlocked without a DWK present.
        if (message.body && secureKeyManager.hasDWK()) {
            try {
                const messageData = new TextEncoder().encode(message.body);
                const { encrypted: encryptedBody, iv } =
                    await secureKeyManager.encryptWithDWK(messageData);
                messageToStore = {
                    ...message,
                    body: undefined,
                    encryptedBody,
                    iv,
                    storedWithDWK: true,
                };
            } catch (error) {
                debug.warn(
                    'Failed to encrypt message body with DWK, storing in plaintext (legacy mode):',
                    error
                );
                messageToStore = message;
            }
        } else if (message.body && secureKeyManager.hasConversationKey(message.chatId)) {
            try {
                const messageData = new TextEncoder().encode(message.body);
                const sharePayload = await secureKeyManager.createSharePayload(
                    message.chatId,
                    messageData
                );
                const encryptedBody =
                    typeof sharePayload.c === 'string'
                        ? this.base64ToArrayBuffer(sharePayload.c)
                        : new Uint8Array(sharePayload.c).buffer;
                const iv =
                    typeof sharePayload.n === 'string'
                        ? this.base64ToArrayBuffer(sharePayload.n)
                        : new Uint8Array(sharePayload.n).buffer;
                messageToStore = {
                    ...message,
                    body: undefined,
                    encryptedBody,
                    iv,
                };
            } catch (error) {
                debug.warn(
                    'Failed to encrypt message body, storing in plaintext (legacy mode):',
                    error
                );
                messageToStore = message;
            }
        } else {
            // Store as-is (legacy mode or already encrypted)
            messageToStore = message;
        }

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([MESSAGE_STORE], 'readwrite');
            const store = transaction.objectStore(MESSAGE_STORE);
            const request = store.put(messageToStore);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async addMessage(message: StoredMessageWithConversation): Promise<void> {
        await this.storeMessage(message);
    }

    async getAllMessages(): Promise<StoredMessageWithConversation[]> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction([MESSAGE_STORE], 'readonly');
                const store = transaction.objectStore(MESSAGE_STORE);
                const request = store.getAll();

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const messages = (request.result || []) as StoredMessageWithConversation[];
                    messages.sort((a, b) => a.timestamp - b.timestamp);
                    resolve(messages);
                };

                transaction.onerror = () => reject(transaction.error);
            } catch (error) {
                debug.warn('IndexedDB getAllMessages error, returning empty array:', error);
                resolve([]);
            }
        });
    }

    async getMessagesByChat(chatId: string): Promise<StoredMessageWithConversation[]> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction([MESSAGE_STORE], 'readonly');
                const store = transaction.objectStore(MESSAGE_STORE);

                let request: IDBRequest;
                try {
                    const index = store.index('chatId_timestamp');
                    const range = IDBKeyRange.bound([chatId, 0], [chatId, Date.now()]);
                    request = index.getAll(range);
                } catch (indexError) {
                    // If index doesn't exist, fall back to filtering all messages
                    const allRequest = store.getAll();
                    allRequest.onsuccess = () => {
                        const allMessages = allRequest.result || [];
                        const filteredMessages = allMessages.filter((msg) => msg.chatId === chatId);
                        filteredMessages.sort((a, b) => a.timestamp - b.timestamp);
                        resolve(filteredMessages);
                    };
                    allRequest.onerror = () => reject(allRequest.error);
                    return;
                }

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const messages = request.result || [];
                    messages.sort((a: any, b: any) => a.timestamp - b.timestamp);
                    resolve(messages);
                };

                transaction.onerror = () => reject(transaction.error);
            } catch (error) {
                debug.warn('IndexedDB transaction error, returning empty messages array:', error);
                resolve([]);
            }
        });
    }

    /**
     * Load the newest page of messages for a chat, walking the chatId_timestamp index
     * backwards. With `before` set, returns the page immediately older than that cursor.
     * Messages are returned in ascending timestamp order.
     */
    async getMessagesByChatPaged(
        chatId: string,
        opts: { before?: MessagePageCursor; limit: number }
    ): Promise<MessagePage> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction([MESSAGE_STORE], 'readonly');
                const store = transaction.objectStore(MESSAGE_STORE);

                // Databases created by older schema versions may lack the compound index
                // (the v5 upgrade adds it); fall back to an in-memory page rather than
                // failing, so the chat can never render empty over a missing index.
                let index: IDBIndex;
                try {
                    index = store.index('chatId_timestamp');
                } catch (indexError) {
                    debug.warn('chatId_timestamp index missing, paging in memory:', indexError);
                    const allRequest = store.getAll();
                    allRequest.onsuccess = () => {
                        resolve(this.paginateInMemory(allRequest.result || [], chatId, opts));
                    };
                    allRequest.onerror = () => reject(allRequest.error);
                    return;
                }

                // Inclusive upper bound at the cursor timestamp: same-timestamp neighbors of
                // the boundary message must still be visited; already-returned ones are
                // skipped by id below. Infinity sorts above every number in IndexedDB.
                const upper = opts.before ? opts.before.timestamp : Infinity;
                const range = IDBKeyRange.bound([chatId, 0], [chatId, upper]);
                const request = index.openCursor(range, 'prev');

                const collected: StoredMessageWithConversation[] = [];
                const target = opts.limit + 1; // one extra to learn whether more exist

                request.onerror = () => reject(request.error);
                request.onsuccess = (event) => {
                    const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                    if (cursor && collected.length < target) {
                        const record = cursor.value as StoredMessageWithConversation;
                        // Within an equal index key a 'prev' cursor visits records in
                        // descending primary-key order, so everything at the boundary
                        // timestamp with id >= the cursor id was already returned.
                        if (
                            opts.before &&
                            record.timestamp === opts.before.timestamp &&
                            record.id >= opts.before.id
                        ) {
                            cursor.continue();
                            return;
                        }
                        collected.push(record);
                        cursor.continue();
                        return;
                    }
                    const hasMore = collected.length > opts.limit;
                    const page = hasMore ? collected.slice(0, opts.limit) : collected;
                    page.reverse(); // walked newest-to-oldest; callers want ascending
                    resolve({ messages: page, hasMore });
                };

                transaction.onerror = () => reject(transaction.error);
            } catch (error) {
                debug.warn('IndexedDB paged read error, returning empty page:', error);
                resolve({ messages: [], hasMore: false });
            }
        });
    }

    /**
     * Fallback paging over a full getAll result, for databases missing the compound
     * index. Ordering matches the index walk: ascending (timestamp, id), with the id
     * tiebreak in IndexedDB string-key order (plain code-unit comparison).
     */
    private paginateInMemory(
        all: StoredMessageWithConversation[],
        chatId: string,
        opts: { before?: MessagePageCursor; limit: number }
    ): MessagePage {
        const mine = all
            .filter((m) => m.chatId === chatId)
            .sort((a, b) =>
                a.timestamp !== b.timestamp
                    ? a.timestamp - b.timestamp
                    : a.id < b.id
                      ? -1
                      : a.id > b.id
                        ? 1
                        : 0
            );
        const before = opts.before;
        const eligible = before
            ? mine.filter(
                  (m) =>
                      m.timestamp < before.timestamp ||
                      (m.timestamp === before.timestamp && m.id < before.id)
              )
            : mine;
        const start = Math.max(0, eligible.length - opts.limit);
        return { messages: eligible.slice(start), hasMore: start > 0 };
    }

    /** Newest message of a chat, or null. Used for chat-list previews. */
    async getLatestMessageForChat(chatId: string): Promise<StoredMessageWithConversation | null> {
        const page = await this.getMessagesByChatPaged(chatId, { limit: 1 });
        return page.messages.length > 0 ? page.messages[0] : null;
    }

    /** Fetch a single message by id (any chat). Used by jump-to-message. */
    async getMessageById(id: string): Promise<StoredMessageWithConversation | null> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction([MESSAGE_STORE], 'readonly');
                const store = transaction.objectStore(MESSAGE_STORE);
                const request = store.get(id);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result || null);
            } catch (error) {
                debug.warn('IndexedDB getMessageById error:', error);
                resolve(null);
            }
        });
    }

    /**
     * Decrypt a single message body if it's encrypted and key is available
     */
    async decryptMessage(
        message: StoredMessageWithConversation
    ): Promise<StoredMessageWithConversation> {
        // If message already has plaintext body (not just placeholder), return as-is
        if (message.body && !message.body.startsWith('[Encrypted')) {
            return message;
        }

        // If message has encrypted body, decrypt via DWK (new) or conversation key (legacy)
        if (message.encryptedBody && message.iv) {
            if (message.storedWithDWK) {
                if (secureKeyManager.hasDWK()) {
                    try {
                        const decrypted = await secureKeyManager.decryptWithDWK(
                            message.encryptedBody,
                            message.iv
                        );
                        return { ...message, body: new TextDecoder().decode(decrypted) };
                    } catch (error) {
                        debug.warn('DWK decryptMessage failed', {
                            id: message.id,
                            chatId: message.chatId,
                            error,
                        });
                        return { ...message, body: '[Encrypted message - decryption failed]' };
                    }
                } else {
                    return { ...message, body: '[Encrypted message - session locked]' };
                }
            }

            // Legacy path: message encrypted with conversation key
            const keyState = await secureKeyManager.getKeyAvailabilityState(message.chatId);

            if (keyState === 'available') {
                try {
                    const sharePayload = {
                        v: 1,
                        keyId: message.chatId,
                        c: Array.from(new Uint8Array(message.encryptedBody)),
                        n: Array.from(new Uint8Array(message.iv)),
                        ts: Date.now(),
                    };

                    const decryptedData = await secureKeyManager.openSharePayload(sharePayload);
                    return { ...message, body: new TextDecoder().decode(decryptedData) };
                } catch (error) {
                    debug.warn('decryptMessage failed', {
                        id: message.id,
                        chatId: message.chatId,
                        error,
                    });
                    return { ...message, body: '[Encrypted message - decryption failed]' };
                }
            } else if (keyState === 'locked') {
                return { ...message, body: '[Encrypted message - session locked]' };
            } else {
                return { ...message, body: '[Encrypted message - key not found]' };
            }
        }

        // Fallback for messages without encrypted body
        if (message.body === '[Encrypted]') {
            return {
                ...message,
                body: '[Message content unavailable]',
            };
        }
        return {
            ...message,
            body: message.body || '[Message content unavailable]',
        };
    }

    async decryptMessages(
        messages: StoredMessageWithConversation[]
    ): Promise<StoredMessageWithConversation[]> {
        const decryptedMessages = await Promise.all(
            messages.map((message) => this.decryptMessage(message))
        );
        return decryptedMessages;
    }

    async deleteMessage(id: string): Promise<void> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([MESSAGE_STORE], 'readwrite');
            const store = transaction.objectStore(MESSAGE_STORE);
            const request = store.delete(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async clearChatMessages(chatId: string): Promise<void> {
        const db = await this.ensureDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([MESSAGE_STORE], 'readwrite');
            const messageStore = transaction.objectStore(MESSAGE_STORE);
            const messageIndex = messageStore.index('chatId');
            const request = messageIndex.openCursor(IDBKeyRange.only(chatId));

            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    async deleteExpiredMessages(chatId: string): Promise<number> {
        const db = await this.ensureDB();
        const now = Date.now();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([MESSAGE_STORE], 'readwrite');
            const messageStore = transaction.objectStore(MESSAGE_STORE);
            const index = messageStore.index('chatId');
            const request = index.openCursor(IDBKeyRange.only(chatId));
            let deleted = 0;

            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor) {
                    const msg = cursor.value as StoredMessageWithConversation;
                    if (msg.autoDeleteAfter && now - msg.timestamp > msg.autoDeleteAfter) {
                        cursor.delete();
                        deleted++;
                    }
                    cursor.continue();
                }
            };

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve(deleted);
        });
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        let binary: string;

        if (typeof atob === 'function') {
            binary = atob(base64);
        } else {
            binary = Buffer.from(base64, 'base64').toString('binary');
        }

        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        return bytes.buffer;
    }

    /**
     * Replay protection: check if a message UUID has already been processed.
     * Returns true if the UUID is new (should be accepted), false if it was already seen.
     * When the UUID is new, it is recorded in the store immediately.
     */
    async checkAndRecordUUID(uuid: string, chatId: string): Promise<boolean> {
        const db = await this.ensureDB();

        // Storage errors deliberately fail open (resolve(true), accepting the message). Replay
        // protection is a hardening layer on top of AES-GCM authentication, not the primary
        // gate: an attacker still cannot forge or alter a code without the key. Failing closed
        // would let a transient IndexedDB error silently discard a genuine incoming message,
        // which is the worse outcome for a user who cannot ask the sender to retry.
        return new Promise((resolve) => {
            try {
                const transaction = db.transaction([UUID_STORE], 'readwrite');
                const store = transaction.objectStore(UUID_STORE);

                const getReq = store.get(uuid);
                getReq.onsuccess = () => {
                    if (getReq.result) {
                        resolve(false); // already seen
                        return;
                    }
                    const putReq = store.put({ uuid, chatId, seenAt: Date.now() });
                    putReq.onsuccess = () => resolve(true);
                    putReq.onerror = () => resolve(true);
                };
                getReq.onerror = () => resolve(true);

                transaction.onerror = () => resolve(true);
            } catch {
                resolve(true);
            }
        });
    }

    /** Remove UUID records older than 30 days to keep the store bounded. */
    async pruneOldUUIDs(): Promise<void> {
        const db = await this.ensureDB();
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

        return new Promise((resolve) => {
            try {
                const transaction = db.transaction([UUID_STORE], 'readwrite');
                const store = transaction.objectStore(UUID_STORE);
                const index = store.index('seenAt');
                const range = IDBKeyRange.upperBound(cutoff);
                const req = index.openCursor(range);

                req.onsuccess = (event) => {
                    const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    }
                };

                transaction.oncomplete = () => resolve();
                transaction.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    }

    isSupported(): boolean {
        return typeof window !== 'undefined' && 'indexedDB' in window;
    }
}

export const dataStorage = new IndexedDBStorage();
