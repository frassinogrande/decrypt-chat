/**
 * Format a share fragment (e.g. "#secure=..." or "#webrtc-offer=...") as a shareable
 * code: just the fragment, with no URL. Because a code isn't a clickable link, messengers
 * can't turn it into a tappable link that opens a new, separately-locked browser tab — the
 * recipient pastes it into the open app instead. Codes are the single share format; there
 * is intentionally no link option.
 */
export function buildShareCode(fragment: string): string {
    return fragment.startsWith('#') ? fragment : `#${fragment}`;
}
