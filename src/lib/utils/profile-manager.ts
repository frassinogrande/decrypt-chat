import { writable } from 'svelte/store';
import { deriveKeyFromPassword, deriveBitsFromPassword } from './crypto';
import { debug } from './debug';
import type { UserProfile, ProfileSettings, ProfileLockState } from '../types';
import { generateUUID } from './crypto';
import { secureKeyManager } from './secure-key-manager';
import { activityTracker } from './activity-tracker';

const PROFILE_STORAGE_KEY = 'encrypted-profile-data';
const PROFILE_SETTINGS_KEY = 'profile-settings';
const PROFILE_SALT_KEY = 'profile-salt';
const PROFILE_KDF_ITERATIONS_KEY = 'profile-kdf-iterations';
const LAST_ACTIVITY_KEY = 'profile-last-activity';
const SESSION_DERIVED_KEY_KEY = 'profile-session-derived-key';

const KDF_ITERATIONS_LEGACY = 100000; // used by profiles created before the security upgrade
const KDF_ITERATIONS_CURRENT = 600000;

interface EncryptedProfileData {
    data: string;
    iv: string;
}

export class ProfileManager {
    private currentProfile = writable<UserProfile | undefined>(undefined);
    private profileSettings = writable<ProfileSettings>({
        autoLockTimeout: -1, // Manual only by default
        hideMessagesOnHomepage: false, // Show messages by default
        showInstantLockButton: false, // Quick lock button hidden by default
        enterKeySendsMessage: true, // Enter key sends by default
        use24HourTime: false, // 12-hour format by default
        themePreference: 'system',
    });
    private _lockState = writable<ProfileLockState>({
        isLocked: true, // Start locked by default until we determine the actual state
        isInitializing: true,
    });

    private masterPasswordHash: string | null = null;
    private profileSalt: Uint8Array | null = null;
    // The profile-encryption key for the current unlocked session, kept in memory so
    // non-credential edits (contact methods) can re-encrypt without re-prompting for
    // the master password. Held for the whole session regardless of auto-lock mode,
    // and wiped on lock via clearSessionDerivedKey(). Never persisted from here.
    private sessionEncryptionKey: CryptoKey | null = null;
    private autoLockTimer: number | null = null;
    private unlockTimeout: number | null = null;
    private _isLocking = false;

    /**
     * Resolves once initializeLockState() has settled (session restored or confirmed
     * locked). Callers that need the final lock state on startup — e.g. the page's
     * incoming-link processor — should await this before acting, to avoid prompting
     * for unlock while a cross-tab session handoff is still in flight.
     */
    public readonly ready: Promise<void>;
    private _readyResolve: (() => void) | null = null;

    // Same-origin cross-tab session handoff (see setupSessionSync). Lets a freshly
    // opened tab (e.g. one spawned by opening a share link) inherit the unlocked
    // session from a sibling tab in memory, without persisting keys to disk.
    private sessionSyncChannel: BroadcastChannel | null = null;

    constructor() {
        this.ready = new Promise((resolve) => {
            this._readyResolve = resolve;
        });

        // Clean up any legacy data
        if (typeof window !== 'undefined') {
            localStorage.removeItem('profile-lock-reason');
        }

        this.initializeBrowserEvents();
        this.setupSessionSync();
        activityTracker.initialize();
        this.initializeLockState()
            .catch((error) => {
                debug.error('Failed to initialize lock state:', error);
            })
            .finally(() => this._readyResolve?.());
    }

