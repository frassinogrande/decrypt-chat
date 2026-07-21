import type { Call, CallSignalData, CallEventOutcome } from '../types';
import { mediaManager } from './MediaManager';
import { debug } from '../utils/debug';

export class CallService {
    private activeCalls = new Map<string, Call>();
    private acceptingCalls = new Set<string>();
    private recordedCalls = new Set<string>();
    private onCallUpdated?: (call: Call) => void;
    private onIncomingCall?: (call: Call) => void;

    constructor() {
        // Remove a 'call-history' localStorage record written by pre-release builds. Call
        // history is read from callEvent on stored messages, which is encrypted in IndexedDB
        // like the rest, so there is no separate log to keep.
        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.removeItem('call-history');
            } catch (error) {
                debug.warn('Failed to remove legacy call history:', error);
            }
        }
    }

    setCallUpdateCallback(callback: (call: Call) => void): void {
        this.onCallUpdated = callback;
    }

    setIncomingCallCallback(callback: (call: Call) => void): void {
        this.onIncomingCall = callback;
    }

    async initiateCall(
        chatId: string,
        contactName: string,
        type: 'audio' | 'video'
    ): Promise<Call> {
        const callId = this.generateCallId();

        const call: Call = {
            id: callId,
            chatId: chatId,
            type: type,
            state: 'outgoing',
            participants: [
                {
                    id: 'self',
                    name: 'You',
                    isAudioMuted: false,
                    isVideoMuted: type === 'audio',
                },
                {
                    id: 'peer',
                    name: contactName,
                    isAudioMuted: false,
                    isVideoMuted: type === 'audio',
                },
            ],
            startTime: Date.now(),
            isInitiator: true,
        };

        this.activeCalls.set(callId, call);
        this.notifyCallUpdate(call);

        return call;
    }

    async receiveCall(
        callData: CallSignalData,
        contactName: string,
        receiverChatId?: string
    ): Promise<Call> {
        const chatId = receiverChatId || callData.data.chatId || '';

        const call: Call = {
            id: callData.callId,
            chatId: chatId,
            type: callData.data.type || 'audio',
            state: 'incoming',
            participants: [
                {
                    id: 'peer',
                    name: contactName,
                    isAudioMuted: false,
                    isVideoMuted: callData.data.type === 'audio',
                },
                {
                    id: 'self',
                    name: 'You',
                    isAudioMuted: false,
                    isVideoMuted: callData.data.type === 'audio',
                },
            ],
            startTime: Date.now(),
            isInitiator: false,
        };

        this.activeCalls.set(call.id, call);

        if (this.onIncomingCall) {
            this.onIncomingCall(call);
        } else {
            debug.warn('CallService: No onIncomingCall callback registered!');
        }

        this.notifyCallUpdate(call);
        return call;
    }

    async acceptCall(callId: string): Promise<void> {
        debug.log('CallService: Accepting call:', callId);

        const call = this.activeCalls.get(callId);
        if (!call) {
            throw new Error('Call not found');
        }

        // Ignore duplicate accepts (e.g. tapping Accept twice while the connection is forming).
        // Re-running acceptCall would add a second set of tracks / answer to the call connection
        // and throw, which previously tore the call down and left the local side in a dead call.
        if (call.state === 'connected' || this.acceptingCalls.has(callId)) {
            debug.log('CallService: Accept ignored, call already accepted/accepting:', callId);
            return;
        }
        this.acceptingCalls.add(callId);

        try {
            const { appStore } = await import('../stores/app');
            const manager = appStore.getWebRTCManager(call.chatId);

            if (manager) {
                debug.log('CallService: Calling WebRTC manager acceptCall for chat:', call.chatId);
                await manager.acceptCall(callId, call.type);
            } else {
                debug.warn(
                    'CallService: No WebRTC manager found for call acceptance, chat:',
                    call.chatId
                );
            }
        } catch (error) {
            debug.error('CallService: Failed to accept call via WebRTC manager:', error);
            // The WebRTC manager already tore down its own peer connection/stream and told the
            // caller via a tagged hangup signal. Without this, the call stayed in activeCalls
            // forever with the incoming-call UI still pinned to it — nothing else ever moves it
            // to a terminal state on this failure path.
            this.recordCallEvent(call, 'failed');
            this.updateCallState(callId, 'failed');
            this.activeCalls.delete(callId);
            throw error;
        } finally {
            this.acceptingCalls.delete(callId);
        }

        this.updateCallState(callId, 'connected');
        debug.log('CallService: Call accepted and state updated to connected');
    }

    async rejectCall(callId: string): Promise<void> {
        const call = this.activeCalls.get(callId);
        if (!call) {
            throw new Error('Call not found');
        }

        // The local user declined an incoming call. Record it before the state flips to 'ended'
        // (endCall's own logging is gated on the pre-ended state, so it won't double up).
        this.recordCallEvent(call, 'declined');

        this.updateCallState(callId, 'ended');
        this.endCall(callId);
    }

    async endCall(callId: string, options?: { silent?: boolean }): Promise<void> {
        const call = this.activeCalls.get(callId);
        if (!call) {
            return;
        }

        debug.log('CallService: Ending call:', callId);

        // If the local user hangs up an outgoing call that never connected, that's a cancel.
        // (A connected call ending, or the post-reject endCall whose state is already 'ended',
        // records nothing here.) `silent` suppresses the event for programmatic teardowns.
        if (!options?.silent && call.state === 'outgoing') {
            this.recordCallEvent(call, 'cancelled');
        }

        try {
            const { appStore } = await import('../stores/app');
            const manager = appStore.getWebRTCManager(call.chatId);

            if (manager) {
                debug.log('CallService: Calling WebRTC manager endCall to send hangup signal');
                await manager.endCall(callId);
            } else {
                debug.warn(
                    'CallService: No WebRTC manager found for call termination, chat:',
                    call.chatId
                );
            }
        } catch (error) {
            debug.error('CallService: Failed to end call via WebRTC manager:', error);
        }

        // The local user hung up a call that was connected: record how long it lasted. The peer
        // records its own copy when our hangup signal arrives.
        const duration = this.connectedDuration(call);
        if (!options?.silent && duration !== undefined) {
            this.recordCallEvent(call, 'completed', duration);
        }

        this.updateCallState(callId, 'ended');
        this.activeCalls.delete(callId);
        mediaManager.stopLocalStream();

        debug.log('CallService: Call ended and cleaned up');
    }

    private async cleanupCallLocally(callId: string): Promise<void> {
        const call = this.activeCalls.get(callId);
        if (!call) {
            return;
        }

        debug.log('CallService: Cleaning up call locally (no signal to peer):', callId);

        try {
            const { appStore } = await import('../stores/app');
            const manager = appStore.getWebRTCManager(call.chatId);

            if (manager) {
                debug.log('CallService: Cleaning up WebRTC manager state');
                // Call cleanup directly to avoid sending duplicate hangup signals
                manager.cleanupCall();
            } else {
                debug.warn('CallService: No WebRTC manager found for cleanup, chat:', call.chatId);
            }
        } catch (error) {
            debug.error('CallService: Failed to cleanup WebRTC manager:', error);
        }

        // No duration is stamped here: every caller flips the state to 'ended' first, so the
        // call event (and its duration) is recorded by the caller while the state is still live.
        this.activeCalls.delete(callId);
        mediaManager.stopLocalStream();

        debug.log('CallService: Local call cleanup complete');
    }

    toggleCallAudio(callId: string): boolean {
        const call = this.activeCalls.get(callId);
        if (!call || call.state !== 'connected') {
            return false;
        }

        const selfParticipant = call.participants.find((p) => p.id === 'self');
        if (selfParticipant) {
            const newMutedState = !selfParticipant.isAudioMuted;
            selfParticipant.isAudioMuted = newMutedState;

            const audioEnabled = mediaManager.toggleAudio(!newMutedState);
            selfParticipant.isAudioMuted = !audioEnabled;

            this.notifyCallUpdate(call);
            return audioEnabled;
        }

        return false;
    }

    toggleCallVideo(callId: string): boolean {
        const call = this.activeCalls.get(callId);
        if (!call || call.state !== 'connected') {
            return false;
        }

        const selfParticipant = call.participants.find((p) => p.id === 'self');
        if (selfParticipant) {
            const newMutedState = !selfParticipant.isVideoMuted;
            selfParticipant.isVideoMuted = newMutedState;

            const videoEnabled = mediaManager.toggleVideo(!newMutedState);
            selfParticipant.isVideoMuted = !videoEnabled;

            this.notifyCallUpdate(call);
            return videoEnabled;
        }

        return false;
    }

    async handleCallSignal(callData: CallSignalData): Promise<void> {
        debug.log(
            'CallService: Handling call signal:',
            callData.type,
            'for call:',
            callData.callId
        );

        const call = this.activeCalls.get(callData.callId);
        if (!call) {
            debug.warn('CallService: Received signal for unknown call:', callData.callId);
            return;
        }

        // For WebRTC-related signals, we don't need to handle them here anymore
        // The WebRTC manager already processes them when they arrive via data channel
        // We only handle the call state updates

        switch (callData.type) {
            case 'call-answer':
                if (callData.data.accepted) {
                    debug.log('CallService: Call accepted, updating state to connected');
                    this.updateCallState(callData.callId, 'connected');
                } else {
                    debug.log('CallService: Call rejected, ending call');
                    // Peer declined our outgoing call (only meaningful while still ringing).
                    if (call.state === 'outgoing') {
                        this.recordCallEvent(call, 'declined');
                    }
                    this.updateCallState(callData.callId, 'ended');
                    this.cleanupCallLocally(callData.callId);
                }
                break;

            case 'call-hangup':
                debug.log('CallService: Call hangup received, ending call');
                // A hangup before the call connected means it was never answered: if we were
                // calling out, the peer declined (or, tagged 'media-error', couldn't answer at
                // all — no camera/mic to accept with); if they were calling us, we missed it. A
                // hangup on a connected call is a normal end, recorded with how long it lasted.
                // This runs before the state flips to 'ended' below, which every branch needs.
                if (call.state === 'outgoing' && callData.data?.reason === 'media-error') {
                    this.recordCallEvent(call, 'failed');
                } else if (call.state === 'outgoing') {
                    this.recordCallEvent(call, 'declined');
                } else if (call.state === 'incoming') {
                    this.recordCallEvent(call, 'missed');
                } else if (call.state === 'connected') {
                    this.recordCallEvent(call, 'completed', this.connectedDuration(call));
                }
                this.updateCallState(callData.callId, 'ended');
                this.cleanupCallLocally(callData.callId);
                break;

            case 'call-media-toggle':
                debug.log('CallService: Media toggle received:', callData.data);
                this.handlePeerMediaToggle(callData.callId, callData.data);
                break;
        }
    }

    private handlePeerMediaToggle(callId: string, data: any): void {
        const call = this.activeCalls.get(callId);
        if (!call) return;

        const peerParticipant = call.participants.find((p) => p.id === 'peer');
        if (!peerParticipant) return;

        if (data.media === 'audio') {
            peerParticipant.isAudioMuted = !data.enabled;
        } else if (data.media === 'video') {
            peerParticipant.isVideoMuted = !data.enabled;
        }

        this.notifyCallUpdate(call);
    }

    // Write a completed / declined / missed / cancelled call record into the chat as a system line.
    private recordCallEvent(call: Call, outcome: CallEventOutcome, duration?: number): void {
        // A call yields at most one record. Both sides tear a call down independently, and if the
        // two hang up at the same moment one side can run its own teardown and handle the peer's
        // hangup signal, which would otherwise write the event twice in that chat.
        if (this.recordedCalls.has(call.id)) {
            return;
        }
        this.recordedCalls.add(call.id);

        const direction: 'incoming' | 'outgoing' = call.isInitiator ? 'outgoing' : 'incoming';
        import('../stores/app')
            .then(({ appStore }) =>
                appStore.addCallEventMessage(call.chatId, {
                    direction,
                    outcome,
                    callType: call.type,
                    ...(duration !== undefined ? { duration } : {}),
                })
            )
            .catch((error) => debug.error('CallService: Failed to record call event:', error));
    }

    // Seconds the call spent connected, or undefined if it never connected.
    private connectedDuration(call: Call): number | undefined {
        if (call.state !== 'connected' || !call.connectedAt) {
            return undefined;
        }
        call.endTime = Date.now();
        call.duration = Math.max(0, Math.floor((call.endTime - call.connectedAt) / 1000));
        return call.duration;
    }

    private updateCallState(callId: string, newState: Call['state']): void {
        const call = this.activeCalls.get(callId);
        if (!call) return;

        call.state = newState;

        if (newState === 'connected' && !call.startTime) {
            call.startTime = Date.now();
        }

        // startTime is stamped when the call starts ringing, so it can't be the origin for a
        // duration: it would count the ringing as talk time. Stamp the answer separately.
        if (newState === 'connected' && !call.connectedAt) {
            call.connectedAt = Date.now();
        }

        this.notifyCallUpdate(call);
    }

    private notifyCallUpdate(call: Call): void {
        if (this.onCallUpdated) {
            this.onCallUpdated({ ...call });
        }
    }

    getActiveCall(chatId?: string): Call | null {
        if (chatId) {
            for (const call of this.activeCalls.values()) {
                if (call.chatId === chatId) {
                    return call;
                }
            }
            return null;
        }

        const calls = Array.from(this.activeCalls.values());
        return calls.find((call) => call.state !== 'ended') || null;
    }

    private generateCallId(): string {
        return `call_${crypto.randomUUID()}`;
    }

    static isSupported(): boolean {
        return !!(
            navigator.mediaDevices &&
            typeof navigator.mediaDevices.getUserMedia === 'function' &&
            typeof window.RTCPeerConnection === 'function'
        );
    }

    getCallStats(callId: string): any {
        const call = this.activeCalls.get(callId);
        if (!call) return null;

        return {
            callId: call.id,
            duration: call.startTime ? Math.floor((Date.now() - call.startTime) / 1000) : 0,
            type: call.type,
            state: call.state,
            participants: call.participants.length,
        };
    }
}

export const callService = new CallService();
