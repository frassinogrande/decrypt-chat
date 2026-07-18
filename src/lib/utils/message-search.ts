import { chatStorage } from './chat-storage';
import { dataStorage } from './indexeddb-storage';
import { debug } from './debug';

// Bodies that are placeholders rather than real content; never searchable.
const UNSEARCHABLE_BODIES = new Set([
    '[Encrypted]',
    '[Message content unavailable]',
    '[Encrypted message - session locked]',
    '[Encrypted message - key not found]',
    '[Encrypted message - decryption failed]',
]);

// Decrypt this many messages per chunk, yielding to the event loop in between,
// so searching a multi-thousand-message chat does not freeze the UI.
const DECRYPT_CHUNK_SIZE = 200;

// How many chats build their search cache concurrently.
const CHAT_CONCURRENCY = 2;

interface CachedEntry {
    id: string;
    body: string;
    lowerBody: string;
    timestamp: number;
}

export interface ChatSearchMatch {
    id: string;
    body: string;
    timestamp: number;
}

/**
 * On-demand full-history message search. Chats are read from IndexedDB and decrypted
 * only when a search actually runs, so the chat list no longer needs to keep every
 * chat's full history decrypted in memory. Decrypted bodies (text only) are cached
 * per session; the cache is invalidated per chat on writes and wiped on lock.
 */
class MessageSearchService {
    private cache = new Map<string, CachedEntry[]>();
    private generation = 0;

    /**
     * Search the given chats for a substring match. Results are streamed per chat
     * through `onChatResults` as each chat finishes. A newer search() call cancels
     * result delivery of older ones.
     */
    async search(
        chatIds: string[],
        query: string,
        onChatResults: (chatId: string, matches: ChatSearchMatch[]) => void
    ): Promise<void> {
        const myGeneration = ++this.generation;
        const q = query.trim().toLowerCase();
        if (!q || !chatStorage.isUnlocked()) {
            return;
        }

        const queue = [...chatIds];
        const workers = Array.from(
            { length: Math.min(CHAT_CONCURRENCY, queue.length) },
            async () => {
                while (queue.length > 0 && this.generation === myGeneration) {
                    const chatId = queue.shift();
                    if (!chatId) break;
                    try {
                        const entries = await this.getEntries(chatId, myGeneration);
                        if (this.generation !== myGeneration) return;
                        const matches = entries
                            .filter((e) => e.lowerBody.includes(q))
                            .map((e) => ({ id: e.id, body: e.body, timestamp: e.timestamp }));
                        if (matches.length > 0) {
                            onChatResults(chatId, matches);
                        }
                    } catch (error) {
                        debug.warn('Message search failed for chat', chatId, error);
                    }
                }
            }
        );

        await Promise.all(workers);
    }

    /** Drop a chat's cached bodies; rebuilt on the next search. */
    invalidateChat(chatId: string): void {
        this.cache.delete(chatId);
    }

    /** Wipe all cached plaintext (on lock/logout). */
    clearCache(): void {
        this.cache.clear();
    }

    private async getEntries(chatId: string, myGeneration: number): Promise<CachedEntry[]> {
        const cached = this.cache.get(chatId);
        if (cached) {
            return cached;
        }

        const stored = await dataStorage.getMessagesByChat(chatId);
        const entries: CachedEntry[] = [];

        for (let i = 0; i < stored.length; i += DECRYPT_CHUNK_SIZE) {
            if (this.generation !== myGeneration) {
                // A newer search superseded this one; abandon without caching a partial set.
                return entries;
            }
            const chunk = stored.slice(i, i + DECRYPT_CHUNK_SIZE);
            const decrypted = await dataStorage.decryptMessages(chunk);
            for (const message of decrypted) {
                const body = message.body;
                if (!body || UNSEARCHABLE_BODIES.has(body)) {
                    continue;
                }
                entries.push({
                    id: message.id,
                    body,
                    lowerBody: body.toLowerCase(),
                    timestamp: message.timestamp,
                });
            }
            // Yield so a long decrypt run cannot freeze the UI thread.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        this.cache.set(chatId, entries);
        return entries;
    }
}

export const messageSearch = new MessageSearchService();
