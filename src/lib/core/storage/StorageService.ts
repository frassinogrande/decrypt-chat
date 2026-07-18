import type { AppState, Chat, StoredMessage } from '../../types';
import { cryptoService } from '../crypto/CryptoService';

const STORAGE_KEY = 'decrypt-chat-data';
const UUID_STORAGE_KEY = 'decrypt-chat-uuids';
const SALT_STORAGE_KEY = 'decrypt-chat-salt';

const DB_NAME = 'decrypt-chat-data';
// v6: some v5 databases were created without the compound index and must be upgraded.
const DB_VERSION = 6;
const CONVERSATION_STORE = 'conversations';
const MESSAGE_STORE = 'messages';
const UUID_STORE = 'seen-uuids';

export interface StorageInterface {
    saveAppState(state: AppState): Promise<void>;
    loadAppState(): Promise<AppState>;

    saveUsedUUID(uuid: string): void;
    isUUIDUsed(uuid: string): boolean;

    saveChat(chat: Chat): Promise<void>;
    loadChat(id: string): Promise<Chat | null>;
    loadAllChats(): Promise<Chat[]>;
    deleteChat(id: string): Promise<void>;

    addMessage(chatId: string, message: StoredMessage): Promise<void>;
    loadMessages(chatId: string): Promise<StoredMessage[]>;

    setPassword(password: string): Promise<void>;
    clearAllData(): void;
}

export class StorageService implements StorageInterface {
    private static instance: StorageService;
    private password: string | null = null;
    private salt: Uint8Array | null = null;
    private db: IDBDatabase | null = null;
    private initPromise: Promise<void> | null = null;

    private constructor() {
        if (typeof window !== 'undefined' && 'indexedDB' in window) {
            this.initPromise = this.initDB();
        }
    }

    static getInstance(): StorageService {
        if (!StorageService.instance) {
            StorageService.instance = new StorageService();
        }
        return StorageService.instance;
    }

    async setPassword(password: string): Promise<void> {
        this.password = password;
    }

