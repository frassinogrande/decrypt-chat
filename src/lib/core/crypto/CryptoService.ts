import * as bip39 from 'bip39';
import { deflate, inflate } from 'pako';
import { Buffer } from 'buffer';
import type { Message, EncryptedBlob } from '../../types';
import { debug } from '../../utils/debug';

// Make Buffer available globally for bip39
if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = Buffer;
}

const MAGIC_STRING = 'trusted-chat';
const MAX_MESSAGE_SIZE = 1024; // 1KB limit before compression

// --- Forward secrecy (daily key ratchet) ---
// Fixed origin day shared by all installs so both peers derive the identical daily
// chain key for any absolute day without exchanging an anchor. Absolute day number of
// 2026-01-01 UTC = floor(1767225600 / 86400).
const FS_ORIGIN_DAY = 20454;
// Number of recent daily keys each device retains. A seized device exposes at most this
// many days of history; codes pasted more than this many days late no longer decrypt.
const FS_WINDOW_DAYS = 7;
const FS_LABEL_INIT = 'fs-init-v1'; // root -> chain origin key
const FS_LABEL_NEXT = 'fs-next'; // chain_d -> chain_{d+1} (one-way)
const FS_LABEL_MSG = 'fs-msg'; // chain_d -> per-day message key
const FS_LABEL_SIGNALING = 'webrtc-sig-v1'; // root -> retained signaling key

/** Rolling daily-key chain state for one conversation. `keys` is ordered oldest..newest
 *  and holds at most FS_WINDOW_DAYS entries; the last entry is the key for `latestDay`. */
export interface FsChainState {
    latestDay: number;
    keys: ArrayBuffer[];
}

export class CryptoService {
    private static instance: CryptoService;

    private constructor() {}

    static getInstance(): CryptoService {
        if (!CryptoService.instance) {
            CryptoService.instance = new CryptoService();
        }
        return CryptoService.instance;
    }

    generateUUID(): string {
        return crypto.randomUUID();
    }

    generateMnemonic(): string {
        return bip39.generateMnemonic();
    }

    validateMnemonic(mnemonic: string): boolean {
        return bip39.validateMnemonic(mnemonic);
    }

    /**
     * Derive the raw 32-byte key material from a BIP39 mnemonic without creating a CryptoKey.
     * Use this when the bytes are needed for wrapping/storage; use mnemonicToKey for encryption.
     */
    async mnemonicToRawBytes(mnemonic: string): Promise<ArrayBuffer> {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const raw = new Uint8Array(32);
        raw.set(seed.slice(0, 32));
        return raw.buffer;
    }

