<script lang="ts">
    import { onMount, tick } from 'svelte';

    // SvelteKit passes params to route components; declare it to avoid the dev-mode
    // "unknown prop" warning. This app has a single route, so it is always empty.
    // The trace read keeps the compiler from flagging the prop unused; it prints
    // nothing at the default debug level and is stripped from production builds.
    export let params: Record<string, string> | undefined = undefined;
    debug.trace('route params', params);
    import { browser } from '$app/environment';
    import { appStore, chatsStore } from '$lib/stores/app';
    import { encryptMessage, generateUUID } from '$lib/utils/crypto';
    import { copyToClipboard } from '$lib/utils/web-share';
    import { buildShareCode } from '$lib/utils/share-link';
    import ChatSetup from '$lib/components/ChatSetup.svelte';
    import DesktopLayout from '$lib/components/DesktopLayout.svelte';
    import ProfileSetup from '$lib/components/ProfileSetup.svelte';
    import ProfileBootstrap from '$lib/components/ProfileBootstrap.svelte';
    import RestoreProfile from '$lib/components/RestoreProfile.svelte';
    import SettingsMenu from '$lib/components/SettingsMenu.svelte';
    import UnlockDialog from '$lib/components/UnlockDialog.svelte';
    import { profileManager } from '$lib/utils/profile-manager';
    import { activityTracker } from '$lib/utils/activity-tracker';
    import { secureKeyManager } from '$lib/utils/secure-key-manager';
    import { debug } from '$lib/utils/debug';
    import { secureChatStorage, linkMessageOverageChars } from '$lib/utils/secure-chat-storage';
    import { uiStore } from '$lib/stores/ui-store';
    import { APP_NAME } from '$lib/constants';
    import { translations as LL } from '$lib/i18n/runtime';
    import type { StoredMessage, UserProfile } from '$lib/types';
    import type { AppView } from '$lib/types/app-view';
    import { UrlFragmentProcessor, SECURE_FRAGMENT } from '$lib/services/url-fragment-processor';
    import { tutorialController } from '$lib/services/tutorial';
    import TutorialOfferDialog from '$lib/components/TutorialOfferDialog.svelte';
    import TutorialDeferredDialog from '$lib/components/TutorialDeferredDialog.svelte';
    import { dataStorage } from '$lib/utils/indexeddb-storage';

    // Determine initial view immediately to prevent any flashing. Every check here is
    // synchronous and mirrors ProfileManager.initializeLockState(), so the first paint
    // matches where the async lock resolution will land.
    function determineInitialView(): AppView {
        if (typeof window === 'undefined') return 'chats';

        const hasProfile = localStorage.getItem('encrypted-profile-data') !== null;

        if (!hasProfile) {
            return 'profile-bootstrap';
        }

        // Mirror ProfileManager.loadProfileSettings(): missing or unparseable settings
        // fall back to the -1 default, so the guess agrees with the async resolution.
        let autoLockTimeout = -1;
        const storedSettings = localStorage.getItem('profile-settings');
        if (storedSettings) {
            try {
                const parsed = Number(JSON.parse(storedSettings).autoLockTimeout);
                autoLockTimeout = Number.isFinite(parsed) ? parsed : -1;
            } catch (e) {
                // Keep the -1 default; loadProfileSettings() does the same.
            }
        }

        if (autoLockTimeout === -2) {
            // "On every page refresh" - always show unlock dialog
            return 'unlock';
        }
        if (autoLockTimeout > 0 && activityTracker.isTimeoutExceeded(autoLockTimeout)) {
            // Timed mode whose inactivity window already expired: it is about to lock.
            return 'unlock';
        }
        // All remaining modes restore the session from the derived key in sessionStorage.
        // If it's present the restore virtually always succeeds, so paint chats right
        // away; if it's gone (locked before refresh, fresh tab), no local unlock is
        // possible, so paint the lock screen. Either rare miss (corrupt session material,
        // cross-tab session handoff) is corrected by the lock state store moments later.
        return profileManager.hasLocalSessionMaterial() ? 'chats' : 'unlock';
    }

    const initialView = determineInitialView();
    uiStore.setView(initialView, initialView === 'unlock');

    let currentView: AppView = initialView;
    let hasInitialized = false;
    let showContent = false;
    let allowUnlockDialog = initialView === 'unlock';
    let isHandlingPopState = false;
    let isMobileChatView = false;
    let desktopLayout: DesktopLayout | undefined;

    const senderName = '';

    let pendingChatCreation: { name: string; key: string } | null = null;

    let showTutorialOffer = false;
    let showTutorialDeferred = false;

    let userProfile: UserProfile | undefined;
    // Track ProfileManager's lock state from component init so the paint gate below
    // holds until the lock state is actually known (prevents flashing chat content
    // on refresh while the profile is locked / still resolving).
    const lockStateStore = profileManager.lockState;
    $: isProfileLocked = $lockStateStore.isLocked;
    $: isProfileInitializing = $lockStateStore.isInitializing ?? false;
    const footerYear = new Date().getFullYear();

    let modalState = uiStore.getCurrentState().modals;

    $: currentView = $uiStore.view.current;
    $: allowUnlockDialog = $uiStore.view.allowUnlockDialog;
    $: showContent = $uiStore.view.showContent;
    $: modalState = $uiStore.modals;
    $: toastCloseLabel = $LL.toastCloseLabel ? $LL.toastCloseLabel() : 'Close notification';

    // Text for the permanently mounted toast live regions. Cleared when the toast
    // hides (removal is not announced) so an identical follow-up message still
    // registers as a change and gets spoken again.
    let toastPoliteText = '';
    let toastAlertText = '';
    $: {
        const toast = $uiStore.toast;
        if (toast.visible && toast.message) {
            toastPoliteText = toast.type === 'error' ? '' : toast.message;
            toastAlertText = toast.type === 'error' ? toast.message : '';
        } else {
            toastPoliteText = '';
            toastAlertText = '';
        }
    }
    // Screen readers rely on the document title to announce view changes in this
    // single-route SPA, so it must track the active view.
    $: pageTitle = (() => {
        if (currentView === 'unlock') return `${$LL.unlockTitle()} - ${APP_NAME}`;
        if (currentView === 'profile-setup') return `${$LL.profileSetupTitle()} - ${APP_NAME}`;
        if (currentView === 'restore-profile')
            return `${$LL.restoreProfileTitle()} - ${APP_NAME}`;
        // Deliberately never include the open chat's name: the title leaks into
        // browser history, the window list, and the tab bar even when locked.
        // The generic "Conversation" title leaks nothing while still telling
        // screen reader users which view the window is showing.
        if (currentView === 'chats' && isMobileChatView)
            return `${$LL.pageTitleConversation()} - ${APP_NAME}`;
        if (currentView === 'chats') return `${$LL.chatListHeading()} - ${APP_NAME}`;
        return APP_NAME;
    })();
    // Mirrors the render chain below so the footer shows exactly when one of the
    // logged-out views is on screen (including an unlock view painted while the
    // lock state is still resolving).
    $: showLoggedOutFooter =
        showContent &&
        (currentView === 'profile-bootstrap' ||
            currentView === 'profile-setup' ||
            currentView === 'restore-profile' ||
            currentView === 'unlock' ||
            (!isProfileInitializing && profileManager.hasProfile() && isProfileLocked));

    const urlFragmentProcessor = new UrlFragmentProcessor({
        appStore,
        chatsStore,
        uiStore,
        secureKeyManager,
        secureChatStorage,
        navigateTo,
        openChat: (chatId: string) => {
            appStore.setCurrentChat(chatId);
            navigateTo('chats');
            if (window.innerWidth <= 999) {
                isMobileChatView = true;
            }
        },
    });

    function navigateTo(view: AppView, options?: { allowUnlockDialog?: boolean }) {
        uiStore.setView(view, options?.allowUnlockDialog ?? view === 'unlock');
        if (browser) {
            if (!isHandlingPopState) {
                // Intentionally using native history API: this app is a single-route SPA
                // where all "views" are UI state, not SvelteKit routes. Native pushState
                // has no actual conflict with SvelteKit's router here.
                history.pushState({ view }, '');
            }
            window.scrollTo(0, 0);
            // Move focus to the main landmark so keyboard and screen reader users
            // land on the new view instead of the control that triggered navigation.
            void tick().then(() => {
                document.querySelector('main')?.focus();
            });
        }
    }

    // Only the top layer can paint over a showModal() dialog; no z-index can. Popovers
    // join it, stacked in show order, so a toast raised over an open dialog wins.
    function topLayer(node: HTMLElement) {
        node.setAttribute('popover', 'manual');
        try {
            node.showPopover?.();
        } catch {
            // Unsupported or already detached: falls back to the z-index below the dialog.
        }
        return {
            destroy() {
                try {
                    node.hidePopover?.();
                } catch {
                    // Already gone from the top layer.
                }
            },
        };
    }

    function openChatSetup(backgroundView?: AppView) {
        if (backgroundView && currentView !== backgroundView) {
            navigateTo(backgroundView, { allowUnlockDialog: backgroundView === 'unlock' });
        }
        uiStore.openModal('chatSetup');
    }

    function closeChatSetup(targetView: AppView = 'chats') {
        uiStore.closeModal('chatSetup');
        navigateTo(targetView);
    }

    function handleResize() {
        if (window.innerWidth > 999) {
            isMobileChatView = false;
        }
    }

    function ensureViewReady(reason: string) {
        if (typeof document === 'undefined') return;

        const hasViewReady = document.body.classList.contains('view-ready');
        if (!hasViewReady) {
            debug.warn(`Forcing view-ready state (${reason})`);
            document.body.classList.add('view-ready');
        }

        const { showContent: hasContent } = uiStore.getCurrentState().view;
        if (!hasContent) {
            uiStore.showContent();
        }
    }

    // Markers the app knows how to receive: shared content (#secure=) and WebRTC
    // connection signals (#webrtc-offer= / #webrtc-answer=). Pasting any of these into
    // the message box (or a full link containing one) imports it instead of sending it.
    const RECEIVABLE_MARKERS = ['#secure=', '#webrtc-offer=', '#webrtc-answer='];

    // Detects a share/connection fragment (a full URL or a bare code) in pasted text and
    // returns its hash (e.g. "#secure=..."), or null if it isn't one. This lets the
    // recipient receive by pasting into the already-open, unlocked app instead of opening
    // it in the browser, which would spawn a new, separately-locked tab. Detection keys
    // off the exact markers, so any other text, including raw base64, is sent normally.
    function extractShareFragment(text: string): string | null {
        const trimmed = text.trim();
        const hashIndex = trimmed.indexOf('#');
        if (hashIndex === -1) return null;
        const hash = trimmed.slice(hashIndex);
        return RECEIVABLE_MARKERS.some((m) => hash.startsWith(m)) ? hash : null;
    }

    onMount(() => {
        if (!browser) return;

        // Prune stale replay-protection UUID records (>30 days old) on startup
        dataStorage.pruneOldUUIDs().catch(() => {});

        window.addEventListener('resize', handleResize);

        history.replaceState({ view: initialView }, '');

        const popStateHandler = (event: PopStateEvent) => {
            const view = event.state?.view as AppView | undefined;
            if (view) {
                isHandlingPopState = true;
                navigateTo(view);
                isHandlingPopState = false;
            }
        };
        window.addEventListener('popstate', popStateHandler);

        const hashChangeHandler = () => {
            urlFragmentProcessor.handleHashChange(window.location.hash);
        };
        window.addEventListener('hashchange', hashChangeHandler);

        const pageShowHandler = () => {
            ensureViewReady('pageshow');
        };
        window.addEventListener('pageshow', pageShowHandler);

        const visibilityHandler = () => {
            if (!document.hidden) {
                ensureViewReady('visibility');
            }
        };
        document.addEventListener('visibilitychange', visibilityHandler);

        // Global paste-to-receive: pasting a share link/code onto a non-editable part of
        // the page imports it into this open tab. Pastes into editable fields (the message
        // box, inputs) are left alone so the text lands there and the message box can do
        // double duty: the recipient pastes a received message and sends it, which the
        // send handler detects and imports (see handleSendMessage). Non-share pastes always
        // fall through untouched.
        const pasteHandler = (event: ClipboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (
                target &&
                target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')
            ) {
                return;
            }
            const text = event.clipboardData?.getData('text') ?? '';
            const fragment = extractShareFragment(text);
            if (!fragment) return;
            event.preventDefault();
            urlFragmentProcessor.captureFromHash(fragment);
            urlFragmentProcessor
                .processPending()
                .catch((error) => debug.error('Failed to process pasted link:', error));
        };
        document.addEventListener('paste', pasteHandler);

        const viewReadyFailsafe = window.setTimeout(() => {
            ensureViewReady('failsafe');
        }, 2000);

        const cleanups: Array<() => void> = [];

        // Initialize secure managers on window object for backward compatibility
        if (typeof window !== 'undefined') {
            window.secureKeyManager = secureKeyManager;
            window.secureChatStorage = secureChatStorage;
        }

        const initialize = async () => {
            // currentView and allowUnlockDialog are already set by determineInitialView() in the variable declarations
            // Mark ready to show content, then flush Svelte's pending DOM updates before
            // making the body visible; this ensures the correct view is in the DOM
            // before the user sees anything (no loading-spinner flash).
            uiStore.showContent();
            await tick();
            document.body.classList.add('view-ready');

            // Small delay to ensure the view change is rendered before app initialization
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Extract URL fragment data immediately and clean browser history
            urlFragmentProcessor.captureFromHash(window.location.hash);

            await appStore.init();

            // Restore any in-progress guided tour (no-op if none); chats are loaded by now.
            tutorialController.hydrate();

            // Clear any stored conversation state on refresh to ensure we always go to homepage
            appStore.setCurrentChat(null);

            // Subscribe to profile manager first, then allow UI to render
            const unsubscribeProfile = profileManager.profile.subscribe((profile) => {
                userProfile = profile;
            });
            cleanups.push(unsubscribeProfile);

            const unsubscribeLockState = profileManager.lockState.subscribe((lockState) => {
                if (lockState.isLocked && profileManager.hasProfile()) {
                    if (!(lockState.isInitializing ?? false)) {
                        // Only close modals if they're actually open (avoids unnecessary store updates)
                        const ms = uiStore.getCurrentState().modals;
                        if (ms.settings) uiStore.closeModal('settings');
                        if (ms.profileSetup) uiStore.closeModal('profileSetup');
                        if (currentView !== 'unlock' || !allowUnlockDialog) {
                            navigateTo('unlock', { allowUnlockDialog: true });
                        }
                    }
                } else if (!lockState.isLocked && profileManager.hasProfile()) {
                    if (hasInitialized) {
                        appStore.setCurrentChat(null);
                        navigateTo('chats');
                    } else if (currentView !== 'chats') {
                        navigateTo('chats');
                    }
                }
            });
            cleanups.push(unsubscribeLockState);

            hasInitialized = true;

            // Wait for the lock state to settle before processing incoming links. On a
            // freshly opened tab this lets a cross-tab session handoff complete, so we
            // decrypt straight away instead of prompting for unlock unnecessarily.
            await profileManager.ready;

            await urlFragmentProcessor.processPending();
        };

        initialize().catch((error) => {
            debug.error('Failed to initialize app:', error);
        });

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('popstate', popStateHandler);
            window.removeEventListener('hashchange', hashChangeHandler);
            window.removeEventListener('pageshow', pageShowHandler);
            document.removeEventListener('visibilitychange', visibilityHandler);
            document.removeEventListener('paste', pasteHandler);
            clearTimeout(viewReadyFailsafe);
            cleanups.forEach((cleanup) => {
                try {
                    cleanup();
                } catch (error) {
                    debug.warn('Cleanup error during onDestroy:', error);
                }
            });
        };
    });

    function handleCreateProfile() {
        uiStore.openModal('profileSetup');
    }

    function handleBootstrapCreate() {
        navigateTo('profile-setup');
    }

    function handleBootstrapRestore() {
        navigateTo('restore-profile');
    }

    async function handleProfileCreated() {
        uiStore.closeModal('profileSetup');

        // Session is now automatically unlocked by ProfileManager.createProfile()
        debug.log('New profile created - session ready for use');

        // Go straight to the chats view after creating an account. First-timers get the
        // optional guided-tour offer instead of a separate welcome screen.
        navigateTo('chats');
        if ($appStore.isFirstTime && !tutorialController.hasBeenOffered()) {
            showTutorialOffer = true;
        }
    }

    async function handleProfileUnlocked(
        event: CustomEvent<{ profile: UserProfile; masterPassword: string }>
    ) {
        const { profile, masterPassword } = event.detail;
        // Initialize the app store with the unlocked profile
        // This ensures that chat keys are properly loaded
        try {
            await appStore.unlockApp(masterPassword);
        } catch (error) {
            debug.error('Failed to unlock app store:', error);
        }

        // Retry any pending URL payloads (messages, offers, etc.) now that the profile is unlocked
        await urlFragmentProcessor.processPending();

        if (pendingChatCreation) {
            debug.log(
                'Profile unlocked - retrying pending chat creation:',
                pendingChatCreation.name
            );

            debug.log('Session locked state before retry:', secureKeyManager.isSessionLocked());

            const { name, key } = pendingChatCreation;
            pendingChatCreation = null;

            if (secureKeyManager.isSessionLocked()) {
                debug.log('Session still locked - unlocking again before retry');
                try {
                    await appStore.unlockApp(masterPassword);
                } catch (unlockError) {
                    debug.error('Failed to unlock session for retry:', unlockError);
                    showToast('Failed to unlock session. Please try again.', 'error');
                    openChatSetup('chats');
                    return;
                }
            }

            try {
                await appStore.addChat(name, key);
                debug.log('Pending chat creation completed successfully');
                showToast(`Chat "${name}" created successfully!`, 'success');
                closeChatSetup('chats');
                if (window.innerWidth <= 999) {
                    isMobileChatView = true;
                }
                await desktopLayout?.focusChatPane();
                return; // Exit early, don't continue to other view logic
            } catch (error) {
                debug.error('Failed to create pending chat after unlock:', error);
                debug.log(
                    'Session locked state after failed retry:',
                    secureKeyManager.isSessionLocked()
                );
                showToast('Failed to create chat. Please try again.', 'error');
                openChatSetup('chats');
                return;
            }
        }

        // Clear any stored conversation state to ensure we go to homepage
        appStore.setCurrentChat(null);

        // Navigation will be handled by the lock state subscription
        // currentView will automatically change to 'chats'
    }

    function handleRestoreCompleted() {
        showToast($LL.toastAccountRestored(), 'success');
        // After restore, route to chats; lock state subscription will manage if needed
        navigateTo('chats');
    }

    function handleProfileLocked() {
        uiStore.closeModal('settings');
    }

    async function handleTutorialStart() {
        showTutorialOffer = false;
        await tutorialController.start();
        if (window.innerWidth <= 999) {
            isMobileChatView = true;
        }
    }

    function handleTutorialSkip() {
        showTutorialOffer = false;
        tutorialController.markOffered();
        // Reassure the user the tour isn't gone for good.
        showTutorialDeferred = true;
    }

    async function handleRedoTutorial() {
        uiStore.closeModal('settings');
        await tutorialController.restart();
        if (window.innerWidth <= 999) {
            isMobileChatView = true;
        }
    }

    async function handleCreateChat(event: CustomEvent<{ name: string; key: string }>) {
        const { name, key } = event.detail;
        try {
            await appStore.addChat(name, key);
            closeChatSetup('chats');
            // addChat already made the new chat current; on mobile the chat pane is a
            // separate view, so switch to it instead of dropping back to the list.
            if (window.innerWidth <= 999) {
                isMobileChatView = true;
            }
            // Creating a chat opens it, so focus follows into it. Without this the
            // dialog returns focus to whatever row was focused before, leaving the
            // keyboard somewhere unrelated to the chat now on screen.
            await desktopLayout?.focusChatPane();
        } catch (error) {
            if (error instanceof Error) {
                const message = error.message;
                if (
                    message.includes('unlock your session') ||
                    message.includes('Session is locked')
                ) {
                    pendingChatCreation = { name, key };
                    showToast('Session locked. Please unlock to continue creating chat.', 'info');
                    closeChatSetup('unlock');
                    return;
                }
                showToast(message, 'error');
            } else {
                showToast('Failed to create chat', 'error');
            }
        }
    }

    function handleGoBackFromSetup() {
        pendingChatCreation = null;
        closeChatSetup('chats');
    }

    function handleOpenChat(event: CustomEvent<{ id: string; messageId?: string }>) {
        appStore.setCurrentChat(event.detail.id);
        if (window.innerWidth <= 999) {
            isMobileChatView = true;
        }
    }

    function handleAddChat() {
        openChatSetup('chats');
    }

    function handleOpenSettings() {
        uiStore.openModal('settings');
    }

    function handleGoBackFromChat() {
        appStore.setCurrentChat(null);
        if (window.innerWidth <= 999) {
            isMobileChatView = false;
        }
    }

    function handleDeleteChat(event: CustomEvent<{ id: string }>) {
        appStore.deleteChat(event.detail.id);
    }

    async function handleSendMessage(
        event: CustomEvent<{
            chatId: string;
            message: string;
            reaction?: { targetRemoteUuid: string; type: 'laugh' | 'heart' | '100' } | null;
        }>
    ) {
        const { chatId, message, reaction } = event.detail;
        const conversation = $chatsStore.find((c) => c.id === chatId);
        if (!conversation) return;

        const incomingFragment = extractShareFragment(message);

        // Guided tour: the Tutorial chat is a scripted dummy account; nothing sent in it runs the
        // real send/receive pipeline, so a pasted code is never decrypted or imported. The stand-in
        // just replies as scripted. The one genuine exchange is the live "Go online" WebRTC
        // handshake: the offer is answered by the local stand-in, and the answer really connects.
        if (tutorialController.isTutorialChat(chatId)) {
            if (incomingFragment?.startsWith('#webrtc-offer=')) {
                await tutorialController.notifyOfferSent(chatId);
                return;
            }
            if (incomingFragment?.startsWith('#webrtc-answer=')) {
                urlFragmentProcessor.captureFromHash(incomingFragment);
                await urlFragmentProcessor.processPending();
                return;
            }
            await tutorialController.handleScriptedSend(
                chatId,
                message,
                senderName,
                incomingFragment != null
            );
            return;
        }

        // The message box doubles as the inbox: if what's being "sent" is actually a received
        // message (a share link or a raw code), decrypt and display it in place instead of sending
        // it. The processor trial-decrypts across chats, so it lands in the right conversation
        // regardless of which one is open.
        if (incomingFragment) {
            urlFragmentProcessor.captureFromHash(incomingFragment);
            await urlFragmentProcessor.processPending();
            return;
        }

        try {
            const rtResult = await appStore.sendRealTimeMessage(chatId, message, senderName);
            if (rtResult.ok) {
                const storedMessage: StoredMessage = {
                    id: generateUUID(),
                    from: senderName,
                    body: message,
                    timestamp: Date.now(),
                    isOwn: true,
                    deliveryMethod: 'online',
                    remoteUuid: rtResult.remoteUuid,
                };
                appStore.addMessage(chatId, storedMessage);
                return;
            }

            // Falling back to link delivery, which caps the message size. Surface
            // the overage in characters so the user knows how much to trim.
            const overageChars = linkMessageOverageChars(message);
            if (overageChars > 0) {
                showToast($LL.errorMessageTooLongForLink({ count: overageChars }), 'error');
                return;
            }

            if (
                typeof window !== 'undefined' &&
                window.secureKeyManager?.hasConversationKey?.(chatId) &&
                window.secureChatStorage
            ) {
                const forcedUuid = generateUUID();
                const encodedPayload = await window.secureChatStorage.createSharePayload(
                    chatId,
                    message,
                    senderName,
                    reaction?.type
                        ? { meta: { emoji: reaction.type }, forceMessageUuid: forcedUuid }
                        : { forceMessageUuid: forcedUuid }
                );
                // Shares are always copied as a code (the bare fragment, no URL) so it
                // can't be tapped into a new browser tab; the recipient pastes it into
                // their open app instead.
                const shareText = buildShareCode(`${SECURE_FRAGMENT}${encodedPayload}`);

                const storedMessage: StoredMessage = {
                    id: generateUUID(),
                    from: senderName,
                    body: message,
                    timestamp: Date.now(),
                    isOwn: true,
                    deliveryMethod: 'offline',
                    remoteUuid: forcedUuid,
                };

                appStore.addMessage(chatId, storedMessage);
                appStore.markUUIDAsUsed(forcedUuid);
                try {
                    const copied = await copyToClipboard(shareText);
                    if (copied) {
                        showToast($LL.toastCopiedCodeToClipboard(), 'success');
                    }
                } catch {
                    // Clipboard failures are non-blocking
                }
                return;
            }

            let cryptoKey: CryptoKey | null = null;
            try {
                // Forward secrecy: encrypt with today's rotating per-day key, not a static key.
                cryptoKey = await secureKeyManager.getSendMessageKey(chatId);
                if (!cryptoKey) {
                    throw new Error($LL.errorNoConversationKeyUnlockAccount());
                }
            } catch (error) {
                debug.warn('Failed to get key from secure manager:', error);
                throw new Error($LL.errorNoConversationKeyUnlockAccount());
            }

            const encryptedData = await encryptMessage(message, senderName, cryptoKey);
            const shareCode = buildShareCode(`#secure=${encryptedData}`);

            const storedMessage: StoredMessage = {
                id: generateUUID(),
                from: senderName,
                body: message,
                timestamp: Date.now(),
                isOwn: true,
                deliveryMethod: 'offline',
            };

            appStore.addMessage(chatId, storedMessage);
            try {
                const copied = await copyToClipboard(shareCode);
                if (copied) {
                    showToast($LL.toastCopiedCodeToClipboard(), 'success');
                }
            } catch {
                // Clipboard failures are non-blocking
            }
        } catch (error) {
            debug.error('Failed to send message:', error);
            showToast($LL.pageSendMessageFailed(), 'error');
        }
    }

    function showToast(message: string, type: 'info' | 'success' | 'error' = 'info') {
        uiStore.showToast(message, type);
    }
