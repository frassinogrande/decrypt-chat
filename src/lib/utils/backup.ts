import { deflate, inflate } from 'pako';
import {
    dataStorage,
    type StoredMessageWithConversation,
    type StoredConversation,
} from './indexeddb-storage';
import { storageService } from '../core/storage/StorageService';
import { cryptoService } from '../core/crypto/CryptoService';

type LocalSnapshot = Record<string, string | null>;

export interface BackupPayload {
    version: number;
    createdAt: number;
    localStorage: LocalSnapshot;
    conversations: Array<
        StoredConversation & {
            messages: Array<
                Omit<StoredMessageWithConversation, 'encryptedBody' | 'iv'> & {
                    encryptedBody?: string; // base64
                    iv?: string; // base64
                }
            >;
        }
    >;
}

interface EncryptedBackupFile {
    v: number;
    kdf: {
        algorithm: 'PBKDF2';
        iterations: number;
        salt: string; // base64
    };
    iv: string; // base64
    data: string; // base64 (AES-GCM over deflated JSON of BackupPayload)
    meta: {
        createdAt: number;
    };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function pickLocalStorage(keys: string[]): LocalSnapshot {
    const out: LocalSnapshot = {};
    if (typeof window === 'undefined' || !window.localStorage) return out;
    for (const key of keys) out[key] = localStorage.getItem(key);
    return out;
}

export async function createBackupPayload(): Promise<BackupPayload> {
    // Collect localStorage data (explicit allowlist)
    const localSnapshot = pickLocalStorage([
        // Profile
        'encrypted-profile-data',
        'profile-salt',
        'profile-settings',
        // PBKDF2 iteration count the profile was encrypted at — without it, restore
        // re-derives at the legacy count and the profile fails to unlock.
        'profile-kdf-iterations',
        // App state (legacy/light state)
        'decrypt-chat-data',
        'decrypt-chat-uuids',
        'decrypt-chat-salt',
        // Secure key manager (wrapped conversation keys)
        'secure-wrapped-keys',
    ]);

    const conversations = await dataStorage.getAllChats();
    const convoWithData: BackupPayload['conversations'] = [];

    for (const conv of conversations) {
        const messages = await dataStorage.getMessagesByChat(conv.id);

        const serializedMessages = messages.map((m) => ({
            id: m.id,
            chatId: m.chatId,
            from: m.from,
            body: m.body,
            encryptedBody: m.encryptedBody ? arrayBufferToBase64(m.encryptedBody) : undefined,
            iv: m.iv ? arrayBufferToBase64(m.iv) : undefined,
            timestamp: m.timestamp,
            isOwn: m.isOwn,
            deliveryMethod: m.deliveryMethod,
            // Selects DWK vs conversation-key decryption; without it a restored DWK-encrypted
            // message is mistaken for a legacy record and fails to decrypt.
            storedWithDWK: m.storedWithDWK,
        }));

        convoWithData.push({
            id: conv.id,
            name: conv.name,
            lastActivity: conv.lastActivity,
            isOnlineMode: conv.isOnlineMode,
            sharedProfile: conv.sharedProfile,
            messages: serializedMessages as any,
        });
    }

    return {
        version: 1,
        createdAt: Date.now(),
        localStorage: localSnapshot,
        conversations: convoWithData,
    };
}

async function encryptPayload(
    payload: BackupPayload,
    masterPassword: string
): Promise<EncryptedBackupFile> {
    const json = JSON.stringify(payload);
    const compressed = deflate(new TextEncoder().encode(json));

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iterations = 600000;
    const key = await cryptoService.deriveKeyFromPassword(masterPassword, salt, iterations);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);

    return {
        v: 1,
        kdf: { algorithm: 'PBKDF2', iterations, salt: arrayBufferToBase64(salt.buffer) },
        iv: arrayBufferToBase64(iv.buffer),
        data: arrayBufferToBase64(ciphertext),
        meta: { createdAt: Date.now() },
    };
}

