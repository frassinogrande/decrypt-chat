import { derived, get, writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { appStore } from './app';
import { uiStore } from './ui-store';
import { buildShareCode } from '$lib/utils/share-link';
import { copyToClipboard } from '$lib/utils/web-share';
import { tutorialController } from '$lib/services/tutorial';
import { translations as LL } from '$lib/i18n/runtime';
import { debug } from '$lib/utils/debug';

export type ConnectionRole = 'sender' | 'receiver';

export interface ChatConnectionState {
    showPanel: boolean;
    connectionUrl: string;
    isGeneratingOffer: boolean;
    hasActiveOffer: boolean;
    generatedAnswerUrl: string;
    quickMode: boolean;
    currentRole: ConnectionRole | null;
    processedOfferData: string;
    receivedAnswerData: string;
    connectionFailed: boolean;
    canRetryConnection: boolean;
    autoCopied: boolean;
}

const defaultState = (): ChatConnectionState => ({
    showPanel: false,
    connectionUrl: '',
    isGeneratingOffer: false,
    hasActiveOffer: false,
    generatedAnswerUrl: '',
    quickMode: false,
    currentRole: null,
    processedOfferData: '',
    receivedAnswerData: '',
    connectionFailed: false,
    canRetryConnection: false,
    autoCopied: false,
});

const stateMap = writable(new Map<string, ChatConnectionState>());

function updateState(chatId: string, updater: (state: ChatConnectionState) => void) {
    stateMap.update((map) => {
        const next = new Map(map);
        const current = next.get(chatId) ?? defaultState();
        const updated = { ...current };
        updater(updated);
        next.set(chatId, updated);
        return next;
    });
}

function getSnapshot(chatId: string): ChatConnectionState {
    const map = get(stateMap);
    return map.get(chatId) ?? defaultState();
}

function setState(chatId: string, state: ChatConnectionState) {
    stateMap.update((map) => {
        const next = new Map(map);
        next.set(chatId, state);
        return next;
    });
}

function state(chatId: string): Readable<ChatConnectionState> {
    return derived(stateMap, (map) => map.get(chatId) ?? defaultState());
}

function setAutoCopied(chatId: string, copied: boolean) {
    updateState(chatId, (state) => {
        state.autoCopied = copied;
    });
}

export interface PendingAutoCopy {
    fulfill: (chatId: string, code: string) => void;
    discard: () => void;
}

// Gesture-anchored auto-copy of a connection code that does not exist yet.
// Safari revokes a gesture's transient activation at the first await, so the
// clipboard write must start inside the gesture: armAutoCopy() synchronously
// hands copyToClipboard a pending promise, and the code generation later
// settles it via fulfill (copy the finished code) or discard (abort, leaving
// the clipboard untouched). Arm only synchronously from the user gesture that
// starts the flow.
let pendingAutoCopy: PendingAutoCopy | null = null;

function armAutoCopy(): PendingAutoCopy {
    pendingAutoCopy?.discard();

    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });

    let settled = false;
    let copiedChatId = '';
    const entry: PendingAutoCopy = {
        fulfill(chatId, value) {
            if (settled) return;
            settled = true;
            if (pendingAutoCopy === entry) pendingAutoCopy = null;
            copiedChatId = chatId;
            resolveCode(value);
        },
        discard() {
            if (settled) return;
            settled = true;
            if (pendingAutoCopy === entry) pendingAutoCopy = null;
            rejectCode(new Error('auto-copy discarded'));
        },
    };
    pendingAutoCopy = entry;

    void copyToClipboard(code).then(
        (ok) => {
            if (ok && copiedChatId) setAutoCopied(copiedChatId, true);
        },
        () => {}
    );

    return entry;
}

function fulfillAutoCopy(chatId: string, code: string) {
    pendingAutoCopy?.fulfill(chatId, code);
}

function discardAutoCopy() {
    pendingAutoCopy?.discard();
}

async function generateOffer(chatId: string) {
    const snapshot = getSnapshot(chatId);
    if (snapshot.isGeneratingOffer || snapshot.connectionUrl) return;

    // Runs synchronously within the go-online gesture (directly or in its
    // microtask flush), so the auto-copy is armed here rather than by callers.
    const autoCopy = armAutoCopy();
    updateState(chatId, (state) => {
        state.isGeneratingOffer = true;
        state.autoCopied = false;
    });

    try {
        // The guided tutorial connects to an on-device stand-in, so it never needs STUN;
        // real chats do, for NAT traversal.
        const localOnly = tutorialController.isTutorialChat(chatId);
        const offer = await appStore.initWebRTC(chatId, { localOnly });
        const offerUrl = buildShareCode(`#webrtc-offer=${encodeURIComponent(offer)}`);
        updateState(chatId, (state) => {
            state.connectionUrl = offerUrl;
            state.hasActiveOffer = true;
        });
        autoCopy.fulfill(chatId, offerUrl);
        // Guided tour: a local stand-in answers the offer so going online actually connects.
        void tutorialController.notifyWentOnline(chatId, offer);
    } catch (error) {
        debug.error('Failed to generate offer:', error);
        const t = get(LL);
        const message = error instanceof Error ? error.message : t.commonUnknown();
        alert(t.chatInterfaceErrorOffer({ reason: message }));
    } finally {
        autoCopy.discard();
        updateState(chatId, (state) => {
            state.isGeneratingOffer = false;
        });
    }
}

