import { debug } from './debug';
import {
    dataStorage,
    type MessagePageCursor,
    type StoredConversation,
    type StoredMessageWithConversation,
} from './indexeddb-storage';
import type { Chat, StoredMessage as AppStoredMessage } from '../types';
import { generateUUID } from './crypto';
import { secureKeyManager } from './secure-key-manager';

export class ChatStorage {
    async initializeWithPassword(password: string): Promise<void> {
        await secureKeyManager.unlockSession(password);
        await dataStorage.loadAllChatKeysIntoMemory();
    }

    lock(): void {
        secureKeyManager.lockSession();
    }

    isUnlocked(): boolean {
        try {
            if (secureKeyManager.isSessionLocked()) {
                throw new Error('Session is locked');
            }
            return true;
        } catch {
            return false;
        }
    }

    async saveChat(chat: Chat): Promise<void> {
        const storedConversation: StoredConversation = {
            id: chat.id,
            name: chat.name,
            key: chat.key,
            lastActivity: chat.lastActivity,
            isOnlineMode: chat.isOnlineMode,
            sharedProfile: chat.sharedProfile,
            autoDeleteAfter: chat.autoDeleteAfter,
        };

        await dataStorage.storeChat(storedConversation);
    }

    /**
     * Get a chat by ID (without messages)
     */
    async getChat(id: string): Promise<Chat | null> {
        const stored = await dataStorage.getChat(id);
        if (!stored) return null;

        return {
            id: stored.id,
            name: stored.name,
            lastActivity: stored.lastActivity,
            isOnlineMode: stored.isOnlineMode,
            sharedProfile: stored.sharedProfile,
            autoDeleteAfter: stored.autoDeleteAfter,
            messages: [], // Empty - will be loaded separately
        };
    }

    /**
     * Get all chats (without messages)
     */
    async getAllChats(): Promise<Chat[]> {
        const storedConversations = await dataStorage.getAllChats();

        // Deduplicate conversations by id (the primary key), NOT by name. Two distinct
        // chats can legitimately share a display name (two contacts both called "Mom", a
        // re-added contact), and collapsing by name would delete one of them along with its
        // entire message history on a routine list load. Records are keyed by id in
        // IndexedDB, so this only ever collapses a true id-duplicate (which should not
        // occur), keeping the most recently active copy as a defensive safety net.
        const deduplicatedConversations = new Map<string, (typeof storedConversations)[0]>();

        for (const conversation of storedConversations) {
            const existingConv = deduplicatedConversations.get(conversation.id);

            if (!existingConv || conversation.lastActivity > existingConv.lastActivity) {
                deduplicatedConversations.set(conversation.id, conversation);
            }
        }

        const uniqueConversations = Array.from(deduplicatedConversations.values());

        if (storedConversations.length > uniqueConversations.length) {
            debug.log(
                `Found ${storedConversations.length - uniqueConversations.length} duplicate conversations, cleaning up...`
            );
            await this.cleanupDuplicateChats(storedConversations, uniqueConversations);
        }

        const chats = uniqueConversations.map((stored) => {
            return {
                id: stored.id,
                name: stored.name,
                lastActivity: stored.lastActivity,
                isOnlineMode: stored.isOnlineMode,
                sharedProfile: stored.sharedProfile,
                autoDeleteAfter: stored.autoDeleteAfter,
                messages: [], // Empty - will be loaded separately
            };
        });

        return chats;
    }

    /**
     * Get a chat with all its messages (encrypted)
     */
    async getChatWithMessages(id: string): Promise<Chat | null> {
        const chat = await this.getChat(id);
        if (!chat) return null;

        const messages = await this.getMessages(id);
        chat.messages = messages;

        return chat;
    }

    /**
     * Get a chat with all its messages (decrypted)
     */
    async getChatWithMessagesDecrypted(id: string): Promise<Chat | null> {
        const chat = await this.getChat(id);
        if (!chat) return null;

        const messages = await this.getMessagesDecrypted(id);
        chat.messages = messages;

        return chat;
    }

