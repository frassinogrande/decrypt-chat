import { debug } from './debug';
import type { CallSignalData } from '../types';
import { mediaManager } from '../services/MediaManager';
import { encryptSignalData, decryptSignalData } from './webrtc-signal-codec';
import type { RTCSignalData } from './webrtc-signal-codec';
export type { RTCSignalData } from './webrtc-signal-codec';

export interface RTCDataMessage {
    type:
        | 'message'
        | 'reaction'
        | 'reaction-clear'
        | 'message-delete'
        | 'disconnect-notification'
        | 'typing'
        | 'heartbeat'
        | 'heartbeat-ack'
        | 'call-offer'
        | 'call-answer'
        | 'call-ice-candidate'
        | 'call-hangup'
        | 'call-media-toggle';
    data: any;
    timestamp: number;
}

export enum ConnectionState {
    DISCONNECTED = 'disconnected',
    CONNECTING = 'connecting',
    CONNECTED = 'connected',
    FAILED = 'failed',
}

// Public STUN servers used to discover each peer's reflexive address for NAT traversal.
// Two independent, non-Google operators for redundancy; Nextcloud runs on 443 so it also
// traverses restrictive firewalls. This is the only network contact a real connection makes,
// and it is what lets two people connect directly with no server of ours in the middle.
// The list is mirrored in tutorial-online-sim.ts and named in PRIVACY_POLICY.md.
const STUN_ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.nextcloud.com:443' },
];

export class WebRTCManager {
    private peerConnection: RTCPeerConnection | null = null;
    private dataChannel: RTCDataChannel | null = null;
    // When true, no STUN server is contacted: only host candidates are gathered. Used by the
    // guided tutorial, which connects to a stand-in on the same device where host candidates
    // always suffice, so the tour reaches out to nothing at all.
    localOnly = false;
    private chatId: string;
    private chatKey: CryptoKey;
    private onStateChange: (state: ConnectionState) => void;
    private onMessage: (payload: { message: string; from: string; uuid?: string }) => void;
    private onReaction?: (emoji: string | null, target?: string) => void;
    private onDeleteMessage?: (targetRemoteUuid: string) => void;
    private onCallReceived?: (callData: CallSignalData) => void;
    private onCallStateChanged?: (callId: string, state: string) => void;
    private onRemoteStreamReceived?: (stream: MediaStream) => void;
    private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
    private onTypingStatus?: (isTyping: boolean) => void;

    // Call-related properties
    // Calls use their OWN peer connection, created fresh for each call and fully closed on hangup.
    // The long-lived `peerConnection` carries only the data channel (used here for call signaling);
    // keeping call media off it means no transceiver/m-line state ever accumulates across calls,
    // which is what previously caused renderer crashes and "RTP extension ID reassignment" errors.
    private callPeerConnection: RTCPeerConnection | null = null;
    // Call ICE candidates that arrived before the call's remote description was applied; flushed
    // once it is set. Calls trickle ICE over the data channel so they connect without waiting for
    // full candidate gathering (which added multi-second latency).
    private callIceCandidates: RTCIceCandidateInit[] = [];
    private localStream: MediaStream | null = null;
    private remoteStream: MediaStream | null = null;
    private activeCallId: string | null = null;
    private isCallMode: boolean = false;
    private iceCandidates: RTCIceCandidate[] = [];
    private connectionTimeout: NodeJS.Timeout | null = null;
    // True for the side that created the offer. Only the initiator arms the failure
    // timeout (once the answer is applied) — the receiver can't know when its answer
    // will be pasted back, so it must never auto-fail while waiting.
    private isInitiator: boolean = false;
    private retryCount: number = 0;
    private maxRetries: number = 3;
    private reconnectionDebounceTimeout: NodeJS.Timeout | null = null;
    private iceDisconnectDebounce: NodeJS.Timeout | null = null;
    private isDisconnecting: boolean = false;
    private hasHandledDisconnection: boolean = false;
    // True once the data channel has opened at least once. Distinguishes a setup failure
    // (never connected — surface FAILED so the failed panel shows) from a live connection
    // dropping (was connected — treat as going offline).
    private hasEverConnected: boolean = false;
    private connectionStabilityTimeout: NodeJS.Timeout | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private lastHeartbeatReceived: number = 0;
    private heartbeatMissedCount: number = 0;

    constructor(
        chatId: string,
        chatKey: CryptoKey,
        onStateChange: (state: ConnectionState) => void,
        onMessage: (payload: { message: string; from: string; uuid?: string }) => void,
        onCallReceived?: (callData: CallSignalData) => void,
        onCallStateChanged?: (callId: string, state: string) => void,
        onRemoteStreamReceived?: (stream: MediaStream) => void,
        onReaction?: (emoji: string | null, target?: string) => void,
        onDeleteMessage?: (targetRemoteUuid: string) => void,
        onTypingStatus?: (isTyping: boolean) => void
    ) {
        this.chatId = chatId;
        this.chatKey = chatKey;
        this.onStateChange = onStateChange;
        this.onMessage = onMessage;
        this.onCallReceived = onCallReceived;
        this.onCallStateChanged = onCallStateChanged;
        this.onRemoteStreamReceived = onRemoteStreamReceived;
        this.onReaction = onReaction;
        this.onDeleteMessage = onDeleteMessage;
        this.onTypingStatus = onTypingStatus;
    }

