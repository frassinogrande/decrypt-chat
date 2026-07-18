import { debug } from './debug';
import {
    dataStorage,
    type StoredConversation,
    type StoredMessageWithConversation,
} from './indexeddb-storage';
import type { Chat, StoredMessage as AppStoredMessage } from '../types';
import { generateUUID } from './crypto';
import {
    secureKeyManager,
    serializeBinaryPayload,
    deserializeBinaryPayload,
} from './secure-key-manager';

// Maximum message body size (bytes, pre-compression) for URL-based sharing.
// Matches MAX_MESSAGE_SIZE in CryptoService for the legacy path.
export const MAX_LINK_MESSAGE_BYTES = 1024;

/**
 * How many characters a message must be shortened by to fit in a share link.
 * Returns 0 when it fits. Computed in characters (scaled by the message's own
 * average bytes-per-character) so the number is meaningful to users.
 */
export function linkMessageOverageChars(message: string): number {
    const bytes = new TextEncoder().encode(message).length;
    if (bytes <= MAX_LINK_MESSAGE_BYTES) return 0;
    const avgBytesPerChar = bytes / Math.max(message.length, 1);
    return Math.ceil((bytes - MAX_LINK_MESSAGE_BYTES) / avgBytesPerChar);
}

export class SecureChatStorage {
    async initializeWithPassphrase(passphrase: string, isFirstTime = false): Promise<void> {
        if (isFirstTime) {
            await secureKeyManager.unlockSession(passphrase);
        } else {
            await secureKeyManager.unlockSession(passphrase);
            await this.loadAllWrappedKeys();
        }
    }

    lock(): void {
        secureKeyManager.lockSession();
    }

    isUnlocked(): boolean {
        return !secureKeyManager.isSessionLocked();
    }

    async createChat(name: string, mnemonic: string): Promise<Chat> {
        if (secureKeyManager.isSessionLocked()) {
            throw new Error('Session is locked. Unlock with passphrase first.');
        }

        const chatId = generateUUID();

        const wrappedKey = await secureKeyManager.wrapConversationKey(chatId, mnemonic);

        const storedConversation: StoredConversation = {
            id: chatId,
            name,
            key: undefined, // No plaintext key stored
            encryptedKey: wrappedKey.wrapped,
            keyIv: wrappedKey.iv,
            lastActivity: Date.now(),
            isOnlineMode: false,
        };

        await dataStorage.storeChat(storedConversation);

        const chat: Chat = {
            id: chatId,
            name,
            key: undefined, // Never expose plaintext key
            messages: [],
            lastActivity: Date.now(),
        };

        return chat;
    }

    /**
     * Get all chats (loads wrapped keys into memory)
     */
    async getAllChats(): Promise<Chat[]> {
        const storedConversations = await dataStorage.getAllChats();

        const chats = await Promise.all(
            storedConversations.map(async (stored) => {
                if (stored.encryptedKey && stored.keyIv && !secureKeyManager.isSessionLocked()) {
                    try {
                        await secureKeyManager.unwrapConversationKey(stored.id);
                        debug.log('Loaded wrapped key for chat:', stored.name);
                    } catch (error) {
                        debug.warn('Failed to load wrapped key for', stored.name, error);
                    }
                }

                return {
                    id: stored.id,
                    name: stored.name,
                    key: undefined, // Never expose plaintext keys
                    lastActivity: stored.lastActivity,
                    isOnlineMode: stored.isOnlineMode,
                    messages: [], // Will be loaded separately
                };
            })
        );

        return chats;
    }

    async getChat(id: string): Promise<Chat | null> {
        const stored = await dataStorage.getChat(id);
        if (!stored) return null;

        if (stored.encryptedKey && stored.keyIv && !secureKeyManager.isSessionLocked()) {
            try {
                await secureKeyManager.unwrapConversationKey(stored.id);
            } catch (error) {
                debug.warn('Failed to load wrapped key for chat', stored.name, error);
            }
        }

        return {
            id: stored.id,
            name: stored.name,
            key: undefined, // Never expose plaintext keys
            lastActivity: stored.lastActivity,
            isOnlineMode: stored.isOnlineMode,
            messages: [],
        };
    }

    hasKeyLoaded(chatId: string): boolean {
        return secureKeyManager.hasConversationKey(chatId);
    }

