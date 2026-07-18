const NOTICE_KEY = 'connection-notice-dismissed';

export function isConnectionNoticeDismissed(): boolean {
    try {
        return localStorage.getItem(NOTICE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function dismissConnectionNotice() {
    try {
        localStorage.setItem(NOTICE_KEY, 'true');
    } catch {
        /* best-effort; the notice simply shows again next time */
    }
}
