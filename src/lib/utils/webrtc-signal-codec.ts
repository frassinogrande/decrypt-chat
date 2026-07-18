import { debug } from './debug';
import { deflate, inflate } from 'pako';

export interface RTCSignalData {
    type: 'offer' | 'answer' | 'ice-candidate';
    data: RTCSessionDescriptionInit | RTCIceCandidateInit;
}

/**
 * Encodes/decodes the AES-GCM-encrypted WebRTC signaling payload (offer/answer SDP)
 * exchanged via URL fragments. The SDP JSON is compressed with deflate to shorten
 * links, encrypted with the conversation key, and base64url-encoded.
 *
 * This is a stateless collaborator: it holds no connection state and is safe to
 * call at any time. Wire format is unchanged from the original WebRTCManager
 * implementation (12-byte IV prefix + ciphertext, base64url, '=' stripped).
 */
export async function encryptSignalData(
    signalData: RTCSignalData,
    chatKey: CryptoKey
): Promise<string> {
    const jsonString = JSON.stringify(signalData);
    const jsonBytes = new TextEncoder().encode(jsonString);

    let payload: Uint8Array<ArrayBuffer>;
    try {
        payload = deflate(jsonBytes) as Uint8Array<ArrayBuffer>;
    } catch (_) {
        payload = jsonBytes as Uint8Array<ArrayBuffer>; // fallback if compression fails
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chatKey, payload);

    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);

    return arrayBufferToBase64url(combined.buffer);
}

export async function decryptSignalData(
    encryptedData: string,
    chatKey: CryptoKey
): Promise<RTCSignalData> {
    try {
        const combined = base64urlToArrayBuffer(encryptedData);

        if (combined.byteLength < 12) {
            throw new Error('Encrypted data too short (missing IV)');
        }

        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);

        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, chatKey, encrypted);

        const decryptedBytes = new Uint8Array(decrypted);
        // Try plain JSON first (backward compatibility)
        try {
            const asString = new TextDecoder().decode(decryptedBytes);
            const parsed = JSON.parse(asString);
            if (parsed && parsed.type && parsed.data) {
                return parsed;
            }
        } catch (_) {
            // fallthrough to decompression path
        }

        const inflated = inflate(decryptedBytes);
        const jsonString = new TextDecoder().decode(inflated);
        const signalData = JSON.parse(jsonString);

        if (!signalData.type || !signalData.data) {
            throw new Error('Invalid signal data structure');
        }

        return signalData;
    } catch (error) {
        debug.error('Failed to decrypt signal data:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error('Failed to decrypt signal data: ' + errorMessage);
    }
}

export function arrayBufferToBase64url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function base64urlToArrayBuffer(base64url: string): ArrayBuffer {
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}