    /**
     * Create encrypted share payload for URL messaging
     * This requires the key to be already loaded or will throw
     */
    async createSharePayload(
        chatId: string,
        message: string,
        senderName: string,
        options?: { meta?: any; forceMessageUuid?: string }
    ): Promise<string> {
        if (!secureKeyManager.hasConversationKey(chatId)) {
            throw new Error('Conversation key not loaded. Key required for URL messaging.');
        }

        // Same cap as CryptoService.encryptMessage — beyond this the resulting URL
        // exceeds what messengers/browsers handle reliably.
        if (new TextEncoder().encode(message).length > MAX_LINK_MESSAGE_BYTES) {
            throw new Error('Message too large');
        }

        const messageObj: any = {
            magic: 'trusted-chat',
            from: senderName,
            timestamp: Math.floor(Date.now() / 1000),
            body: message,
            uuid: options?.forceMessageUuid || generateUUID(),
            pad: this.generatePadding(),
        };

        if (options?.meta && typeof options.meta === 'object') {
            // Attach small metadata blob (e.g., reaction info). Keep minimal to avoid URL bloat.
            messageObj.meta = options.meta;
        }

        const messageBytes = new TextEncoder().encode(JSON.stringify(messageObj));
        // Forward secrecy: encrypt async chat codes with today's rotating daily key, not
        // the static conversation key. See the Forward Secrecy section in README.md.
        const payload = await secureKeyManager.createMessageSharePayload(chatId, messageBytes);

        return serializeBinaryPayload(payload);
    }

    /**
     * Open share payload from URL
     * If key not loaded, this will throw and UI should prompt for mnemonic
     */
    async openSharePayload(chatId: string, encodedPayload: string): Promise<any> {
        if (!secureKeyManager.hasConversationKey(chatId)) {
            throw new Error('Conversation key not loaded. Key required to decrypt message.');
        }

        try {
            const payload = deserializeBinaryPayload(encodedPayload);
            let messageBytes: Uint8Array;
            try {
                // Forward-secret message path: trial-decrypt against the retained daily keys.
                messageBytes = await secureKeyManager.openMessageSharePayload(payload, chatId);
            } catch {
                // Content that intentionally rides the static conversation key (call
                // invitations) or any pre-forward-secrecy code falls back here.
                const effectivePayload =
                    payload.keyId === chatId ? payload : { ...payload, keyId: chatId };
                messageBytes = await secureKeyManager.openSharePayload(effectivePayload);
            }
            const messageStr = new TextDecoder().decode(messageBytes);
            return JSON.parse(messageStr);
        } catch (error) {
            throw new Error('Failed to decrypt message. Invalid payload or wrong key.');
        }
    }

    /**
     * Temporarily load key from mnemonic for specific operations.
     * JavaScript strings are immutable and cannot be wiped, so callers should hold the
     * mnemonic for as little time as possible. It is never persisted: the derived key
     * bytes are zeroized once the conversation key is set up.
     */
    async temporaryLoadKeyFromMnemonic(chatId: string, mnemonic: string): Promise<void> {
        await secureKeyManager.importConversationKey(mnemonic, chatId);
    }

    async addMessage(chatId: string, message: AppStoredMessage): Promise<void> {
        const messageWithChatId: StoredMessageWithConversation = {
            ...message,
            chatId,
        };

        await dataStorage.addMessage(messageWithChatId);
        await this.updateLastActivity(chatId);
    }

    async getMessages(chatId: string): Promise<AppStoredMessage[]> {
        const messages = await dataStorage.getMessagesByChat(chatId);
        return messages.map((msg) => {
            const { chatId: _, ...messageWithoutChatId } = msg;
            return messageWithoutChatId;
        });
    }

    async deleteChat(id: string): Promise<void> {
        await dataStorage.deleteChat(id);
        secureKeyManager.removeConversationKey(id);
    }

    async updateLastActivity(chatId: string): Promise<void> {
        const chat = await dataStorage.getChat(chatId);
        if (chat) {
            chat.lastActivity = Date.now();
            await dataStorage.storeChat(chat);
        }
    }

    async getStorageStats(): Promise<{
        chats: number;
        messages: number;
        keys: number;
    }> {
        const chats = await dataStorage.getAllChats();
        const messages = await dataStorage.getAllMessages();
        const loadedKeys = secureKeyManager.getLoadedKeyIds();

        return {
            chats: chats.length,
            messages: messages.length,
            keys: loadedKeys.length,
        };
    }

    private async loadAllWrappedKeys(): Promise<void> {
        const chats = await dataStorage.getAllChats();

        for (const chat of chats) {
            if (chat.encryptedKey && chat.keyIv) {
                try {
                    await secureKeyManager.unwrapConversationKey(chat.id);
                } catch (error) {
                    debug.warn(`Failed to load wrapped key for ${chat.name}:`, error);
                }
            }
        }
    }

    /**
     * Generate random padding for message obfuscation
     */
    private generatePadding(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const lenBuf = crypto.getRandomValues(new Uint8Array(1));
        const length = 50 + (lenBuf[0] % 101); // 50–150
        const buf = crypto.getRandomValues(new Uint8Array(length));
        return Array.from(buf, (b) => chars[b % chars.length]).join('');
    }
}

export const secureChatStorage = new SecureChatStorage();