async function decryptPayload(
    serialized: EncryptedBackupFile,
    masterPassword: string
): Promise<BackupPayload> {
    const salt = new Uint8Array(base64ToArrayBuffer(serialized.kdf.salt));
    const iv = base64ToArrayBuffer(serialized.iv);
    const encrypted = base64ToArrayBuffer(serialized.data);
    const key = await cryptoService.deriveKeyFromPassword(
        masterPassword,
        salt,
        serialized.kdf.iterations
    );

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    const inflated = inflate(new Uint8Array(decrypted));
    const payloadStr = new TextDecoder().decode(inflated);
    return JSON.parse(payloadStr) as BackupPayload;
}

export async function createEncryptedBackup(
    masterPassword: string
): Promise<{ blob: Blob; fileName: string }> {
    if (!masterPassword || masterPassword.length === 0)
        throw new Error('Master password is required');

    const payload = await createBackupPayload();
    const encrypted = await encryptPayload(payload, masterPassword);

    const blob = new Blob([JSON.stringify(encrypted)], { type: 'application/octet-stream' });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `decrypt-chat-backup-${ts}.ecb`;
    return { blob, fileName };
}

async function clearExistingState() {
    if (typeof window !== 'undefined') {
        const keysToRemove = [
            'encrypted-profile-data',
            'profile-settings',
            'profile-salt',
            'profile-last-activity',
            'profile-session-derived-key',
            'profile-session-password',
            'decrypt-chat-data',
            'decrypt-chat-uuids',
            'decrypt-chat-salt',
            'secure-wrapped-keys',
            'secure-key-manager-lockout',
        ];
        for (const k of keysToRemove) {
            try {
                localStorage.removeItem(k);
            } catch {
                /* key may not exist or storage blocked; continue */
            }
        }
        // Session material lives in sessionStorage, not localStorage; drop it too so
        // a stale pre-restore session can't unlock (or half-unlock) the restored profile.
        for (const k of ['profile-session-derived-key', 'profile-session-password']) {
            try {
                sessionStorage.removeItem(k);
            } catch {
                /* storage blocked; continue */
            }
        }
    }
    await dataStorage.clearAllStores();
}

async function applySnapshot(payload: BackupPayload): Promise<void> {
    if (typeof window !== 'undefined') {
        for (const [k, v] of Object.entries(payload.localStorage)) {
            if (v === null) continue;
            if (k === 'secure-key-manager-lockout') continue;
            localStorage.setItem(k, v);
        }
    }

    await dataStorage.getAllChats();

    let restoredChats = 0;
    let restoredMessages = 0;

    for (const conv of payload.conversations) {
        const chatRecord: StoredConversation = {
            id: conv.id,
            name: conv.name,
            lastActivity: conv.lastActivity,
            isOnlineMode: conv.isOnlineMode,
            sharedProfile: conv.sharedProfile,
        };
        await dataStorage.storeChat(chatRecord);

        try {
            await storageService.saveChat({
                id: chatRecord.id,
                name: chatRecord.name,
                key: undefined,
                messages: [],
                lastActivity: chatRecord.lastActivity,
                isOnlineMode: chatRecord.isOnlineMode,
                sharedProfile: chatRecord.sharedProfile,
            } as any);
        } catch (e) {
            // Ignore legacy sync failures
        }
        restoredChats++;

        for (const m of conv.messages) {
            const restored: StoredMessageWithConversation = {
                id: m.id,
                chatId: m.chatId || conv.id,
                from: m.from,
                body: m.body,
                encryptedBody: m.encryptedBody ? base64ToArrayBuffer(m.encryptedBody) : undefined,
                iv: m.iv ? base64ToArrayBuffer(m.iv) : undefined,
                timestamp: m.timestamp,
                isOwn: m.isOwn,
                deliveryMethod: m.deliveryMethod,
                storedWithDWK: m.storedWithDWK,
            } as any;
            await dataStorage.storeMessage(restored);
            restoredMessages++;
        }
    }

    try {
        localStorage.setItem(
            'backup-restore-summary',
            JSON.stringify({
                at: Date.now(),
                chats: restoredChats,
                messages: restoredMessages,
            })
        );
    } catch {
        /* summary is informational only; ignore storage failures */
    }
}

