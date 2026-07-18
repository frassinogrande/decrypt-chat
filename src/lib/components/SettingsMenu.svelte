<script lang="ts">
    import { get } from 'svelte/store';
    import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
    import { locale as localeStore, setLocale, translations as LL } from '$lib/i18n/runtime';
    import type { Locale } from '$lib/i18n/config';
    import { profileManager } from '../utils/profile-manager';
    import { applyTheme } from '../utils/theme';
    import { debug } from '../utils/debug';
    import { chatStorage } from '../utils/chat-storage';
    import { storageMonitor } from '../utils/storage-monitor';
    import { calculateContactStorageUsage } from '../utils/contact-stats';
    import ProfileShare from './ProfileShare.svelte';
    import ExportChatsDialog from './ExportChatsDialog.svelte';
    import WeakPasswordDialog from './WeakPasswordDialog.svelte';
    import { isWeakPassword } from '../utils/password-strength';
    import ProfileTab from './settings/ProfileTab.svelte';
    import AboutTab from './settings/AboutTab.svelte';
    import StatsTab from './settings/StatsTab.svelte';
    import SecurityTab from './settings/SecurityTab.svelte';
    import StorageTab from './settings/StorageTab.svelte';
    import type { UserProfile, ProfileSettings, ContactMethod } from '../types';
    import { createEncryptedBackup, restoreFromEncryptedBackup } from '../utils/backup';
    import Icon from '$lib/components/icons/Icon.svelte';

    const dispatch = createEventDispatcher();
    const FOCUSABLE_SELECTORS =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    type SettingsTab = 'profile' | 'storage' | 'stats' | 'security' | 'about';
    const tabOrder: SettingsTab[] = ['profile', 'storage', 'stats', 'security', 'about'];
    const tabIdSuffix = Math.random().toString(36).slice(2, 10);
    const tabButtonIds: Record<SettingsTab, string> = {
        profile: `settings-tab-${tabIdSuffix}-profile`,
        storage: `settings-tab-${tabIdSuffix}-storage`,
        stats: `settings-tab-${tabIdSuffix}-stats`,
        security: `settings-tab-${tabIdSuffix}-security`,
        about: `settings-tab-${tabIdSuffix}-about`,
    };
    const tabPanelIds: Record<SettingsTab, string> = {
        profile: `settings-panel-${tabIdSuffix}-profile`,
        storage: `settings-panel-${tabIdSuffix}-storage`,
        stats: `settings-panel-${tabIdSuffix}-stats`,
        security: `settings-panel-${tabIdSuffix}-security`,
        about: `settings-panel-${tabIdSuffix}-about`,
    };
    const indexedDbHeadingId = `settings-storage-heading-indexeddb-${tabIdSuffix}`;
    const localStorageHeadingId = `settings-storage-heading-local-${tabIdSuffix}`;

    const languageOptions: Array<{ tag: Locale; label: string }> = [
        { tag: 'en', label: 'English' },
        { tag: 'es', label: 'Español' },
        { tag: 'de', label: 'Deutsch' },
        { tag: 'fr', label: 'Français' },
        { tag: 'it', label: 'Italiano' },
        { tag: 'ru', label: 'Русский' },
        { tag: 'pt-br', label: 'Português (Brasil)' },
        { tag: 'pt-pt', label: 'Português (Portugal)' },
    ];

    const autoLockOptions = [
        { value: -1, label: () => get(LL).settingsMenuSecurityAutoLockOptionSession() },
        { value: -2, label: () => get(LL).settingsMenuSecurityAutoLockOptionRefresh() },
        { value: 5, label: () => get(LL).settingsMenuSecurityAutoLockOption5() },
        { value: 15, label: () => get(LL).settingsMenuSecurityAutoLockOption15() },
        { value: 30, label: () => get(LL).settingsMenuSecurityAutoLockOption30() },
        { value: 60, label: () => get(LL).settingsMenuSecurityAutoLockOption60() },
        { value: -3, label: () => get(LL).settingsMenuSecurityAutoLockOptionManualInsecure() },
    ];

    let selectedLocale: Locale = 'en';

    $: selectedLocale = $localeStore as Locale;

    function handleLanguageChange(event: Event) {
        const target = event.target as HTMLSelectElement | null;
        const next = target?.value as Locale | undefined;
        if (!next) return;
        setLocale(next).catch((error) => {
            debug.error('Failed to change locale', error);
        });
    }

    let settingsDialogRef: HTMLDialogElement;
    let deleteDialogRef: HTMLDialogElement;
    let backupDialogRef: HTMLDialogElement;
    let restoreDialogRef: HTMLDialogElement;
    const settingsTitleId = `settings-title-${Math.random().toString(36).slice(2, 10)}`;
    const deleteTitleId = `settings-delete-title-${Math.random().toString(36).slice(2, 10)}`;
    const deleteDescriptionId = `settings-delete-description-${Math.random().toString(36).slice(2, 10)}`;
    const backupTitleId = `settings-backup-title-${Math.random().toString(36).slice(2, 10)}`;
    const backupDescriptionId = `settings-backup-description-${Math.random().toString(36).slice(2, 10)}`;
    const restoreTitleId = `settings-restore-title-${Math.random().toString(36).slice(2, 10)}`;
    const restoreDescriptionId = `settings-restore-description-${Math.random().toString(36).slice(2, 10)}`;

    let activeTab: SettingsTab = 'profile';
    let settingsContentRef: HTMLDivElement;
    let settingsNavRef: HTMLElement;
    let profile: UserProfile | undefined;
    let settings: ProfileSettings = {
        autoLockTimeout: -1,
        hideMessagesOnHomepage: false,
        showInstantLockButton: false,
        enterKeySendsMessage: true,
        use24HourTime: false,
        themePreference: 'system',
    }; // Default values, will be updated by subscription
    let lockState: any;
    let isLoading = false;
    let error = '';
    let success = '';

    // Screen-reader mirrors of the banner texts. The visual banner mounts its
    // content inside an {#if}, which live regions announce unreliably; these
    // are set alongside it and rendered in persistent, always-mounted live
    // nodes. They intentionally survive the 5s visual dismiss and persist
    // until replaced by the next message.
    let announceError = '';
    let announceSuccess = '';
    $: if (error) announceError = error;
    $: if (success) announceSuccess = success;

    // Auto-dismiss the status/error banner: it's raised by direct assignment from
    // many handlers, so a single reactive timer covers them all. Without this the
    // banner lingers until the next action that happens to overwrite it.
    const MESSAGE_TIMEOUT_MS = 5000;
    let messageTimeout: ReturnType<typeof setTimeout> | undefined;
    $: if (error || success) {
        clearTimeout(messageTimeout);
        messageTimeout = setTimeout(() => {
            error = '';
            success = '';
        }, MESSAGE_TIMEOUT_MS);
    }
    onDestroy(() => clearTimeout(messageTimeout));

    const MIN_CONTACT_ROWS = 3;
    let editingProfile = false;
    let editContacts: ContactMethod[] = [];

    // Seed the edit rows from the saved profile, padded to a few blank rows so
    // there is always somewhere to type. Cloned so edits don't mutate the store.
    function seedEditContacts() {
        const existing = (profile?.contacts ?? []).map((c) => ({ ...c }));
        while (existing.length < MIN_CONTACT_ROWS) {
            existing.push({ app: '', value: '' });
        }
        editContacts = existing;
    }

    function addContactField() {
        editContacts = [...editContacts, { app: '', value: '' }];
    }

    function removeContactField(index: number) {
        editContacts = editContacts.filter((_, i) => i !== index);
    }

    let changingPassword = false;
    let currentPassword = '';
    let newPassword = '';
    let confirmNewPassword = '';
    let showWeakPasswordDialog = false;

    let storageInfo: any = null;
    let storagePersisted = false;
    // Only surface the persistence control when there's something to do: when it's off
    // (so the user can turn it on) or when the user enabled it themselves (so they can
    // see the status and how to remove it). When the browser grants persistence on its
    // own (e.g. Chromium heuristics), the user never opted in, so we stay out of the way.
    // The "user enabled it" flag is persisted so this survives across sessions.
    const PERSIST_USER_ENABLED_KEY = 'persistent-storage-user-enabled';
    let persistenceEnabledByUser = false;
    $: showPersistence = !storagePersisted || persistenceEnabledByUser;
    let chatStorageBreakdown: Array<{
        chatId: string;
        name: string;
        bytes: number;
        percentage: number;
        color: string;
    }> = [];

    let statsLoading = false;
    let statsError = '';
    interface ReactionLeaderboardEntry {
        reactionType: 'laugh' | 'heart' | '100' | string;
        emoji: string;
        count: number;
    }

    interface LeaderboardEntry {
        name: string;
        count: number;
    }

    let stats: {
        reactions: ReactionLeaderboardEntry[];
        messages: LeaderboardEntry[];
    } = {
        reactions: [],
        messages: [],
    };

    const reactionEmojiMap: Record<'laugh' | 'heart' | '100', string> = {
        laugh: '😂',
        heart: '❤️',
        '100': '💯',
    };

    function resolveDisplayName(name: string | undefined | null, fallback: string): string {
        const trimmed = name?.trim();
        if (!trimmed) return fallback;
        const normalized = trimmed.toLowerCase();
        if (normalized === 'peer' || normalized === 'unknown' || normalized === 'unknown contact') {
            return fallback;
        }
        return trimmed;
    }
    let showProfileShare = false;

    let showDeleteConfirmation = false;
    let deletePassword = '';
    let showDeletePassword = false;
    let deleteStep = 1; // 1: initial confirmation, 2: password confirmation
    let isDeleting = false;

    let showBackupDialog = false;
    let backupPassword = '';
    let showBackupPassword = false;
    let isBackingUp = false;
    let backupError = '';

    let showExportDialog = false;

    let showRestoreDialog = false;
    let restorePassword = '';
    let showRestorePassword = false;
    let restoreFile: File | null = null;
    let restoreAcknowledge = false;
    let isRestoring = false;
    let restoreError = '';
    let restoreDragActive = false;
    let restoreFileInput: HTMLInputElement;

    function handleRestoreFileChange(e: Event) {
        const t = e.target as HTMLInputElement;
        restoreFile = t && t.files && t.files[0] ? t.files[0] : null;
    }

    function openRestoreFileDialog() {
        if (isRestoring) return;
        restoreFileInput?.click();
    }

    function clearRestoreFile() {
        if (isRestoring) return;
        restoreFile = null;
        if (restoreFileInput) restoreFileInput.value = '';
    }

    function handleRestoreDragOver(e: DragEvent) {
        if (isRestoring) return;
        e.preventDefault();
        restoreDragActive = true;
    }

    function handleRestoreDragLeave() {
        restoreDragActive = false;
    }

    function handleRestoreDrop(e: DragEvent) {
        if (isRestoring) return;
        e.preventDefault();
        restoreDragActive = false;
        const dropped = e.dataTransfer?.files?.[0];
        if (dropped) restoreFile = dropped;
    }

    $: profile = undefined; // Will be set by subscriptions
    // settings will be set by subscriptions - don't override with defaults

    onMount(() => {
        if (settingsDialogRef && !settingsDialogRef.open) {
            settingsDialogRef.showModal();
        }
        requestAnimationFrame(() => focusNavForTab(activeTab));

        const unsubscribeProfile = profileManager.profile.subscribe((p) => {
            profile = p;
            // Don't reseed while the user is mid-edit or their typing is lost.
            if (p && !editingProfile) {
                seedEditContacts();
            }
        });

        const unsubscribeSettings = profileManager.settings.subscribe((s) => {
            settings = s;
        });

        const unsubscribeLockState = profileManager.lockState.subscribe((ls) => {
            lockState = ls;

            // Security: Close settings immediately if profile becomes locked
            if (ls.isLocked) {
                dispatch('close');
            }
        });

        // Restore whether the user previously enabled persistence themselves, so the
        // status and removal instructions keep showing across sessions (unlike browsers
        // that grant it silently, where we never show the control).
        persistenceEnabledByUser = localStorage.getItem(PERSIST_USER_ENABLED_KEY) === 'true';

        loadStorageInfo();
        loadStats();

        // Persistence can be revoked in the browser's site settings while the app is
        // open; those settings usually open in another tab, so re-check when our tab
        // becomes visible again (covers same-window tab switches and window refocus).
        document.addEventListener('visibilitychange', refreshStoragePersistence);
        window.addEventListener('focus', refreshStoragePersistence);

        return () => {
            unsubscribeProfile();
            unsubscribeSettings();
            unsubscribeLockState();
            document.removeEventListener('visibilitychange', refreshStoragePersistence);
            window.removeEventListener('focus', refreshStoragePersistence);
        };
    });

    function getNavButtons(): HTMLButtonElement[] {
        if (!settingsNavRef) return [];
        return Array.from(settingsNavRef.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    }

    function focusNavForTab(tab: SettingsTab): boolean {
        const buttons = getNavButtons();
        const index = tabOrder.indexOf(tab);
        if (index === -1) return false;
        const button = buttons[index];
        if (!button) return false;
        button.focus();
        return true;
    }

    function focusNextNavFrom(tab: SettingsTab): boolean {
        const index = tabOrder.indexOf(tab);
        if (index === -1) return false;
        const nextTab = tabOrder[(index + 1) % tabOrder.length];
        return focusNavForTab(nextTab);
    }

    function focusPrevNavFrom(tab: SettingsTab): boolean {
        const index = tabOrder.indexOf(tab);
        if (index === -1) return false;
        const prevTab = tabOrder[(index - 1 + tabOrder.length) % tabOrder.length];
        return focusNavForTab(prevTab);
    }

    // Programmatically focusing a <select> (or a date/time/color/file input)
    // makes iOS Safari immediately pop its native picker, so tabs whose first
    // control is a dropdown (Account, Security) would open the picker just from
    // being selected. For those, focus the panel container instead: keyboard
    // users still land in the content, but no picker springs open on touch.
    function opensNativePicker(el: HTMLElement): boolean {
        if (el.tagName === 'SELECT') return true;
        if (el.tagName === 'INPUT') {
            const type = (el as HTMLInputElement).type;
            return ['date', 'datetime-local', 'month', 'week', 'time', 'color', 'file'].includes(
                type
            );
        }
        return false;
    }

    function focusFirstInteractiveInTab(tab: SettingsTab): boolean {
        if (!settingsContentRef) return false;
        const panel = settingsContentRef.querySelector<HTMLElement>(
            `.tab-content[data-tab="${tab}"]`
        );
        if (!panel) return false;
        const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
        if (firstFocusable && !opensNativePicker(firstFocusable)) {
            firstFocusable.focus({ preventScroll: true });
        } else {
            panel.tabIndex = -1;
            panel.focus({ preventScroll: true });
        }
        return true;
    }

    async function activateTabAndFocusContent(tab: SettingsTab) {
        activeTab = tab;
        await tick();
        if (settingsContentRef) {
            settingsContentRef.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        }
        focusFirstInteractiveInTab(tab);
    }

    function handleNavKeydown(event: KeyboardEvent, tab: SettingsTab) {
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowRight':
                event.preventDefault();
                focusNextNavFrom(tab);
                break;
            case 'ArrowUp':
            case 'ArrowLeft':
                event.preventDefault();
                focusPrevNavFrom(tab);
                break;
            case 'Home':
                event.preventDefault();
                focusNavForTab(tabOrder[0]);
                break;
            case 'End':
                event.preventDefault();
                focusNavForTab(tabOrder[tabOrder.length - 1]);
                break;
            case ' ':
            case 'Spacebar':
            case 'Enter':
                event.preventDefault();
                activateTabAndFocusContent(tab);
                break;
            default:
                break;
        }
    }

    $: if (deleteDialogRef) {
        if (showDeleteConfirmation && !deleteDialogRef.open) {
            deleteDialogRef.showModal();
        } else if (!showDeleteConfirmation && deleteDialogRef.open) {
            deleteDialogRef.close();
        }
    }

    $: if (backupDialogRef) {
        if (showBackupDialog && !backupDialogRef.open) {
            backupDialogRef.showModal();
        } else if (!showBackupDialog && backupDialogRef.open) {
            backupDialogRef.close();
        }
    }

    $: if (restoreDialogRef) {
        if (showRestoreDialog && !restoreDialogRef.open) {
            restoreDialogRef.showModal();
        } else if (!showRestoreDialog && restoreDialogRef.open) {
            restoreDialogRef.close();
        }
    }

    async function loadStorageInfo() {
        try {
            const chatInfo = await chatStorage.getStorageInfo();
            const quota = await storageMonitor.getStorageQuota();

            storageInfo = {
                indexedDB: {
                    used: chatInfo.used,
                    quota: chatInfo.quota,
                    conversations: chatInfo.chatCount,
                    messages: chatInfo.messageCount,
                },
                localStorage: {
                    used: 0, // Will estimate
                    quota: 5 * 1024 * 1024, // 5MB typical localStorage limit
                },
            };

            if (typeof window !== 'undefined') {
                let localStorageUsed = 0;
                for (const key in localStorage) {
                    if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
                        localStorageUsed += localStorage[key].length + key.length;
                    }
                }
                storageInfo.localStorage.used = localStorageUsed;
            }

            storagePersisted = await storageMonitor.isPersisted();

            await calculateChatStorageBreakdown();
        } catch (error) {
            debug.error('Failed to load storage info:', error);
        }
    }

    async function enablePersistence() {
        // Mark that the user drove this, so we keep showing the status (and how to remove
        // it) even though we hide the section for browsers that grant it on their own.
        persistenceEnabledByUser = true;
        storagePersisted = await storageMonitor.requestPersistence();
        if (storagePersisted) {
            localStorage.setItem(PERSIST_USER_ENABLED_KEY, 'true');
        }
    }

    async function refreshStoragePersistence() {
        // The persistence state can change outside the app (e.g. the user revokes it
        // in the browser's own site settings, which typically open in a separate tab),
        // so re-read it whenever the app tab becomes visible again.
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        storagePersisted = await storageMonitor.isPersisted();
    }

    async function loadStats() {
        statsLoading = true;
        statsError = '';

        try {
            const chats = await chatStorage.getAllChats();
            const reactionCounts = new Map<string, number>();
            const messageCounts = new Map<string, number>();

            for (const chat of chats) {
                const messages = await chatStorage.getMessages(chat.id);
                const contactName = resolveDisplayName(
                    chat.name,
                    get(LL).settingsMenuUnknownContact()
                );

                for (const message of messages) {
                    if (!message.isOwn) {
                        const receivedCount = messageCounts.get(contactName) ?? 0;
                        messageCounts.set(contactName, receivedCount + 1);
                    }

                    if (message.reaction) {
                        const reactionType = message.reaction;
                        reactionCounts.set(
                            reactionType,
                            (reactionCounts.get(reactionType) ?? 0) + 1
                        );
                    }
                }
            }

            const reactionLeaderboard: ReactionLeaderboardEntry[] = Array.from(
                reactionCounts.entries()
            )
                .map(([reactionType, count]) => ({
                    reactionType,
                    emoji:
                        reactionEmojiMap[reactionType as keyof typeof reactionEmojiMap] ??
                        reactionType,
                    count,
                }))
                .filter((entry) => entry.count > 0)
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);

            const messageLeaderboard: LeaderboardEntry[] = Array.from(messageCounts.entries())
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);

            stats = {
                reactions: reactionLeaderboard,
                messages: messageLeaderboard,
            };
        } catch (error) {
            debug.error('Failed to load stats:', error);
            statsError = get(LL).settingsMenuErrorStatsGeneric();
        } finally {
            statsLoading = false;
        }
    }

    function handleClose(event?: Event) {
        event?.preventDefault();
        settingsDialogRef?.close();
        dispatch('close');
    }

    function redoTutorial() {
        settingsDialogRef?.close();
        dispatch('redo-tutorial');
    }

    function handleDialogCancel(event: Event) {
        event.preventDefault();
        handleClose();
    }

    function handleDialogPointerDown(event: PointerEvent) {
        if (event.target === settingsDialogRef) {
            handleClose();
        }
    }

    function startEditingProfile() {
        seedEditContacts();
        editingProfile = true;
        error = '';
        success = '';
    }

    function cancelEditingProfile() {
        editingProfile = false;
        seedEditContacts();
        error = '';
    }

    async function saveProfileChanges() {
        isLoading = true;
        error = '';

        try {
            // Keep only complete rows (a method chosen and a value typed); drop stray
            // custom labels on non-'other' rows.
            const contacts: ContactMethod[] = editContacts
                .map((c) => ({
                    app: c.app,
                    value: c.value.trim(),
                    ...(c.app === 'other' && c.label?.trim() ? { label: c.label.trim() } : {}),
                }))
                .filter((c) => c.app !== '' && c.value !== '');

            const updateSuccess = await profileManager.updateProfile({ contacts });

            if (updateSuccess) {
                editingProfile = false;
                success = get(LL).settingsMenuSuccessProfileUpdated();
            } else {
                error = get(LL).settingsMenuErrorProfileUpdate();
            }
        } catch (err) {
            error = get(LL).settingsMenuErrorProfileUpdate();
        } finally {
            isLoading = false;
        }
    }

    function startChangingPassword() {
        changingPassword = true;
        currentPassword = '';
        newPassword = '';
        confirmNewPassword = '';
        error = '';
        success = '';
    }

    function cancelChangingPassword() {
        changingPassword = false;
        currentPassword = '';
        newPassword = '';
        confirmNewPassword = '';
        error = '';
    }

    async function saveNewPassword() {
        if (!currentPassword) {
            error = get(LL).settingsMenuErrorCurrentPasswordMissing();
            return;
        }

        if (!newPassword) {
            error = get(LL).settingsMenuErrorNewPasswordRequired();
            return;
        }

        if (newPassword !== confirmNewPassword) {
            error = get(LL).settingsMenuErrorNewPasswordMismatch();
            return;
        }

        // Soft nudge: weak passwords are allowed, but confirm first. Matches the
        // account-creation flow in ProfileSetup.
        if (isWeakPassword(newPassword)) {
            showWeakPasswordDialog = true;
            return;
        }

        await changeMasterPassword();
    }

    function confirmWeakPassword() {
        showWeakPasswordDialog = false;
        changeMasterPassword();
    }

    function cancelWeakPassword() {
        showWeakPasswordDialog = false;
    }

    async function changeMasterPassword() {
        isLoading = true;
        error = '';

        try {
            const changeSuccess = await profileManager.changeMasterPassword(
                currentPassword,
                newPassword
            );

            if (changeSuccess) {
                changingPassword = false;
                currentPassword = '';
                newPassword = '';
                confirmNewPassword = '';
                success = get(LL).settingsMenuSuccessPasswordChanged();
            } else {
                error = get(LL).settingsMenuErrorPasswordChangeInvalid();
            }
        } catch (err) {
            error = get(LL).settingsMenuErrorPasswordChange();
        } finally {
            isLoading = false;
        }
    }

    async function updateSettings() {
        try {
            await profileManager.updateSettings(settings);
            applyTheme(settings.themePreference ?? 'system');
            success = get(LL).settingsMenuSuccessSettingsUpdated();
        } catch (err) {
            error = get(LL).settingsMenuErrorSettingsUpdate();
        }
    }

    function lockProfile() {
        profileManager.lockProfile();
        dispatch('profile-locked');
    }

    function openProfileShare() {
        showProfileShare = true;
    }

    function generateChatColor(chatId: string): string {
        let hash = 0;
        for (let i = 0; i < chatId.length; i++) {
            hash = chatId.charCodeAt(i) + ((hash << 5) - hash);
        }

        const hue = Math.abs(hash) % 360;
        const saturation = 65 + (Math.abs(hash >> 8) % 20);
        const lightness = 45 + (Math.abs(hash >> 16) % 20);

        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }

    async function calculateChatStorageBreakdown(): Promise<void> {
        try {
            const chats = await chatStorage.getAllChats();
            const breakdown = [];
            const totalQuota = storageInfo?.indexedDB?.quota || 1;

            for (const chat of chats) {
                const stats = await calculateContactStorageUsage(chat.id);

                if (stats.totalBytes > 0) {
                    const percentage = (stats.totalBytes / totalQuota) * 100;

                    breakdown.push({
                        chatId: chat.id,
                        name: resolveDisplayName(chat.name, get(LL).settingsMenuUnknownContact()),
                        bytes: stats.totalBytes,
                        percentage,
                        color: generateChatColor(chat.id),
                    });
                }
            }

            breakdown.sort((a, b) => b.bytes - a.bytes);
            chatStorageBreakdown = breakdown;
        } catch (error) {
            debug.error('Failed to calculate chat storage breakdown:', error);
            chatStorageBreakdown = [];
        }
    }

    function openDeleteConfirmation() {
        showDeleteConfirmation = true;
        deleteStep = 1;
        deletePassword = '';
        error = '';
        success = '';
    }

    function openBackupDialog() {
        showBackupDialog = true;
        backupPassword = '';
        backupError = '';
    }

    async function performBackup() {
        backupError = '';
        if (!backupPassword) {
            backupError = get(LL).unlockErrorMissingPassword();
            return;
        }
        isBackingUp = true;
        try {
            // The backup is encrypted with the password typed here and can only be
            // restored with the same password. The dialog promises "your master
            // password", so verify that is what was entered: a typo would otherwise
            // silently produce a backup no password the user knows can ever open.
            const isMasterPassword = await profileManager.verifyPassword(backupPassword);
            if (!isMasterPassword) {
                backupError = get(LL).settingsMenuBackupWrongPassword();
                return;
            }
            const { blob, fileName } = await createEncryptedBackup(backupPassword);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Revoke on a later tick, not synchronously: revoking before the browser
            // has finished reading the blob can truncate the download and produce a
            // corrupt backup file (notably on Firefox), which then fails to restore.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            showBackupDialog = false;
            success = get(LL).settingsMenuSuccessBackupDownloaded();
        } catch (e) {
            backupError = get(LL).settingsMenuErrorBackupFailed();
        } finally {
            isBackingUp = false;
        }
    }

    function openExportDialog() {
        showExportDialog = true;
    }

    function handleChatsExported() {
        success = get(LL).settingsMenuSuccessExportDownloaded();
    }

    function openRestoreDialog() {
        showRestoreDialog = true;
        restorePassword = '';
        restoreFile = null;
        restoreAcknowledge = false;
        restoreError = '';
    }

    async function performRestore() {
        restoreError = '';
        if (!restoreAcknowledge) {
            restoreError = get(LL).settingsMenuErrorRestoreAcknowledge();
            return;
        }
        if (!restoreFile) {
            restoreError = get(LL).settingsMenuErrorRestoreFile();
            return;
        }
        if (!restorePassword) {
            restoreError = get(LL).settingsMenuErrorRestorePassword();
            return;
        }
        isRestoring = true;
        try {
            await restoreFromEncryptedBackup(restoreFile, restorePassword);
            // Best-effort: if the backup password matches the master password, establish
            // a session so the reload lands in chats instead of the lock screen.
            try {
                await profileManager.unlockProfile(restorePassword);
            } catch {
                /* reload below handles the locked case */
            }
            // Reload to ensure all stores and state are consistent
            window.location.reload();
        } catch (e) {
            restoreError = get(LL).settingsMenuErrorRestoreFailed();
        } finally {
            isRestoring = false;
        }
    }

    function closeBackupDialog(event?: Event) {
        event?.preventDefault();
        showBackupDialog = false;
        backupError = '';
        if (!isBackingUp) {
            backupPassword = '';
        }
    }

    function handleBackupDialogCancel(event: Event) {
        event.preventDefault();
        closeBackupDialog();
    }

    function handleBackupDialogPointerDown(event: PointerEvent) {
        if (event.target === backupDialogRef) {
            closeBackupDialog();
        }
    }

    function closeRestoreDialog(event?: Event) {
        event?.preventDefault();
        showRestoreDialog = false;
        restoreError = '';
        if (!isRestoring) {
            restorePassword = '';
            restoreFile = null;
            restoreAcknowledge = false;
        }
    }

    function handleRestoreDialogCancel(event: Event) {
        event.preventDefault();
        closeRestoreDialog();
    }

    function handleRestoreDialogPointerDown(event: PointerEvent) {
        if (event.target === restoreDialogRef) {
            closeRestoreDialog();
        }
    }

    function closeDeleteConfirmation() {
        showDeleteConfirmation = false;
        deleteStep = 1;
        deletePassword = '';
        isDeleting = false;
        error = '';
    }

    function handleDeleteDialogCancel(event: Event) {
        event.preventDefault();
        closeDeleteConfirmation();
    }

    function handleDeleteDialogPointerDown(event: PointerEvent) {
        if (event.target === deleteDialogRef) {
            closeDeleteConfirmation();
        }
    }

    function proceedToPasswordConfirmation() {
        if (!profile) {
            confirmDeleteAllData();
            return;
        }

        deleteStep = 2;
        error = '';
    }

    async function confirmDeleteAllData() {
        isDeleting = true;
        error = '';

        try {
            if (profile) {
                if (!deletePassword) {
                    error = get(LL).settingsMenuErrorDeletePasswordRequired();
                    isDeleting = false;
                    return;
                }

                const verified = await profileManager.updateProfile(
                    { contacts: profile.contacts },
                    deletePassword
                );

                if (!verified) {
                    error = get(LL).settingsMenuErrorDeleteInvalidPassword();
                    isDeleting = false;
                    return;
                }
            }

            await profileManager.deleteAllData();

            closeDeleteConfirmation();
            success = get(LL).settingsMenuSuccessDelete();

            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } catch (err) {
            error = get(LL).settingsMenuErrorDeleteFailed();
            debug.error('Delete all data error:', err);
            isDeleting = false;
        }
    }