async function processCode(chatId: string, code: string) {
    const input = code.trim();
    const t = get(LL);

    try {
        if (input.includes('#webrtc-offer=')) {
            const urlParts = input.split('#webrtc-offer=');
            if (urlParts.length !== 2) throw new Error('Invalid connection URL format');
            const data = decodeURIComponent(urlParts[1]);

            updateState(chatId, (state) => {
                state.processedOfferData = data;
            });

            const result = await appStore.handleWebRTCOffer(data);
            const answerUrl = buildShareCode(`#webrtc-answer=${encodeURIComponent(result.answer)}`);

            appStore.setCurrentChat(result.chatId);
            updateState(chatId, (state) => {
                state.generatedAnswerUrl = answerUrl;
                state.hasActiveOffer = false;
            });
        } else if (input.includes('#webrtc-answer=')) {
            const urlParts = input.split('#webrtc-answer=');
            if (urlParts.length !== 2) throw new Error('Invalid connection URL format');
            const data = decodeURIComponent(urlParts[1]);

            updateState(chatId, (state) => {
                state.receivedAnswerData = data;
            });

            await appStore.handleWebRTCAnswer(chatId, data);
        } else {
            throw new Error('Invalid connection URL format');
        }
    } catch (error) {
        debug.error('Failed to process connection code:', error);
        const message = error instanceof Error ? error.message : t.commonUnknown();
        if (message.includes('Failed to decrypt signal data')) {
            alert(t.chatInterfaceErrorConnectionChecklist());
        } else if (message.includes('Invalid connection URL format')) {
            alert(t.chatInterfaceErrorConnectionInvalid());
        } else {
            alert(t.chatInterfaceErrorConnectionGeneric({ reason: message }));
        }
    }
}

async function retryConnection(chatId: string) {
    debug.log('[DEBUG] Retrying connection for chat:', chatId);
    await appStore.retryConnection(chatId);
    updateState(chatId, (state) => {
        state.connectionFailed = false;
        state.canRetryConnection = false;
        state.hasActiveOffer = false;
        state.connectionUrl = '';
        state.showPanel = true;
        state.autoCopied = false;
    });
}

function openPanel(
    chatId: string,
    options: {
        quickMode?: boolean;
        role?: ConnectionRole;
        connectionUrl?: string;
        generatedAnswerUrl?: string;
        hasActiveOffer?: boolean;
    } = {}
) {
    updateState(chatId, (state) => {
        state.showPanel = true;
        if (typeof options.quickMode === 'boolean') state.quickMode = options.quickMode;
        if (options.role) state.currentRole = options.role;
        if (typeof options.connectionUrl === 'string') state.connectionUrl = options.connectionUrl;
        if (typeof options.generatedAnswerUrl === 'string')
            state.generatedAnswerUrl = options.generatedAnswerUrl;
        if (typeof options.hasActiveOffer === 'boolean')
            state.hasActiveOffer = options.hasActiveOffer;
    });
}

function dismissPanel(chatId: string) {
    discardAutoCopy();
    updateState(chatId, (state) => {
        state.showPanel = false;
        state.quickMode = false;
        state.isGeneratingOffer = false;
        state.generatedAnswerUrl = '';
        state.processedOfferData = '';
        state.receivedAnswerData = '';
        state.connectionFailed = false;
        state.canRetryConnection = false;
        state.autoCopied = false;
    });
}

function setQuickMode(chatId: string, quickMode: boolean) {
    updateState(chatId, (state) => {
        state.quickMode = quickMode;
    });
}

function setRole(chatId: string, role: ConnectionRole | null) {
    updateState(chatId, (state) => {
        state.currentRole = role;
    });
}

function markConnectionFailure(chatId: string, failed: boolean, canRetry: boolean) {
    updateState(chatId, (state) => {
        state.connectionFailed = failed;
        state.canRetryConnection = canRetry;
    });
}

function setHasActiveOffer(chatId: string, hasActive: boolean) {
    updateState(chatId, (state) => {
        state.hasActiveOffer = hasActive;
    });
}

function setConnectionUrl(chatId: string, url: string) {
    updateState(chatId, (state) => {
        state.connectionUrl = url;
    });
}

function reset(chatId: string) {
    setState(chatId, defaultState());
}

function applyUiWizardState(chatId: string) {
    const uiWizard = uiStore.getCurrentState().connectionWizard;
    if (uiWizard.chatId !== chatId) return;
    updateState(chatId, (state) => {
        state.showPanel = uiWizard.isOpen;
        state.quickMode = uiWizard.quickMode;
        state.currentRole = uiWizard.currentRole;
        state.generatedAnswerUrl = uiWizard.generatedAnswerUrl;
        state.hasActiveOffer = uiWizard.hasActiveOffer;
        state.connectionFailed = uiWizard.connectionFailed;
        state.processedOfferData = uiWizard.processedOfferData;
        state.receivedAnswerData = uiWizard.receivedAnswerData;
    });
}

export const chatConnectionStore = {
    state,
    openPanel,
    dismissPanel,
    setQuickMode,
    setRole,
    setConnectionUrl,
    setHasActiveOffer,
    markConnectionFailure,
    generateOffer,
    processCode,
    retryConnection,
    applyUiWizardState,
    reset,
    armAutoCopy,
    fulfillAutoCopy,
    discardAutoCopy,
    setAutoCopied,
};
