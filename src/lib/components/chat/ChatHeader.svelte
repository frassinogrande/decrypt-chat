<script lang="ts">
    import { createEventDispatcher, tick } from 'svelte';
    import Icon from '$lib/components/icons/Icon.svelte';
    import type { Call, Chat } from '$lib/types';
    import { translations as LL } from '$lib/i18n/runtime';
    import { anchorFallback } from '$lib/actions/anchor-fallback';

    type SmartButtonState = 'offline' | 'connected' | 'connecting';

    export let chat: Chat;
    export let isOnline: boolean;
    export let isConnecting: boolean;
    export let connectionFailed: boolean;
    export let currentCall: Call | null;
    export let smartButtonState: SmartButtonState;
    export let smartButtonHoverText = '';
    export let smartButtonTooltip = '';
    export let isPeerTyping = false;
    export let backButtonLabel = 'Back';

    const dispatch = createEventDispatcher<
        | { type: 'goBack' }
        | { type: 'startAudioCall' }
        | { type: 'startVideoCall' }
        | { type: 'smartButton' }
        | { type: 'dropdownAction'; detail: { action: string } }
        | { type: 'showContactInfo' }
    >();

    function emit<T extends { type: string } & { detail?: any }>(event: T) {
        // @ts-expect-error - Svelte dispatcher requires positional args
        dispatch(event.type, event.detail);
    }

    function autoDeleteLabel(ms: number | null | undefined): string {
        if (!ms) return $LL.autoDeleteLabel();
        if (ms === 3600000) return `${$LL.autoDeleteLabel()} (1 hour)`;
        if (ms === 86400000) return `${$LL.autoDeleteLabel()} (1 day)`;
        if (ms === 604800000) return `${$LL.autoDeleteLabel()} (1 week)`;
        if (ms === 2592000000) return `${$LL.autoDeleteLabel()} (1 month)`;
        return $LL.autoDeleteLabel();
    }

    let offlineCallDialogRef: HTMLDialogElement;
    let showOfflineCallDialog = false;
    let dropdownMenuRef: HTMLElement;
    let dropdownToggleRef: HTMLButtonElement;
    let showDropdownMenu = false;

    const dropdownAnchorName = '--chat-options-toggle';
    const dropdownPopoverId = 'chat-options-popover';

    function handleDropdownPopoverToggle(event: ToggleEvent) {
        showDropdownMenu = event.newState === 'open';
        if (showDropdownMenu) {
            tick().then(() => {
                dropdownMenuRef
                    ?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')
                    ?.focus();
            });
        }
    }

    function handleDropdownKeydown(event: KeyboardEvent) {
        if (!dropdownMenuRef) return;
        const items = Array.from(
            dropdownMenuRef.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])')
        );
        const idx = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            items[(idx + 1) % items.length]?.focus();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            items[(idx - 1 + items.length) % items.length]?.focus();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            dropdownMenuRef?.hidePopover();
        }
    }

    function doDropdownAction(action: string) {
        dropdownMenuRef?.hidePopover();
        emit({ type: 'dropdownAction', detail: { action } });
    }

    $: if (showOfflineCallDialog) offlineCallDialogRef?.showModal();

    function handleOfflineCallClick() {
        showOfflineCallDialog = true;
    }

    function closeOfflineCallDialog() {
        offlineCallDialogRef?.close();
        showOfflineCallDialog = false;
    }
</script>

