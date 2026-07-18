import { Buffer } from 'buffer';
import { mnemonicToRawBytes, deriveBitsFromPassword } from './crypto';
import { cryptoService, type FsChainState } from '../core/crypto/CryptoService';
import { kdfService } from './kdf-service';
import { debug } from './debug';
import { memoryPressureService } from './memory-pressure-service';

export interface WrappedKey {
    keyId: string;
    wrapped: ArrayBuffer;
    iv: ArrayBuffer;
    kdfParams: {
        salt: Uint8Array;
        iterations: number;
        algorithm: string;
    };
    alg: string;
    created: number;
}

export interface SharePayload {
    v: number;
    keyId: string;
    n: number[] | string; // nonce as byte array (legacy) or base64 string (new)
    c: number[] | string; // ciphertext as byte array (legacy) or base64 string (new)
    ts: number;
    ad?: number[] | string; // optional associated data
}

/**
 * Secure Key Manager. Design principles:
 * - Never store mnemonics anywhere
 * - Non-extractable keys for all long-term conversation keys
 * - Explicit user action to re-enter mnemonic when needed
 * - Key wrapping with device wrap key (DWK) protected by passphrase
 */
export class SecureKeyManager {
    private conversationKeys = new Map<string, CryptoKey>();
    private deviceWrapKey: CryptoKey | null = null;
    private sessionLocked = true;
    private sessionDWKSalt: Uint8Array | null = null; // Track salt used for current session DWK
    private lockTimer: number | null = null;
    private readonly LOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
    private lastUnlockTimestamp = 0; // Track when session was last unlocked
    private _profileLockCallback: (() => void) | null = null;
    private autoLockPolicy: number = -2; // Default to "on every page refresh", will be set by ProfileManager
    private readonly KDF_ITERATIONS = 600000; // Raised from 100k; see the Profile & Authentication section in README.md
    // Cap on how far the daily-key chain may advance in a single loadFsState call. Bounds the
    // damage from a wrong (far-forward) device clock: jumps larger than this are applied in
    // memory for the session but NOT persisted, so the chain never gets permanently ratcheted
    // past the real day. ~1 year tolerates any realistic offline gap; a longer gap re-imports.
    private readonly FS_MAX_ADVANCE_DAYS = 370;

    // Unlock failure tracking for security with exponential backoff
    private failedAttempts = 0;
    private lockoutUntil: number | null = null;
    private readonly MAX_FAILED_ATTEMPTS = 10; // Increased for exponential backoff
    private readonly BASE_LOCKOUT_DURATION_MS = 30 * 1000; // Start at 30 seconds
    private readonly MAX_LOCKOUT_DURATION_MS = 24 * 60 * 60 * 1000; // Cap at 24 hours
    private readonly LOCKOUT_STORAGE_KEY = 'secure-key-manager-lockout';

    constructor() {
        this.setupVisibilityHandlers();
        this.restoreLockoutState();
        this.initializeAdvancedSecurity();
    }

    private initializeAdvancedSecurity(): void {
        if (memoryPressureService.isSupported()) {
            const defensiveActions = memoryPressureService.createDefensiveActions({
                clearCaches: () => {
                    debug.log('Memory pressure: clearing conversation key cache');
                    this.conversationKeys.clear();
                },
                lockSession: () => {
                    debug.warn('Critical memory pressure: locking session for security');
                    this.lockSession();
                },
                reduceFunctionality: () => {
                    debug.log('Memory pressure: suggesting reduced functionality');
                    // Could be used to notify UI to reduce features
                },
            });

            memoryPressureService.registerEvents(defensiveActions);
            memoryPressureService.startMonitoring();
            debug.log('Memory pressure monitoring initialized');
        } else {
            debug.log('Memory pressure monitoring not supported in this environment');
        }
    }

