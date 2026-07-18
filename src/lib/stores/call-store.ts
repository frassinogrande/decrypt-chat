import { debug } from '$lib/utils/debug';
import { writable, derived, get } from 'svelte/store';
import type { Call, CallSettings } from '../types';
import { callService, CallService } from '../services/CallService';

export const activeCall = writable<Call | null>(null);

export const incomingCall = writable<Call | null>(null);

export const remoteStreams = writable<Map<string, MediaStream>>(new Map());

export const callSettings = writable<CallSettings>({
    autoAnswer: false,
    videoEnabled: true,
});

export const isInCall = derived(
    activeCall,
    ($activeCall) => $activeCall !== null && $activeCall.state === 'connected'
);

export const hasIncomingCall = derived(
    incomingCall,
    ($incomingCall) => $incomingCall !== null && $incomingCall.state === 'incoming'
);

export const callState = derived(activeCall, ($activeCall) => $activeCall?.state || 'idle');

class CallStore {
    constructor() {
        this.loadSettings();
        this.setupCallService();
    }

    private setupCallService(): void {
        callService.setCallUpdateCallback((call: Call) => {
            if (call.state === 'incoming') {
                incomingCall.set(call);
            } else if (call.state === 'ended') {
                const currentActive = get(activeCall);
                const currentIncoming = get(incomingCall);

                if (currentActive?.id === call.id) {
                    activeCall.set(null);
                }
                if (currentIncoming?.id === call.id) {
                    incomingCall.set(null);
                }
            } else {
                activeCall.set(call);

                const currentIncoming = get(incomingCall);
                if (currentIncoming?.id === call.id) {
                    incomingCall.set(null);
                }
            }
        });

        callService.setIncomingCallCallback((call: Call) => {
            incomingCall.set(call);
        });
    }

    async startCall(chatId: string, contactName: string, type: 'audio' | 'video'): Promise<Call> {
        try {
            const call = await callService.initiateCall(chatId, contactName, type);
            activeCall.set(call);
            return call;
        } catch (error) {
            debug.error('CallStore: Failed to start call:', error);
            throw error;
        }
    }

    setIncomingCall(call: Call): void {
        incomingCall.set(call);
    }

    async acceptCall(callId: string): Promise<void> {
        try {
            await callService.acceptCall(callId);

            const incoming = get(incomingCall);
            if (incoming && incoming.id === callId) {
                activeCall.set(incoming);
                incomingCall.set(null);
            }
        } catch (error) {
            debug.error('Failed to accept call:', error);
            throw error;
        }
    }

    async rejectCall(callId: string): Promise<void> {
        try {
            await callService.rejectCall(callId);
            incomingCall.set(null);
        } catch (error) {
            debug.error('Failed to reject call:', error);
            throw error;
        }
    }

    async endCall(callId: string, options?: { silent?: boolean }): Promise<void> {
        try {
            await callService.endCall(callId, options);

            const currentActive = get(activeCall);
            const currentIncoming = get(incomingCall);

            if (currentActive?.id === callId) {
                activeCall.set(null);
            }
            if (currentIncoming?.id === callId) {
                incomingCall.set(null);
            }
        } catch (error) {
            debug.error('Failed to end call:', error);
            throw error;
        }
    }

    toggleCallAudio(callId: string): boolean {
        const result = callService.toggleCallAudio(callId);

        const current = get(activeCall);
        if (current && current.id === callId) {
            const selfParticipant = current.participants.find((p) => p.id === 'self');
            if (selfParticipant) {
                selfParticipant.isAudioMuted = !result;
                activeCall.set({ ...current });
            }
        }

        return result;
    }

    toggleCallVideo(callId: string): boolean {
        const result = callService.toggleCallVideo(callId);

        const current = get(activeCall);
        if (current && current.id === callId) {
            const selfParticipant = current.participants.find((p) => p.id === 'self');
            if (selfParticipant) {
                selfParticipant.isVideoMuted = !result;
                activeCall.set({ ...current });
            }
        }

        return result;
    }

    updateSettings(newSettings: Partial<CallSettings>): void {
        callSettings.update((current) => {
            const updated = { ...current, ...newSettings };
            this.saveSettings(updated);
            return updated;
        });
    }

    private loadSettings(): void {
        try {
            const saved = localStorage.getItem('call-settings');
            if (saved) {
                const settings = JSON.parse(saved);
                callSettings.set({ ...get(callSettings), ...settings });
            }
        } catch (error) {
            debug.warn('Failed to load call settings:', error);
        }
    }

    private saveSettings(settings: CallSettings): void {
        try {
            localStorage.setItem('call-settings', JSON.stringify(settings));
        } catch (error) {
            debug.warn('Failed to save call settings:', error);
        }
    }

    handleCallSignal(callData: any, contactName: string, receiverChatId?: string): void {
        debug.log('CallStore: Handling call signal:', callData.type, 'for call:', callData.callId);

        if (callData.type === 'call-offer') {
            callService.receiveCall(callData, contactName, receiverChatId);
        } else {
            callService.handleCallSignal(callData).catch((error) => {
                debug.error('CallStore: Failed to handle call signal:', error);
            });
        }
    }

    getActiveCallForChat(chatId: string): Call | null {
        return callService.getActiveCall(chatId);
    }

    static isSupported(): boolean {
        return CallService.isSupported();
    }
}

export const callStore = new CallStore();