    /**
     * Delete a chat and all its messages
     */
    async deleteChat(id: string): Promise<void> {
        await dataStorage.deleteChat(id);
    }

    async clearChatMessages(chatId: string): Promise<void> {
        await dataStorage.clearChatMessages(chatId);
    }

    async deleteExpiredMessages(chatId: string): Promise<number> {
        return dataStorage.deleteExpiredMessages(chatId);
    }

    async addMessage(chatId: string, message: AppStoredMessage): Promise<void> {
        const storedMessage: StoredMessageWithConversation = {
            id: message.id,
            chatId: chatId,
            from: message.from,
            body: message.body,
            encryptedBody: message.encryptedBody,
            iv: message.iv,
            timestamp: message.timestamp,
            isOwn: message.isOwn,
            deliveryMethod: message.deliveryMethod,
            remoteUuid: message.remoteUuid,
            reaction: message.reaction,
            reactionBy: message.reactionBy,
            autoDeleteAfter: message.autoDeleteAfter,
            callEvent: message.callEvent,
        };

        await dataStorage.storeMessage(storedMessage);

        const chat = await dataStorage.getChat(chatId);
        if (chat) {
            chat.lastActivity = Date.now();
            await dataStorage.storeChat(chat);
        }
    }

    private async getKeyState(chatId: string): Promise<'available' | 'locked' | 'not_found'> {
        try {
            return await secureKeyManager.getKeyAvailabilityState(chatId);
        } catch (error) {
            debug.warn('Failed to check key availability state for chat', chatId, error);
            return 'not_found';
        }
    }

    /**
     * Decrypt stored messages when the key is available (placeholder bodies otherwise)
     * and map them to the app message shape.
     */
    private async mapStoredMessages(
        storedMessages: StoredMessageWithConversation[],
        keyState: 'available' | 'locked' | 'not_found'
    ): Promise<AppStoredMessage[]> {
        if (keyState === 'available') {
            const decryptedMessages = await dataStorage.decryptMessages(storedMessages);
            return decryptedMessages.map((stored) => ({
                id: stored.id,
                from: stored.from,
                body: stored.body || '[Message content unavailable]',
                encryptedBody: stored.encryptedBody,
                iv: stored.iv,
                timestamp: stored.timestamp,
                isOwn: stored.isOwn,
                deliveryMethod: stored.deliveryMethod,
                chatId: stored.chatId,
                remoteUuid: (stored as any).remoteUuid,
                reaction: (stored as any).reaction,
                reactionBy: (stored as any).reactionBy,
                autoDeleteAfter: (stored as any).autoDeleteAfter,
                callEvent: (stored as any).callEvent,
            }));
        }

        const placeholderBody =
            keyState === 'locked'
                ? '[Encrypted message - session locked]'
                : '[Encrypted message - key not found]';

        return storedMessages.map((stored) => ({
            id: stored.id,
            from: stored.from,
            body: stored.body || placeholderBody,
            encryptedBody: stored.encryptedBody,
            iv: stored.iv,
            timestamp: stored.timestamp,
            isOwn: stored.isOwn,
            deliveryMethod: stored.deliveryMethod,
            chatId: stored.chatId,
            remoteUuid: (stored as any).remoteUuid,
            reaction: (stored as any).reaction,
            reactionBy: (stored as any).reactionBy,
            autoDeleteAfter: (stored as any).autoDeleteAfter,
            callEvent: (stored as any).callEvent,
        }));
    }

    /**
     * Get all messages for a chat (returns encrypted messages)
     */
    async getMessages(chatId: string): Promise<AppStoredMessage[]> {
        const storedMessages = await dataStorage.getMessagesByChat(chatId);
        const keyState = await this.getKeyState(chatId);
        return this.mapStoredMessages(storedMessages, keyState);
    }

