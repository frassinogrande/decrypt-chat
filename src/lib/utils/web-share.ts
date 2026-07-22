import { debug } from './debug';

export interface ShareData {
    title?: string;
    text?: string;
    url?: string;
}

export function canShare(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        'share' in navigator &&
        typeof navigator.share === 'function'
    );
}

export function canShareData(data: ShareData): boolean {
    if (!canShare()) return false;

    if (!data.url && !data.text && !data.title) return false;

    if ('canShare' in navigator && typeof navigator.canShare === 'function') {
        try {
            return navigator.canShare(data);
        } catch {
            return false;
        }
    }

    return true;
}

export async function shareConnectionLink(url: string, contactName: string): Promise<boolean> {
    const shareData: ShareData = {
        title: `Connect with ${contactName}`,
        text: `Join my secure chat! Click this link to connect with me on our private encrypted chat.`,
        url: url,
    };

    if (!canShareData(shareData)) {
        return false;
    }

    try {
        await navigator.share(shareData);
        return true;
    } catch (error) {
        // User cancelled or sharing failed
        debug.log('Web Share cancelled or failed:', error);
        return false;
    }
}

export async function shareResponseLink(url: string, contactName: string): Promise<boolean> {
    const shareData: ShareData = {
        title: `Response to ${contactName}`,
        text: `Here's my response to connect! Click this link to complete our secure chat connection.`,
        url: url,
    };

    if (!canShareData(shareData)) {
        return false;
    }

    try {
        await navigator.share(shareData);
        return true;
    } catch (error) {
        // User cancelled or sharing failed
        debug.log('Web Share cancelled or failed:', error);
        return false;
    }
}

export async function shareUrl(url: string, title?: string, text?: string): Promise<boolean> {
    const shareData: ShareData = {
        title: title || 'Share Link',
        text: text || 'Check out this link',
        url: url,
    };

    if (!canShareData(shareData)) {
        return false;
    }

    try {
        await navigator.share(shareData);
        return true;
    } catch (error) {
        debug.log('Web Share cancelled or failed:', error);
        return false;
    }
}

/**
 * Copy text to the clipboard. The content stays there until the user copies
 * something else: the browser only allows clipboard writes from a user gesture
 * on a focused document, so an app cannot reliably clear it again afterwards.
 *
 * Text that is still being built (e.g. a share code mid-encryption) can be
 * passed as a promise, but this function must then be CALLED synchronously
 * from the gesture handler: Safari revokes the gesture's transient activation
 * at the first await, so the write is started immediately via a
 * promise-carrying ClipboardItem and the browser itself waits for the text.
 */
export async function copyToClipboard(text: string | Promise<string>): Promise<boolean> {
    if (typeof text !== 'string') {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
            const blob = Promise.resolve(text).then((t) => new Blob([t], { type: 'text/plain' }));
            // Mark handled so a rejected text promise never surfaces as an
            // unhandled rejection when the ClipboardItem path bails early.
            blob.catch(() => {});
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
                return true;
            } catch (error) {
                debug.warn('clipboard.write with pending text failed, falling back:', error);
            }
        }
        // Rethrows the builder's error to the caller if the text itself failed.
        text = await text;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            debug.warn('navigator.clipboard.writeText failed, trying execCommand:', error);
        }
    }

    // Chromium rejects the async clipboard API outright on file:// (NotAllowedError:
    // permission denied), which the single-file offline build runs under. The legacy
    // execCommand path still honors the triggering user gesture there.
    const helper = document.createElement('textarea');
    try {
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        // iOS Safari ignores select() alone; an explicit range is required.
        helper.setSelectionRange(0, helper.value.length);
        return document.execCommand('copy');
    } catch (error) {
        debug.error('Failed to copy to clipboard:', error);
        return false;
    } finally {
        helper.remove();
    }
}