    private setupVisibilityHandlers(): void {
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    this.startLockTimer();
                } else {
                    this.resetLockTimer();
                }
            });

            window.addEventListener('beforeunload', () => {
                // Only lock if auto-lock policy is "on every page refresh" (-2)
                // Manual lock (-1) should preserve session across refreshes
                if (this.autoLockPolicy === -2) {
                    this.lockSession();
                }
            });

            // But give a grace period for recently unlocked sessions
            window.addEventListener('blur', () => {
                const timeSinceUnlock = Date.now() - this.lastUnlockTimestamp;
                const GRACE_PERIOD = 2 * 60 * 1000; // 2 minutes grace period

                if (timeSinceUnlock > GRACE_PERIOD) {
                    this.startLockTimer();
                } else {
                    debug.log(
                        `Grace period active - delaying lock timer (${Math.ceil((GRACE_PERIOD - timeSinceUnlock) / 1000)}s remaining)`
                    );
                }
            });

            window.addEventListener('focus', () => {
                if (!this.sessionLocked) {
                    this.resetLockTimer();
                }
            });

            let idleTimer: number | null = null;
            const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity

            const resetIdleTimer = () => {
                if (idleTimer) clearTimeout(idleTimer);
                if (
                    !this.sessionLocked &&
                    this.autoLockPolicy !== -1 &&
                    this.autoLockPolicy !== -3
                ) {
                    idleTimer = window.setTimeout(() => {
                        debug.log('Session locked due to user inactivity');
                        this.lockSession();
                    }, IDLE_TIMEOUT_MS);
                }
            };

            const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'];
            activityEvents.forEach((event) => {
                document.addEventListener(event, resetIdleTimer, { passive: true });
            });

            resetIdleTimer();
        }
    }

    private startLockTimer(): void {
        // Don't auto-lock if policy is "after new session" or "manual only"
        if (this.autoLockPolicy === -1 || this.autoLockPolicy === -3) return;
        this.clearLockTimer();
        this.lockTimer = window.setTimeout(() => {
            this.lockSession();
        }, this.LOCK_TIMEOUT_MS);
    }

    private resetLockTimer(): void {
        this.clearLockTimer();
        if (!this.sessionLocked) {
            this.startLockTimer();
        }
    }

    private clearLockTimer(): void {
        if (this.lockTimer) {
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
        }
    }

    public lockSession(): void {
        if (this.sessionLocked) return; // already locked — skip and don't fire callback
        this.deviceWrapKey = null;
        this.conversationKeys.clear();
        this.sessionLocked = true;
        this.sessionDWKSalt = null;
        this.clearLockTimer();
        debug.log('Session locked - all keys cleared from memory');
        this._profileLockCallback?.();
    }

    public destroy(): void {
        this.lockSession();
        memoryPressureService.stopMonitoring();
        debug.log('SecureKeyManager destroyed - all resources cleaned up');
    }

    public isSessionLocked(): boolean {
        return this.sessionLocked || !this.deviceWrapKey;
    }

    /**
     * Set auto-lock policy (called by ProfileManager)
     * @param policy -2 = on page refresh, -1 = after new session, -3 = manual only (less secure: unlock material persists in localStorage), >0 = inactivity timeout in minutes
     */
    public setAutoLockPolicy(policy: number): void {
        debug.log(`Setting auto-lock policy: ${policy}`);
        this.autoLockPolicy = policy;
    }

    /**
     * Register a callback invoked when the session locks internally (visibility/blur/idle/
     * memory-pressure). ProfileManager uses this to propagate lock state to the UI.
     * Pass null to deregister.
     */
    public setProfileLockCallback(cb: (() => void) | null): void {
        this._profileLockCallback = cb;
    }

    /**
     * Check if we should persist session across page refreshes (manual lock mode)
     */
    public shouldPersistSession(): boolean {
        return (this.autoLockPolicy === -1 || this.autoLockPolicy === -3) && !this.sessionLocked;
    }

    /**
     * Restore session state from ProfileManager (for manual lock mode)
     * This bypasses normal password unlock when ProfileManager has valid session
     */
    public restoreSessionFromProfileManager(): void {
        if (this.autoLockPolicy === -1 || this.autoLockPolicy === -3) {
            debug.log('Restoring SecureKeyManager session from ProfileManager (manual lock mode)');
            this.sessionLocked = false;
            this.lastUnlockTimestamp = Date.now();
            this.resetLockTimer();
        }
    }

    public clearCorruptedStorage(): void {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('secure-wrapped-keys');
            debug.log('Cleared corrupted wrapped keys from storage');
        }
    }

    public debugStorageContents(): void {
        if (typeof localStorage !== 'undefined') {
            const stored = localStorage.getItem('secure-wrapped-keys');
            debug.log('=== STORAGE DEBUG ===');
            debug.log('Raw localStorage content:', stored);
            if (stored) {
                try {
                    const parsed = JSON.parse(stored);
                    debug.log('Parsed storage content:', parsed);
                    debug.log('Number of keys:', parsed.length);
                    parsed.forEach((key: any, index: number) => {
                        debug.log(`Key ${index}:`, {
                            keyId: key.keyId,
                            saltLength: key.kdfParams.salt.length,
                            iterations: key.kdfParams.iterations,
                            algorithm: key.kdfParams.algorithm,
                            created: key.created,
                        });
                    });
                } catch (error) {
                    debug.log('Failed to parse storage content:', error);
                }
            }
            debug.log('=== END STORAGE DEBUG ===');
        }
    }

    /**
     * Store a validation key for password verification (used after profile creation)
     */
    public async storeValidationKey(): Promise<void> {
        if (!this.deviceWrapKey) {
            throw new Error('Session must be unlocked to store validation key');
        }

        // Create a dummy conversation key for validation purposes
        const validationKeyId = 'validation-key';
        const rawKeyData = crypto.getRandomValues(new Uint8Array(32));

        const iv = crypto.getRandomValues(new Uint8Array(12));

        // The validation key must be wrapped with the same salt as the current session DWK,
        // or unwrapping derives a different key and fails.
        const existingKeys = await this.getStoredWrappedKeys();
        debug.log(`Found ${existingKeys.length} existing keys when storing validation key`);

        let kdfParams;
        if (existingKeys.length > 0) {
            kdfParams = existingKeys[0].kdfParams;
            debug.log('Using existing salt from stored keys');
        } else {
            if (!this.sessionDWKSalt) {
                throw new Error('No session DWK salt available - session not properly initialized');
            }

            kdfParams = {
                salt: this.sessionDWKSalt,
                iterations: this.KDF_ITERATIONS,
                algorithm: 'PBKDF2' as const,
            };
            debug.log('Using session DWK salt for validation key - this ensures consistency!');
        }

        debug.log(
            `Using kdfParams for validation key - salt length: ${kdfParams.salt.length}, iterations: ${kdfParams.iterations}`
        );

        debug.log('=== VALIDATION KEY STORAGE ===');
        debug.log('About to encrypt validation key with DWK');
        debug.log('KDF params used for validation key:', {
            iterations: kdfParams.iterations,
            algorithm: kdfParams.algorithm,
        });

        const wrapped = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            this.deviceWrapKey,
            rawKeyData
        );

        const wrappedKey: WrappedKey = {
            keyId: validationKeyId,
            wrapped,
            iv: iv.buffer,
            kdfParams,
            alg: 'AES-GCM-256',
            created: Date.now(),
        };

        await this.storeWrappedKey(wrappedKey);
        debug.log('Validation key stored successfully');

        debug.log('=== IMMEDIATE VALIDATION TEST ===');
        try {
            const testDecryption = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: wrappedKey.iv },
                this.deviceWrapKey,
                wrappedKey.wrapped
            );
            debug.log(
                'Immediate validation test PASSED - validation key can be decrypted with current DWK'
            );
        } catch (immediateTestError) {
            debug.error(
                'CRITICAL: Immediate validation test FAILED - validation key cannot be decrypted with current DWK:',
                immediateTestError
            );
        }
        debug.log('=== END IMMEDIATE VALIDATION TEST ===');

        debug.log('=== END VALIDATION KEY STORAGE ===');
    }

    /**
     * Unlock session with passphrase (includes failure tracking and lockout)
     */
    public async unlockSession(passphrase: string): Promise<void> {
        if (this.isLockedOut()) {
            const remainingMs = this.lockoutUntil! - Date.now();
            const timeStr = this.formatDuration(remainingMs);

            throw new Error(
                `Account locked due to repeated failed attempts. Try again in ${timeStr}.`
            );
        }

        try {
            this.debugStorageContents();

            // Try to load an existing wrapped key to validate passphrase
            const wrappedKeys = await this.getStoredWrappedKeys();
            debug.log(`Found ${wrappedKeys.length} wrapped keys for validation`);

            if (wrappedKeys.length > 0) {
                // Validate passphrase by trying to derive DWK with master salt (from validation key)
                const validationKey = wrappedKeys.find((k) => k.keyId === 'validation-key');
                const testKey = validationKey || wrappedKeys[0];
                debug.log(
                    `Using wrapped key for validation: ${testKey.keyId}, salt length: ${testKey.kdfParams.salt.length}, iterations: ${testKey.kdfParams.iterations}`
                );

                this.deviceWrapKey = await this.deriveDWK(passphrase, testKey.kdfParams);
                this.sessionDWKSalt = testKey.kdfParams.salt;
                debug.log('=== UNLOCK VALIDATION ===');
                debug.log('DWK derived successfully, attempting to unwrap test key');

                // Try to validate with any available key, preferring conversation keys over validation keys
                const conversationKey = wrappedKeys.find((k) => k.keyId !== 'validation-key');
                const keyToTest = conversationKey || testKey;

                debug.log(
                    `Using key for validation: ${keyToTest.keyId} (${keyToTest.keyId === 'validation-key' ? 'validation key' : 'conversation key'})`
                );

                if (keyToTest.keyId === 'validation-key') {
                    debug.log('=== VALIDATION KEY DECRYPTION ===');
                    debug.log('Validation key details:', {
                        keyId: keyToTest.keyId,
                        ivLength: keyToTest.iv.byteLength,
                        wrappedLength: keyToTest.wrapped.byteLength,
                        // NB: never log IV/wrapped-key bytes (project rule).
                    });

                    try {
                        const validationDecrypted = await crypto.subtle.decrypt(
                            { name: 'AES-GCM', iv: keyToTest.iv },
                            this.deviceWrapKey,
                            keyToTest.wrapped
                        );
                        debug.log('Validation key decrypted successfully - passphrase is valid');
                        debug.log(
                            'Decrypted validation data length:',
                            validationDecrypted.byteLength
                        );
                        this.zeroizeArrayBuffer(validationDecrypted);
                    } catch (validationError) {
                        debug.error('Validation key decryption failed:', validationError);
                        debug.error('This suggests the DWK or validation key data is incorrect');
                        throw validationError;
                    }
                    debug.log('=== END VALIDATION KEY DECRYPTION ===');
                } else {
                    debug.log('=== CONVERSATION KEY VALIDATION ===');
                    try {
                        await this.unwrapConversationKey(keyToTest.keyId);
                        debug.log('Conversation key unwrapped successfully - passphrase is valid');
                    } catch (convError) {
                        debug.error('Conversation key unwrap failed:', convError);
                        throw convError;
                    }
                    debug.log('=== END CONVERSATION KEY VALIDATION ===');
                }
                debug.log('=== END UNLOCK VALIDATION ===');
            } else {
                // First time - create DWK from passphrase
                const salt = crypto.getRandomValues(new Uint8Array(32));
                const kdfParams = {
                    salt,
                    iterations: this.KDF_ITERATIONS,
                    algorithm: 'PBKDF2',
                };
                this.deviceWrapKey = await this.deriveDWK(passphrase, kdfParams);
                this.sessionDWKSalt = kdfParams.salt;
            }

            this.resetFailedAttempts();
            this.sessionLocked = false;
            this.lastUnlockTimestamp = Date.now();
            this.resetLockTimer();
            debug.log(
                'Session unlocked - DWK stored and available for conversation key unwrapping'
            );
        } catch (error) {
            this.recordFailedAttempt();

            if (this.isLockedOut()) {
                const remainingMs = this.lockoutUntil! - Date.now();
                const timeStr = this.formatDuration(remainingMs);

                throw new Error(
                    `Account locked due to repeated failed attempts. Try again in ${timeStr}.`
                );
            } else {
                const attemptsBeforeLockout = Math.max(0, 3 - this.failedAttempts);
                if (attemptsBeforeLockout > 0) {
                    throw new Error(
                        `Invalid passphrase. ${attemptsBeforeLockout} attempts remaining before lockout.`
                    );
                } else {
                    throw new Error(
                        `Invalid passphrase. Account will be locked with exponential backoff.`
                    );
                }
            }
        }
    }

    /**
     * Derive Device Wrap Key from passphrase using Web Worker for responsiveness
     */
    private async deriveDWK(
        passphrase: string,
        kdfParams: WrappedKey['kdfParams']
    ): Promise<CryptoKey> {
        debug.log('=== DWK DERIVATION START ===');
        debug.log('Deriving DWK with', kdfParams.iterations, 'iterations');

        // Warn if passphrase normalization would change the string (without logging content)
        if (passphrase.normalize('NFC') !== passphrase) {
            debug.warn(
                'Passphrase NFC normalization changes the string — key derivation may be inconsistent'
            );
        }

        try {
            const dwk = await kdfService.deriveKey(
                passphrase,
                kdfParams.salt,
                kdfParams.iterations,
                ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
            );

            debug.log('DWK derived successfully via KDF_SERVICE');
            return dwk;
        } catch (error) {
            debug.error('KDF SERVICE FAILED, falling back to legacy method:', error);
            debug.error(
                'This could cause DWK inconsistency if different methods are used for wrapping vs unwrapping!'
            );

            const dwkBits = await deriveBitsFromPassword(
                passphrase,
                kdfParams.salt,
                kdfParams.iterations
            );
            debug.log('DWK derived via legacy fallback');

            return crypto.subtle.importKey('raw', dwkBits, 'AES-GCM', false, [
                'encrypt',
                'decrypt',
                'wrapKey',
                'unwrapKey',
            ]);
        }
    }

    // ===== Forward secrecy: per-conversation daily key ratchet =====
    //
    // The persisted conversation record holds the retained *signaling* key (HKDF of the root),
    // never the message root. The one-way daily chain that produces message keys lives in a
    // separate `fs:<keyId>` record. The root is derived transiently at import/migration and is
    // never persisted, so a seized device cannot recover message keys older than the retained
    // window (see the Forward Secrecy section in README.md).

    private fsStates = new Map<string, FsChainState>();

    private serializeFsState(state: FsChainState): ArrayBuffer {
        const out = new Uint8Array(5 + state.keys.length * 32);
        new DataView(out.buffer).setUint32(0, state.latestDay, true);
        out[4] = state.keys.length;
        state.keys.forEach((k, i) => out.set(new Uint8Array(k), 5 + i * 32));
        return out.buffer;
    }

    private deserializeFsState(bytes: ArrayBuffer): FsChainState {
        const u8 = new Uint8Array(bytes);
        const latestDay = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, true);
        const count = u8[4];
        const keys: ArrayBuffer[] = [];
        for (let i = 0; i < count; i++) {
            keys.push(u8.slice(5 + i * 32, 5 + i * 32 + 32).buffer);
        }
        return { latestDay, keys };
    }

    /** Pick the salt/iteration params to wrap with, preferring the master (validation-key) salt. */
    private async kdfParamsForWrapping(): Promise<WrappedKey['kdfParams']> {
        const existingKeys = await this.getStoredWrappedKeys();
        const validationKey = existingKeys.find((k) => k.keyId === 'validation-key');
        if (validationKey) return validationKey.kdfParams;
        if (existingKeys.length > 0) return existingKeys[0].kdfParams;
        return {
            salt: crypto.getRandomValues(new Uint8Array(32)),
            iterations: this.KDF_ITERATIONS,
            algorithm: 'PBKDF2',
        };
    }

    private async wrapBytesUnderDwk(keyId: string, plaintext: ArrayBuffer): Promise<void> {
        if (!this.deviceWrapKey || this.sessionLocked) {
            throw new Error(`Cannot wrap ${keyId} - session is locked`);
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const kdfParams = await this.kdfParamsForWrapping();
        const wrapped = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            this.deviceWrapKey,
            plaintext
        );
        await this.storeWrappedKey({
            keyId,
            wrapped,
            iv: iv.buffer,
            kdfParams,
            alg: 'AES-GCM-256',
            created: Date.now(),
        });
    }

    private async unwrapBytesUnderDwk(keyId: string): Promise<ArrayBuffer | null> {
        if (!this.deviceWrapKey) {
            throw new Error('Session is locked. Unlock with passphrase first.');
        }
        const rec = await this.getStoredWrappedKey(keyId);
        if (!rec) return null;
        return crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: rec.iv },
            this.deviceWrapKey,
            rec.wrapped
        );
    }

    /**
     * Derive the retained signaling key and the daily chain from a conversation root, cache
     * them for this session, and (when `persist`) store them — the conversation record becomes
     * the signaling key and a `fs:<keyId>` record holds the chain. The root is never stored.
     */
    private async setupConversationFromRoot(
        keyId: string,
        rootBytes: ArrayBuffer,
        persist: boolean
    ): Promise<CryptoKey> {
        const signalingBytes = await cryptoService.deriveSignalingKeyBytes(rootBytes);
        const chain = await cryptoService.seedChainState(rootBytes);

        if (persist) {
            await this.wrapBytesUnderDwk(keyId, signalingBytes);
            await this.wrapBytesUnderDwk(`fs:${keyId}`, this.serializeFsState(chain));
        }

        const signalingKey = await crypto.subtle.importKey(
            'raw',
            signalingBytes,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        this.conversationKeys.set(keyId, signalingKey);
        this.fsStates.set(keyId, chain);
        this.zeroizeArrayBuffer(signalingBytes);
        return signalingKey;
    }

    /** Load (or migrate) the daily chain for a conversation and advance it to today. */
    private async loadFsState(keyId: string): Promise<FsChainState> {
        let state = this.fsStates.get(keyId);
        if (!state) {
            const bytes = await this.unwrapBytesUnderDwk(`fs:${keyId}`);
            if (!bytes) {
                throw new Error(`No forward-secrecy state for ${keyId} (conversation not set up)`);
            }
            state = this.deserializeFsState(bytes);
        }

        // Advance the chain to the local day. The advance is capped: a wildly-forward device
        // clock could otherwise ratchet the stored chain far into the future and — since the
        // chain never rewinds — permanently lock the conversation out of the real current keys.
        // Beyond the cap we advance in memory only (best effort for this session) and do NOT
        // persist, so a corrected clock resumes from the last good day.
        const today = cryptoService.currentDayNumber();
        const gap = today - state.latestDay;
        if (gap > 0) {
            const capped = gap > this.FS_MAX_ADVANCE_DAYS;
            const target = capped ? state.latestDay + this.FS_MAX_ADVANCE_DAYS : today;
            state = await cryptoService.advanceChainTo(state, target);
            if (capped) {
                debug.warn(
                    `FS chain for ${keyId}: ${gap}-day advance exceeds cap (${this.FS_MAX_ADVANCE_DAYS}); not persisting (device clock?)`
                );
            } else {
                await this.wrapBytesUnderDwk(`fs:${keyId}`, this.serializeFsState(state));
            }
        }
        this.fsStates.set(keyId, state);
        return state;
    }

    /** Message key for today — used when sending a share code. */
    public async getSendMessageKey(keyId: string): Promise<CryptoKey> {
        return cryptoService.currentMessageKey(await this.loadFsState(keyId));
    }

    /** The retained daily message keys (newest first) — the trial-decrypt set when receiving. */
    public async getReceiveMessageKeys(keyId: string): Promise<CryptoKey[]> {
        return cryptoService.recentMessageKeys(await this.loadFsState(keyId));
    }

    /**
     * Import conversation key from mnemonic (non-extractable)
     */
    public async importConversationKey(mnemonic: string, keyId: string): Promise<CryptoKey> {
        debug.log('=== CONVERSATION KEY IMPORT ===');
        debug.log(`Importing conversation key for: ${keyId}`);
        // NB: never log any part of the mnemonic or derived key bytes (project rule).

        // Derive raw key bytes directly from the mnemonic seed — avoids needing an extractable CryptoKey
        const rawKey = await mnemonicToRawBytes(mnemonic);

        // Derive the retained signaling key + daily chain from the root (in memory only here;
        // wrapConversationKey persists them). The root itself is never stored.
        const signalingKey = await this.setupConversationFromRoot(keyId, rawKey, false);

        this.zeroizeArrayBuffer(rawKey);

        debug.log(`Conversation key imported and stored for: ${keyId}`);
        debug.log('=== END CONVERSATION KEY IMPORT ===');

        return signalingKey;
    }

    public async wrapConversationKey(keyId: string, mnemonic: string): Promise<WrappedKey> {
        if (!this.deviceWrapKey) {
            throw new Error('Session is locked. Unlock with passphrase first.');
        }
        if (this.sessionLocked) {
            throw new Error(`Cannot wrap conversation key ${keyId} - session is locked`);
        }

        // Derive the signaling key + daily chain from the root and persist them. The stored
        // conversation record holds the signaling key; the daily chain lives in `fs:<keyId>`.
        // The root is used only transiently here and never written to storage.
        const rootBytes = await mnemonicToRawBytes(mnemonic);
        await this.setupConversationFromRoot(keyId, rootBytes, true);
        this.zeroizeArrayBuffer(rootBytes);

        const stored = await this.getStoredWrappedKey(keyId);
        if (!stored) {
            throw new Error(`Failed to persist conversation key ${keyId}`);
        }
        return stored;
    }

    public async unwrapConversationKey(keyId: string): Promise<CryptoKey> {
        if (!this.deviceWrapKey) {
            throw new Error('Session is locked. Unlock with passphrase first.');
        }

        const existing = this.conversationKeys.get(keyId);
        if (existing) {
            return existing;
        }

        const wrappedKey = await this.getStoredWrappedKey(keyId);
        if (!wrappedKey) {
            throw new Error(`Wrapped key not found for ${keyId}`);
        }

        debug.log(
            `Attempting to decrypt wrapped key ${keyId} with iv length: ${wrappedKey.iv.byteLength}`
        );

        debug.log('Wrapped key details:', {
            keyId,
            ivLength: wrappedKey.iv.byteLength,
            wrappedLength: wrappedKey.wrapped.byteLength,
            algorithm: wrappedKey.alg,
            created: new Date(wrappedKey.created).toISOString(),
        });

        let recordBytes: ArrayBuffer;
        try {
            recordBytes = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: wrappedKey.iv },
                this.deviceWrapKey,
                wrappedKey.wrapped
            );
            debug.log('Decryption successful, record bytes length:', recordBytes.byteLength);
        } catch (decryptError) {
            debug.error('CRITICAL: crypto.subtle.decrypt failed with OperationError');
            debug.error(
                'This indicates the DWK used for unwrapping differs from the DWK used for wrapping'
            );
            if (decryptError instanceof Error) {
                debug.error('Detailed decrypt error:', {
                    error: decryptError.message,
                    name: decryptError.name,
                    ivLength: wrappedKey.iv.byteLength,
                    wrappedLength: wrappedKey.wrapped.byteLength,
                    dwkAlgorithm: this.deviceWrapKey ? 'AES-GCM-256' : 'N/A',
                });
            } else {
                debug.error('Detailed decrypt error (non-Error):', decryptError);
            }

            debug.error('Possible causes:');
            debug.error('1. Password entered incorrectly (different from original)');
            debug.error('2. Salt corruption or mismatch in stored data');
            debug.error('3. KDF parameters changed between wrapping and unwrapping');
            debug.error('4. DWK derivation inconsistency');

            throw decryptError;
        }

        // The stored record holds the retained signaling key (HKDF of the conversation root).
        const signalingKey = await crypto.subtle.importKey(
            'raw',
            recordBytes,
            { name: 'AES-GCM', length: 256 },
            false, // non-extractable
            ['encrypt', 'decrypt']
        );
        this.zeroizeArrayBuffer(recordBytes);
        this.conversationKeys.set(keyId, signalingKey);
        return signalingKey;
    }

    public getConversationKey(keyId: string): CryptoKey | null {
        return this.conversationKeys.get(keyId) || null;
    }

    /** Compress + AES-GCM encrypt a message under an explicit key into a SharePayload. */
    private async encryptPayloadWithKey(
        convKey: CryptoKey,
        keyId: string,
        message: Uint8Array,
        additionalData?: Uint8Array
    ): Promise<SharePayload> {
        // Compress the message data with pako to match CryptoService.decryptMessage expectations
        const { deflate } = await import('pako');
        let messageToEncrypt: Uint8Array<ArrayBuffer>;
        try {
            messageToEncrypt = deflate(message) as Uint8Array<ArrayBuffer>;
            debug.log(
                `ENCRYPT: Compressed message from ${message.length} to ${messageToEncrypt.length} bytes`
            );
        } catch (error) {
            debug.warn(`ENCRYPT: Compression failed, using raw message:`, error as any);
            messageToEncrypt = message as Uint8Array<ArrayBuffer>;
        }

        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
                {
                    name: 'AES-GCM',
                    iv: nonce,
                    ...(additionalData ? { additionalData } : {}),
                },
                convKey,
                messageToEncrypt
            )
        );

        return {
            v: 1,
            keyId,
            n: this.uint8ArrayToBase64(nonce),
            c: this.uint8ArrayToBase64(ciphertext),
            ts: Date.now(),
            ...(additionalData ? { ad: this.uint8ArrayToBase64(additionalData) } : {}),
        };
    }

    /** AES-GCM decrypt + decompress a SharePayload under an explicit key. */
    private async decryptPayloadWithKey(
        convKey: CryptoKey,
        payload: SharePayload
    ): Promise<Uint8Array> {
        const nonce = (
            typeof payload.n === 'string'
                ? this.base64ToUint8Array(payload.n)
                : new Uint8Array(payload.n)
        ) as Uint8Array<ArrayBuffer>;
        const ciphertext = (
            typeof payload.c === 'string'
                ? this.base64ToUint8Array(payload.c)
                : new Uint8Array(payload.c)
        ) as Uint8Array<ArrayBuffer>;
        const additionalData = payload.ad
            ? ((typeof payload.ad === 'string'
                  ? this.base64ToUint8Array(payload.ad)
                  : new Uint8Array(payload.ad)) as Uint8Array<ArrayBuffer>)
            : undefined;

        const encryptedData = new Uint8Array(
            await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: nonce,
                    ...(additionalData ? { additionalData } : {}),
                },
                convKey,
                ciphertext
            )
        );

        // Decompress the decrypted data with pako (messages are compressed before encryption)
        const { inflate } = await import('pako');
        let plaintext: Uint8Array;
        try {
            plaintext = inflate(encryptedData);
            debug.log(
                `DECRYPT: Decompressed message from ${encryptedData.length} to ${plaintext.length} bytes`
            );
        } catch (error) {
            debug.warn(`DECRYPT: Decompression failed, using raw decrypted data:`, error as any);
            plaintext = encryptedData;
        }

        return plaintext;
    }

    /**
     * Create share payload encrypted under the *static* conversation (signaling) key.
     * Used for at-rest storage fallback and ephemeral call invitations — i.e. content
     * that must remain decryptable beyond the forward-secrecy window. Async chat
     * messages must use createMessageSharePayload instead (forward secrecy).
     */
    public async createSharePayload(
        keyId: string,
        message: Uint8Array,
        additionalData?: Uint8Array
    ): Promise<SharePayload> {
        const convKey = this.getConversationKey(keyId);
        if (!convKey) {
            throw new Error(`Conversation key not loaded for ${keyId}`);
        }
        return this.encryptPayloadWithKey(convKey, keyId, message, additionalData);
    }

    /**
     * Open a share payload encrypted under the static conversation (signaling) key.
     */
    public async openSharePayload(payload: SharePayload): Promise<Uint8Array> {
        const convKey = this.getConversationKey(payload.keyId);
        if (!convKey) {
            throw new Error(`Conversation key not loaded for ${payload.keyId}`);
        }
        return this.decryptPayloadWithKey(convKey, payload);
    }

    /**
     * Create a forward-secret share payload for an async chat message: encrypts with
     * today's rotating daily message key (see the Forward Secrecy section in README.md), not the static
     * conversation key. A seized device that has discarded an old day's chain key can no
     * longer decrypt codes from that day.
     */
    public async createMessageSharePayload(
        keyId: string,
        message: Uint8Array
    ): Promise<SharePayload> {
        const dayKey = await this.getSendMessageKey(keyId);
        return this.encryptPayloadWithKey(dayKey, keyId, message);
    }

    /**
     * Open a forward-secret message payload by trial-decrypting against the retained daily
     * keys (newest first). The GCM auth tag identifies the correct day; throws if none of
     * the retained keys authenticate (code older than the window or wrong conversation).
     */
    public async openMessageSharePayload(
        payload: SharePayload,
        keyId: string
    ): Promise<Uint8Array> {
        const dayKeys = await this.getReceiveMessageKeys(keyId);
        let lastError: unknown = null;
        for (const dayKey of dayKeys) {
            try {
                return await this.decryptPayloadWithKey(dayKey, payload);
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError ?? new Error('No retained daily key authenticated the message payload');
    }

    private uint8ArrayToBase64(bytes: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }

        if (typeof btoa === 'function') {
            return btoa(binary);
        }

        // Node.js fallback
        return Buffer.from(binary, 'binary').toString('base64');
    }

    private base64ToUint8Array(base64: string): Uint8Array {
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

        return bytes;
    }

    public hasConversationKey(keyId: string): boolean {
        return this.conversationKeys.has(keyId);
    }

    public hasDWK(): boolean {
        return !!this.deviceWrapKey;
    }

    public async encryptWithDWK(
        data: Uint8Array
    ): Promise<{ encrypted: ArrayBuffer; iv: ArrayBuffer }> {
        if (!this.deviceWrapKey) {
            throw new Error('Session must be unlocked to encrypt with DWK');
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            this.deviceWrapKey,
            data as Uint8Array<ArrayBuffer>
        );
        return { encrypted, iv: iv.buffer as ArrayBuffer };
    }

    public async decryptWithDWK(encrypted: ArrayBuffer, iv: ArrayBuffer): Promise<Uint8Array> {
        if (!this.deviceWrapKey) {
            throw new Error('Session must be unlocked to decrypt with DWK');
        }
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            this.deviceWrapKey,
            encrypted
        );
        return new Uint8Array(decrypted);
    }

    public removeConversationKey(keyId: string): void {
        this.conversationKeys.delete(keyId);
    }

    public getLoadedKeyIds(): string[] {
        return Array.from(this.conversationKeys.keys());
    }

    /**
     * Check if conversation key exists in storage (even if session is locked)
     */
    public async hasConversationKeyInStorage(keyId: string): Promise<boolean> {
        try {
            const wrappedKey = await this.getStoredWrappedKey(keyId);
            return wrappedKey !== null;
        } catch (error) {
            debug.warn(`Failed to check storage for key ${keyId}:`, error);
            return false;
        }
    }

    /**
     * Check session state for a conversation key
     * Returns: 'available' | 'locked' | 'not_found'
     */
    public async getKeyAvailabilityState(
        keyId: string
    ): Promise<'available' | 'locked' | 'not_found'> {
        if (this.hasConversationKey(keyId)) {
            return 'available';
        }

        if (this.isSessionLocked()) {
            const hasInStorage = await this.hasConversationKeyInStorage(keyId);
            return hasInStorage ? 'locked' : 'not_found';
        }

        const hasInStorage = await this.hasConversationKeyInStorage(keyId);
        if (hasInStorage) {
            try {
                await this.unwrapConversationKey(keyId);
                return 'available';
            } catch (error) {
                debug.warn(`Failed to unwrap key ${keyId} despite unlocked session:`, error);
                return 'locked'; // Likely needs password re-entry
            }
        }

        return 'not_found';
    }

    private formatDuration(ms: number): string {
        const totalMinutes = Math.ceil(ms / (60 * 1000));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else if (minutes >= 1) {
            return `${minutes}m`;
        } else {
            return 'less than 1m';
        }
    }

    private zeroizeArrayBuffer(buffer: ArrayBuffer): void {
        const view = new Uint8Array(buffer);
        crypto.getRandomValues(view);
        view.fill(0);
    }

    private async storeWrappedKey(wrappedKey: WrappedKey): Promise<void> {
        const keys = await this.getStoredWrappedKeys();
        const filtered = keys.filter((k) => k.keyId !== wrappedKey.keyId);
        filtered.push(wrappedKey);

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(
                'secure-wrapped-keys',
                JSON.stringify(
                    filtered.map((k) => ({
                        ...k,
                        wrapped: Array.from(new Uint8Array(k.wrapped)),
                        iv: Array.from(new Uint8Array(k.iv)),
                        kdfParams: {
                            ...k.kdfParams,
                            salt: Array.from(k.kdfParams.salt),
                        },
                    }))
                )
            );
        }
    }

    private async getStoredWrappedKey(keyId: string): Promise<WrappedKey | null> {
        const keys = await this.getStoredWrappedKeys();
        return keys.find((k) => k.keyId === keyId) || null;
    }

    private async getStoredWrappedKeys(): Promise<WrappedKey[]> {
        if (typeof localStorage === 'undefined') {
            return [];
        }

        const stored = localStorage.getItem('secure-wrapped-keys');
        if (!stored) {
            return [];
        }

        try {
            const parsed = JSON.parse(stored);

            // Check for corrupted data (empty objects instead of arrays)
            const hasCorruptedData = parsed.some(
                (k: any) => !Array.isArray(k.wrapped) || !Array.isArray(k.iv)
            );

            if (hasCorruptedData) {
                debug.warn(
                    'Detected corrupted wrapped keys (ArrayBuffer serialization issue), clearing storage'
                );
                this.clearCorruptedStorage();
                return [];
            }

            return parsed.map((k: any) => {
                const wrapped = new Uint8Array(k.wrapped).buffer;
                const iv = new Uint8Array(k.iv).buffer;

                debug.log(
                    `Converting stored key ${k.keyId}: wrapped=${k.wrapped.length} bytes -> ${wrapped.byteLength} bytes, iv=${k.iv.length} bytes -> ${iv.byteLength} bytes`
                );

                return {
                    ...k,
                    wrapped,
                    iv,
                    kdfParams: {
                        ...k.kdfParams,
                        salt: new Uint8Array(k.kdfParams.salt),
                    },
                };
            });
        } catch {
            return [];
        }
    }

    private restoreLockoutState(): void {
        if (typeof localStorage === 'undefined') return;

        try {
            const stored = localStorage.getItem(this.LOCKOUT_STORAGE_KEY);
            if (stored) {
                const lockoutData = JSON.parse(stored);
                this.failedAttempts = lockoutData.failedAttempts || 0;
                this.lockoutUntil = lockoutData.lockoutUntil || null;

                if (this.lockoutUntil && Date.now() >= this.lockoutUntil) {
                    this.resetFailedAttempts();
                }
            }
        } catch (error) {
            debug.warn('Failed to restore lockout state:', error);
            this.resetFailedAttempts();
        }
    }

    /**
     * Record a failed unlock attempt with exponential backoff
     * Formula: lockout = min(BASE * 2^(attempts-3), MAX_LOCKOUT)
     */
    private recordFailedAttempt(): void {
        this.failedAttempts++;

        // Start lockout after 3rd failed attempt
        if (this.failedAttempts >= 3) {
            // Exponential backoff: 30s, 1m, 2m, 4m, 8m, 16m, 32m, 1h, 2h, 4h, 8h, 16h, 24h
            const exponentialMultiplier = Math.pow(2, this.failedAttempts - 3);
            const lockoutDuration = Math.min(
                this.BASE_LOCKOUT_DURATION_MS * exponentialMultiplier,
                this.MAX_LOCKOUT_DURATION_MS
            );

            this.lockoutUntil = Date.now() + lockoutDuration;
            const timeStr = this.formatDuration(lockoutDuration);

            debug.warn(
                `Failed attempt ${this.failedAttempts}/${this.MAX_FAILED_ATTEMPTS}. Locked out for ${timeStr} until ${new Date(this.lockoutUntil).toLocaleTimeString()}`
            );
        } else {
            debug.warn(
                `Failed attempt ${this.failedAttempts}/${this.MAX_FAILED_ATTEMPTS}. ${3 - this.failedAttempts} more attempts before lockout.`
            );
        }

        this.saveLockoutState();
    }

    private resetFailedAttempts(): void {
        this.failedAttempts = 0;
        this.lockoutUntil = null;
        this.clearLockoutState();
    }

    public isLockedOut(): boolean {
        if (!this.lockoutUntil) return false;

        if (Date.now() >= this.lockoutUntil) {
            // Lockout expired
            this.resetFailedAttempts();
            return false;
        }

        return true;
    }

    public getLockoutRemainingMs(): number {
        if (!this.isLockedOut()) return 0;
        return Math.max(0, this.lockoutUntil! - Date.now());
    }

    public getFailedAttempts(): number {
        return this.failedAttempts;
    }

    public getNextLockoutDuration(): number {
        const nextAttempts = this.failedAttempts + 1;
        if (nextAttempts < 3) return 0;

        const exponentialMultiplier = Math.pow(2, nextAttempts - 3);
        return Math.min(
            this.BASE_LOCKOUT_DURATION_MS * exponentialMultiplier,
            this.MAX_LOCKOUT_DURATION_MS
        );
    }

    private saveLockoutState(): void {
        if (typeof localStorage === 'undefined') return;

        try {
            localStorage.setItem(
                this.LOCKOUT_STORAGE_KEY,
                JSON.stringify({
                    failedAttempts: this.failedAttempts,
                    lockoutUntil: this.lockoutUntil,
                })
            );
        } catch (error) {
            debug.warn('Failed to save lockout state:', error);
        }
    }

    private clearLockoutState(): void {
        if (typeof localStorage === 'undefined') return;

        try {
            localStorage.removeItem(this.LOCKOUT_STORAGE_KEY);
        } catch (error) {
            debug.warn('Failed to clear lockout state:', error);
        }
    }
}

