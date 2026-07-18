import { writable } from 'svelte/store';

interface UIState {
    toast: {
        message: string;
        type: 'info' | 'success' | 'error';
        visible: boolean;
    };

    modals: {
        profileSetup: boolean;
        settings: boolean;
        connectionWizard: boolean;
        filePreview: boolean;
        deleteConfirm: boolean;
        chatSetup: boolean;
    };

    loading: {
        global: boolean;
        chatCreation: boolean;
        messageEncryption: boolean;
        fileUpload: boolean;
        connection: boolean;
    };

    view: {
        current:
            | 'profile-bootstrap'
            | 'profile-setup'
            | 'restore-profile'
            | 'unlock'
            | 'chats'
            | 'chat';
        previous: string | null;
        allowUnlockDialog: boolean;
        showContent: boolean;
    };

    connectionWizard: {
        isOpen: boolean;
        quickMode: boolean;
        fallbackMode: boolean;
        chatId: string | null;
        currentRole: 'sender' | 'receiver' | null;
        processedOfferData: string;
        receivedAnswerData: string;
        generatedAnswerUrl: string;
        hasActiveOffer: boolean;
        connectionFailed: boolean;
    };
}

const defaultState: UIState = {
    toast: {
        message: '',
        type: 'info',
        visible: false,
    },
    modals: {
        profileSetup: false,
        settings: false,
        connectionWizard: false,
        filePreview: false,
        deleteConfirm: false,
        chatSetup: false,
    },
    loading: {
        global: false,
        chatCreation: false,
        messageEncryption: false,
        fileUpload: false,
        connection: false,
    },
    view: {
        current: 'chats',
        previous: null,
        allowUnlockDialog: false,
        showContent: false,
    },
    connectionWizard: {
        isOpen: false,
        quickMode: false,
        fallbackMode: false,
        chatId: null,
        currentRole: null,
        processedOfferData: '',
        receivedAnswerData: '',
        generatedAnswerUrl: '',
        hasActiveOffer: false,
        connectionFailed: false,
    },
};

const TOAST_DURATION_MS = 5000;

function createUIStore() {
    const { subscribe, set, update } = writable<UIState>(defaultState);

    let toastTimeout: ReturnType<typeof setTimeout> | null = null;

    function clearToastTimeout() {
        if (toastTimeout !== null) {
            clearTimeout(toastTimeout);
            toastTimeout = null;
        }
    }

    return {
        subscribe,

        showToast(message: string, type: 'info' | 'success' | 'error' = 'info') {
            // Clear any pending timer so a stale one can't dismiss this toast early
            clearToastTimeout();
            update((state) => ({
                ...state,
                toast: {
                    message,
                    type,
                    visible: true,
                },
            }));

            toastTimeout = setTimeout(() => {
                this.hideToast();
            }, TOAST_DURATION_MS);
        },

        hideToast() {
            clearToastTimeout();
            update((state) => ({
                ...state,
                toast: {
                    ...state.toast,
                    visible: false,
                },
            }));
        },

        // Hold the toast open while the user is reading or interacting with it
        // (hover / focus), then restart the full dismiss window on leave.
        pauseToastAutoDismiss() {
            clearToastTimeout();
        },

        resumeToastAutoDismiss() {
            clearToastTimeout();
            toastTimeout = setTimeout(() => {
                this.hideToast();
            }, TOAST_DURATION_MS);
        },

        openModal(modal: keyof UIState['modals']) {
            update((state) => ({
                ...state,
                modals: {
                    ...state.modals,
                    [modal]: true,
                },
            }));
        },

        closeModal(modal: keyof UIState['modals']) {
            update((state) => ({
                ...state,
                modals: {
                    ...state.modals,
                    [modal]: false,
                },
            }));
        },

        closeAllModals() {
            update((state) => ({
                ...state,
                modals: {
                    profileSetup: false,
                    settings: false,
                    connectionWizard: false,
                    filePreview: false,
                    deleteConfirm: false,
                    chatSetup: false,
                },
            }));
        },

        setLoading(type: keyof UIState['loading'], loading: boolean) {
            update((state) => ({
                ...state,
                loading: {
                    ...state.loading,
                    [type]: loading,
                },
            }));
        },

        setGlobalLoading(loading: boolean) {
            this.setLoading('global', loading);
        },

        setView(view: UIState['view']['current'], allowUnlockDialog: boolean = false) {
            update((state) => ({
                ...state,
                view: {
                    ...state.view,
                    previous: state.view.current,
                    current: view,
                    allowUnlockDialog,
                },
            }));
        },

        showContent() {
            update((state) => ({
                ...state,
                view: {
                    ...state.view,
                    showContent: true,
                },
            }));
        },

        openConnectionWizard(options: Partial<UIState['connectionWizard']> = {}) {
            update((state) => ({
                ...state,
                connectionWizard: {
                    ...state.connectionWizard,
                    isOpen: true,
                    ...options,
                },
            }));
        },

        closeConnectionWizard() {
            update((state) => ({
                ...state,
                connectionWizard: {
                    ...defaultState.connectionWizard,
                    isOpen: false,
                },
            }));
        },

        updateConnectionWizard(updates: Partial<UIState['connectionWizard']>) {
            update((state) => ({
                ...state,
                connectionWizard: {
                    ...state.connectionWizard,
                    ...updates,
                },
            }));
        },

        reset() {
            set(defaultState);
        },

        // Get current state (for components that need sync access)
        getCurrentState(): UIState {
            let currentState: UIState = defaultState;
            const unsubscribe = subscribe((state) => {
                currentState = state;
            });
            unsubscribe();
            return currentState;
        },
    };
}

export const uiStore = createUIStore();