<div class="chat-header">
    <button
        type="button"
        class="btn btn--primary btn--icon back-button mobile-only"
        on:click={() => emit({ type: 'goBack' })}
        aria-label={backButtonLabel}
    >
        <Icon name="chevron-left" size={24} className="back-icon-graphic" />
    </button>
    <div class="contact-info">
        <div class="contact-name-container">
            {#if isOnline}
                <span class="online-dot" aria-hidden="true"></span>
            {/if}
            <h3 class="contact-name-heading">
                <button
                    type="button"
                    class="btn btn--secondary contact-name-clickable"
                    on:click={() => emit({ type: 'showContactInfo' })}
                    aria-label={$LL.chatHeaderContactInfoButton({ name: chat.name })}
                >
                    <span class="contact-name-text">{chat.name}</span>
                    <Icon name="edit" size={15} className="contact-name-edit-icon" />
                </button>
            </h3>
        </div>
        <div class="status-container">
            <!-- Only the transition INTO typing is announced: the text is cleared to
                 empty when typing stops, and text removal is not announced, so the
                 typing/online flip-flop doesn't spam "Typing", "Online" on every cycle. -->
            <span class="sr-only" role="status"
                >{isPeerTyping ? $LL.chatInterfaceStatusTyping() : ''}</span
            >
            <span
                class="status"
                title={isPeerTyping
                    ? $LL.chatInterfaceStatusTooltipTyping({ name: chat.name })
                    : isOnline
                      ? $LL.chatInterfaceStatusTooltipOnline()
                      : isConnecting
                        ? $LL.chatInterfaceStatusTooltipConnecting({ name: chat.name })
                        : $LL.chatInterfaceStatusTooltipOffline()}
            >
                {#if isPeerTyping}
                    <span class="status-text">{$LL.chatInterfaceStatusTyping()}</span>
                {:else if isOnline}
                    <span class="status-text">{$LL.chatInterfaceStatusOnline()}</span>
                {:else if isConnecting}
                    <span class="status-text">{$LL.chatInterfaceStatusConnecting()}</span>
                {:else if connectionFailed}
                    <Icon name="close" size={14} className="status-indicator failed" />
                    <span class="status-text">{$LL.chatInterfaceStatusFailed()}</span>
                {:else}
                    <span class="status-text">{$LL.chatInterfaceStatusOffline()}</span>
                {/if}
            </span>
        </div>
    </div>

    <div class="header-actions">
        {#if !currentCall}
            {#if isOnline}
                <button
                    type="button"
                    class="btn btn--secondary btn--icon call-button audio-call"
                    on:click={() => emit({ type: 'startAudioCall' })}
                    title={$LL.chatInterfaceVoiceCallTitle()}
                    aria-label={$LL.chatInterfaceVoiceCallAria()}
                >
                    <Icon name="call" size={24} className="call-icon-graphic" />
                </button>
                <button
                    type="button"
                    class="btn btn--secondary btn--icon call-button video-call"
                    on:click={() => emit({ type: 'startVideoCall' })}
                    title={$LL.chatInterfaceVideoCallTitle()}
                    aria-label={$LL.chatInterfaceVideoCallAria()}
                >
                    <Icon name="videocam" size={24} className="call-icon-graphic" />
                </button>
            {:else}
                <button
                    type="button"
                    class="btn btn--secondary btn--icon call-button call-button--disabled audio-call"
                    title={$LL.chatInterfaceVoiceCallTitle()}
                    aria-label={$LL.chatInterfaceVoiceCallAria()}
                    on:click={handleOfflineCallClick}
                >
                    <Icon name="call" size={24} className="call-icon-graphic" />
                </button>
                <button
                    type="button"
                    class="btn btn--secondary btn--icon call-button call-button--disabled video-call"
                    title={$LL.chatInterfaceVideoCallTitle()}
                    aria-label={$LL.chatInterfaceVideoCallAria()}
                    on:click={handleOfflineCallClick}
                >
                    <Icon name="videocam" size={24} className="call-icon-graphic" />
                </button>
            {/if}
        {/if}

        {#if currentCall}
            <div class="call-status-indicator">
                <span class="call-icon">
                    {#if currentCall.type === 'video'}
                        <Icon name="videocam" size={20} className="call-status-icon" />
                    {:else}
                        <Icon name="call" size={18} className="call-status-icon" />
                    {/if}
                </span>
                <span class="call-status-text">
                    {#if currentCall.state === 'outgoing'}
                        {$LL.chatInterfaceCallStatusOutgoing()}
                    {:else if currentCall.state === 'connected'}
                        {$LL.chatInterfaceCallStatusConnected()}
                    {/if}
                </span>
            </div>
        {/if}
        <div class="smart-button-container">
            <button
                type="button"
                class="btn btn--secondary smart-button"
                class:offline={smartButtonState === 'offline'}
                class:connected={smartButtonState === 'connected'}
                class:connecting={smartButtonState === 'connecting'}
                class:expanded={smartButtonState === 'offline'}
                disabled={smartButtonState === 'connecting' || !!currentCall}
                on:click={() => emit({ type: 'smartButton' })}
                aria-label={smartButtonTooltip}
                title={smartButtonTooltip}
            >
                <span class="smart-button-icon" aria-hidden="true">
                    {#if smartButtonState === 'offline'}
                        <Icon name="wifi" size={18} className="smart-button-icon-graphic" />
                    {:else if smartButtonState === 'connected'}
                        <Icon
                            name="wifi-disabled"
                            size={18}
                            className="smart-button-icon-graphic"
                        />
                    {:else}
                        <Icon name="wifi" size={18} className="smart-button-icon-graphic" />
                    {/if}
                </span>
                <span class="button-text">{smartButtonHoverText}</span>
            </button>
        </div>
        <div class="dropdown-container">
            <button
                type="button"
                class="btn btn--secondary btn--icon menu-button dropdown-toggle"
                bind:this={dropdownToggleRef}
                popovertarget={dropdownPopoverId}
                popovertargetaction="toggle"
                style="anchor-name: {dropdownAnchorName}"
                title={$LL.chatInterfaceMenuTitle()}
                aria-label={$LL.chatInterfaceMenuTitle()}
                aria-haspopup="menu"
                aria-expanded={showDropdownMenu}
            >
                <Icon name="more-vert" size={24} className="menu-icon-graphic" />
            </button>
            <ul
                id={dropdownPopoverId}
                popover="auto"
                class="dropdown-menu"
                role="menu"
                aria-label={$LL.chatInterfaceMenuTitle()}
                bind:this={dropdownMenuRef}
                on:keydown={handleDropdownKeydown}
                on:toggle={handleDropdownPopoverToggle}
                use:anchorFallback={{ trigger: dropdownToggleRef, placement: 'bottom-end', gap: 8 }}
                style="position-anchor: {dropdownAnchorName}"
            >
                <li role="none">
                    <button
                        type="button"
                        class="btn btn--secondary dropdown-item"
                        role="menuitem"
                        on:click={() => doDropdownAction('share-profile')}
                    >
                        {$LL.chatInterfaceShareProfile({ name: chat.name })}
                    </button>
                </li>
                <li role="none">
                    <button
                        type="button"
                        class="btn btn--secondary dropdown-item"
                        role="menuitem"
                        on:click={() => doDropdownAction('regenerate-key')}
                    >
                        {$LL.chatInterfaceRegenerateKey()}
                    </button>
                </li>
                <li role="none">
                    <button
                        type="button"
                        class="btn btn--secondary dropdown-item"
                        role="menuitem"
                        on:click={() => doDropdownAction('import-whatsapp')}
                    >
                        {$LL.chatInterfaceImportChat()}
                    </button>
                </li>
                <li role="none">
                    <button
                        type="button"
                        class="btn btn--secondary dropdown-item"
                        role="menuitem"
                        on:click={() => doDropdownAction('export-chat')}
                    >
                        {$LL.chatInterfaceExportChat()}
                    </button>
                </li>
                <li role="none">
                    <button
                        type="button"
                        class="btn btn--secondary dropdown-item"
                        role="menuitem"
                        on:click={() => doDropdownAction('clear-chat')}
                    >
                        {$LL.clearChat()}
                    </button>
                </li>
                <li role="none">
                    <button
                        type="button"
                        class="btn btn--secondary dropdown-item"
                        role="menuitem"
                        on:click={() => doDropdownAction('auto-delete')}
                    >
                        {autoDeleteLabel(chat.autoDeleteAfter)}
                    </button>
                </li>
                <li role="none">
                    <button
                        type="button"
                        class="btn btn--warning dropdown-item delete-item"
                        role="menuitem"
                        on:click={() => doDropdownAction('delete-chat')}
                    >
                        {$LL.chatInterfaceDeleteChat()}
                    </button>
                </li>
            </ul>
        </div>
    </div>
</div>

{#if showOfflineCallDialog}
    <dialog
        bind:this={offlineCallDialogRef}
        class="dialog"
        aria-labelledby="offline-call-title"
        on:cancel|preventDefault={closeOfflineCallDialog}
        aria-modal="true"
    >
        <div class="dialog__header">
            <h3 id="offline-call-title" class="dialog__title">{$LL.offlineDialogTitle()}</h3>
            <button
                type="button"
                class="btn btn--secondary"
                data-modal-close
                on:click={closeOfflineCallDialog}
                aria-label={$LL.dialogClose()}>×</button
            >
        </div>
        <div class="dialog__body">
            <p>{$LL.offlineCallDialogBody({ name: chat.name })}</p>
        </div>
        <div class="dialog__footer">
            <button type="button" class="btn btn--primary" on:click={closeOfflineCallDialog}
                >{$LL.dialogOk()}</button
            >
        </div>
    </dialog>
{/if}

<style>
    .chat-header {
        display: grid;
        grid-template-columns: auto 1fr;
        grid-template-areas:
            'back info'
            'actions actions';
        align-items: center;
        column-gap: 0.75rem;
        row-gap: 0.85rem;
        padding: 0.75rem 1rem;
        background: var(--color-bg);
        border-bottom: 1px solid var(--color-border);
        position: sticky;
        top: 0;
        z-index: 10;
    }

    .back-button {
        grid-area: back;
        --btn-padding: 0;
        --btn-radius: 50%;
        width: 40px;
        height: 40px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .back-button :global(.back-icon-graphic) {
        width: 1.5rem;
        height: 1.5rem;
    }

    @media (min-width: 1000px) {
        .back-button.mobile-only {
            display: none;
        }

        .chat-header {
            grid-template-columns: 1fr auto;
            grid-template-areas: 'info actions';
            row-gap: 0;
            padding: 1rem;
        }
    }

    .contact-info {
        grid-area: info;
        min-width: 0;
    }

    .contact-name-container {
        display: flex;
        align-items: center;
        color: var(--color-text);
    }

    .contact-name-heading {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
    }

    .contact-name-clickable {
        --btn-padding: 0;
        --btn-bg: transparent;
        --btn-hover-bg: transparent;
        --btn-border: transparent;
        --btn-hover-border: transparent;
        --btn-color: #006de2;
        --btn-hover-color: #006de2;
        --btn-radius: 0;
        cursor: pointer;
        font: inherit;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        min-width: 0;
    }

    .contact-name-text {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    .contact-name-clickable :global(.contact-name-edit-icon) {
        flex-shrink: 0;
    }

    .online-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #28a745;
        display: inline-block;
        margin-right: 0.5rem;
    }

    .status-container {
        font-size: 0.9rem;
        color: var(--color-text-muted);
    }

    .status {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
    }

    .status :global(.status-indicator.failed) {
        color: #dc3545;
    }

    .header-actions {
        grid-area: actions;
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .header-actions .dropdown-container {
        margin-left: auto;
    }

    .call-button {
        --btn-padding: 0.5rem;
        --btn-radius: 50%;
        --btn-bg: transparent;
        --btn-hover-bg: rgba(40, 167, 69, 0.1);
        --btn-border: transparent;
        --btn-color: #28a745;
        width: 2.5rem;
        height: 2.5rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .call-button :global(.call-icon-graphic) {
        width: 1.5rem;
        height: 1.5rem;
    }

    .call-button.video-call {
        --btn-color: #006de2;
        --btn-hover-bg: rgba(0, 123, 255, 0.12);
    }

    .call-button.call-button--disabled {
        --btn-color: rgba(100, 116, 139, 0.75);
        --btn-border: rgba(148, 163, 184, 0.5);
        --btn-hover-bg: transparent;
        cursor: not-allowed;
        opacity: 0.6;
    }

    .call-button--disabled:hover {
        background: transparent;
        transform: none;
    }

    .smart-button-container {
        position: relative;
    }

    .smart-button {
        --btn-padding: 0.5rem;
        --btn-radius: 999px;
        --btn-bg: transparent;
        --btn-hover-bg: rgba(0, 123, 255, 0.1);
        --btn-border: transparent;
        --btn-color: #006de2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 2.5rem;
        min-width: 2.5rem;
        overflow: hidden;
        gap: 0.25rem;
    }

    .smart-button.offline {
        --btn-color: #006de2;
        --btn-hover-bg: rgba(0, 109, 226, 0.1);
        --btn-border: #006de2;
    }

    .smart-button.connected {
        --btn-color: #dc2626;
        --btn-hover-color: #dc2626;
        --btn-hover-bg: transparent;
        --btn-hover-border: #dc2626;
        --btn-border: #dc2626;
    }

    .smart-button.connecting {
        --btn-color: #ffc107;
        cursor: not-allowed;
    }

    @media (hover: hover) and (pointer: fine) {
        .smart-button:hover:not(:disabled) {
            padding-right: 1rem;
        }

        .smart-button:hover:not(:disabled) .button-text,
        .smart-button:focus-visible .button-text {
            opacity: 1;
            max-width: 8rem;
            margin-left: 0.35rem;
            transform: translateX(0);
        }

        .smart-button:focus-visible {
            padding-right: 1rem;
        }
    }

    .smart-button.expanded {
        padding-right: 1rem;
    }

    .smart-button.expanded .button-text {
        opacity: 1;
        max-width: 8rem;
        margin-left: 0.35rem;
        transform: translateX(0);
    }

    .smart-button:disabled {
        opacity: 0.7;
        cursor: not-allowed;
        transform: none;
    }

    .smart-button-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .smart-button-icon :global(.smart-button-icon-graphic) {
        width: 1.5rem;
        height: 1.5rem;
    }

    .smart-button .button-text {
        font-size: 0.85rem;
        font-weight: 500;
        color: currentColor;
        white-space: nowrap;
        opacity: 0;
        max-width: 0;
        margin-left: 0;
        transform: translateX(-0.25rem);
        transition:
            opacity 0.2s ease,
            transform 0.2s ease,
            max-width 0.2s ease;
        overflow: hidden;
    }

    .dropdown-container {
        position: relative;
    }

    .dropdown-toggle {
        --btn-padding: 0;
        --btn-radius: 50%;
        --btn-bg: var(--color-bg-muted);
        --btn-hover-bg: var(--color-border);
        --btn-color: var(--color-text-muted);
        --btn-border: var(--color-border);
        width: 40px;
        height: 40px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .dropdown-toggle :global(.menu-icon-graphic) {
        width: 1.25rem;
        height: 1.25rem;
    }

    .dropdown-menu {
        inset: unset;
        margin: 0;
        border: none;

        /* Anchor positioning: below the toggle, right-aligned */
        position: fixed;
        top: anchor(bottom);
        right: anchor(right);
        margin-top: 8px;
        position-try-fallbacks: --dropdown-above;

        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 0.75rem;
        padding: 0.5rem 0;
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.18);
        min-width: 220px;
        list-style: none;
        overflow: hidden;
    }

    @position-try --dropdown-above {
        top: unset;
        bottom: anchor(top);
        right: anchor(right);
        margin-top: 0;
        margin-bottom: 8px;
    }

    .dropdown-item {
        --btn-padding: 0.75rem 1.25rem;
        --btn-radius: 0;
        --btn-bg: transparent;
        --btn-hover-bg: var(--color-bg-muted);
        --btn-border: transparent;
        --btn-color: var(--color-text);
        width: 100%;
        text-align: left;
        font-size: 0.95rem;
        display: flex;
        justify-content: flex-start;
    }

    .dropdown-item.delete-item {
        --btn-color: #dc2626;
        --btn-hover-bg: rgba(220, 38, 38, 0.08);
        --btn-hover-color: #dc2626;
    }

    .call-status-indicator {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        background: var(--color-bg-muted);
        border-radius: 999px;
        padding: 0.35rem 0.75rem;
    }

    :global(.call-status-icon) {
        color: #3b82f6;
    }

    .call-status-text {
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--color-text);
    }
</style>