export async function restoreFromEncryptedBackup(
    file: File | ArrayBuffer,
    masterPassword: string
): Promise<void> {
    if (!masterPassword || masterPassword.length === 0)
        throw new Error('Master password is required');

    let text: string;
    if (file instanceof ArrayBuffer) {
        text = new TextDecoder().decode(file);
    } else {
        text = await file.text();
    }

    const parsed: EncryptedBackupFile = JSON.parse(text);
    if (!parsed || !parsed.v || !parsed.kdf || !parsed.data || !parsed.iv)
        throw new Error('Invalid backup file');

    const payload = await decryptPayload(parsed, masterPassword);
    await clearExistingState();
    await applySnapshot(payload);
}

export async function decryptBackupFile(
    file: File | ArrayBuffer,
    masterPassword: string
): Promise<BackupPayload> {
    let text: string;
    if (file instanceof ArrayBuffer) {
        text = new TextDecoder().decode(file);
    } else {
        text = await file.text();
    }

    const parsed: EncryptedBackupFile = JSON.parse(text);
    if (!parsed || !parsed.v || !parsed.kdf || !parsed.data || !parsed.iv)
        throw new Error('Invalid backup file');

    return decryptPayload(parsed, masterPassword);
}

export async function applyBackupPayload(
    payload: BackupPayload,
    options: { mode?: 'replace' | 'merge' } = {}
): Promise<void> {
    const mode = options.mode ?? 'replace';

    if (mode === 'merge') {
        const current = await createBackupPayload();
        const merged = mergeBackupPayloads(current, payload);
        await clearExistingState();
        await applySnapshot(merged);
    } else {
        await clearExistingState();
        await applySnapshot(payload);
    }
}

export function mergeBackupPayloads(local: BackupPayload, incoming: BackupPayload): BackupPayload {
    const latestCreatedAt = Math.max(local.createdAt, incoming.createdAt, Date.now());

    const [primary, secondary] = [local, incoming].sort((a, b) => b.createdAt - a.createdAt);

    const mergedLocalStorage: LocalSnapshot = {
        ...secondary.localStorage,
        ...primary.localStorage,
    };

    const conversationMap = new Map<string, BackupPayload['conversations'][number]>();

    const upsertConversation = (source: BackupPayload, preferSourceMeta: boolean) => {
        for (const conv of source.conversations) {
            const existing = conversationMap.get(conv.id);
            if (!existing) {
                conversationMap.set(conv.id, {
                    ...conv,
                    messages: [...conv.messages],
                });
                continue;
            }

            const useSourceMeta = preferSourceMeta || conv.lastActivity > existing.lastActivity;
            if (useSourceMeta) {
                existing.name = conv.name;
                existing.lastActivity = conv.lastActivity;
                existing.isOnlineMode = conv.isOnlineMode;
                existing.sharedProfile = conv.sharedProfile;
            }

            const messageMap = new Map<string, (typeof conv.messages)[number]>();
            for (const message of existing.messages) messageMap.set(message.id, message);
            for (const message of conv.messages) {
                const prev = messageMap.get(message.id);
                if (!prev || (message.timestamp ?? 0) >= (prev.timestamp ?? 0)) {
                    messageMap.set(message.id, message);
                }
            }
            existing.messages = Array.from(messageMap.values()).sort(
                (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
            );
        }
    };

    upsertConversation(primary, true);
    upsertConversation(secondary, false);

    return {
        version: Math.max(local.version, incoming.version),
        createdAt: latestCreatedAt,
        localStorage: mergedLocalStorage,
        conversations: Array.from(conversationMap.values()).sort(
            (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)
        ),
    };
}
