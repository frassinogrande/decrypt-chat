import type { CallEventInfo } from '../types';

// The label shown for a call event, shared by the in-chat system line and the chat-list preview
// so the two never drift apart.

// Structural subset of the compiled Paraglide messages, so passing the whole module works.
interface CallEventMessages {
    callTypeVideo: () => string;
    callTypeVoice: () => string;
    callEventMissed: () => string;
    callEventYouDeclined: () => string;
    callEventDeclined: () => string;
    callEventCancelled: () => string;
    callEventYouFailed: () => string;
    callEventFailed: () => string;
    callEventVideoLasted: (args: { duration: string }) => string;
    callEventVoiceLasted: (args: { duration: string }) => string;
}

function formatUnit(value: number, unit: 'hour' | 'minute' | 'second', locale: string): string {
    try {
        return new Intl.NumberFormat(locale, {
            style: 'unit',
            unit,
            unitDisplay: 'short',
        }).format(value);
    } catch {
        // Very old engines without unit formatting.
        const suffix = unit === 'hour' ? 'hr' : unit === 'minute' ? 'min' : 'sec';
        return `${value} ${suffix}`;
    }
}

// Two units at most, largest first: "1 hr 5 min", "5 min 23 sec", "8 sec". Seconds are dropped
// once the call ran past an hour, where they are noise.
export function formatCallDuration(totalSeconds: number, locale: string): string {
    const total = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    const parts: string[] = [];
    if (hours > 0) {
        parts.push(formatUnit(hours, 'hour', locale));
        if (minutes > 0) parts.push(formatUnit(minutes, 'minute', locale));
    } else if (minutes > 0) {
        parts.push(formatUnit(minutes, 'minute', locale));
        if (seconds > 0) parts.push(formatUnit(seconds, 'second', locale));
    } else {
        parts.push(formatUnit(seconds, 'second', locale));
    }
    return parts.join(' ');
}

export function callEventLabel(
    event: CallEventInfo,
    ll: CallEventMessages,
    locale: string
): string {
    if (event.outcome === 'completed') {
        // Records written before durations were stored, or a teardown that lost the timestamp:
        // name the call without claiming a length.
        if (event.duration === undefined) {
            return event.callType === 'video' ? ll.callTypeVideo() : ll.callTypeVoice();
        }
        const duration = formatCallDuration(event.duration, locale);
        return event.callType === 'video'
            ? ll.callEventVideoLasted({ duration })
            : ll.callEventVoiceLasted({ duration });
    }

    if (event.direction === 'incoming') {
        if (event.outcome === 'declined') return ll.callEventYouDeclined();
        if (event.outcome === 'failed') return ll.callEventYouFailed();
        return ll.callEventMissed();
    }
    if (event.outcome === 'declined') return ll.callEventDeclined();
    if (event.outcome === 'failed') return ll.callEventFailed();
    return ll.callEventCancelled();
}