export const secureKeyManager = new SecureKeyManager();

// Binary payload format helpers
// v2 layout: [0x02 version][12 IV][ciphertext] — base64url-encoded.
// The conversation id and timestamp are deliberately NOT serialized: receivers
// trial-decrypt against their chats anyway, and a plaintext keyId/timestamp in
// the URL would leak metadata the app promises to hide.
// v1 (legacy, read-only): [0x01][1 keyIdLen][keyId UTF-8][4 ts uint32LE seconds][12 IV][ciphertext]
// First byte distinguishes from legacy JSON payloads (which start with 0x7B '{').

function _b64encode(binary: string): string {
    if (typeof btoa === 'function') return btoa(binary);
    return Buffer.from(binary, 'binary').toString('base64');
}

function _b64decode(encoded: string): string {
    // Accept both base64url (v2) and standard base64 (v1 legacy)
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    if (typeof atob === 'function') return atob(base64);
    return Buffer.from(base64, 'base64').toString('binary');
}

function _b64urlEncode(binary: string): string {
    return _b64encode(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Serialize a SharePayload to a compact binary base64url string.
 * Emits the v2 format, which carries no plaintext metadata (no keyId, no timestamp).
 */
export function serializeBinaryPayload(payload: SharePayload): string {
    if (payload.ad) {
        // The binary format has no field for associated data; serializing would
        // silently produce an undecryptable link.
        throw new Error('additionalData is not supported in binary share payloads');
    }

    const ivBinary = _b64decode(payload.n as string);
    const ctBinary = _b64decode(payload.c as string);

    const buf = new Uint8Array(1 + ivBinary.length + ctBinary.length);
    let offset = 0;

    buf[offset++] = 0x02; // version
    for (let i = 0; i < ivBinary.length; i++) buf[offset++] = ivBinary.charCodeAt(i);
    for (let i = 0; i < ctBinary.length; i++) buf[offset++] = ctBinary.charCodeAt(i);

    let binary = '';
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    return _b64urlEncode(binary);
}

/**
 * Deserialize a binary payload (v1 or v2) back into a SharePayload.
 * v2 payloads carry no keyId/timestamp; callers must set keyId to the chat
 * being tried before passing to openSharePayload.
 * Throws if the data does not begin with a known version byte.
 */
export function deserializeBinaryPayload(encoded: string): SharePayload {
    const binary = _b64decode(encoded);

    let offset = 0;
    const version = binary.charCodeAt(offset++);

    if (version === 0x02) {
        const n = _b64encode(binary.slice(offset, offset + 12));
        offset += 12;
        const c = _b64encode(binary.slice(offset));
        return { v: 2, keyId: '', n, c, ts: 0 };
    }

    if (version !== 0x01) throw new Error(`Unknown binary payload version: ${version}`);

    const keyIdLen = binary.charCodeAt(offset++);
    const keyId = binary.slice(offset, offset + keyIdLen);
    offset += keyIdLen;

    // Timestamp uint32 LE (seconds → ms)
    const ts =
        ((binary.charCodeAt(offset) |
            (binary.charCodeAt(offset + 1) << 8) |
            (binary.charCodeAt(offset + 2) << 16) |
            (binary.charCodeAt(offset + 3) << 24)) >>>
            0) *
        1000;
    offset += 4;

    const n = _b64encode(binary.slice(offset, offset + 12));
    offset += 12;
    const c = _b64encode(binary.slice(offset));

    return { v: 1, keyId, n, c, ts };
}