    /**
     * Get one page of messages for a chat, newest page first (messages ascending).
     * With `before` set, returns the page immediately older than that cursor.
     */
    async getMessagesPaged(
        chatId: string,
        opts: { before?: MessagePageCursor; limit: number }
    ): Promise<{ messages: AppStoredMessage[]; hasMore: boolean }> {
        const page = await dataStorage.getMessagesByChatPaged(chatId, opts);
        const keyState = await this.getKeyState(chatId);
        const messages = await this.mapStoredMessages(page.messages, keyState);
        return { messages, hasMore: page.hasMore };
    }

    /**
     * Get the newest message of a chat, decrypted when possible. For chat-list previews.
     */
    async getLatestMessageDecrypted(chatId: string): Promise<AppStoredMessage | null> {
        const stored = await dataStorage.getLatestMessageForChat(chatId);
        if (!stored) return null;
        // Like getMessagesDecrypted: load the conversation key best-effort, then always
        // attempt decryption. Stored bodies are DWK-encrypted, so they decrypt even when
        // the conversation key is unavailable (e.g. the tutorial chat has none); gating
        // on conversation-key state here would show placeholders for decryptable
        // messages. decryptMessage falls back to a placeholder per message on its own.
        try {
            await secureKeyManager.unwrapConversationKey(chatId);
        } catch {
            // Conversation key unavailable; DWK decryption below still works.
        }
        const mapped = await this.mapStoredMessages([stored], 'available');
        return mapped[0] ?? null;
    }

    /**
     * Get all messages for a chat with decryption
     */
    async getMessagesDecrypted(chatId: string): Promise<AppStoredMessage[]> {
        try {
            await secureKeyManager.unwrapConversationKey(chatId);
        } catch (error) {
            debug.warn('Failed to unwrap conversation key:', error);
        }

        const storedMessages = await dataStorage.getMessagesByChat(chatId);
        const decryptedMessages = await dataStorage.decryptMessages(storedMessages);

        return decryptedMessages.map((stored) => ({
            id: stored.id,
            from: stored.from,
            body: stored.body || '[Decryption failed]',
            encryptedBody: stored.encryptedBody,
            iv: stored.iv,
            timestamp: stored.timestamp,
            isOwn: stored.isOwn,
            deliveryMethod: stored.deliveryMethod,
            chatId: stored.chatId,
            remoteUuid: (stored as any).remoteUuid,
            reaction: (stored as any).reaction,
            reactionBy: (stored as any).reactionBy,
            autoDeleteAfter: (stored as any).autoDeleteAfter,
            callEvent: (stored as any).callEvent,
        }));
    }

    async deleteMessage(id: string): Promise<void> {
        await dataStorage.deleteMessage(id);
    }

    async createChat(name: string, key: string): Promise<Chat> {
        if (secureKeyManager.isSessionLocked()) {
            throw new Error(
                'Session is locked. Please unlock with your passphrase before creating chats.'
            );
        }

        const chat: Chat = {
            id: generateUUID(),
            name,
            key,
            messages: [],
            lastActivity: Date.now(),
        };

        await this.saveChat(chat);
        return chat;
    }

    async updateLastActivity(chatId: string): Promise<void> {
        const chat = await dataStorage.getChat(chatId);
        if (chat) {
            chat.lastActivity = Date.now();
            await dataStorage.storeChat(chat);
        }
    }

    isSupported(): boolean {
        return dataStorage.isSupported();
    }

    private async cleanupDuplicateChats(
        allChats: Awaited<ReturnType<typeof dataStorage.getAllChats>>,
        chatsToKeep: Awaited<ReturnType<typeof dataStorage.getAllChats>>
    ): Promise<void> {
        const idsToKeep = new Set(chatsToKeep.map((chat) => chat.id));
        const duplicatesToDelete = allChats.filter((chat) => !idsToKeep.has(chat.id));

        debug.log(
            `Deleting ${duplicatesToDelete.length} duplicate chats:`,
            duplicatesToDelete.map((chat) => `${chat.name} (${chat.id})`)
        );

        for (const duplicateChat of duplicatesToDelete) {
            try {
                await dataStorage.deleteChat(duplicateChat.id);
                debug.log(`Deleted duplicate chat: ${duplicateChat.name} (${duplicateChat.id})`);
            } catch (error) {
                debug.error(`Failed to delete duplicate chat ${duplicateChat.id}:`, error);
            }
        }

        debug.log('Duplicate chat cleanup completed');
    }