    async saveAppState(state: AppState): Promise<void> {
        if (typeof window === 'undefined' || !window.localStorage) {
            return;
        }

        const data = JSON.stringify(state);

        if (this.password) {
            const key = await cryptoService.deriveKeyFromPassword(this.password, this.getSalt());
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                new TextEncoder().encode(data)
            );

            const encryptedData = {
                data: this.arrayBufferToBase64(encrypted),
                iv: this.arrayBufferToBase64(iv.buffer),
            };

            localStorage.setItem(STORAGE_KEY, JSON.stringify(encryptedData));
        } else {
            localStorage.setItem(STORAGE_KEY, data);
        }
    }

    async loadAppState(): Promise<AppState> {
        if (typeof window === 'undefined' || !window.localStorage) {
            return this.getDefaultState();
        }

        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) {
            return this.getDefaultState();
        }

        try {
            if (this.password) {
                const encryptedData = JSON.parse(stored);
                const key = await cryptoService.deriveKeyFromPassword(
                    this.password,
                    this.getSalt()
                );
                const iv = this.base64ToArrayBuffer(encryptedData.iv);
                const encrypted = this.base64ToArrayBuffer(encryptedData.data);

                const decrypted = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv },
                    key,
                    encrypted
                );
                const data = new TextDecoder().decode(decrypted);
                return JSON.parse(data);
            } else {
                return JSON.parse(stored);
            }
        } catch (error) {
            return this.getDefaultState();
        }
    }

    private static readonly UUID_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    saveUsedUUID(uuid: string): void {
        if (typeof window === 'undefined' || !window.localStorage) {
            return;
        }

        const now = Date.now();
        const uuids = this.getUUIDMap();
        uuids[uuid] = now;

        const cutoff = now - StorageService.UUID_TTL_MS;
        for (const key of Object.keys(uuids)) {
            if (uuids[key] < cutoff) {
                delete uuids[key];
            }
        }

        localStorage.setItem(UUID_STORAGE_KEY, JSON.stringify(uuids));
    }

    isUUIDUsed(uuid: string): boolean {
        const uuids = this.getUUIDMap();
        if (!(uuid in uuids)) return false;
        // Treat as unused if the record is older than the TTL window
        return Date.now() - uuids[uuid] < StorageService.UUID_TTL_MS;
    }

    private getUUIDMap(): Record<string, number> {
        if (typeof window === 'undefined' || !window.localStorage) {
            return {};
        }

        const stored = localStorage.getItem(UUID_STORAGE_KEY);
        if (!stored) return {};

        try {
            const parsed = JSON.parse(stored);
            // Migrate from old flat-array format (string[]) to timestamped map
            if (Array.isArray(parsed)) {
                const now = Date.now();
                const migrated: Record<string, number> = {};
                for (const u of parsed) {
                    if (typeof u === 'string') migrated[u] = now;
                }
                return migrated;
            }
            if (typeof parsed === 'object' && parsed !== null) {
                return parsed as Record<string, number>;
            }
            return {};
        } catch {
            return {};
        }
    }

    private async ensureDB(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }
    }

    private async initDB(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                reject(new Error('IndexedDB not supported'));
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(new Error('Failed to open IndexedDB'));

            request.onblocked = () => {
                // Another tab/connection is open at an older version; wait for it to close
            };

            request.onsuccess = () => {
                this.db = request.result;
                // Close this connection gracefully when a future version upgrade is requested
                this.db.onversionchange = () => {
                    this.db?.close();
                    this.db = null;
                    this.initPromise = null;
                };
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;

                if (!db.objectStoreNames.contains(CONVERSATION_STORE)) {
                    db.createObjectStore(CONVERSATION_STORE, { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
                    const messageStore = db.createObjectStore(MESSAGE_STORE, {
                        keyPath: 'id',
                    });
                    messageStore.createIndex('chatId', 'chatId', { unique: false });
                    messageStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // v4: replay-protection store for message UUIDs
                if (!db.objectStoreNames.contains(UUID_STORE)) {
                    const uuidStore = db.createObjectStore(UUID_STORE, { keyPath: 'uuid' });
                    uuidStore.createIndex('seenAt', 'seenAt', { unique: false });
                }

                // Ensure the chatId_timestamp compound index exists on messages (runs on
                // every upgrade; idempotent). This schema must stay in lockstep with
                // indexeddb-storage.ts, which opens the same database; paged message
                // reads depend on this index.
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

    async saveChat(chat: Chat): Promise<void> {
        await this.ensureDB();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([CONVERSATION_STORE], 'readwrite');
        const store = transaction.objectStore(CONVERSATION_STORE);

        const storedChat = {
            id: chat.id,
            name: chat.name,
            key: chat.key,
            lastActivity: chat.lastActivity,
            isOnlineMode: chat.isOnlineMode,
        };

        await new Promise<void>((resolve, reject) => {
            const request = store.put(storedChat);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error('Failed to save chat'));
        });
    }

    async loadChat(id: string): Promise<Chat | null> {
        await this.ensureDB();
        if (!this.db) return null;

        const transaction = this.db.transaction([CONVERSATION_STORE], 'readonly');
        const store = transaction.objectStore(CONVERSATION_STORE);

        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => {
                const result = request.result;
                if (result) {
                    resolve({
                        ...result,
                        messages: [], // Messages loaded separately
                    });
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(new Error('Failed to load chat'));
        });
    }

    async loadAllChats(): Promise<Chat[]> {
        await this.ensureDB();
        if (!this.db) return [];

        const transaction = this.db.transaction([CONVERSATION_STORE], 'readonly');
        const store = transaction.objectStore(CONVERSATION_STORE);

        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const results = request.result.map((chat) => ({
                    ...chat,
                    messages: [], // Messages loaded separately
                }));
                resolve(results);
            };
            request.onerror = () => reject(new Error('Failed to load chats'));
        });
    }

    async deleteChat(id: string): Promise<void> {
        await this.ensureDB();
        if (!this.db) return;

        const transaction = this.db.transaction([CONVERSATION_STORE, MESSAGE_STORE], 'readwrite');

        const chatStore = transaction.objectStore(CONVERSATION_STORE);
        chatStore.delete(id);

        const messageStore = transaction.objectStore(MESSAGE_STORE);
        const messageIndex = messageStore.index('chatId');
        messageIndex.openCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
            const cursor = (event.target as IDBRequest).result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };

        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(new Error('Failed to delete chat'));
        });
    }

    async addMessage(chatId: string, message: StoredMessage): Promise<void> {
        await this.ensureDB();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([MESSAGE_STORE], 'readwrite');
        const store = transaction.objectStore(MESSAGE_STORE);

        const storedMessage = {
            ...message,
            chatId,
        };

        await new Promise<void>((resolve, reject) => {
            const request = store.put(storedMessage);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error('Failed to add message'));
        });
    }

    async loadMessages(chatId: string): Promise<StoredMessage[]> {
        await this.ensureDB();
        if (!this.db) return [];

        const transaction = this.db.transaction([MESSAGE_STORE], 'readonly');
        const store = transaction.objectStore(MESSAGE_STORE);
        const index = store.index('chatId');

        return new Promise((resolve, reject) => {
            const request = index.getAll(chatId);
            request.onsuccess = () => {
                const messages = request.result.sort((a, b) => a.timestamp - b.timestamp);
                resolve(messages);
            };
            request.onerror = () => reject(new Error('Failed to load messages'));
        });
    }

    clearAllData(): void {
        if (typeof window === 'undefined') return;

        if (window.localStorage) {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(UUID_STORAGE_KEY);
            localStorage.removeItem(SALT_STORAGE_KEY);
        }

        if (this.db) {
            this.db.close();
            indexedDB.deleteDatabase(DB_NAME);
            this.db = null;
        }
    }

    private getSalt(): Uint8Array {
        if (this.salt) {
            return this.salt;
        }

        if (typeof window === 'undefined' || !window.localStorage) {
            throw new Error('localStorage is not available');
        }

        const stored = localStorage.getItem(SALT_STORAGE_KEY);
        if (stored) {
            this.salt = new Uint8Array(JSON.parse(stored));
            return this.salt;
        }

        const newSalt = crypto.getRandomValues(new Uint8Array(16));
        localStorage.setItem(SALT_STORAGE_KEY, JSON.stringify(Array.from(newSalt)));
        this.salt = newSalt;
        return newSalt;
    }

    private getDefaultState(): AppState {
        return {
            currentChatId: null,
            isFirstTime: true,
            usedUUIDs: new Set(),
            peerConnections: new Map(),
            profileSettings: {
                autoLockTimeout: -1,
                hideMessagesOnHomepage: false,
                showInstantLockButton: false,
                enterKeySendsMessage: true,
                use24HourTime: false,
                themePreference: 'system',
            },
            profileLockState: {
                isLocked: false,
            },
        };
    }

    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

export const storageService = StorageService.getInstance();