</script>

<svelte:head>
    <title>{pageTitle}</title>
    <meta name="description" content="Decentralized, privacy-first chat application" />
</svelte:head>

{#if !showContent}
    <!-- Pre-mount loading state. determineInitialView() decides lock vs chats
         synchronously and accurately, so this is only shown in the brief window
         before showContent flips (normally invisible behind the body opacity gate).
         Styled like the unlock screen (brand backdrop + dialog card) so any rare
         sighting of it blends with the surrounding views. -->
    <div class="app-loading brand-backdrop">
        <div class="app-loading-card" role="status">
            <div class="loading-spinner"></div>
            <span class="sr-only">{$LL.pageLoading()}</span>
        </div>
    </div>
{:else if currentView === 'unlock' || (!isProfileInitializing && profileManager.hasProfile() && isProfileLocked)}
    <!-- Unlock screen is evaluated before view routing so there is exactly one mounted instance.
         This prevents Svelte from destroying/recreating the component when internal state
         transitions cause the condition to briefly pass through the {else} fallback. -->
    <UnlockDialog
        on:profile-unlocked={handleProfileUnlocked}
        on:cancel={() => {
            /* No cancel option for security */
        }}
    />
{:else if currentView === 'profile-bootstrap'}
    <ProfileBootstrap on:create-new={handleBootstrapCreate} on:restore={handleBootstrapRestore} />
{:else if currentView === 'profile-setup'}
    <ProfileSetup isRequired={true} on:profile-created={handleProfileCreated} />
{:else if currentView === 'restore-profile'}
    <RestoreProfile
        isRequired={true}
        on:restore-completed={handleRestoreCompleted}
        on:cancel={() => navigateTo('profile-bootstrap')}
    />
{:else if currentView === 'chats'}
    <!-- Desktop: Always show DesktopLayout. Mobile: Show DesktopLayout unless in chat view -->
    <div class="app-layout" class:mobile-chat-view={isMobileChatView}>
        <DesktopLayout
            bind:this={desktopLayout}
            on:open-chat={handleOpenChat}
            on:add-chat={handleAddChat}
            on:open-settings={handleOpenSettings}
            on:send-message={handleSendMessage}
            on:delete-chat={handleDeleteChat}
            on:go-back-from-chat={handleGoBackFromChat}
        />
    </div>
{:else}
    <div class="loading-container" role="status">
        <div class="loading-spinner"></div>
        <p>{$LL.pageInitializing()}</p>
    </div>
{/if}

{#if showLoggedOutFooter}
    <footer class="logged-out-footer" aria-label={$LL.footerAria()}>
        <span>{$LL.footerLicense()}</span>
        <span class="footer-separator" aria-hidden="true">|</span>
        <a
            href="https://github.com/frassinogrande/decrypt-chat"
            target="_blank"
            rel="noopener noreferrer"
        >
            GitHub
        </a>
        <span class="footer-separator" aria-hidden="true">|</span>
        <a
            href="https://github.com/frassinogrande/decrypt-chat/blob/main/PRIVACY_POLICY.md"
            target="_blank"
            rel="noopener noreferrer"
        >
            {$LL.footerPrivacyPolicy()}
        </a>
    </footer>
{/if}

{#if modalState.chatSetup}
    <ChatSetup
        on:create-chat={handleCreateChat}
        on:go-back={handleGoBackFromSetup}
        on:show-toast={(event) => showToast(event.detail.message, event.detail.type)}
    />
{/if}

<!-- Toast announcers: live regions must exist in the tree BEFORE their content
     changes or VoiceOver/NVDA frequently skip the announcement, so these stay
     permanently mounted and only their text swaps. The visual toast below is a
     popover that re-parents into the top layer, which is another reason it cannot
     double as the live region. Errors go through role="alert" (assertive). -->
<div class="sr-only" role="status">{toastPoliteText}</div>
<div class="sr-only" role="alert">{toastAlertText}</div>

{#if $uiStore.toast.visible}
    <div
        use:topLayer
        class="toast toast-{$uiStore.toast.type}"
        class:show={$uiStore.toast.visible}
        role="presentation"
        on:mouseenter={() => uiStore.pauseToastAutoDismiss()}
        on:mouseleave={() => uiStore.resumeToastAutoDismiss()}
        on:focusin={() => uiStore.pauseToastAutoDismiss()}
        on:focusout={() => uiStore.resumeToastAutoDismiss()}
    >
        <span class="toast-message">{$uiStore.toast.message}</span>
        <button
            type="button"
            class="btn btn--secondary toast-close"
            data-modal-close
            on:click={uiStore.hideToast}
            aria-label={toastCloseLabel}
        >
            ×
        </button>
    </div>
{/if}

{#if modalState.profileSetup}
    <ProfileSetup
        on:profile-created={handleProfileCreated}
        on:cancel={() => uiStore.closeModal('profileSetup')}
    />
{/if}

{#if modalState.settings}
    <SettingsMenu
        on:close={() => uiStore.closeModal('settings')}
        on:profile-locked={handleProfileLocked}
        on:redo-tutorial={handleRedoTutorial}
    />
{/if}

<TutorialOfferDialog
    show={showTutorialOffer}
    on:start={handleTutorialStart}
    on:skip={handleTutorialSkip}
/>
<TutorialDeferredDialog show={showTutorialDeferred} on:ok={() => (showTutorialDeferred = false)} />

<style>
    :global(.share-dialog-overlay) {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: 1rem;
    }

    :global(.share-dialog) {
        background: var(--color-surface);
        border-radius: 12px;
        padding: 2rem;
        max-width: 500px;
        width: 100%;
        text-align: center;
    }

    :global(.share-dialog h3) {
        margin: 0 0 1.5rem 0;
        color: var(--color-text);
    }

    :global(.share-options) {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        margin-bottom: 1.5rem;
    }

    :global(.qr-container img) {
        max-width: 200px;
        width: 100%;
        height: auto;
        border: 1px solid var(--color-border);
        border-radius: 8px;
    }

    :global(.qr-container p) {
        margin: 0.5rem 0 0 0;
        color: var(--color-text-muted);
        font-size: 0.9rem;
    }

    :global(.url-container) {
        display: flex;
        gap: 0.5rem;
    }

    :global(.url-input) {
        flex: 1;
        padding: 0.75rem;
        border: 2px solid var(--color-border);
        border-radius: 6px;
        font-size: 0.9rem;
        background: var(--color-bg-subtle);
        color: var(--color-text);
    }

    :global(.copy-button) {
        background: #006de2;
        color: white;
        border: none;
        padding: 0.75rem 1rem;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.9rem;
        white-space: nowrap;
    }

    :global(.copy-button:hover) {
        background: #0056b3;
    }

    :global(.close-button) {
        background: #6c757d;
        color: white;
        border: none;
        padding: 0.75rem 2rem;
        border-radius: 6px;
        cursor: pointer;
        font-size: 1rem;
    }

    :global(.close-button:hover) {
        background: #545b62;
    }

    :global(.response-actions) {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        margin: 1.5rem 0;
    }

    .toast {
        position: fixed;
        inset: auto;
        margin: 0;
        border: none;
        overflow: visible;
        width: auto;
        height: auto;
        top: 20px;
        right: 20px;
        background: #333;
        color: white;
        padding: 1rem 1.5rem;
        border-radius: 8px;
        font-size: 0.9rem;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        transform: translateX(400px);
        transition: transform 0.3s ease-out;
        z-index: 2000;
        max-width: 300px;
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .toast.show {
        transform: translateX(0);
    }

    .toast-info {
        background: #006de2;
    }

    .toast-success {
        background: #28a745;
    }

    .toast-error {
        background: #dc3545;
    }

    .toast .toast-close[data-modal-close] {
        width: 1.75rem;
        height: 1.75rem;
        font-size: 1.25rem;
        margin-left: auto;
        background: rgba(255, 255, 255, 0.15);
        color: white;
        opacity: 0.8;
    }

    .toast .toast-close[data-modal-close]:hover {
        background: rgba(255, 255, 255, 0.3);
        color: white;
        opacity: 1;
    }

    .logged-out-footer {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        margin: 0 auto;
        padding: 0.5rem 1rem;
        border-top: 1px solid var(--color-border);
        color: var(--color-text-muted);
        font-size: 0.75rem;
        letter-spacing: 0.02em;
    }

    .logged-out-footer a {
        color: inherit;
        text-decoration: none;
    }

    .logged-out-footer a:hover,
    .logged-out-footer a:focus {
        color: var(--color-text);
        text-decoration: underline;
    }

    @media (max-width: 600px) {
        :global(.share-dialog) {
            padding: 1.5rem;
        }

        :global(.url-container) {
            flex-direction: column;
        }

        :global(.qr-container img) {
            max-width: 150px;
        }

        .toast {
            top: 10px;
            right: 10px;
            left: 10px;
            max-width: none;
            transform: translateY(-100px);
        }

        .toast.show {
            transform: translateY(0);
        }
    }

    .loading-container,
    .app-loading {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 9999;
    }

    .loading-container {
        background: var(--color-bg-subtle);
    }

    /* Match the unlock screen so the spinner-to-unlock handoff is seamless: the
       global .brand-backdrop class supplies the blue background and watermark
       (no background declared here so it isn't overridden by scope specificity),
       and the card mirrors .unlock-dialog in UnlockDialog.svelte. */
    .app-loading {
        padding: 1rem;
    }

    .app-loading-card {
        background: var(--color-dialog-bg);
        border-radius: 20px;
        padding: 2.5rem;
        width: 100%;
        max-width: 450px;
        min-height: 280px;
        box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
        display: flex;
        justify-content: center;
        align-items: center;
    }

    /* Prevent any flash by hiding content until viewDetermined */
    :global(body) {
        opacity: 0;
    }

    :global(body.view-ready) {
        opacity: 1;
    }

    .loading-spinner {
        width: 40px;
        height: 40px;
        border: 4px solid var(--color-input-border);
        border-top: 4px solid var(--color-accent-text);
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .app-layout {
        height: 100vh;
        height: 100svh;
        width: 100vw;
        overflow: hidden;
    }
</style>
