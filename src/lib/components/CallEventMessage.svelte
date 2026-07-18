<script lang="ts">
    import Icon from '$lib/components/icons/Icon.svelte';
    import type { CallEventInfo } from '../types';
    import { translations as LL, locale as localeStore } from '$lib/i18n/runtime';
    import { profileManager } from '../utils/profile-manager';
    import { callEventLabel } from '../utils/call-event-label';
    import { get } from 'svelte/store';

    export let callEvent: CallEventInfo;
    export let timestamp: number;

    const profileSettings = profileManager.settings;
    $: use24HourTime = $profileSettings.use24HourTime;

    // Declined and missed read as failures; cancelled and completed are neutral.
    $: isFailure = callEvent.outcome === 'declined' || callEvent.outcome === 'missed';

    // A completed call names its own type ("Video call lasted ..."), so the sr-only call-type
    // suffix below would repeat it.
    $: isCompleted = callEvent.outcome === 'completed';

    $: localeCode = $localeStore || 'en';

    $: label = callEventLabel(callEvent, $LL, localeCode);

    function formatShortTime(value: number): string {
        let localeCode = 'en';
        try {
            localeCode = get(localeStore);
        } catch {
            localeCode = 'en';
        }
        try {
            return new Intl.DateTimeFormat(localeCode, {
                hour: '2-digit',
                minute: '2-digit',
                hour12: !use24HourTime,
            }).format(new Date(value));
        } catch {
            return new Date(value).toLocaleTimeString();
        }
    }
</script>

<div class="call-event" class:is-failure={isFailure}>
    <span class="call-event__icon" aria-hidden="true">
        <Icon name={callEvent.callType === 'video' ? 'videocam' : 'call'} size={16} />
    </span>
    <span class="call-event__label">{label}</span>
    <!-- The voice/video distinction is otherwise only carried by the aria-hidden icon. -->
    {#if !isCompleted}
        <span class="sr-only"
            >, {callEvent.callType === 'video' ? $LL.callTypeVideo() : $LL.callTypeVoice()}</span
        >
    {/if}
    <time class="call-event__time" datetime={new Date(timestamp).toISOString()}>
        {formatShortTime(timestamp)}
    </time>
</div>

<style>
    .call-event {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        margin: 0 auto;
        padding: 0.35rem 0.75rem;
        border-radius: 999px;
        background: var(--color-bg-subtle);
        border: 1px solid var(--color-border);
        color: var(--color-text-muted);
        font-size: 0.8rem;
        max-width: 90%;
    }

    .call-event.is-failure {
        background: color-mix(in srgb, #dc3545 10%, var(--color-bg));
        border-color: var(--color-error-border);
        color: var(--color-error-text);
    }

    .call-event__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .call-event__label {
        font-weight: 500;
    }

    .call-event__time {
        opacity: 0.7;
    }
</style>