    async getStorageInfo(): Promise<{
        used: number;
        quota: number;
        chatCount: number;
        messageCount: number;
    }> {
        const fileInfo = await dataStorage.getStorageUsage();
        const chats = await dataStorage.getAllChats();

        let messageCount = 0;
        for (const chat of chats) {
            const messages = await dataStorage.getMessagesByChat(chat.id);
            messageCount += messages.length;
        }

        return {
            used: fileInfo.used,
            quota: fileInfo.quota,
            chatCount: chats.length,
            messageCount,
        };
    }

    /**
     * Rotate the conversation key: re-encrypts all existing messages with the new key.
     */
    async rotateConversationKey(
        chatId: string,
        newMnemonic: string,
        onProgress?: (done: number, total: number) => void
    ): Promise<void> {
        if (secureKeyManager.isSessionLocked()) throw new Error('Session is locked');

        // The old conversation key must be in memory to read any legacy
        // (conversation-key-encrypted) history before we replace it.
        await secureKeyManager.unwrapConversationKey(chatId);

        // Read the FULL history (not the Date.now()-bounded getMessagesByChat, which would
        // hide any future-timestamped record and leave it stranded under the old key).
        const allMessages = await dataStorage.getAllMessages();
        const rawMessages = allMessages.filter((m) => m.chatId === chatId);

        // Only LEGACY records — encrypted under the conversation key (i.e. NOT storedWithDWK)
        // — depend on the key we are about to rotate. Messages stored with the DWK are keyed
        // to the device wrap key, which this operation does not change, so they are left
        // untouched. Decrypt every legacy body with the OLD key FIRST: openSharePayload throws
        // on failure, so a decryption problem aborts the whole rotation before the key is
        // touched, and the original state is left intact (no partial, unrecoverable loss).
        const legacyToMigrate = rawMessages.filter(
            (msg) => !msg.storedWithDWK && msg.encryptedBody && msg.iv
        );
        const decryptedPairs: Array<{ msg: StoredMessageWithConversation; body: string }> = [];
        for (const msg of legacyToMigrate) {
            const sharePayload = {
                v: 1,
                keyId: chatId,
                c: Array.from(new Uint8Array(msg.encryptedBody as ArrayBuffer)),
                n: Array.from(new Uint8Array(msg.iv as ArrayBuffer)),
                ts: Date.now(),
            };
            const data = await secureKeyManager.openSharePayload(sharePayload);
            decryptedPairs.push({ msg, body: new TextDecoder().decode(data) });
        }

        // Migrate the decrypted legacy messages to DWK storage while the OLD conversation key
        // is still present. storeMessage re-encrypts the plaintext body under the (unchanged)
        // DWK, so afterwards NO stored message depends on the conversation key. Doing this
        // before the swap means a failure here still leaves every message decryptable.
        const total = decryptedPairs.length;
        for (let i = 0; i < total; i++) {
            const { msg, body } = decryptedPairs[i];
            await dataStorage.storeMessage({
                ...msg,
                body,
                encryptedBody: undefined,
                iv: undefined,
            });
            onProgress?.(i + 1, total || 1);
        }

        // All history is now independent of the conversation key — safe to replace it. This
        // rewraps the key and re-derives the forward-secrecy chain from the new root.
        await secureKeyManager.wrapConversationKey(chatId, newMnemonic);
        onProgress?.(total, total || 1);
    }

    get dataStorage() {
        return dataStorage;
    }
}

export const chatStorage = new ChatStorage();
