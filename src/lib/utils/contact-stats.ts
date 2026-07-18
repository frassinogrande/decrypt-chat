import { debug } from './debug';
import { dataStorage } from './indexeddb-storage';

export interface ContactStorageStats {
    totalBytes: number;
    totalQuota: number;
    messageCount: number;
    sentCount: number;
    receivedCount: number;
}

export async function calculateContactStorageUsage(chatId: string): Promise<ContactStorageStats> {
    try {
        const messages = await dataStorage.getMessagesByChat(chatId);
        const storageUsage = await dataStorage.getStorageUsage();

        let sentCount = 0;
        let receivedCount = 0;
        let messageBytes = 0;

        messages.forEach((message) => {
            if (message.isOwn) {
                sentCount++;
            } else {
                receivedCount++;
            }

            messageBytes += estimateMessageSize(message);
        });

        return {
            totalBytes: messageBytes,
            totalQuota: storageUsage.quota,
            messageCount: messages.length,
            sentCount,
            receivedCount,
        };
    } catch (error) {
        debug.error('Failed to calculate contact storage usage:', error);
        return {
            totalBytes: 0,
            totalQuota: 0,
            messageCount: 0,
            sentCount: 0,
            receivedCount: 0,
        };
    }
}

function estimateMessageSize(message: any): number {
    let size = 0;

    // Message ID (UUID string)
    size += 36;

    size += (message.from || '').length * 2; // UTF-16 encoding

    if (message.body) {
        size += message.body.length * 2; // UTF-16 encoding
    }

    if (message.encryptedBody) {
        size += message.encryptedBody.byteLength;
    }
    if (message.iv) {
        size += message.iv.byteLength;
    }

    // Timestamp (8 bytes for number)
    size += 8;

    // Boolean fields (1 byte each)
    size += 1; // isOwn

    if (message.deliveryMethod) {
        size += message.deliveryMethod.length * 2;
    }

    size += (message.chatId || '').length * 2;

    // Add some overhead for IndexedDB metadata
    size += 50;

    return size;
}

export function formatStorageSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    const value = bytes / Math.pow(k, i);
    const formatted = i === 0 ? value.toString() : value.toFixed(1);

    return `${formatted} ${sizes[i]}`;
}
