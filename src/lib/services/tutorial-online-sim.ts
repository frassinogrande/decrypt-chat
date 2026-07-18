import { decryptSignalData, encryptSignalData } from '$lib/utils/webrtc-signal-codec';
import { secureKeyManager } from '$lib/utils/secure-key-manager';

// The tutorial connects the user to this stand-in on the same device, where host candidates
// always complete the loopback. So there is deliberately NO STUN server here: the guided tour
// contacts nothing at all. Real connections use the public STUN servers in webrtc.ts, and the
// tutorial explains that difference to the user.
const ICE_SERVERS: RTCConfiguration = {
    iceServers: [],
};

/**
 * A throwaway in-page "peer" that answers the user's own WebRTC offer during the guided tour, so
 * going online connects them to a friendly local stand-in instead of a real contact. Because the
 * app uses vanilla ICE (each offer/answer carries its full candidate set), a single answer code is
 * enough to complete a genuine loopback connection — the normal connected UI then just works.
 *
 * The stand-in only keeps the heartbeat alive; it never reads or sends real chat messages.
 */
export class TutorialPeer {
    private pc: RTCPeerConnection | null = null;
    private channel: RTCDataChannel | null = null;

    /** Decrypt the user's offer with the chat key, produce an encrypted answer, and complete ICE. */
    async answerOffer(chatId: string, encryptedOffer: string): Promise<string> {
        const key = secureKeyManager.getConversationKey(chatId);
        if (!key) {
            throw new Error('Tutorial chat key unavailable');
        }

        const signal = await decryptSignalData(encryptedOffer, key);
        if (signal.type !== 'offer') {
            throw new Error('Expected a WebRTC offer');
        }

        const pc = new RTCPeerConnection(ICE_SERVERS);
        this.pc = pc;

        // The initiator creates the data channel; we receive it and answer heartbeats so the
        // connection is never torn down as stale while the tour is in progress.
        pc.ondatachannel = (event) => {
            this.channel = event.channel;
            this.channel.onmessage = (e) => this.handleChannelMessage(e.data);
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                this.close();
            }
        };

        await pc.setRemoteDescription(signal.data as RTCSessionDescriptionInit);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.waitForIceGathering(pc);

        return await encryptSignalData({ type: 'answer', data: pc.localDescription! }, key);
    }

    private handleChannelMessage(data: string | ArrayBuffer): void {
        if (typeof data !== 'string') return;
        try {
            const message = JSON.parse(data);
            if (message?.type === 'heartbeat' && this.channel?.readyState === 'open') {
                this.channel.send(JSON.stringify({ type: 'heartbeat-ack', timestamp: Date.now() }));
            }
        } catch {
            // Real chat messages are encrypted app payloads; the stand-in ignores everything
            // except the plain-JSON heartbeat it needs to acknowledge.
        }
    }

    private waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            const onChange = () => {
                if (pc.iceGatheringState === 'complete') {
                    pc.removeEventListener('icegatheringstatechange', onChange);
                    resolve();
                }
            };
            pc.addEventListener('icegatheringstatechange', onChange);
            // Safety net: with no STUN servers, host candidates gather almost instantly, but never
            // block the tour on ICE in the unlikely event the state change is missed.
            setTimeout(() => {
                pc.removeEventListener('icegatheringstatechange', onChange);
                resolve();
            }, 3000);
        });
    }

    close(): void {
        try {
            this.channel?.close();
        } catch {
            // ignore
        }
        try {
            this.pc?.close();
        } catch {
            // ignore
        }
        this.channel = null;
        this.pc = null;
    }
}