    async createOffer(): Promise<string> {
        try {
            this.isInitiator = true;
            this.initializePeerConnection();
            this.setupDataChannel();

            const offer = await this.peerConnection!.createOffer();
            await this.peerConnection!.setLocalDescription(offer);

            await this.waitForIceGathering();

            const signalData: RTCSignalData = {
                type: 'offer',
                data: this.peerConnection!.localDescription!,
            };

            return await encryptSignalData(signalData, this.chatKey);
        } catch (error) {
            debug.error('Failed to create offer:', error);
            this.updateConnectionState(ConnectionState.FAILED);
            throw error;
        }
    }

    async handleOffer(encryptedOffer: string, onPrepared?: () => void): Promise<string> {
        try {
            const signalData = await decryptSignalData(encryptedOffer, this.chatKey);

            if (signalData.type !== 'offer') {
                throw new Error('Invalid offer data');
            }

            this.isInitiator = false;
            this.initializePeerConnection();
            this.setupDataChannelReceiver();

            await this.peerConnection!.setRemoteDescription(
                signalData.data as RTCSessionDescriptionInit
            );

            const answer = await this.peerConnection!.createAnswer();
            await this.peerConnection!.setLocalDescription(answer);

            // The offer decrypted with this chat's key, so the conversation is now known.
            // Signal the caller before the (slow) ICE gathering so it can show progress.
            onPrepared?.();

            await this.waitForIceGathering();

            const answerData: RTCSignalData = {
                type: 'answer',
                data: this.peerConnection!.localDescription!,
            };

            return await encryptSignalData(answerData, this.chatKey);
        } catch (error) {
            debug.error('Failed to handle offer:', error);
            this.updateConnectionState(ConnectionState.FAILED);
            throw error;
        }
    }

    async handleAnswer(encryptedAnswer: string): Promise<void> {
        try {
            const signalData = await decryptSignalData(encryptedAnswer, this.chatKey);

            if (signalData.type !== 'answer') {
                throw new Error('Invalid answer data');
            }

            await this.peerConnection!.setRemoteDescription(
                signalData.data as RTCSessionDescriptionInit
            );

            for (const candidate of this.iceCandidates) {
                await this.peerConnection!.addIceCandidate(candidate);
            }
            this.iceCandidates = [];

            // The peer's answer is now applied, so we're actually connecting. If ICE
            // already moved us into CONNECTING while we waited for the answer, the state
            // won't transition again — arm the failure timeout explicitly now.
            if (this.connectionState === ConnectionState.CONNECTING) {
                this.startConnectionTimeout();
            }
        } catch (error) {
            debug.error('Failed to handle answer:', error);
            this.updateConnectionState(ConnectionState.FAILED);
            throw error;
        }
    }

    async sendMessage(message: string, from: string, uuid?: string): Promise<void> {
        if (!this.dataChannel) {
            throw new Error('Data channel not initialized');
        }

        if (this.dataChannel.readyState !== 'open') {
            throw new Error(`Data channel not ready (state: ${this.dataChannel.readyState})`);
        }

        const rtcMessage: RTCDataMessage = {
            type: 'message',
            data: { message, from, uuid },
            timestamp: Date.now(),
        };

        this.dataChannel.send(JSON.stringify(rtcMessage));
    }

    async sendReaction(emoji: string, targetRemoteUuid?: string): Promise<void> {
        if (!this.dataChannel) {
            throw new Error('Data channel not initialized');
        }
        if (this.dataChannel.readyState !== 'open') {
            throw new Error(`Data channel not ready (state: ${this.dataChannel.readyState})`);
        }

        const rtcMessage: RTCDataMessage = {
            type: 'reaction',
            data: targetRemoteUuid ? { emoji, target: targetRemoteUuid } : { emoji },
            timestamp: Date.now(),
        };

        this.dataChannel.send(JSON.stringify(rtcMessage));
    }

    async sendReactionClear(targetRemoteUuid?: string): Promise<void> {
        if (!this.dataChannel) {
            throw new Error('Data channel not initialized');
        }
        if (this.dataChannel.readyState !== 'open') {
            throw new Error(`Data channel not ready (state: ${this.dataChannel.readyState})`);
        }

        const rtcMessage: RTCDataMessage = {
            type: 'reaction-clear',
            data: targetRemoteUuid ? { target: targetRemoteUuid } : {},
            timestamp: Date.now(),
        };

        this.dataChannel.send(JSON.stringify(rtcMessage));
    }

    async sendTyping(isTyping: boolean): Promise<void> {
        if (!this.dataChannel) {
            throw new Error('Data channel not initialized');
        }
        if (this.dataChannel.readyState !== 'open') {
            throw new Error(`Data channel not ready (state: ${this.dataChannel.readyState})`);
        }

        const rtcMessage: RTCDataMessage = {
            type: 'typing',
            data: { isTyping },
            timestamp: Date.now(),
        };

        this.dataChannel.send(JSON.stringify(rtcMessage));
    }

    async sendDelete(targetRemoteUuid: string): Promise<void> {
        if (!this.dataChannel) {
            throw new Error('Data channel not initialized');
        }
        if (this.dataChannel.readyState !== 'open') {
            throw new Error(`Data channel not ready (state: ${this.dataChannel.readyState})`);
        }
        if (!targetRemoteUuid) {
            throw new Error('Target remote UUID is required to delete a message');
        }

        const rtcMessage: RTCDataMessage = {
            type: 'message-delete',
            data: { target: targetRemoteUuid },
            timestamp: Date.now(),
        };

        this.dataChannel.send(JSON.stringify(rtcMessage));
    }