    async mnemonicToKey(mnemonic: string): Promise<CryptoKey> {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const keyMaterial = seed.slice(0, 32);

        return await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, [
            'encrypt',
            'decrypt',
        ]);
    }

    async encryptMessage(message: string, senderName: string, key: CryptoKey): Promise<string> {
        if (!message || typeof message !== 'string') {
            throw new Error('Invalid message');
        }
        if (!senderName || typeof senderName !== 'string') {
            throw new Error('Invalid sender name');
        }
        if (!key) {
            throw new Error('Invalid encryption key');
        }

        if (new TextEncoder().encode(message).length > MAX_MESSAGE_SIZE) {
            throw new Error('Message too large');
        }

        const messageObj: Message = {
            magic: MAGIC_STRING,
            from: senderName,
            timestamp: Math.floor(Date.now() / 1000),
            body: message,
            uuid: this.generateUUID(),
            pad: this.generatePadding(),
        };

        const messageString = JSON.stringify(messageObj);
        const messageBytes = new TextEncoder().encode(messageString);

        let compressed: Uint8Array<ArrayBuffer>;
        try {
            compressed = deflate(messageBytes) as Uint8Array<ArrayBuffer>;
        } catch (error) {
            throw new Error('Compression failed');
        }

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);

        const blob: EncryptedBlob = {
            data: this.arrayBufferToBase64url(encrypted),
            iv: this.arrayBufferToBase64url(iv.buffer),
        };

        const blobBytes = new TextEncoder().encode(JSON.stringify(blob));
        const buffer = new ArrayBuffer(blobBytes.length);
        new Uint8Array(buffer).set(blobBytes);
        return this.arrayBufferToBase64url(buffer);
    }

    async decryptMessage(encryptedData: string, key: CryptoKey): Promise<Message | null> {
        debug.debug(`DECRYPT: Starting decryption process`);
        debug.debug(`DECRYPT: Encrypted data length:`, encryptedData.length);
        debug.debug(`DECRYPT: Key algorithm:`, key.algorithm);

        if (!encryptedData || typeof encryptedData !== 'string') {
            debug.debug(`DECRYPT: Invalid encrypted data`);
            return null;
        }
        if (!key) {
            debug.debug(`DECRYPT: No key provided`);
            return null;
        }

        try {
            debug.debug(`DECRYPT: Decoding base64url to blob string`);
            const blobString = new TextDecoder().decode(this.base64urlToArrayBuffer(encryptedData));
            debug.debug(`DECRYPT: Blob string length:`, blobString.length);

            debug.debug(`DECRYPT: Parsing JSON blob`);
            debug.debug(`DECRYPT: Blob string preview:`, blobString.substring(0, 200));
            const parsedBlob = JSON.parse(blobString);
            debug.debug(`DECRYPT: Parsed blob:`, parsedBlob);

            let iv: ArrayBuffer;
            let encrypted: ArrayBuffer;

            // Check if this is the new format (with version, keyId, n, c) or old format (data, iv)
            if (parsedBlob.v && parsedBlob.n && parsedBlob.c) {
                debug.debug(`DECRYPT: Detected new message format (v${parsedBlob.v})`);
                // New format: n = nonce/IV as array, c = ciphertext as array
                iv = new Uint8Array(parsedBlob.n).buffer;
                encrypted = new Uint8Array(parsedBlob.c).buffer;
                debug.debug(
                    `DECRYPT: New format - IV length:`,
                    iv.byteLength,
                    `Encrypted data length:`,
                    encrypted.byteLength
                );
            } else if (parsedBlob.data && parsedBlob.iv) {
                debug.debug(`DECRYPT: Detected old message format`);
                // Old format: data and iv as base64url strings
                const blob: EncryptedBlob = parsedBlob;
                iv = this.base64urlToArrayBuffer(blob.iv);
                encrypted = this.base64urlToArrayBuffer(blob.data);
                debug.debug(
                    `DECRYPT: Old format - IV length:`,
                    iv.byteLength,
                    `Encrypted data length:`,
                    encrypted.byteLength
                );
            } else {
                debug.debug(`DECRYPT: Unknown message format, neither old nor new format detected`);
                return null;
            }

            debug.debug(`DECRYPT: Attempting crypto.subtle.decrypt`);
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
            debug.debug(`DECRYPT: Decryption successful, decrypted length:`, decrypted.byteLength);

            debug.debug(`DECRYPT: Attempting decompression with pako`);
            let decompressed: Uint8Array;
            try {
                decompressed = inflate(new Uint8Array(decrypted));
                debug.debug(
                    `DECRYPT: Decompression successful, decompressed length:`,
                    decompressed.length
                );
            } catch (error) {
                debug.debug(`DECRYPT: Decompression failed:`, error as any);
                return null;
            }

            debug.debug(`DECRYPT: Converting decompressed data to string`);
            const messageString = new TextDecoder().decode(decompressed);
            debug.debug(`DECRYPT: Message string length:`, messageString.length);
            debug.debug(`DECRYPT: Message string preview:`, messageString.substring(0, 100));

            debug.debug(`DECRYPT: Parsing message JSON`);
            const message: Message = JSON.parse(messageString);
            debug.debug(`DECRYPT: Parsed message:`, message);

            debug.debug(`DECRYPT: Validating message structure`);
            if (
                !message ||
                typeof message !== 'object' ||
                typeof message.magic !== 'string' ||
                typeof message.from !== 'string' ||
                typeof message.body !== 'string' ||
                typeof message.uuid !== 'string' ||
                typeof message.timestamp !== 'number'
            ) {
                debug.debug(`DECRYPT: Message structure validation failed`);
                debug.debug(`DECRYPT: Message type checks:`, {
                    messageExists: !!message,
                    isObject: typeof message === 'object',
                    hasMagic: typeof message?.magic === 'string',
                    hasFrom: typeof message?.from === 'string',
                    hasBody: typeof message?.body === 'string',
                    hasUuid: typeof message?.uuid === 'string',
                    hasTimestamp: typeof message?.timestamp === 'number',
                });
                return null;
            }

            debug.debug(`DECRYPT: Checking magic string`);
            if (message.magic !== MAGIC_STRING) {
                debug.debug(
                    `DECRYPT: Magic string validation failed. Expected: "${MAGIC_STRING}", Got: "${message.magic}"`
                );
                return null;
            }

            // Reject messages too far in the past or future. The past window is tied to the
            // forward-secrecy key retention (FS_WINDOW_DAYS): a code older than the retained
            // daily keys can't be decrypted anyway, so a wider window here would be misleading.
            // The +1 day of slack absorbs intra-day and cross-peer clock offset at the edge.
            const nowSeconds = Math.floor(Date.now() / 1000);
            const MAX_FUTURE_SKEW = 5 * 60;
            const MAX_PAST_WINDOW = (FS_WINDOW_DAYS + 1) * 24 * 3600;
            if (
                message.timestamp > nowSeconds + MAX_FUTURE_SKEW ||
                message.timestamp < nowSeconds - MAX_PAST_WINDOW
            ) {
                debug.debug(`DECRYPT: Timestamp out of acceptable window: ${message.timestamp}`);
                return null;
            }

            debug.debug(`DECRYPT: Message validation successful, returning message`);
            return message;
        } catch (error) {
            debug.debug(`DECRYPT: Error during decryption:`, error as any);
            debug.debug(`DECRYPT: Error type:`, (error as any)?.constructor?.name);
            if (error instanceof Error) {
                debug.debug(`DECRYPT: Error message:`, error.message);
            }
            return null;
        }
    }

    async deriveKeyFromPassword(
        password: string,
        salt: Uint8Array,
        iterations = 600000
    ): Promise<CryptoKey> {
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        );

        return await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt as Uint8Array<ArrayBuffer>,
                iterations,
                hash: 'SHA-256',
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Derive raw bytes from a password using PBKDF2. Use this instead of
     * deriveKeyFromPassword + exportKey when you need the raw bytes (e.g. for
     * hashing or serialisation) — avoids creating an exportable CryptoKey.
     */
    async deriveBitsFromPassword(
        password: string,
        salt: Uint8Array,
        iterations = 600000
    ): Promise<ArrayBuffer> {
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveBits']
        );

        return crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: salt as Uint8Array<ArrayBuffer>,
                iterations,
                hash: 'SHA-256',
            },
            keyMaterial,
            256
        );
    }

    // --- Forward secrecy: daily key ratchet primitives ---
    //
    // The chain is one-way: chain_{d+1} = HMAC(chain_d, "fs-next"). A device that holds
    // chain_d can move forward but cannot recover chain_{d-1}, so discarding old keys makes
    // the messages they encrypted unrecoverable. Both peers derive the identical chain from
    // the shared root and the fixed FS_ORIGIN_DAY, so no anchor needs to be exchanged.

    /** Absolute day number for a unix-millisecond timestamp (defaults to now). */
    currentDayNumber(nowMs: number = Date.now()): number {
        return Math.floor(nowMs / 86_400_000);
    }

    /** HMAC-SHA256(keyBytes, label) — the one-way step used throughout the ratchet. */
    private async hmac(keyBytes: ArrayBuffer, label: string): Promise<ArrayBuffer> {
        const key = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label));
    }

    /** Derive the retained per-conversation WebRTC signaling key bytes from the root. */
    async deriveSignalingKeyBytes(rootBytes: ArrayBuffer): Promise<ArrayBuffer> {
        return this.hmac(rootBytes, FS_LABEL_SIGNALING);
    }

    /** Seed the chain at FS_ORIGIN_DAY from the root, then advance to `targetDay`,
     *  keeping only the last FS_WINDOW_DAYS keys. Used at import/restore. */
    async seedChainState(
        rootBytes: ArrayBuffer,
        targetDay: number = this.currentDayNumber()
    ): Promise<FsChainState> {
        const origin = await this.hmac(rootBytes, FS_LABEL_INIT);
        const state: FsChainState = { latestDay: FS_ORIGIN_DAY, keys: [origin] };
        return this.advanceChainTo(state, targetDay);
    }

    /** Ratchet a chain forward to `targetDay`, retaining at most FS_WINDOW_DAYS keys.
     *  No-op if already at or past the target (a backwards clock never rewinds the chain). */
    async advanceChainTo(state: FsChainState, targetDay: number): Promise<FsChainState> {
        let latestDay = state.latestDay;
        const keys = state.keys.slice();
        while (latestDay < targetDay) {
            const next = await this.hmac(keys[keys.length - 1], FS_LABEL_NEXT);
            keys.push(next);
            if (keys.length > FS_WINDOW_DAYS) keys.shift();
            latestDay++;
        }
        return { latestDay, keys };
    }

    /** Non-extractable AES-GCM message key for a given chain key. */
    private async messageKeyFromChain(chainKey: ArrayBuffer): Promise<CryptoKey> {
        const raw = await this.hmac(chainKey, FS_LABEL_MSG);
        return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
            'decrypt',
        ]);
    }

    /** Message key for the most recent (current) day — used when sending. */
    async currentMessageKey(state: FsChainState): Promise<CryptoKey> {
        if (state.keys.length === 0) throw new Error('Empty chain state');
        return this.messageKeyFromChain(state.keys[state.keys.length - 1]);
    }

    /** All retained daily message keys, newest first — the trial-decrypt set when receiving. */
    async recentMessageKeys(state: FsChainState): Promise<CryptoKey[]> {
        const ordered = state.keys.slice().reverse();
        return Promise.all(ordered.map((k) => this.messageKeyFromChain(k)));
    }

    /**
     * Generate random padding to obfuscate message length
     */
    private generatePadding(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const lenBuf = crypto.getRandomValues(new Uint8Array(1));
        const length = 50 + (lenBuf[0] % 101); // 50–150
        const buf = crypto.getRandomValues(new Uint8Array(length));
        return Array.from(buf, (b) => chars[b % chars.length]).join('');
    }

    private arrayBufferToBase64url(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    private base64urlToArrayBuffer(base64url: string): ArrayBuffer {
        let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) {
            base64 += '=';
        }

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

export const cryptoService = CryptoService.getInstance();

// Export functions for backward compatibility
export const generateUUID = () => cryptoService.generateUUID();
export const generateMnemonic = () => cryptoService.generateMnemonic();
export const validateMnemonic = (mnemonic: string) => cryptoService.validateMnemonic(mnemonic);
export const mnemonicToKey = (mnemonic: string) => cryptoService.mnemonicToKey(mnemonic);
export const encryptMessage = (message: string, senderName: string, key: CryptoKey) =>
    cryptoService.encryptMessage(message, senderName, key);
export const decryptMessage = (encryptedData: string, key: CryptoKey) =>
    cryptoService.decryptMessage(encryptedData, key);
export const deriveKeyFromPassword = (password: string, salt: Uint8Array, iterations?: number) =>
    cryptoService.deriveKeyFromPassword(password, salt, iterations);
export const deriveBitsFromPassword = (password: string, salt: Uint8Array, iterations?: number) =>
    cryptoService.deriveBitsFromPassword(password, salt, iterations);