</script>

{#if showProfileShare}
    <ProfileShare
        on:close={() => (showProfileShare = false)}
        on:shared={() => {
            showProfileShare = false;
            success = $LL.settingsMenuSuccessProfileShared();
        }}
    />
{/if}

<WeakPasswordDialog
    show={showWeakPasswordDialog}
    on:confirm={confirmWeakPassword}
    on:cancel={cancelWeakPassword}
/>

{#if showDeleteConfirmation}
    <dialog
        bind:this={deleteDialogRef}
        class="dialog"
        aria-labelledby={deleteTitleId}
        aria-describedby={deleteDescriptionId}
        on:cancel|preventDefault={handleDeleteDialogCancel}
        on:pointerdown={handleDeleteDialogPointerDown}
        aria-modal="true"
    >
        <div class="dialog__header">
            <h3 id={deleteTitleId} class="dialog__title">{$LL.settingsMenuDeleteTitle()}</h3>
            <button
                type="button"
                class="btn btn--secondary"
                data-modal-close
                on:click={closeDeleteConfirmation}
                aria-label={$LL.settingsMenuDeleteCloseAria()}>×</button
            >
        </div>

        <div class="dialog__body">
            {#if deleteStep === 1}
                <div class="warning-content">
                    <div class="warning-icon">
                        <Icon name="warning" size={36} className="warning-icon-graphic" />
                    </div>
                    <h4 id={deleteDescriptionId}>{$LL.settingsMenuDeleteIntro()}</h4>
                    <ul class="delete-list">
                        {#if profile}
                            <li>{$LL.settingsMenuDeleteItemProfile()}</li>
                        {/if}
                        <li>{$LL.settingsMenuDeleteItemChats()}</li>
                        <li>{$LL.settingsMenuDeleteItemKeys()}</li>
                        <li>{$LL.settingsMenuDeleteItemApp()}</li>
                    </ul>
                    <p class="final-warning">
                        <strong>{$LL.settingsMenuDeleteWarning()}</strong>
                        {profile
                            ? $LL.settingsMenuDeleteWarningWithProfile()
                            : $LL.settingsMenuDeleteWarningWithoutProfile()}
                    </p>
                </div>
            {:else if deleteStep === 2}
                <div class="password-confirmation">
                    <div class="warning-icon">
                        <Icon name="padlock" size={20} className="warning-icon-graphic" />
                    </div>
                    <h4>{$LL.settingsMenuDeleteConfirmTitle()}</h4>
                    <p id={deleteDescriptionId}>{$LL.settingsMenuDeleteConfirmDescription()}</p>

                    <!-- confirmDeleteAllData() raises `error`, whose banner lives
                         behind this modal in .settings-content. Show it here too. -->
                    {#if error}
                        <div class="error-message" role="alert">{error}</div>
                    {/if}

                    <div class="form-group">
                        <label for="delete-confirm-password" class="visually-hidden"
                            >{$LL.settingsMenuDeleteConfirmTitle()}</label
                        >
                        <div class="password-input-container">
                            <input
                                id="delete-confirm-password"
                                type={showDeletePassword ? 'text' : 'password'}
                                value={deletePassword}
                                on:input={(e) => (deletePassword = e.currentTarget.value)}
                                placeholder={$LL.settingsMenuDeleteConfirmPlaceholder()}
                                disabled={isDeleting}
                                class="input"
                                on:keydown={(e) => e.key === 'Enter' && confirmDeleteAllData()}
                            />
                            <button
                                type="button"
                                class="btn btn--secondary password-toggle"
                                on:click={() => (showDeletePassword = !showDeletePassword)}
                                disabled={isDeleting}
                                title={showDeletePassword
                                    ? $LL.profileSetupToggleHide()
                                    : $LL.profileSetupToggleShow()}
                                aria-label={showDeletePassword
                                    ? $LL.profileSetupToggleHide()
                                    : $LL.profileSetupToggleShow()}
                            >
                                <Icon
                                    name={showDeletePassword ? 'eye-disabled' : 'eye'}
                                    size={20}
                                    className={`password-toggle-icon${showDeletePassword ? ' password-toggle-icon--disabled' : ''}`}
                                />
                            </button>
                        </div>
                    </div>
                </div>
            {/if}
        </div>
        <div class="dialog__footer">
            {#if deleteStep === 1}
                <button type="button" class="btn btn--secondary" on:click={closeDeleteConfirmation}>
                    {$LL.profileSetupCancel()}
                </button>
                <button
                    type="button"
                    class="btn btn--primary"
                    on:click={proceedToPasswordConfirmation}
                >
                    {profile
                        ? $LL.settingsMenuDeleteProceed()
                        : $LL.settingsMenuStorageDeleteButton()}
                </button>
            {:else if deleteStep === 2}
                <button
                    type="button"
                    class="btn btn--secondary"
                    on:click={closeDeleteConfirmation}
                    disabled={isDeleting}
                >
                    {$LL.profileSetupCancel()}
                </button>
                <button
                    type="button"
                    class="btn btn--warning"
                    on:click={confirmDeleteAllData}
                    disabled={isDeleting || !deletePassword}
                >
                    {isDeleting
                        ? $LL.settingsMenuDeleteConfirmDeleting()
                        : $LL.settingsMenuDeleteConfirmAction()}
                </button>
            {/if}
        </div>
    </dialog>
{/if}

{#if showBackupDialog}
    <dialog
        bind:this={backupDialogRef}
        class="dialog"
        aria-labelledby={backupTitleId}
        aria-describedby={backupDescriptionId}
        on:cancel|preventDefault={handleBackupDialogCancel}
        on:pointerdown={handleBackupDialogPointerDown}
        aria-modal="true"
    >
        <div class="dialog__header">
            <h3 id={backupTitleId} class="dialog__title">
                <Icon name="padlock" size={20} className="dialog__icon" />
                <span>{$LL.settingsMenuBackupTitle()}</span>
            </h3>
            <button
                type="button"
                class="btn btn--secondary"
                data-modal-close
                on:click={closeBackupDialog}
                aria-label={$LL.settingsMenuBackupCloseAria()}>×</button
            >
        </div>

        <div class="dialog__body">
            <p id={backupDescriptionId}>{$LL.settingsMenuBackupDescription()}</p>
            {#if backupError}
                <div class="error-message" role="alert">{backupError}</div>
            {/if}
            <div class="form-group">
                <label for="backup-password">{$LL.sessionUnlockPasswordLabel()}</label>
                <div class="password-input-container">
                    <input
                        id="backup-password"
                        type={showBackupPassword ? 'text' : 'password'}
                        value={backupPassword}
                        on:input={(e) => (backupPassword = e.currentTarget.value)}
                        placeholder={$LL.sessionUnlockPasswordPlaceholder()}
                        class="input"
                        disabled={isBackingUp}
                        on:keydown={(e) => e.key === 'Enter' && performBackup()}
                    />
                    <button
                        type="button"
                        class="btn btn--secondary password-toggle"
                        on:click={() => (showBackupPassword = !showBackupPassword)}
                        disabled={isBackingUp}
                        title={showBackupPassword
                            ? $LL.profileSetupToggleHide()
                            : $LL.profileSetupToggleShow()}
                        aria-label={showBackupPassword
                            ? $LL.profileSetupToggleHide()
                            : $LL.profileSetupToggleShow()}
                    >
                        <Icon
                            name={showBackupPassword ? 'eye-disabled' : 'eye'}
                            size={20}
                            className={`password-toggle-icon${showBackupPassword ? ' password-toggle-icon--disabled' : ''}`}
                        />
                    </button>
                </div>
            </div>
        </div>
        <div class="dialog__footer">
            <button
                type="button"
                class="btn btn--secondary"
                on:click={closeBackupDialog}
                disabled={isBackingUp}>{$LL.profileSetupCancel()}</button
            >
            <button
                type="button"
                class="btn btn--primary"
                on:click={performBackup}
                disabled={isBackingUp || !backupPassword}
                >{isBackingUp
                    ? $LL.settingsMenuBackupPreparing()
                    : $LL.settingsMenuBackupDownload()}</button
            >
        </div>
    </dialog>
{/if}

{#if showExportDialog}
    <ExportChatsDialog
        on:close={() => (showExportDialog = false)}
        on:exported={handleChatsExported}
    />
{/if}

{#if showRestoreDialog}
    <dialog
        bind:this={restoreDialogRef}
        class="dialog"
        aria-labelledby={restoreTitleId}
        aria-describedby={restoreDescriptionId}
        on:cancel|preventDefault={handleRestoreDialogCancel}
        on:pointerdown={handleRestoreDialogPointerDown}
        aria-modal="true"
    >
        <div class="dialog__header">
            <h3 id={restoreTitleId} class="dialog__title">{$LL.settingsMenuRestoreTitle()}</h3>
            <button
                type="button"
                class="btn btn--secondary"
                data-modal-close
                on:click={closeRestoreDialog}
                aria-label={$LL.settingsMenuRestoreCloseAria()}>×</button
            >
        </div>

        <div class="dialog__body">
            <p id={restoreDescriptionId}>{$LL.settingsMenuRestoreDescription()}</p>
            {#if restoreError}
                <div class="error-message" role="alert">{restoreError}</div>
            {/if}
            <div class="form-group">
                <span class="field-label">{$LL.restoreProfileFileLabel()}</span>
                {#if !restoreFile}
                    <div
                        class="dropzone {restoreDragActive ? 'active' : ''} {isRestoring
                            ? 'disabled'
                            : ''}"
                        role="button"
                        aria-label={$LL.restoreProfileFileLabel()}
                        tabindex={isRestoring ? -1 : 0}
                        on:click={openRestoreFileDialog}
                        on:keydown={(e) =>
                            (e.key === 'Enter' || e.key === ' ') && openRestoreFileDialog()}
                        on:dragover={handleRestoreDragOver}
                        on:dragleave={handleRestoreDragLeave}
                        on:drop={handleRestoreDrop}
                    >
                        <div class="dropzone-inner">
                            <Icon name="upload" size={32} className="dz-icon" />
                            <div class="dz-title">{$LL.restoreProfileDropzoneTitle()}</div>
                            <div class="dz-subtitle">{$LL.restoreProfileDropzoneSubtitle()}</div>
                        </div>
                        <input
                            bind:this={restoreFileInput}
                            class="file-input"
                            type="file"
                            accept=".ecb,application/octet-stream,application/json"
                            on:change={handleRestoreFileChange}
                            disabled={isRestoring}
                            tabindex="-1"
                        />
                    </div>
                {:else}
                    <div class="file-row">
                        <div class="file-name">
                            <Icon name="description" size={18} className="file-icon" />
                            <span>{restoreFile.name}</span>
                        </div>
                        <button
                            type="button"
                            class="btn btn--secondary clear-file"
                            on:click={clearRestoreFile}
                            disabled={isRestoring}
                            aria-label={$LL.restoreProfileClearFileAria()}>×</button
                        >
                    </div>
                {/if}
            </div>
            <div class="form-group">
                <label for="restore-password">{$LL.restoreProfilePasswordLabel()}</label>
                <div class="password-input-container">
                    <input
                        id="restore-password"
                        type={showRestorePassword ? 'text' : 'password'}
                        value={restorePassword}
                        on:input={(e) => (restorePassword = e.currentTarget.value)}
                        placeholder={$LL.restoreProfilePasswordPlaceholder()}
                        class="input"
                        disabled={isRestoring}
                    />
                    <button
                        type="button"
                        class="btn btn--secondary password-toggle"
                        on:click={() => (showRestorePassword = !showRestorePassword)}
                        disabled={isRestoring}
                        title={showRestorePassword
                            ? $LL.profileSetupToggleHide()
                            : $LL.profileSetupToggleShow()}
                        aria-label={showRestorePassword
                            ? $LL.profileSetupToggleHide()
                            : $LL.profileSetupToggleShow()}
                    >
                        <Icon
                            name={showRestorePassword ? 'eye-disabled' : 'eye'}
                            size={20}
                            className={`password-toggle-icon${showRestorePassword ? ' password-toggle-icon--disabled' : ''}`}
                        />
                    </button>
                </div>
            </div>
            <label class="checkbox-label">
                <input type="checkbox" bind:checked={restoreAcknowledge} disabled={isRestoring} />
                <span class="checkbox-text">{$LL.settingsMenuRestoreAcknowledgeLabel()}</span>
            </label>
        </div>
        <div class="dialog__footer">
            <button
                type="button"
                class="btn btn--secondary"
                on:click={closeRestoreDialog}
                disabled={isRestoring}>{$LL.profileSetupCancel()}</button
            >
            <button
                type="button"
                class="btn btn--warning"
                on:click={performRestore}
                disabled={isRestoring || !restoreFile || !restorePassword || !restoreAcknowledge}
                >{isRestoring ? $LL.restoreProfileSubmitting() : $LL.restoreProfileSubmit()}</button
            >
        </div>
    </dialog>
{/if}

<dialog
    bind:this={settingsDialogRef}
    class="dialog"
    aria-labelledby={settingsTitleId}
    on:cancel|preventDefault={handleDialogCancel}
    on:pointerdown={handleDialogPointerDown}
    aria-modal="true"
    style="--modal-width: 700px; --modal-min-height: 90svh"
>
    <div class="dialog__header">
        <h2 id={settingsTitleId} class="dialog__title">{$LL.settingsMenuTitle()}</h2>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={handleClose}
            aria-label={$LL.settingsMenuCloseAria()}>×</button
        >
    </div>

    <div class="settings-body">
        <nav aria-label={$LL.settingsMenuNavAria()}>
            <div
                class="settings-nav"
                bind:this={settingsNavRef}
                role="tablist"
                aria-label={$LL.settingsMenuNavAria()}
                aria-orientation="vertical"
            >
                <button
                    type="button"
                    class="btn btn--secondary"
                    role="tab"
                    id={tabButtonIds.profile}
                    aria-controls={tabPanelIds.profile}
                    aria-selected={activeTab === 'profile'}
                    tabindex={activeTab === 'profile' ? 0 : -1}
                    on:click={() => activateTabAndFocusContent('profile')}
                    on:keydown={(event) => handleNavKeydown(event, 'profile')}
                >
                    <span class="nav-icon" aria-hidden="true">
                        <Icon name="person-shield" size={20} className="nav-icon-graphic" />
                    </span>
                    <span class="nav-label">{$LL.settingsMenuNavChats()}</span>
                </button>
                <button
                    type="button"
                    class="btn btn--secondary"
                    role="tab"
                    id={tabButtonIds.storage}
                    aria-controls={tabPanelIds.storage}
                    aria-selected={activeTab === 'storage'}
                    tabindex={activeTab === 'storage' ? 0 : -1}
                    on:click={() => activateTabAndFocusContent('storage')}
                    on:keydown={(event) => handleNavKeydown(event, 'storage')}
                >
                    <span class="nav-icon" aria-hidden="true">
                        <Icon name="data-usage" size={20} className="nav-icon-graphic" />
                    </span>
                    <span class="nav-label">{$LL.settingsMenuNavStorage()}</span>
                </button>
                <button
                    type="button"
                    class="btn btn--secondary"
                    role="tab"
                    id={tabButtonIds.stats}
                    aria-controls={tabPanelIds.stats}
                    aria-selected={activeTab === 'stats'}
                    tabindex={activeTab === 'stats' ? 0 : -1}
                    on:click={() => activateTabAndFocusContent('stats')}
                    on:keydown={(event) => handleNavKeydown(event, 'stats')}
                >
                    <span class="nav-icon" aria-hidden="true">
                        <Icon name="stats" size={20} className="nav-icon-graphic" />
                    </span>
                    <span class="nav-label">{$LL.settingsMenuNavStats()}</span>
                </button>
                <button
                    type="button"
                    class="btn btn--secondary"
                    role="tab"
                    id={tabButtonIds.security}
                    aria-controls={tabPanelIds.security}
                    aria-selected={activeTab === 'security'}
                    tabindex={activeTab === 'security' ? 0 : -1}
                    on:click={() => activateTabAndFocusContent('security')}
                    on:keydown={(event) => handleNavKeydown(event, 'security')}
                >
                    <span class="nav-icon" aria-hidden="true">
                        <Icon name="padlock" size={20} className="nav-icon-graphic" />
                    </span>
                    <span class="nav-label">{$LL.settingsMenuNavSecurity()}</span>
                </button>
                <button
                    type="button"
                    class="btn btn--secondary"
                    role="tab"
                    id={tabButtonIds.about}
                    aria-controls={tabPanelIds.about}
                    aria-selected={activeTab === 'about'}
                    tabindex={activeTab === 'about' ? 0 : -1}
                    on:click={() => activateTabAndFocusContent('about')}
                    on:keydown={(event) => handleNavKeydown(event, 'about')}
                >
                    <span class="nav-icon" aria-hidden="true">
                        <Icon name="info" size={20} className="nav-icon-graphic" />
                    </span>
                    <span class="nav-label">{$LL.settingsMenuNavAbout()}</span>
                </button>
            </div>
        </nav>

        <div
            class="settings-content"
            class:has-messages={error || success}
            bind:this={settingsContentRef}
            role="group"
        >
            {#if activeTab === 'profile'}
                <ProfileTab
                    panelId={tabPanelIds.profile}
                    labelledBy={tabButtonIds.profile}
                    bind:settings
                    bind:selectedLocale
                    {languageOptions}
                    {profile}
                    bind:editingProfile
                    bind:editContacts
                    onAddContactField={addContactField}
                    onRemoveContactField={removeContactField}
                    bind:currentPassword
                    bind:newPassword
                    bind:confirmNewPassword
                    bind:changingPassword
                    {isLoading}
                    onUpdateSettings={updateSettings}
                    onLanguageChange={handleLanguageChange}
                    onStartEditingProfile={startEditingProfile}
                    onCancelEditingProfile={cancelEditingProfile}
                    onSaveProfileChanges={saveProfileChanges}
                    onOpenProfileShare={openProfileShare}
                    onStartChangingPassword={startChangingPassword}
                    onCancelChangingPassword={cancelChangingPassword}
                    onSaveNewPassword={saveNewPassword}
                    onRedoTutorial={redoTutorial}
                />
            {:else if activeTab === 'storage'}
                <StorageTab
                    panelId={tabPanelIds.storage}
                    labelledBy={tabButtonIds.storage}
                    {indexedDbHeadingId}
                    {localStorageHeadingId}
                    {storageInfo}
                    {storagePersisted}
                    {showPersistence}
                    {chatStorageBreakdown}
                    onRequestPersistence={enablePersistence}
                    onOpenBackupDialog={openBackupDialog}
                    onOpenRestoreDialog={openRestoreDialog}
                    onOpenExportDialog={openExportDialog}
                    onOpenDeleteConfirmation={openDeleteConfirmation}
                />
            {:else if activeTab === 'stats'}
                <StatsTab
                    panelId={tabPanelIds.stats}
                    labelledBy={tabButtonIds.stats}
                    {statsLoading}
                    {statsError}
                    {stats}
                />
            {:else if activeTab === 'security'}
                <SecurityTab
                    panelId={tabPanelIds.security}
                    labelledBy={tabButtonIds.security}
                    bind:settings
                    {profile}
                    {autoLockOptions}
                    onUpdateSettings={updateSettings}
                    onLockProfile={lockProfile}
                />
            {:else if activeTab === 'about'}
                <AboutTab panelId={tabPanelIds.about} labelledBy={tabButtonIds.about} />
            {/if}

            <!-- Pinned to the bottom of the scroll area: the message must stay in
                 view next to whichever action produced it, however far the user
                 has scrolled. -->
            <!-- The visual banner keeps no live-region role: content mounted
                 inside an {#if} announces unreliably, so announcement is
                 handled by the persistent nodes below. -->
            {#if error || success}
                <div class="settings-messages">
                    {#if error}
                        <div class="error-message">{error}</div>
                    {/if}

                    {#if success}
                        <div class="success-message">{success}</div>
                    {/if}
                </div>
            {/if}

            <!-- Persistent live nodes: always mounted so screen readers
                 reliably announce banner text swapped into them. -->
            <div class="sr-only" role="alert">{announceError}</div>
            <div class="sr-only" role="status">{announceSuccess}</div>
        </div>
    </div>
</dialog>

<style>
    .settings-body {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
    }

    .settings-body nav {
        display: flex;
    }

    .settings-nav {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 220px;
        padding: 1.5rem 1rem;
        border-right: 1px solid var(--color-border);
        background: var(--color-bg-subtle);
    }

    .settings-nav :global(.btn[role='tab']) {
        --btn-padding: 0.75rem 1rem;
        --btn-radius: 7px;
        --btn-bg: transparent;
        --btn-hover-bg: var(--color-bg-muted);
        --btn-border: transparent;
        --btn-color: var(--color-text-muted);
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.95rem;
        font-weight: 500;
        text-align: left;
        transition: color 0.2s ease;
    }

    .settings-nav :global(.btn[role='tab']:hover) {
        --btn-color: #006de2;
    }

    .settings-nav :global(.btn[role='tab'][aria-selected='true']) {
        --btn-bg: #006de2;
        --btn-hover-bg: #006de2;
        --btn-color: #ffffff;
    }

    .settings-nav :global(.btn[role='tab'][aria-selected='true']:hover) {
        --btn-hover-color: #ffffff;
    }

    .nav-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.1rem;
        line-height: 1;
        width: 1.8rem;
        height: 1.8rem;
    }

    .nav-icon :global(.nav-icon-graphic) {
        width: 1.2rem;
        height: 1.2rem;
    }

    .nav-label {
        flex: 1 1 auto;
        white-space: nowrap;
    }

    .settings-content {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 2rem;
        min-height: 0;
    }

    /* Drop the bottom padding so the sticky message bar seats flush against the
       panel's bottom edge instead of floating above a padding gap. */
    .settings-content.has-messages {
        padding-bottom: 0;
    }

    .dialog__body {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    @media (max-width: 768px) {
        .settings-body {
            flex-direction: column;
        }

        .settings-nav {
            flex-direction: row;
            align-items: center;
            gap: 0.75rem;
            width: 100%;
            flex: 0 0 auto;
            min-width: unset;
            border-right: none;
            border-bottom: 1px solid var(--color-border);
            padding: 0.75rem 1rem;
            overflow-x: auto;
        }

        .settings-nav :global(.btn[role='tab']) {
            flex: 1 0 auto;
            justify-content: center;
        }

        .settings-content {
            padding: 1.5rem;
        }

        .settings-messages {
            margin: 1rem -1.5rem 0;
            padding: 1rem 1.5rem;
        }
    }

    /* Sticks to the bottom edge of the scrolling panel so a message raised by a
       button further down the page can't end up off-screen above the fold. The
       negative margins bleed the backdrop over .settings-content's padding, so
       content scrolls under it rather than showing through beside it. */
    .settings-messages {
        position: sticky;
        bottom: 0;
        z-index: 5;
        margin: 1rem -2rem 0;
        padding: 1rem 2rem;
        background: var(--color-surface);
        border-top: 1px solid var(--color-border);
    }

    .error-message {
        background: var(--color-error-bg);
        border: 1px solid var(--color-error-border);
        color: var(--color-error-text);
        padding: 0.75rem;
        border-radius: 8px;
        font-size: 0.9rem;
    }

    .success-message {
        background: var(--color-success-bg);
        border: 1px solid var(--color-success-border);
        color: var(--color-success-text);
        padding: 0.75rem;
        border-radius: 8px;
        font-size: 0.9rem;
    }

    .error-message + .success-message {
        margin-top: 0.5rem;
    }

    /* The delete dialog stacks with margins, not the panel's sticky wrapper. */
    .password-confirmation .error-message {
        margin-bottom: 1rem;
        text-align: left;
    }

    .warning-content {
        text-align: center;
    }

    .warning-icon {
        font-size: 3rem;
        margin-bottom: 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .warning-icon :global(.warning-icon-graphic) {
        width: 2.25rem;
        height: 2.25rem;
    }

    .warning-content .warning-icon {
        color: var(--color-danger-text);
    }

    .warning-content h4 {
        color: var(--color-error-text);
        margin: 1rem 0;
        font-size: 1.1rem;
    }

    .delete-list {
        list-style: none;
        padding: 0;
        margin: 1.5rem 0;
        text-align: left;
    }

    .delete-list li {
        padding: 0.5rem 0;
        color: var(--color-error-text);
        font-weight: 500;
        border-bottom: 1px solid var(--color-error-border);
    }

    .final-warning {
        background: var(--color-error-bg);
        border: 2px solid var(--color-error-border);
        padding: 1rem;
        border-radius: 8px;
        color: var(--color-error-text);
        font-weight: 500;
        margin: 1.5rem 0;
    }

    .password-confirmation {
        text-align: center;
    }

    .password-confirmation h4 {
        color: var(--color-error-text);
        margin: 1rem 0;
    }

    .password-confirmation p {
        color: var(--color-text-muted);
        margin-bottom: 1.5rem;
    }

    @media (max-width: 600px) {
        .settings-content {
            padding: 1.5rem;
        }

        .settings-messages {
            margin: 1rem -1.5rem 0;
            padding: 1rem 1.5rem;
        }
    }
</style>