    async disconnectGracefully(reason: 'user' | 'unload' | 'hidden' = 'user'): Promise<void> {
        this.isDisconnecting = true;

        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            try {
                const disconnectMessage: RTCDataMessage = {
                    type: 'disconnect-notification',
                    data: { reason, timestamp: Date.now() },
                    timestamp: Date.now(),
                };

                debug.log(`Sending graceful disconnect notification (reason: ${reason})`);
                this.dataChannel.send(JSON.stringify(disconnectMessage));

                // Give a brief moment for the message to be sent
                await new Promise((resolve) => setTimeout(resolve, 100));
            } catch (error) {
                debug.warn('Failed to send disconnect notification:', error);
            }
        }

        this.disconnect();
    }

    disconnect(): void {
        this.isDisconnecting = true;
        this.clearConnectionTimeout();
        this.clearReconnectionDebounce();
        this.clearConnectionStabilityCheck();
        this.stopHeartbeat();
        if (this.iceDisconnectDebounce) {
            clearTimeout(this.iceDisconnectDebounce);
            this.iceDisconnectDebounce = null;
        }

        if (this.onTypingStatus) {
            this.onTypingStatus(false);
        }

        // Tear down any in-progress call (its own peer connection + local media) first.
        if (this.localStream) {
            this.localStream.getTracks().forEach((track) => track.stop());
            this.localStream = null;
        }
        this.closeCallPeerConnection();
        this.remoteStream = null;
        this.activeCallId = null;
        this.isCallMode = false;

        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }

        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.updateConnectionState(ConnectionState.DISCONNECTED);

        this.isDisconnecting = false;
        this.hasHandledDisconnection = false;
    }

    getConnectionState(): ConnectionState {
        return this.connectionState;
    }

    isReadyForMessaging(): boolean {
        return !!(
            this.dataChannel &&
            this.dataChannel.readyState === 'open' &&
            this.connectionState === ConnectionState.CONNECTED
        );
    }

    // ICE config for every peer connection this manager creates. In localOnly mode (the guided
    // tutorial) the STUN list is empty, so gathering is limited to host candidates and no request
    // ever leaves the device; otherwise the shared public STUN servers are used.
    private iceConfiguration(): RTCConfiguration {
        return { iceServers: this.localOnly ? [] : STUN_ICE_SERVERS };
    }

    private initializePeerConnection(): void {
        this.hasHandledDisconnection = false;
        this.hasEverConnected = false;

        this.peerConnection = new RTCPeerConnection(this.iceConfiguration());

        this.peerConnection.oniceconnectionstatechange = () => {
            const state = this.peerConnection!.iceConnectionState;

            // If we're in the middle of a manual disconnect, don't process state changes
            if (this.isDisconnecting) {
                return;
            }

            switch (state) {
                case 'connected':
                case 'completed':
                    if (this.iceDisconnectDebounce) {
                        clearTimeout(this.iceDisconnectDebounce);
                        this.iceDisconnectDebounce = null;
                    }
                    // If the data channel is already open (e.g. ICE recovered after a blip),
                    // go straight to CONNECTED rather than CONNECTING.
                    if (this.dataChannel && this.dataChannel.readyState === 'open') {
                        this.updateConnectionState(ConnectionState.CONNECTED);
                    } else {
                        this.updateConnectionState(ConnectionState.CONNECTING);
                    }
                    break;
                case 'new':
                case 'checking':
                    this.updateConnectionState(ConnectionState.CONNECTING);
                    break;
                case 'disconnected':
                    // ICE 'disconnected' is transient — the browser uses it during brief network
                    // blips and it often recovers to 'connected' within a few seconds.
                    // Debounce before treating it as a real disconnect.
                    if (!this.hasHandledDisconnection && !this.iceDisconnectDebounce) {
                        this.iceDisconnectDebounce = setTimeout(() => {
                            this.iceDisconnectDebounce = null;
                            // Only disconnect if ICE is still in a bad state
                            const iceState = this.peerConnection?.iceConnectionState;
                            if (iceState === 'disconnected' && !this.hasHandledDisconnection) {
                                this.handlePeerDisconnection();
                            }
                        }, 5000); // 5-second grace period for ICE to recover
                    }
                    break;
                case 'failed':
                case 'closed':
                    // Cancel any pending disconnect debounce — this is final
                    if (this.iceDisconnectDebounce) {
                        clearTimeout(this.iceDisconnectDebounce);
                        this.iceDisconnectDebounce = null;
                    }
                    if (!this.hasHandledDisconnection) {
                        if (!this.hasEverConnected) {
                            // Never connected — this is a setup failure (e.g. a VPN or strict
                            // firewall blocking every ICE path with no TURN relay to fall back
                            // on). Surface FAILED so the failed panel + troubleshooting shows,
                            // instead of a silent "offline". Guard against a following 'closed'.
                            this.hasHandledDisconnection = true;
                            this.clearConnectionTimeout();
                            this.updateConnectionState(ConnectionState.FAILED);
                        } else {
                            // Was connected and dropped — go offline.
                            this.handlePeerDisconnection();
                        }
                    }
                    break;
            }
        };

        // No onicecandidate handler here by design. This connection is established with
        // vanilla ICE: gathering completes before the offer/answer code is produced, so each
        // code already carries its full candidate set and there is no signaling channel to
        // trickle over. Calls are different, they trickle across the data channel this
        // connection establishes (see createCallPeerConnection).

        this.setupRemoteStreamHandler();
    }

    private setupDataChannel(): void {
        this.dataChannel = this.peerConnection!.createDataChannel('chat', {
            ordered: true,
        });

        this.setupDataChannelHandlers();
    }

    private setupDataChannelReceiver(): void {
        this.peerConnection!.ondatachannel = (event) => {
            this.dataChannel = event.channel;
            this.setupDataChannelHandlers();
        };
    }

    private setupDataChannelHandlers(): void {
        if (!this.dataChannel) return;

        this.dataChannel.binaryType = 'arraybuffer';
        debug.log(
            `setupDataChannelHandlers: binaryType set, readyState=${this.dataChannel.readyState}`
        );

        this.dataChannel.onopen = () => {
            debug.log('Data channel opened for chat:', this.chatId);
            this.hasEverConnected = true;
            // Only update to connected when data channel is actually open
            this.updateConnectionState(ConnectionState.CONNECTED);

            this.startConnectionStabilityCheck();

            this.startHeartbeat();
        };

        this.dataChannel.onclose = () => {
            debug.log('Data channel closed for chat:', this.chatId);
            if (!this.hasHandledDisconnection && !this.isDisconnecting) {
                this.handlePeerDisconnection();
            }
        };

        this.dataChannel.onerror = (error) => {
            debug.log('Data channel error for chat:', this.chatId, error);

            // Check if this is a "User-Initiated Abort" which typically means peer disconnect
            const isUserAbort =
                error.error?.message?.includes('User-Initiated Abort') ||
                error.error?.message?.includes('Close called');

            if (isUserAbort) {
                debug.log('Data channel closed by peer (user abort)');
                // Treat user abort as a clean disconnect, not an error
                if (!this.hasHandledDisconnection && !this.isDisconnecting) {
                    this.handlePeerDisconnection();
                }
            } else {
                debug.error('Data channel error (not user abort):', error);
                this.updateConnectionState(ConnectionState.FAILED);
            }
        };

        this.dataChannel.onmessage = (event) => {
            const d = event.data;
            const tag =
                d instanceof ArrayBuffer
                    ? `ArrayBuffer(${d.byteLength})`
                    : d instanceof Blob
                      ? `Blob(${d.size})`
                      : typeof d === 'string'
                        ? `string(${d.length})`
                        : `unknown(${Object.prototype.toString.call(d)})`;
            debug.log(`onmessage: ${tag}, binaryType=${this.dataChannel?.binaryType}`);
            this.handleDataChannelMessage(event.data);
        };
    }

    private async handleDataChannelMessage(data: string | ArrayBuffer): Promise<void> {
        if (typeof data !== 'string') {
            debug.warn(
                `Unexpected data channel message type: ${Object.prototype.toString.call(data)}`
            );
            return;
        }
        try {
            const message: RTCDataMessage = JSON.parse(data);

            switch (message.type) {
                case 'message':
                    this.onMessage({
                        message: message.data.message,
                        from: message.data.from,
                        uuid: message.data.uuid,
                    });
                    break;
                case 'reaction':
                    if (this.onReaction && message?.data?.emoji) {
                        this.onReaction(
                            message.data.emoji as string,
                            message?.data?.target as string | undefined
                        );
                    }
                    break;
                case 'reaction-clear':
                    if (this.onReaction) {
                        this.onReaction(null, message?.data?.target as string | undefined);
                    }
                    break;

                case 'message-delete':
                    if (this.onDeleteMessage && typeof message?.data?.target === 'string') {
                        this.onDeleteMessage(message.data.target);
                    }
                    break;

                case 'disconnect-notification':
                    this.handleDisconnectNotification(message.data);
                    break;

                case 'typing':
                    if (this.onTypingStatus) {
                        const isTyping = Boolean(message?.data?.isTyping);
                        this.onTypingStatus(isTyping);
                    }
                    break;

                case 'heartbeat':
                    this.handleHeartbeat(message.timestamp);
                    break;

                case 'heartbeat-ack':
                    this.handleHeartbeatAck(message.timestamp);
                    break;

                case 'call-offer':
                    await this.handleIncomingCallOffer(message.data as CallSignalData);
                    if (this.onCallReceived) {
                        this.onCallReceived(message.data as CallSignalData);
                    }
                    break;
                case 'call-answer':
                    await this.handleCallAnswer(message.data as CallSignalData);
                    if (this.onCallReceived) {
                        this.onCallReceived(message.data as CallSignalData);
                    }
                    break;
                case 'call-ice-candidate':
                    await this.handleCallIceCandidate(message.data as CallSignalData);
                    break;
                case 'call-media-toggle':
                    if (this.onCallReceived) {
                        this.onCallReceived(message.data as CallSignalData);
                    }
                    break;
                case 'call-hangup':
                    debug.log('WebRTC: Received hangup signal from peer');
                    this.cleanupCall();
                    if (this.onCallReceived) {
                        this.onCallReceived(message.data as CallSignalData);
                    }
                    break;
            }
        } catch (error) {
            debug.error('Failed to handle data channel message:', error);
        }
    }

    private handleDisconnectNotification(data: { reason: string; timestamp: number }): void {
        debug.log(`Received graceful disconnect notification from peer (reason: ${data.reason})`);

        // Update the disconnection as graceful - don't try to reconnect immediately
        this.hasHandledDisconnection = true;

        if (this.onTypingStatus) {
            this.onTypingStatus(false);
        }

        // Mark this as a peer-initiated disconnect so we know not to auto-reconnect aggressively
        if (!this.isDisconnecting) {
            this.updateConnectionState(ConnectionState.DISCONNECTED);
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.lastHeartbeatReceived = Date.now();
        this.heartbeatMissedCount = 0;

        this.heartbeatInterval = setInterval(() => {
            if (this.dataChannel && this.dataChannel.readyState === 'open') {
                try {
                    const heartbeatMessage: RTCDataMessage = {
                        type: 'heartbeat',
                        data: { timestamp: Date.now() },
                        timestamp: Date.now(),
                    };
                    this.dataChannel.send(JSON.stringify(heartbeatMessage));

                    const now = Date.now();
                    if (now - this.lastHeartbeatReceived > 90000) {
                        // 90 seconds without response
                        this.heartbeatMissedCount++;
                        debug.warn(
                            `Heartbeat missed (${this.heartbeatMissedCount}/3) for chat:`,
                            this.chatId
                        );

                        if (this.heartbeatMissedCount >= 3) {
                            debug.error('Connection appears dead - triggering reconnection');
                            this.handleConnectionLoss();
                        }
                    }
                } catch (error) {
                    debug.error('Failed to send heartbeat:', error);
                    this.heartbeatMissedCount++;
                    if (this.heartbeatMissedCount >= 3) {
                        this.handleConnectionLoss();
                    }
                }
            }
        }, 30000); // 30 seconds
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    private handleHeartbeat(timestamp: number): void {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            try {
                const ackMessage: RTCDataMessage = {
                    type: 'heartbeat-ack',
                    data: { timestamp },
                    timestamp: Date.now(),
                };
                this.dataChannel.send(JSON.stringify(ackMessage));
            } catch (error) {
                debug.warn('Failed to send heartbeat ack:', error);
            }
        }
    }

    private handleHeartbeatAck(timestamp: number): void {
        this.lastHeartbeatReceived = Date.now();
        this.heartbeatMissedCount = 0;
    }

    private handleConnectionLoss(): void {
        debug.log('Connection loss detected - attempting recovery');
        this.stopHeartbeat();

        if (!this.hasHandledDisconnection && !this.isDisconnecting) {
            this.attemptIceRestart().catch(() => {
                this.updateConnectionState(ConnectionState.DISCONNECTED);
            });
        }
    }

    private async attemptIceRestart(): Promise<void> {
        if (!this.peerConnection) {
            throw new Error('No peer connection for ICE restart');
        }

        debug.log('Attempting ICE restart for connection recovery');

        try {
            const offer = await this.peerConnection.createOffer({ iceRestart: true });
            await this.peerConnection.setLocalDescription(offer);

            // The restart offer cannot be delivered automatically: with no signaling channel,
            // reconnecting means the peers exchange fresh codes by hand. Recovery is therefore
            // user-driven, and this only refreshes the local description in case the existing
            // channel comes back on its own.
            debug.log('ICE restart offer created; reconnecting requires a fresh code exchange');
        } catch (error) {
            debug.error('ICE restart failed:', error);
            throw error;
        }
    }

    private async waitForIceGathering(): Promise<void> {
        const startTime = Date.now();
        return new Promise((resolve) => {
            if (this.peerConnection!.iceGatheringState === 'complete') {
                debug.log('[DEBUG] ICE gathering already complete');
                resolve();
                return;
            }
            debug.log('[DEBUG] Waiting for ICE gathering to complete...');

            const checkState = () => {
                if (this.peerConnection!.iceGatheringState === 'complete') {
                    const duration = Date.now() - startTime;
                    debug.log(`[DEBUG] ICE gathering completed in ${duration}ms`);
                    resolve();
                }
            };

            this.peerConnection!.addEventListener('icegatheringstatechange', checkState);

            setTimeout(() => {
                if (this.peerConnection) {
                    this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
                }
                const duration = Date.now() - startTime;
                debug.log(`[DEBUG] ICE gathering timed out after ${duration}ms`);
                resolve();
            }, 3000);
        });
    }

    private startConnectionTimeout(): void {
        this.clearConnectionTimeout();
        this.connectionTimeout = setTimeout(() => {
            if (this.connectionState === ConnectionState.CONNECTING) {
                this.updateConnectionState(ConnectionState.FAILED);
            }
        }, 30000); // 30 second timeout
    }

    private clearConnectionTimeout(): void {
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
    }

    private clearReconnectionDebounce(): void {
        if (this.reconnectionDebounceTimeout) {
            clearTimeout(this.reconnectionDebounceTimeout);
            this.reconnectionDebounceTimeout = null;
        }
    }

    private handlePeerDisconnection(): void {
        if (this.hasHandledDisconnection) {
            return;
        }
        this.hasHandledDisconnection = true;

        this.clearReconnectionDebounce();
        this.clearConnectionStabilityCheck();

        this.updateConnectionState(ConnectionState.DISCONNECTED);

        if (this.onTypingStatus) {
            this.onTypingStatus(false);
        }

        // Note: We don't automatically retry here - let the user decide when to reconnect
        debug.log('Peer disconnected from chat:', this.chatId);
    }

    private startConnectionStabilityCheck(): void {
        this.clearConnectionStabilityCheck();

        // Give the connection 2 seconds to stabilize
        this.connectionStabilityTimeout = setTimeout(() => {
            if (this.connectionState === ConnectionState.CONNECTED) {
                debug.log('Connection stabilized for chat:', this.chatId);
            }
        }, 2000);
    }

    private clearConnectionStabilityCheck(): void {
        if (this.connectionStabilityTimeout) {
            clearTimeout(this.connectionStabilityTimeout);
            this.connectionStabilityTimeout = null;
        }
    }

    canRetry(): boolean {
        return this.retryCount < this.maxRetries;
    }

    retry(): void {
        if (!this.canRetry()) {
            debug.log(
                `Cannot retry - max attempts reached (${this.retryCount}/${this.maxRetries})`
            );
            return;
        }

        // Implement debouncing to prevent connection spam
        if (this.reconnectionDebounceTimeout) {
            debug.log('Reconnection already in progress, please wait...');
            return;
        }

        this.retryCount++;
        debug.log(
            `Retrying connection (attempt ${this.retryCount}/${this.maxRetries}) for chat: ${this.chatId}`
        );

        this.disconnect();

        this.connectionState = ConnectionState.DISCONNECTED;
        this.iceCandidates = [];

        // Increase timeout based on retry count for exponential backoff
        const backoffDelay = Math.min(5000 * this.retryCount, 30000); // Max 30 seconds
        this.reconnectionDebounceTimeout = setTimeout(() => {
            this.reconnectionDebounceTimeout = null;
            debug.log(`Ready for next reconnection attempt (waited ${backoffDelay}ms)`);
        }, backoffDelay);
    }

    private updateConnectionState(newState: ConnectionState): void {
        if (this.isDisconnecting && newState !== ConnectionState.DISCONNECTED) {
            return;
        }

        if (this.connectionState === newState) {
            return;
        }

        // Validate state transitions to prevent rapid cycling
        if (!this.isValidStateTransition(this.connectionState, newState)) {
            debug.log(
                `Invalid state transition from ${this.connectionState} to ${newState}, skipping`
            );
            return;
        }

        const previousState = this.connectionState;
        this.connectionState = newState;

        if (newState === ConnectionState.CONNECTING) {
            // Only the initiator arms the failure timeout, and only once the peer's
            // answer has been applied (remoteDescription set) — at that point both sides
            // are genuinely negotiating. The receiver can't know when its answer will be
            // pasted back into the initiator, so it must never auto-fail while waiting;
            // arranging the codes by hand can take far longer than the timeout.
            if (this.isInitiator && this.peerConnection?.remoteDescription) {
                this.startConnectionTimeout();
            }
        } else {
            this.clearConnectionTimeout();

            if (newState === ConnectionState.CONNECTED) {
                this.retryCount = 0;
                this.clearReconnectionDebounce();
            }
        }

        debug.log(`Connection state: ${previousState} → ${newState} (chat: ${this.chatId})`);
        this.onStateChange(newState);
    }

    private isValidStateTransition(fromState: ConnectionState, toState: ConnectionState): boolean {
        if (toState === ConnectionState.DISCONNECTED) {
            return true;
        }

        if (toState === ConnectionState.CONNECTING) {
            return (
                fromState === ConnectionState.DISCONNECTED || fromState === ConnectionState.FAILED
            );
        }

        // Allow transitions to connected from connecting, or CONNECTED→CONNECTED (ICE recovery)
        if (toState === ConnectionState.CONNECTED) {
            return (
                fromState === ConnectionState.CONNECTING || fromState === ConnectionState.CONNECTED
            );
        }

        if (toState === ConnectionState.FAILED) {
            return (
                fromState === ConnectionState.CONNECTING || fromState === ConnectionState.CONNECTED
            );
        }

        return false;
    }

    // Create a fresh peer connection dedicated to one call's media. Closed and discarded on hangup,
    // so each call starts from a pristine connection with zero accumulated transceiver state.
    private createCallPeerConnection(): RTCPeerConnection {
        const pc = new RTCPeerConnection(this.iceConfiguration());

        pc.ontrack = (event) => {
            debug.log('WebRTC: Call track received, streams:', event.streams.length);
            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];
                if (this.onRemoteStreamReceived) {
                    this.onRemoteStreamReceived(this.remoteStream);
                }
                if (this.onCallStateChanged && this.activeCallId) {
                    this.onCallStateChanged(this.activeCallId, 'connected');
                }
            }
        };

        // Trickle each local candidate to the peer over the data channel as it's gathered, so the
        // call connects without waiting for the full gathering to finish.
        pc.onicecandidate = (event) => {
            if (!event.candidate || !this.activeCallId) return;
            this.sendCallSignal({
                type: 'call-ice-candidate',
                callId: this.activeCallId,
                data: { candidate: event.candidate.toJSON() },
                timestamp: Date.now(),
            }).catch((error) => debug.warn('WebRTC: Failed to send call ICE candidate:', error));
        };

        return pc;
    }

    private closeCallPeerConnection(): void {
        this.callIceCandidates = [];
        if (this.callPeerConnection) {
            try {
                this.callPeerConnection.ontrack = null;
                this.callPeerConnection.onicecandidate = null;
                this.callPeerConnection.close();
            } catch (error) {
                debug.warn('WebRTC: Error closing call peer connection:', error);
            }
            this.callPeerConnection = null;
        }
    }

    // Apply a trickled ICE candidate from the peer. Candidates that arrive before the call's remote
    // description is set are queued and flushed by flushCallIceCandidates() once it is applied.
    private async handleCallIceCandidate(callData: CallSignalData): Promise<void> {
        const candidate = callData.data?.candidate as RTCIceCandidateInit | undefined;
        if (!candidate) return;
        const pc = this.callPeerConnection;
        if (pc && pc.remoteDescription) {
            try {
                await pc.addIceCandidate(candidate);
            } catch (error) {
                debug.warn('WebRTC: Failed to add call ICE candidate:', error);
            }
        } else {
            this.callIceCandidates.push(candidate);
        }
    }

    private async flushCallIceCandidates(): Promise<void> {
        const pc = this.callPeerConnection;
        const queued = this.callIceCandidates;
        this.callIceCandidates = [];
        if (!pc) return;
        for (const candidate of queued) {
            try {
                await pc.addIceCandidate(candidate);
            } catch (error) {
                debug.warn('WebRTC: Failed to add queued call ICE candidate:', error);
            }
        }
    }

    async startCall(callId: string, type: 'audio' | 'video'): Promise<void> {
        try {
            if (this.activeCallId) {
                throw new Error(`Cannot start new call - already in call: ${this.activeCallId}`);
            }

            if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                debug.warn(
                    `WebRTC: Data channel not ready (state: ${this.dataChannel?.readyState || 'null'}), cannot start call`
                );
                throw new Error(
                    'WebRTC connection not established. Please send a message first to connect with this peer, then try calling again.'
                );
            }

            this.activeCallId = callId;
            this.isCallMode = true;

            const constraints = {
                audio: true,
                video: type === 'video',
            };

            this.localStream = await mediaManager.getUserMedia(constraints);

            // Fresh, dedicated peer connection for this call's media.
            this.closeCallPeerConnection();
            const pc = this.createCallPeerConnection();
            this.callPeerConnection = pc;

            this.localStream.getTracks().forEach((track) => {
                pc.addTrack(track, this.localStream!);
            });

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            // Send the offer immediately; ICE candidates trickle separately over the data channel.
            const callSignalData: CallSignalData = {
                type: 'call-offer',
                callId: callId,
                data: {
                    type: type,
                    sdp: pc.localDescription?.sdp,
                    callId: callId,
                    chatId: this.chatId,
                },
                timestamp: Date.now(),
            };

            await this.sendCallSignal(callSignalData);

            if (this.onCallStateChanged) {
                this.onCallStateChanged(callId, 'outgoing');
            }
        } catch (error) {
            debug.error('Failed to start call:', error);
            this.endCall(callId);
            throw error;
        }
    }

    async acceptCall(callId: string, type: 'audio' | 'video'): Promise<void> {
        // Tracks specifically whether getUserMedia was the failing step, so the hangup we send
        // on failure can tell the caller "couldn't answer" apart from any other accept failure,
        // rather than lumping every failure in with a genuine decline.
        let mediaFailed = false;
        try {
            this.activeCallId = callId;
            this.isCallMode = true;

            // The call peer connection was created (and the remote offer applied) when the offer
            // arrived in handleIncomingCallOffer.
            const pc = this.callPeerConnection;
            if (!pc) {
                throw new Error('No incoming call connection to accept');
            }

            const constraints = {
                audio: true,
                video: type === 'video',
            };

            try {
                this.localStream = await mediaManager.getUserMedia(constraints);
            } catch (mediaError) {
                mediaFailed = true;
                throw mediaError;
            }

            this.localStream.getTracks().forEach((track) => {
                pc.addTrack(track, this.localStream!);
            });

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // Send the answer immediately; ICE candidates trickle separately over the data channel.
            const callSignalData: CallSignalData = {
                type: 'call-answer',
                callId: callId,
                data: {
                    type: type,
                    accepted: true,
                    sdp: pc.localDescription?.sdp,
                },
                timestamp: Date.now(),
            };

            await this.sendCallSignal(callSignalData);

            if (this.onCallStateChanged) {
                this.onCallStateChanged(callId, 'connected');
            }
        } catch (error) {
            debug.error('Failed to accept call:', error);
            this.endCall(callId, { reason: mediaFailed ? 'media-error' : 'ended' });
            throw error;
        }
    }

    async endCall(callId: string, options?: { reason?: string }): Promise<void> {
        try {
            if (this.activeCallId === callId) {
                const callSignalData: CallSignalData = {
                    type: 'call-hangup',
                    callId: callId,
                    data: { reason: options?.reason ?? 'ended' },
                    timestamp: Date.now(),
                };

                await this.sendCallSignal(callSignalData);
            }
        } catch (error) {
            debug.warn('Failed to send hangup signal:', error);
        } finally {
            this.cleanupCall();
        }
    }

    cleanupCall(): void {
        debug.log('WebRTC: Cleaning up call, activeCallId:', this.activeCallId);

        // Notify of call end before clearing the ID
        const callIdToEnd = this.activeCallId;

        if (this.localStream) {
            this.localStream.getTracks().forEach((track) => track.stop());
            this.localStream = null;
        }

        // Fully tear down the call's dedicated peer connection. The long-lived data-channel
        // connection is untouched, so the next call starts from a pristine media connection.
        this.closeCallPeerConnection();

        this.remoteStream = null;

        this.activeCallId = null;
        this.isCallMode = false;

        // Notify that call has ended (do this after clearing state)
        if (this.onCallStateChanged && callIdToEnd) {
            this.onCallStateChanged(callIdToEnd, 'ended');
        }

        debug.log('WebRTC: Call cleanup complete');
    }

    async toggleCallAudio(callId: string): Promise<boolean> {
        if (!this.localStream || this.activeCallId !== callId) {
            return false;
        }

        const audioEnabled = mediaManager.toggleAudio();

        const callSignalData: CallSignalData = {
            type: 'call-media-toggle',
            callId: callId,
            data: {
                media: 'audio',
                enabled: audioEnabled,
            },
            timestamp: Date.now(),
        };

        await this.sendCallSignal(callSignalData);
        return audioEnabled;
    }

    async toggleCallVideo(callId: string): Promise<boolean> {
        if (!this.localStream || this.activeCallId !== callId) {
            return false;
        }

        const videoEnabled = mediaManager.toggleVideo();

        const callSignalData: CallSignalData = {
            type: 'call-media-toggle',
            callId: callId,
            data: {
                media: 'video',
                enabled: videoEnabled,
            },
            timestamp: Date.now(),
        };

        await this.sendCallSignal(callSignalData);
        return videoEnabled;
    }

    async switchCamera(): Promise<void> {
        if (!this.localStream || !this.callPeerConnection) {
            throw new Error('No active call to switch camera');
        }

        try {
            // mediaManager swaps the new camera's track into the shared local stream and
            // stops the old one.
            await mediaManager.switchCamera();
        } finally {
            // Point the sender at whatever video track the local stream now holds — the new
            // camera on success, or the restored one on failure. Without replaceTrack the peer
            // keeps the old (now stopped) track and its view freezes. replaceTrack swaps it on
            // the existing transceiver with no renegotiation.
            const videoTrack = this.localStream.getVideoTracks()[0];
            const sender = this.callPeerConnection
                .getSenders()
                .find((s) => s.track?.kind === 'video');
            if (sender && videoTrack) {
                await sender.replaceTrack(videoTrack);
            }
        }
    }

    private async sendCallSignal(callSignalData: CallSignalData): Promise<void> {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('Data channel not available for call signaling');
        }

        const rtcMessage: RTCDataMessage = {
            type: callSignalData.type,
            data: callSignalData,
            timestamp: Date.now(),
        };

        this.dataChannel.send(JSON.stringify(rtcMessage));
    }

    getLocalStream(): MediaStream | null {
        return this.localStream;
    }

    private async handleIncomingCallOffer(callData: CallSignalData): Promise<void> {
        try {
            debug.log('WebRTC: Handling incoming call offer:', callData);

            if (!callData.data.sdp) {
                debug.warn('WebRTC: Call offer missing SDP');
                return;
            }

            this.activeCallId = callData.callId;
            this.isCallMode = true;

            // Stand up a fresh call peer connection and apply the remote offer. acceptCall() will
            // add local media and create the answer on this same connection.
            this.closeCallPeerConnection();
            const pc = this.createCallPeerConnection();
            this.callPeerConnection = pc;

            await pc.setRemoteDescription({
                type: 'offer',
                sdp: callData.data.sdp,
            });

            // Apply any candidates that arrived ahead of the offer.
            await this.flushCallIceCandidates();

            debug.log('WebRTC: Remote description set from call offer');
        } catch (error) {
            debug.error('WebRTC: Failed to handle incoming call offer:', error);
            throw error;
        }
    }

    private async handleCallAnswer(callData: CallSignalData): Promise<void> {
        try {
            debug.log('WebRTC: Handling call answer:', callData);

            const pc = this.callPeerConnection;
            if (!pc) {
                debug.warn('WebRTC: No call peer connection available for call answer');
                return;
            }

            if (!callData.data.sdp) {
                debug.warn('WebRTC: Call answer missing SDP');
                return;
            }

            await pc.setRemoteDescription({
                type: 'answer',
                sdp: callData.data.sdp,
            });

            // Apply any candidates that arrived ahead of the answer.
            await this.flushCallIceCandidates();

            debug.log('WebRTC: Remote description set from call answer');
        } catch (error) {
            debug.error('WebRTC: Failed to handle call answer:', error);
            throw error;
        }
    }

    getRemoteStream(): MediaStream | null {
        return this.remoteStream;
    }

    getActiveCallId(): string | null {
        return this.activeCallId;
    }

    isInCall(): boolean {
        return this.isCallMode && this.activeCallId !== null;
    }

    private setupRemoteStreamHandler(): void {
        if (!this.peerConnection) return;

        this.peerConnection.ontrack = (event) => {
            debug.log('Received remote stream tracks:', event.streams.length);

            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];

                if (this.onRemoteStreamReceived) {
                    this.onRemoteStreamReceived(this.remoteStream);
                }

                if (this.onCallStateChanged && this.activeCallId) {
                    this.onCallStateChanged(this.activeCallId, 'connected');
                }
            }
        };
    }
}
