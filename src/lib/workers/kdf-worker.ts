/**
 * Web Worker for Key Derivation Function (KDF) operations
 * Keeps UI responsive during expensive PBKDF2 operations (600k iterations)
 */

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

self.addEventListener('message', async (event: MessageEvent<KDFRequest>) => {
    const { id, type, password, salt, iterations, keyUsages } = event.data;

    try {
        if (type === 'derive-key') {
            const passwordKey = await crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(password),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            );

            const derivedKey = await crypto.subtle.deriveKey(
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

            const response: KDFResponse = {
                id,
                success: true,
                key: derivedKey,
            };

            self.postMessage(response);
        }
    } catch (error) {
        const response: KDFResponse = {
            id,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };

        self.postMessage(response);
    }
});

export {}; // Make this a module
