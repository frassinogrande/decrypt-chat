/**
 * Offloads expensive key derivation to a Web Worker to prevent UI blocking.
 */

import { debug } from './debug';
import KdfWorker from '../workers/kdf-worker?worker';

interface KDFRequest {
    id: string;
    type: 'derive-key';
    password: string;
    salt: Uint8Array;
    iterations: number;
    keyUsages: KeyUsage[];
}

interface KDFResponse {
    id: string;
    success: boolean;
    key?: CryptoKey;
    error?: string;
}

class KDFService {
    private worker: Worker | null = null;
    private pendingRequests = new Map<
        string,
        {
            resolve: (key: CryptoKey) => void;
            reject: (error: Error) => void;
        }
    >();

    private async initWorker(): Promise<Worker> {
        if (this.worker) {
            return this.worker;
        }

        if (typeof window === 'undefined' || typeof Worker === 'undefined') {
            throw new Error('Web Workers not supported in this environment');
        }

        try {
            this.worker = new KdfWorker();

            this.worker.addEventListener('message', this.handleWorkerMessage.bind(this));
            this.worker.addEventListener('error', this.handleWorkerError.bind(this));

            debug.log('KDF Worker initialized successfully');
            return this.worker;
        } catch (error) {
            debug.warn('Failed to initialize KDF worker, falling back to main thread:', error);
            throw error;
        }
    }

    private handleWorkerMessage(event: MessageEvent<KDFResponse>): void {
        const { id, success, key, error } = event.data;
        const request = this.pendingRequests.get(id);

        if (!request) {
            debug.warn('Received response for unknown request:', id);
            return;
        }

        this.pendingRequests.delete(id);

        if (success && key) {
            request.resolve(key);
        } else {
            request.reject(new Error(error || 'Unknown KDF error'));
        }
    }

    private handleWorkerError(error: ErrorEvent): void {
        debug.error('KDF Worker error:', error);

        for (const request of this.pendingRequests.values()) {
            request.reject(new Error('KDF Worker encountered an error'));
        }
        this.pendingRequests.clear();

        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    }

    /**
     * Derive key using Web Worker (non-blocking) or main thread (fallback)
     */
    async deriveKey(
        password: string,
        salt: Uint8Array,
        iterations: number = 600000,
        keyUsages: KeyUsage[] = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    ): Promise<CryptoKey> {
        try {
            const worker = await this.initWorker();
            return await this.deriveKeyWithWorker(worker, password, salt, iterations, keyUsages);
        } catch (workerError) {
            debug.warn('Web Worker KDF failed, falling back to main thread:', workerError);
            return await this.deriveKeyMainThread(password, salt, iterations, keyUsages);
        }
    }

    private async deriveKeyWithWorker(
        worker: Worker,
        password: string,
        salt: Uint8Array,
        iterations: number,
        keyUsages: KeyUsage[]
    ): Promise<CryptoKey> {
        const id = crypto.randomUUID();

        return new Promise<CryptoKey>((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('KDF operation timed out'));
                }
            }, 30000);

            const request: KDFRequest = {
                id,
                type: 'derive-key',
                password,
                salt,
                iterations,
                keyUsages,
            };

            worker.postMessage(request);
        });
    }

    /**
     * Fallback: derive key in main thread (may block UI)
     */
    private async deriveKeyMainThread(
        password: string,
        salt: Uint8Array,
        iterations: number,
        keyUsages: KeyUsage[]
    ): Promise<CryptoKey> {
        debug.warn('Performing KDF in main thread - UI may become unresponsive');

        const passwordKey = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );

        return await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt as Uint8Array<ArrayBuffer>,
                iterations: iterations,
                hash: 'SHA-256',
            },
            passwordKey,
            { name: 'AES-GCM', length: 256 },
            false, // non-extractable for security
            keyUsages
        );
    }

    destroy(): void {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }

        for (const request of this.pendingRequests.values()) {
            request.reject(new Error('KDF Service was destroyed'));
        }
        this.pendingRequests.clear();
    }
}

export const kdfService = new KDFService();
