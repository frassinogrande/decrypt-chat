import { debug } from './debug';

function buildBasePath(): string {
    if (typeof window === 'undefined') {
        return '';
    }
    const { pathname, search } = window.location;
    return `${pathname}${search}`;
}

/**
 * Clear URL fragment from browser history for security
 * Prevents sensitive data from being stored in browser history
 */
export function clearUrlFragment(): void {
    if (typeof window !== 'undefined') {
        try {
            // Replace current history entry without the fragment using native API
            // (avoids SvelteKit's navigation pipeline which can trigger beforeunload)
            const state = window.history?.state ?? {};
            history.replaceState(state, '', buildBasePath());
        } catch (error) {
            debug.warn('Failed to clear URL fragment:', error);
        }
    }
}

/**
 * Parse URL fragment and immediately clean it for security
 * Returns the extracted data without leaving it in browser history
 */
export function parseAndClearFragment(hash: string): {
    type: 'secure' | 'webrtc-offer' | 'webrtc-answer' | 'unknown';
    data: string | null;
} {
    let type: 'secure' | 'webrtc-offer' | 'webrtc-answer' | 'unknown' = 'unknown';
    let data: string | null = null;

    // `#secure=` is the universal marker for shared encrypted content — messages, calls,
    // and profile shares all ride it and are dispatched by content type after decryption.
    if (hash.startsWith('#secure=')) {
        type = 'secure';
        data = hash.substring('#secure='.length);
        // Some messengers/email clients percent-encode URL fragments in transit
        if (data.includes('%')) {
            try {
                data = decodeURIComponent(data);
            } catch {
                // leave as-is; decryption will fail with a user-facing error
            }
        }
    } else if (hash.startsWith('#webrtc-offer=')) {
        type = 'webrtc-offer';
        data = decodeURIComponent(hash.substring(14));
    } else if (hash.startsWith('#webrtc-answer=')) {
        type = 'webrtc-answer';
        data = decodeURIComponent(hash.substring(15));
    }

    // Immediately clear the fragment from history
    if (data !== null) {
        clearUrlFragment();
    }

    return { type, data };
}