    /**
     * Set up the BroadcastChannel responder that hands this tab's active session to a
     * sibling tab that requests it. Only an unlocked tab (one that still holds session
     * material) responds; the material is transferred in memory and lands in the
     * requesting tab's sessionStorage — never written to disk beyond where unlock
     * already stores it.
     */
    private setupSessionSync(): void {
        if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
            return;
        }
        try {
            this.sessionSyncChannel = new BroadcastChannel('ec-session-sync');
            this.sessionSyncChannel.onmessage = (event) => {
                const msg = event.data;
                if (!msg || msg.type !== 'session-request') return;

                // Only respond if this tab currently holds an active session. The
                // material is cleared on lock, so its presence means we're unlocked.
                const derivedKey = sessionStorage.getItem(SESSION_DERIVED_KEY_KEY);
                const passwordBlob =
                    sessionStorage.getItem('profile-session-password') ||
                    localStorage.getItem('profile-session-password');
                if (derivedKey && passwordBlob) {
                    this.sessionSyncChannel?.postMessage({
                        type: 'session-response',
                        nonce: msg.nonce,
                        derivedKey,
                        passwordBlob,
                    });
                }
            };
        } catch (error) {
            debug.warn('Failed to set up cross-tab session sync:', error);
        }
    }

    /**
     * Ask sibling tabs for the active session over BroadcastChannel. Resolves true if a
     * tab responded and the material was written into this tab's storage (so the normal
     * unlock path can pick it up), false on timeout or if BroadcastChannel is missing.
     */
    private requestSessionFromPeers(timeoutMs = 600): Promise<boolean> {
        return new Promise((resolve) => {
            if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
                resolve(false);
                return;
            }

            let channel: BroadcastChannel;
            try {
                channel = new BroadcastChannel('ec-session-sync');
            } catch {
                resolve(false);
                return;
            }

            const nonce = generateUUID();
            let settled = false;
            const finish = (ok: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                channel.close();
                resolve(ok);
            };

            channel.onmessage = (event) => {
                const msg = event.data;
                if (!msg || msg.type !== 'session-response' || msg.nonce !== nonce) return;
                if (msg.derivedKey && msg.passwordBlob) {
                    sessionStorage.setItem(SESSION_DERIVED_KEY_KEY, msg.derivedKey);
                    const storage =
                        this.getStorageForTimeout(this.getCurrentSettings().autoLockTimeout) ??
                        sessionStorage;
                    storage.setItem('profile-session-password', msg.passwordBlob);
                    finish(true);
                }
            };

            const timer = setTimeout(() => finish(false), timeoutMs);
            channel.postMessage({ type: 'session-request', nonce });
        });
    }

    /**
     * Initialize the correct lock state based on whether a profile exists and lock settings
     */
    private async initializeLockState(): Promise<void> {
        if (typeof window === 'undefined') return;

        if (this.hasProfile()) {
            const settings = this.loadProfileSettings();

            // Set the loaded settings to the store so UI components can access them
            this.profileSettings.set(settings);
            secureKeyManager.setAutoLockPolicy(settings.autoLockTimeout);

            if (settings.autoLockTimeout === -1 || settings.autoLockTimeout === -3) {
                // "After a new session" or "manual only" (less secure) - try stored unlock
                await this.attemptSessionUnlock();
            } else if (settings.autoLockTimeout === -2) {
                // "On every page refresh" - always lock on page load
                this._lockState.set({
                    isLocked: true,
                    isInitializing: false,
                });
            } else {
                // For timed timeout modes (5 min, 15 min, etc.) - check if timer expired
                const shouldLock = this.checkInactivityTimeout(settings.autoLockTimeout);

                if (shouldLock) {
                    this.clearSessionDerivedKey();
                    this._lockState.set({
                        isLocked: true,
                        isInitializing: false,
                    });
                } else {
                    await this.attemptSessionUnlock();
                }
            }
        } else {
            this._lockState.set({
                isLocked: true,
                isInitializing: false,
            });
        }
    }

    /**
     * Attempt to unlock profile using session-stored derived key for manual lock mode
     */
    private async attemptSessionUnlock(): Promise<void> {
        let sessionKey = await this.loadSessionDerivedKey();

        // No local session — likely a freshly opened tab (e.g. opening a share link
        // spawns a new tab with empty sessionStorage). Try to inherit the session from
        // a sibling tab that's already unlocked before falling back to a password prompt.
        if (!sessionKey) {
            const adopted = await this.requestSessionFromPeers();
            if (adopted) {
                sessionKey = await this.loadSessionDerivedKey();
            }
        }

        if (sessionKey) {
            if (this.loadProfileSalt()) {
                try {
                    const profile = await this.loadEncryptedProfileWithKey(sessionKey);

                    if (profile) {
                        let sessionUnlocked = false;

                        const sessionPassword = await this.loadSessionPassword();
                        if (sessionPassword) {
                            try {
                                await secureKeyManager.unlockSession(sessionPassword);
                                sessionUnlocked = true;
                            } catch (error) {
                                debug.warn(
                                    'Failed to unlock SecureKeyManager from session:',
                                    error
                                );
                                secureKeyManager.lockSession();
                            }
                        }

                        // If password unlock failed or no password cached, try session restore (manual mode)
                        if (!sessionUnlocked) {
                            secureKeyManager.restoreSessionFromProfileManager();
                            sessionUnlocked = !secureKeyManager.isSessionLocked();
                        }

                        if (!sessionUnlocked) {
                            debug.warn(
                                'Session unlock via cached credentials failed - requiring full password entry'
                            );
                            this._lockState.set({
                                isLocked: true,
                                isInitializing: false,
                            });
                            this.clearSessionDerivedKey();
                            secureKeyManager.lockSession();
                            return;
                        }

                        this.masterPasswordHash = 'session-unlocked'; // Placeholder since we don't have the actual password

                        this.currentProfile.set(profile);

                        // ONLY set lock state to unlocked AFTER SecureKeyManager is ready
                        this._lockState.set({
                            isLocked: false,
                            unlockTimestamp: Date.now(),
                            isInitializing: false,
                        });

                        this.updateLastActivity();
                        // Also update activity tracker to reset the timer immediately
                        activityTracker.updateActivity();
                        this.startAutoLockTimer();
                        this.registerLockCallback();

                        return;
                    }
                } catch (error) {
                    debug.error('Failed to load profile from session:', error);
                }
            }
        }

        // If we get here, session unlock failed - require password
        this._lockState.set({
            isLocked: true,
            isInitializing: false,
        });

        this.clearSessionDerivedKey();
    }

    private initializeBrowserEvents(): void {
        if (typeof window === 'undefined') return;
        // No event listeners needed for the simplified auto-lock system
    }

    /**
     * Get current settings value synchronously
     */
    private getCurrentSettings(): ProfileSettings {
        let currentSettings: ProfileSettings = {
            autoLockTimeout: -1,
            hideMessagesOnHomepage: false,
            showInstantLockButton: false,
            enterKeySendsMessage: true,
            use24HourTime: false,
            themePreference: 'system',
        };
        this.profileSettings.subscribe((settings) => {
            currentSettings = settings;
        })(); // Immediately unsubscribe after getting value
        return currentSettings;
    }

    private checkInactivityTimeout(timeoutMinutes: number): boolean {
        if (typeof window === 'undefined') return false;

        const isExpired = activityTracker.isTimeoutExceeded(timeoutMinutes);

        // Do NOT update activity timestamp during timeout checking - only update on actual user activity

        return isExpired;
    }

    private updateLastActivity(): void {
        if (typeof window !== 'undefined') {
            localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());
        }
    }

    async createProfile(masterPassword: string): Promise<UserProfile> {
        try {
            this.profileSalt = crypto.getRandomValues(new Uint8Array(16));

            this.masterPasswordHash = await this.hashPassword(masterPassword, this.profileSalt);

            const profile: UserProfile = {
                id: generateUUID(),
                createdAt: Date.now(),
            };

            await this.saveEncryptedProfile(profile, masterPassword);

            await this.saveProfileSettings();
            this.saveProfileSalt();

            // Apply the auto-lock policy for the new profile immediately. Until now
            // initializeLockState() ran with no profile and never set it, so the policy
            // is still at its default (-2, "lock on every refresh"). Without this, the
            // beforeunload handler would lock and wipe the session on the very first
            // refresh, forcing an unnecessary password prompt.
            secureKeyManager.setAutoLockPolicy(this.getCurrentSettings().autoLockTimeout);

            await this.saveSessionDerivedKey(masterPassword);

            debug.log('ProfileManager: Clearing old keys for new profile...');
            secureKeyManager.clearCorruptedStorage(); // Clear old validation keys
            debug.log('ProfileManager: Unlocking SecureKeyManager session...');
            await secureKeyManager.unlockSession(masterPassword);
            debug.log('ProfileManager: Session unlocked successfully');

            debug.log('ProfileManager: Storing validation key...');
            await secureKeyManager.storeValidationKey();
            debug.log('ProfileManager: Validation key stored successfully');

            this.currentProfile.set(profile);
            this._lockState.update((state) => ({
                ...state,
                isLocked: false,
                unlockTimestamp: Date.now(),
                isInitializing: false,
            }));

            this.updateLastActivity();
            // Also update activity tracker to reset the timer immediately
            activityTracker.updateActivity();

            this.startAutoLockTimer();
            this.registerLockCallback();

            return profile;
        } catch (error) {
            debug.error('Failed to create profile:', error);
            throw new Error('Failed to create profile');
        }
    }

    async unlockProfile(masterPassword: string): Promise<UserProfile | null> {
        try {
            if (!this.loadProfileSalt()) {
                throw new Error('No profile found');
            }

            const passwordHash = await this.hashPassword(masterPassword, this.profileSalt!);

            // Profile settings are stored unencrypted (they are needed before unlock); the
            // password itself is verified against the encrypted profile loaded below.
            const settings = this.loadProfileSettings();

            const profile = await this.loadEncryptedProfile(masterPassword);
            if (!profile) {
                throw new Error('Invalid password or corrupted profile');
            }

            this.masterPasswordHash = passwordHash;

            await this.saveSessionDerivedKey(masterPassword);

            const { secureKeyManager } = await import('./secure-key-manager');

            // Apply the profile's auto-lock policy. When unlocking outside the normal
            // boot flow (e.g. right after a backup restore, where initializeLockState
            // ran with no profile), the policy is still at its default (-2, "lock on
            // every refresh") and the beforeunload handler would wipe this session on
            // the reload that follows.
            secureKeyManager.setAutoLockPolicy(settings.autoLockTimeout);

            try {
                await secureKeyManager.unlockSession(masterPassword);
            } catch (secureKeyError) {
                throw new Error(
                    'Key storage could not be unlocked. If this persists, reset your secure storage in Settings.'
                );
            }

            // Update stores - but don't unlock until SecureKeyManager is ready
            this.currentProfile.set(profile);
            this.profileSettings.set(settings);

            // ONLY set lock state to unlocked AFTER SecureKeyManager is ready
            this._lockState.update((state) => ({
                ...state,
                isLocked: false,
                unlockTimestamp: Date.now(),
                isInitializing: false,
            }));

            this.updateLastActivity();
            // Also update activity tracker to reset the timer immediately
            activityTracker.updateActivity();

            this.startAutoLockTimer();
            this.registerLockCallback();

            return profile;
        } catch (error) {
            debug.error('Failed to unlock profile:', error);
            return null;
        }
    }

    async lockProfile(): Promise<void> {
        if (this._isLocking) return;
        this._isLocking = true;
        try {
            const { secureKeyManager } = await import('./secure-key-manager');
            // Deregister callback before calling lockSession to prevent re-entrant notification
            secureKeyManager.setProfileLockCallback(null);
            secureKeyManager.lockSession();

            this.masterPasswordHash = null;

            this.clearSessionDerivedKey();

            this.clearAutoLockTimer();
            this.clearUnlockTimeout();

            this.currentProfile.set(undefined);
            this._lockState.update((state) => ({
                ...state,
                isLocked: true,
                unlockTimestamp: undefined,
                isInitializing: false,
            }));

            debug.log('Profile locked');
        } finally {
            this._isLocking = false;
        }
    }

    /**
     * Verify current password by attempting to decrypt the profile
     */
    async verifyPassword(password: string): Promise<boolean> {
        try {
            if (!this.profileSalt) {
                return false;
            }

            const profile = await this.loadEncryptedProfile(password);
            return profile !== null;
        } catch (error) {
            debug.error('Password verification failed:', error);
            return false;
        }
    }

    /**
     * Update profile information.
     *
     * Editing non-credential profile data (contact methods) doesn't require the
     * master password: the profile is already unlocked, so we re-encrypt with the
     * in-session derived key. Pass `currentPassword` only when the caller wants to
     * verify it as a side effect (e.g. the account-deletion confirmation).
     */
    async updateProfile(
        updates: Partial<Pick<UserProfile, 'contacts'>>,
        currentPassword?: string
    ): Promise<boolean> {
        try {
            const currentProfile = await new Promise<UserProfile | undefined>((resolve) => {
                this.currentProfile.subscribe(resolve)();
            });

            if (!currentProfile || !this.masterPasswordHash) {
                throw new Error('Profile not unlocked');
            }

            if (!this.profileSalt) {
                throw new Error('Profile salt not found');
            }

            if (currentPassword !== undefined) {
                if (this.masterPasswordHash === 'session-unlocked') {
                    const isValid = await this.verifyPassword(currentPassword);
                    if (!isValid) {
                        throw new Error('Invalid current password');
                    }
                } else {
                    const passwordHash = await this.hashPassword(currentPassword, this.profileSalt);
                    if (passwordHash !== this.masterPasswordHash) {
                        throw new Error('Invalid current password');
                    }
                }
            }

            const updatedProfile: UserProfile = {
                ...currentProfile,
                ...updates,
            };

            // Re-encrypt. With a password, derive the key from it; otherwise reuse
            // the unlocked session's derived key (identical key material) so the
            // user isn't forced to re-enter their master password for a contact edit.
            if (currentPassword !== undefined) {
                await this.saveEncryptedProfile(updatedProfile, currentPassword);
            } else {
                const sessionKey =
                    this.sessionEncryptionKey ?? (await this.loadSessionDerivedKey());
                if (sessionKey) {
                    await this.saveEncryptedProfileWithKey(updatedProfile, sessionKey);
                } else {
                    const sessionPassword = await this.loadSessionPassword();
                    if (!sessionPassword) {
                        throw new Error('No active session available to save profile');
                    }
                    await this.saveEncryptedProfile(updatedProfile, sessionPassword);
                }
            }

            this.currentProfile.set(updatedProfile);

            return true;
        } catch (error) {
            debug.error('Failed to update profile:', error);
            return false;
        }
    }

    async changeMasterPassword(currentPassword: string, newPassword: string): Promise<boolean> {
        try {
            const currentProfile = await new Promise<UserProfile | undefined>((resolve) => {
                this.currentProfile.subscribe(resolve)();
            });

            if (!currentProfile || !this.masterPasswordHash || !this.profileSalt) {
                throw new Error('Profile not unlocked');
            }

            if (this.masterPasswordHash === 'session-unlocked') {
                const isValid = await this.verifyPassword(currentPassword);
                if (!isValid) {
                    throw new Error('Invalid current password');
                }
            } else {
                const currentPasswordHash = await this.hashPassword(
                    currentPassword,
                    this.profileSalt
                );
                if (currentPasswordHash !== this.masterPasswordHash) {
                    throw new Error('Invalid current password');
                }
            }

            const newSalt = crypto.getRandomValues(new Uint8Array(16));
            const newPasswordHash = await this.hashPassword(newPassword, newSalt);

            await this.saveEncryptedProfile(currentProfile, newPassword, newSalt);

            this.profileSalt = newSalt;
            this.masterPasswordHash = newPasswordHash;
            this.saveProfileSalt();

            debug.log('Master password changed successfully');
            return true;
        } catch (error) {
            debug.error('Failed to change master password:', error);
            return false;
        }
    }

    async updateSettings(newSettings: ProfileSettings): Promise<void> {
        const normalizedSettings = this.normalizeSettings(newSettings);
        const oldSettings = this.getCurrentSettings();

        const oldStorage = this.getStorageForTimeout(oldSettings.autoLockTimeout);
        const newStorage = this.getStorageForTimeout(normalizedSettings.autoLockTimeout);

        if (!newStorage) {
            this.clearSessionDerivedKey();
        } else if (oldStorage && newStorage !== oldStorage) {
            this.moveStoredUnlock(oldStorage, newStorage);
        }

        this.profileSettings.set(normalizedSettings);
        await this.saveProfileSettings(normalizedSettings);

        secureKeyManager.setAutoLockPolicy(normalizedSettings.autoLockTimeout);

        this.startAutoLockTimer();
    }

    hasProfile(): boolean {
        if (typeof window === 'undefined') return false;
        return localStorage.getItem(PROFILE_STORAGE_KEY) !== null;
    }

    async deleteProfile(): Promise<void> {
        this.lockProfile();

        if (typeof window !== 'undefined') {
            localStorage.removeItem(PROFILE_STORAGE_KEY);
            localStorage.removeItem(PROFILE_SETTINGS_KEY);
            localStorage.removeItem(PROFILE_SALT_KEY);
            localStorage.removeItem(LAST_ACTIVITY_KEY);
        }

        this.profileSettings.set({
            autoLockTimeout: -1,
            hideMessagesOnHomepage: false,
            showInstantLockButton: false,
            enterKeySendsMessage: true,
            use24HourTime: false,
            themePreference: 'system',
        });
    }

    async deleteAllData(): Promise<void> {
        // Import necessary modules dynamically to avoid circular dependencies
        const { chatStorage } = await import('./chat-storage');
        const { storage } = await import('./storage');

        try {
            // Lock profile first to clear sensitive data from memory
            this.lockProfile();

            if (typeof window !== 'undefined' && 'indexedDB' in window) {
                const deleteRequest = indexedDB.deleteDatabase('decrypt-chat-data');
                await new Promise<void>((resolve, reject) => {
                    deleteRequest.onsuccess = () => resolve();
                    deleteRequest.onerror = () => reject(deleteRequest.error);
                    deleteRequest.onblocked = () => {
                        debug.warn('Database deletion blocked, will continue anyway');
                        resolve();
                    };
                });
            }

            if (typeof window !== 'undefined') {
                localStorage.removeItem(PROFILE_STORAGE_KEY);
                localStorage.removeItem(PROFILE_SETTINGS_KEY);
                localStorage.removeItem(PROFILE_SALT_KEY);
                localStorage.removeItem(LAST_ACTIVITY_KEY);

                // Clear SecureKeyManager keys
                localStorage.removeItem('secure-wrapped-keys');
                localStorage.removeItem('secure-key-manager-lockout');

                // Clear legacy storage data
                storage.clearAllData();

                const keysToRemove = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith('decrypt-chat') || key.startsWith('profile-'))) {
                        keysToRemove.push(key);
                    }
                }
                keysToRemove.forEach((key) => localStorage.removeItem(key));
            }

            this.profileSettings.set({
                autoLockTimeout: -1,
                hideMessagesOnHomepage: false,
                showInstantLockButton: false,
                enterKeySendsMessage: true,
                use24HourTime: false,
                themePreference: 'system',
            });

            debug.log('All application data deleted successfully');
        } catch (error) {
            debug.error('Failed to delete all data:', error);
            throw new Error('Failed to delete all application data');
        }
    }

    /**
     * Get the shareable subset of the profile (no credentials or settings).
     * Callers must encrypt this with a conversation key before it leaves the
     * device: contact details are PII and must never appear in a plaintext link.
     */
    async getShareableProfile(): Promise<Pick<UserProfile, 'contacts' | 'createdAt'> | null> {
        const currentProfile = await new Promise<UserProfile | undefined>((resolve) => {
            this.currentProfile.subscribe(resolve)();
        });

        if (!currentProfile) return null;

        return {
            contacts: currentProfile.contacts ?? [],
            createdAt: currentProfile.createdAt,
        };
    }

    /**
     * Synchronous check for whether this tab holds the session material required to
     * restore the session without a password prompt. The derived key only ever lives
     * in sessionStorage and is cleared on lock, so its absence means the only possible
     * unlock path is a cross-tab session handoff. Used by the initial view guess so a
     * refresh while locked can paint the lock screen immediately instead of a loader.
     */
    hasLocalSessionMaterial(): boolean {
        if (typeof window === 'undefined') return false;
        return sessionStorage.getItem(SESSION_DERIVED_KEY_KEY) !== null;
    }

    get profile() {
        return this.currentProfile;
    }
    get settings() {
        return this.profileSettings;
    }
    get lockState() {
        return this._lockState;
    }

    private async hashPassword(password: string, salt: Uint8Array): Promise<string> {
        const bits = await deriveBitsFromPassword(password, salt);
        return btoa(String.fromCharCode(...new Uint8Array(bits)));
    }

    private async saveEncryptedProfile(
        profile: UserProfile,
        password: string,
        salt?: Uint8Array
    ): Promise<void> {
        const useSalt = salt || this.profileSalt;
        if (!useSalt) throw new Error('No salt available');

        const key = await deriveKeyFromPassword(password, useSalt, KDF_ITERATIONS_CURRENT);
        if (typeof window !== 'undefined') {
            localStorage.setItem(PROFILE_KDF_ITERATIONS_KEY, String(KDF_ITERATIONS_CURRENT));
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            new TextEncoder().encode(JSON.stringify(profile))
        );

        const encryptedData: EncryptedProfileData = {
            data: this.arrayBufferToBase64(encrypted),
            iv: this.arrayBufferToBase64(iv.buffer),
        };

        if (typeof window !== 'undefined') {
            localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(encryptedData));
        }
    }

    /**
     * Re-encrypt the profile with an already-derived key (the in-session key).
     * Used when saving non-credential edits without re-prompting for the master
     * password. The KDF iteration marker is left untouched: the session key was
     * derived against the stored count, so the ciphertext stays decryptable via
     * the password path with that same count.
     */
    private async saveEncryptedProfileWithKey(profile: UserProfile, key: CryptoKey): Promise<void> {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            new TextEncoder().encode(JSON.stringify(profile))
        );

        const encryptedData: EncryptedProfileData = {
            data: this.arrayBufferToBase64(encrypted),
            iv: this.arrayBufferToBase64(iv.buffer),
        };

        if (typeof window !== 'undefined') {
            localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(encryptedData));
        }
    }

    /**
     * Normalize a freshly decrypted profile. Folds a legacy single `email`
     * field (from before the unified contact list) into a `contacts` entry so
     * pre-existing local profiles don't lose their address on load.
     */
    private normalizeProfile(profile: UserProfile): UserProfile {
        const legacyEmail = (profile as UserProfile & { email?: string }).email;
        if (legacyEmail && (!profile.contacts || profile.contacts.length === 0)) {
            const { email: _drop, ...rest } = profile as UserProfile & { email?: string };
            return { ...rest, contacts: [{ app: 'email', value: legacyEmail }] };
        }
        return profile;
    }

    private async loadEncryptedProfile(password: string): Promise<UserProfile | null> {
        if (typeof window === 'undefined') return null;

        const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (!stored || !this.profileSalt) return null;

        try {
            const encryptedData: EncryptedProfileData = JSON.parse(stored);
            const storedIterations = parseInt(
                localStorage.getItem(PROFILE_KDF_ITERATIONS_KEY) ?? String(KDF_ITERATIONS_LEGACY),
                10
            );
            const key = await deriveKeyFromPassword(password, this.profileSalt, storedIterations);
            const iv = this.base64ToArrayBuffer(encryptedData.iv);
            const encrypted = this.base64ToArrayBuffer(encryptedData.data);

            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
            const profileData = JSON.parse(new TextDecoder().decode(decrypted));

            // Migrate to stronger KDF parameters if necessary
            if (storedIterations < KDF_ITERATIONS_CURRENT) {
                await this.saveEncryptedProfile(profileData as UserProfile, password);
            }

            return this.normalizeProfile(profileData as UserProfile);
        } catch (error) {
            return null;
        }
    }

    private async loadEncryptedProfileWithKey(key: CryptoKey): Promise<UserProfile | null> {
        if (typeof window === 'undefined') return null;

        const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (!stored) return null;

        try {
            const encryptedData: EncryptedProfileData = JSON.parse(stored);
            const iv = this.base64ToArrayBuffer(encryptedData.iv);
            const encrypted = this.base64ToArrayBuffer(encryptedData.data);

            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
            const profileData = JSON.parse(new TextDecoder().decode(decrypted));

            return this.normalizeProfile(profileData as UserProfile);
        } catch (error) {
            return null;
        }
    }

    private async saveProfileSettings(settings?: ProfileSettings): Promise<void> {
        const settingsToSave =
            settings ||
            (await new Promise<ProfileSettings>((resolve) => {
                this.profileSettings.subscribe(resolve)();
            }));

        if (typeof window !== 'undefined') {
            localStorage.setItem(PROFILE_SETTINGS_KEY, JSON.stringify(settingsToSave));
        }
    }

    private loadProfileSettings(): ProfileSettings {
        if (typeof window === 'undefined') {
            return {
                autoLockTimeout: -1,
                hideMessagesOnHomepage: false,
                showInstantLockButton: false,
                enterKeySendsMessage: true,
                use24HourTime: false,
                themePreference: 'system',
            };
        }

        const stored = localStorage.getItem(PROFILE_SETTINGS_KEY);
        if (!stored) {
            return {
                autoLockTimeout: -1,
                hideMessagesOnHomepage: false,
                showInstantLockButton: false,
                enterKeySendsMessage: true,
                use24HourTime: false,
                themePreference: 'system',
            };
        }

        try {
            const parsed = JSON.parse(stored);
            return this.normalizeSettings(parsed);
        } catch {
            return {
                autoLockTimeout: -1,
                hideMessagesOnHomepage: false,
                showInstantLockButton: false,
                enterKeySendsMessage: true,
                use24HourTime: false,
                themePreference: 'system',
            };
        }
    }

    private saveProfileSalt(): void {
        if (typeof window !== 'undefined' && this.profileSalt) {
            localStorage.setItem(PROFILE_SALT_KEY, JSON.stringify(Array.from(this.profileSalt)));
        }
    }

    private loadProfileSalt(): boolean {
        if (typeof window === 'undefined') return false;

        const stored = localStorage.getItem(PROFILE_SALT_KEY);
        if (!stored) return false;

        try {
            this.profileSalt = new Uint8Array(JSON.parse(stored));
            return true;
        } catch {
            return false;
        }
    }

    private startAutoLockTimer(): void {
        this.clearAutoLockTimer();

        this.profileSettings.subscribe((settings) => {
            if (settings.autoLockTimeout > 0) {
                // Use activity tracker for proper inactivity-based locking
                activityTracker.setAutoLock(settings.autoLockTimeout, () => {
                    this.lockProfile();
                });
            } else {
                // Clear auto-lock for manual modes
                activityTracker.clearAutoLock();
            }
        })();
    }

    private clearAutoLockTimer(): void {
        if (this.autoLockTimer) {
            clearTimeout(this.autoLockTimer);
            this.autoLockTimer = null;
        }
        activityTracker.clearAutoLock();
    }

    private registerLockCallback(): void {
        secureKeyManager.setProfileLockCallback(() => {
            this.lockProfile();
        });
    }

    private clearUnlockTimeout(): void {
        if (this.unlockTimeout) {
            clearTimeout(this.unlockTimeout);
            this.unlockTimeout = null;
        }
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

    private normalizeSettings(settings: Partial<ProfileSettings>): ProfileSettings {
        const autoLockTimeout =
            typeof settings.autoLockTimeout === 'number'
                ? settings.autoLockTimeout
                : Number(settings.autoLockTimeout);

        const themePreference =
            settings.themePreference === 'light' || settings.themePreference === 'dark'
                ? settings.themePreference
                : 'system';

        return {
            autoLockTimeout: Number.isFinite(autoLockTimeout) ? autoLockTimeout : -1,
            hideMessagesOnHomepage: Boolean(settings.hideMessagesOnHomepage),
            showInstantLockButton: Boolean(settings.showInstantLockButton),
            enterKeySendsMessage:
                typeof settings.enterKeySendsMessage === 'boolean'
                    ? settings.enterKeySendsMessage
                    : true,
            use24HourTime: Boolean(settings.use24HourTime),
            themePreference,
        };
    }

    private async saveSessionDerivedKey(masterPassword: string): Promise<void> {
        if (typeof window === 'undefined' || !this.profileSalt) return;

        const iterations = parseInt(
            localStorage.getItem(PROFILE_KDF_ITERATIONS_KEY) ?? String(KDF_ITERATIONS_CURRENT),
            10
        );
        const keyBits = await deriveBitsFromPassword(masterPassword, this.profileSalt, iterations);
        const keyBytes = keyBits.slice(0, 32);

        // Retain the profile-encryption key in memory for the whole unlocked session
        // (all auto-lock modes, including ones that persist no session material), so a
        // contact-detail edit can re-encrypt without re-prompting for the master password.
        this.sessionEncryptionKey = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );

        const settings = this.getCurrentSettings();
        const storage = this.getStorageForTimeout(settings.autoLockTimeout);
        if (storage) {
            // Session derived key always goes in sessionStorage — never localStorage —
            // so it is never written to the browser's profile directory on disk.
            sessionStorage.setItem(SESSION_DERIVED_KEY_KEY, this.arrayBufferToBase64(keyBits));

            const passwordKey = await crypto.subtle.importKey(
                'raw',
                keyBytes,
                { name: 'AES-GCM' },
                false,
                ['encrypt']
            );
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                passwordKey,
                new TextEncoder().encode(masterPassword)
            );

            const sessionData = {
                encrypted: this.arrayBufferToBase64(encrypted),
                iv: this.arrayBufferToBase64(iv.buffer),
                timestamp: Date.now(),
            };
            storage.setItem('profile-session-password', JSON.stringify(sessionData));
        }
    }

    private async loadSessionDerivedKey(): Promise<CryptoKey | null> {
        if (typeof window !== 'undefined') {
            // Session derived key is always in sessionStorage (never localStorage)
            const keyBase64 = sessionStorage.getItem(SESSION_DERIVED_KEY_KEY);
            if (keyBase64) {
                try {
                    const keyBuffer = this.base64ToArrayBuffer(keyBase64);
                    return await crypto.subtle.importKey(
                        'raw',
                        keyBuffer,
                        { name: 'AES-GCM' },
                        false,
                        ['encrypt', 'decrypt']
                    );
                } catch (error) {
                    debug.error('Failed to import session key:', error);
                    this.clearSessionDerivedKey();
                }
            }
        }
        return null;
    }

    private async loadSessionPassword(): Promise<string | null> {
        if (typeof window !== 'undefined') {
            const storage = this.getStorageForTimeout(this.getCurrentSettings().autoLockTimeout);
            if (!storage) return null;

            // Session derived key is always in sessionStorage regardless of lock mode
            const sessionKeyBase64 = sessionStorage.getItem(SESSION_DERIVED_KEY_KEY);
            const sessionPasswordData = storage.getItem('profile-session-password');

            if (sessionKeyBase64 && sessionPasswordData) {
                try {
                    const sessionData = JSON.parse(sessionPasswordData);
                    const age = Date.now() - sessionData.timestamp;
                    const maxAge = 24 * 60 * 60 * 1000; // 24 hours max

                    if (age < maxAge) {
                        const keyBuffer = this.base64ToArrayBuffer(sessionKeyBase64);
                        const keyArray = new Uint8Array(keyBuffer);
                        const cryptoKey = await crypto.subtle.importKey(
                            'raw',
                            keyArray.slice(0, 32), // Use first 32 bytes as decryption key
                            { name: 'AES-GCM' },
                            false,
                            ['decrypt']
                        );

                        const encrypted = this.base64ToArrayBuffer(sessionData.encrypted);
                        const iv = this.base64ToArrayBuffer(sessionData.iv);

                        const decrypted = await crypto.subtle.decrypt(
                            { name: 'AES-GCM', iv },
                            cryptoKey,
                            encrypted
                        );

                        const decoder = new TextDecoder();
                        return decoder.decode(decrypted);
                    }
                } catch (error) {
                    debug.warn('Failed to decrypt session password:', error);
                    storage.removeItem('profile-session-password');
                }
            }
        }
        return null;
    }

    private clearSessionDerivedKey(): void {
        // Drop the in-memory encryption key whenever session material is wiped (lock).
        this.sessionEncryptionKey = null;
        if (typeof window !== 'undefined') {
            // Session derived key lives only in sessionStorage
            sessionStorage.removeItem(SESSION_DERIVED_KEY_KEY);
            this.removeStoredUnlock(sessionStorage);
            this.removeStoredUnlock(localStorage);
        }
    }

    private getStorageForTimeout(timeout: number): Storage | null {
        if (typeof window === 'undefined') return null;
        if (timeout === -2) return null;
        if (timeout === -3) return localStorage;
        return sessionStorage;
    }

    private moveStoredUnlock(from: Storage, to: Storage): void {
        const keys = [SESSION_DERIVED_KEY_KEY, 'profile-session-password'];
        keys.forEach((key) => {
            const value = from.getItem(key);
            if (value) {
                to.setItem(key, value);
                from.removeItem(key);
            }
        });
    }

    private removeStoredUnlock(storage: Storage): void {
        const keys = [SESSION_DERIVED_KEY_KEY, 'profile-session-password'];
        keys.forEach((key) => storage.removeItem(key));
    }
}

export const profileManager = new ProfileManager();
