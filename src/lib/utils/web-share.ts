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
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
        return false;
    }

    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (error) {
        debug.error('Failed to copy to clipboard:', error);
        return false;
    }
}
