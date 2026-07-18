<script lang="ts">
    import { debug } from '$lib/utils/debug';
    import { get } from 'svelte/store';
    import { createEventDispatcher, onMount } from 'svelte';
    import { profileManager } from '../utils/profile-manager';
    import { canShare, shareResponseLink, copyToClipboard } from '../utils/web-share';
    import { browser } from '$app/environment';
    import { chatsStore } from '../stores/app';
    import type { UserProfile } from '../types';
    import { buildShareCode } from '../utils/share-link';
    import { generateUUID } from '$lib/utils/crypto';
    import { resolveAppLabel } from '$lib/config/contact-apps';
    import { translations as LL } from '$lib/i18n/runtime';
    import Icon from '$lib/components/icons/Icon.svelte';

    const dispatch = createEventDispatcher();

    let dialogRef: HTMLDialogElement;

    export let chatId: string | null = null;

    $: chat = chatId ? $chatsStore.find((c) => c.id === chatId) : null;
    $: chatName = chat?.name || $LL.profileShareContactFallback();

    let selectedChatId: string | null = chatId;
    $: selectedChat = selectedChatId ? $chatsStore.find((c) => c.id === selectedChatId) : null;
    $: selectedChatName = selectedChat?.name || $LL.profileShareContactFallback();

    let shareableData: string | null = null;
    let shareUrl = '';
    let isLoading = false;
    let error = '';
    let copySuccess = false;

    let showChatSelection = !chatId;
    let showSelection = false;
    let showShareDialog = false;
    type ShareableProfile = Pick<UserProfile, 'contacts' | 'createdAt'>;
    let userProfile: ShareableProfile | null = null;
    // One checkbox per saved contact method; all included by default.
    let selectedContacts: boolean[] = [];

    onMount(async () => {
        try {
            if (!browser || typeof window === 'undefined') {
                error = get(LL).profileShareErrorUnavailable();
                return;
            }

            await loadProfileData();

            if (chatId) {
                selectedChatId = chatId;
                showChatSelection = false;
                showSelection = true;
            }
        } catch (err) {
            error = get(LL).profileShareErrorLoadFailed();
            debug.error('Profile share error:', err);
        }

        if (dialogRef && !dialogRef.open) {
            dialogRef.showModal();
        }
    });

    async function loadProfileData() {
        const profileData = await profileManager.getShareableProfile();

        if (profileData) {
            userProfile = profileData;

            selectedContacts = (userProfile.contacts ?? []).map(() => true);
        } else {
            throw new Error('Failed to load your profile data');
        }
    }

    function handleClose(event?: Event) {
        event?.preventDefault();
        dialogRef?.close();
        dispatch('close');
    }

    async function generateShareUrl() {
        try {
            if (!userProfile || !window.secureChatStorage) {
                throw new Error('Profile data or secure storage not available');
            }

            if (!selectedChatId) {
                throw new Error('No chat selected for sharing');
            }

            const filteredProfileData = {
                contacts: (userProfile.contacts ?? []).filter((_, i) => selectedContacts[i]),
                createdAt: userProfile.createdAt,
            };

            // Create a profile message using the secure messaging system. uuid lets the
            // receive path replay-protect this the same way it does a message, so an old
            // share can't be re-pasted to silently revert a contact's saved details.
            const profileMessage = JSON.stringify({
                magic: 'trusted-chat',
                type: 'profile-share',
                profileData: filteredProfileData,
                uuid: generateUUID(),
                timestamp: Date.now(),
            });

            const encodedPayload = await window.secureChatStorage.createSharePayload(
                selectedChatId,
                profileMessage,
                selectedChatName
            );

            shareUrl = buildShareCode(`#secure=${encodedPayload}`);

            shareableData = encodedPayload;

            return true;
        } catch (err) {
            debug.error('Failed to generate share URL:', err);
            return false;
        }
    }

    async function handleContinue() {
        isLoading = true;
        error = '';

        const success = await generateShareUrl();

        if (success) {
            showSelection = false;
            showShareDialog = true;
        } else {
            error = get(LL).profileShareErrorCreateFailed();
        }

        isLoading = false;
    }

    function handleBack() {
        showShareDialog = false;
        showSelection = true;
        shareUrl = '';
        shareableData = null;
    }

    function handleChatSelected(selectedId: string) {
        selectedChatId = selectedId;
        showChatSelection = false;
        showSelection = true;
        error = '';
    }

    function handleBackToChatSelection() {
        showSelection = false;
        showChatSelection = true;
        selectedChatId = chatId;
        error = '';
    }

    function selectText(event: Event) {
        const target = event.target as HTMLInputElement;
        if (target) {
            target.select();
        }
    }

    async function handleCopyLink() {
        // Guard double-copy instead of disabling the button, so focus is not
        // dropped to <body> while the success state shows.
        if (copySuccess) return;
        const result = await copyToClipboard(shareUrl);
        if (result) {
            copySuccess = true;
            setTimeout(() => (copySuccess = false), 2000);
        }
    }

    async function handleWebShare() {
        if (canShare()) {
            try {
                await shareResponseLink(shareUrl, 'My Profile');
                dispatch('shared');
            } catch (err) {
                debug.error('Web share failed:', err);
                handleCopyLink();
            }
        }
    }

    function handleDialogCancel(event: Event) {
        event.preventDefault();
        handleClose(event);
    }

    function handleDialogPointerDown(event: PointerEvent) {
        if (event.target === dialogRef) {
            handleClose(event);
        }
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    aria-labelledby="share-dialog-title"
    aria-describedby="share-dialog-description"
    on:cancel|preventDefault={handleDialogCancel}
    on:pointerdown={handleDialogPointerDown}
    aria-modal="true"
>
    <div class="dialog__header">
        <h2 id="share-dialog-title" class="dialog__title">{$LL.profileShareTitle()}</h2>
        <button
            type="button"
            class="btn btn--secondary"
            data-modal-close
            on:click={handleClose}
            aria-label={$LL.profileShareCloseAria()}>×</button
        >
    </div>

    <div class="dialog__body">
        {#if error}
            <div class="error-state">
                <p role="alert">{error}</p>
                <button
                    type="button"
                    class="btn btn--secondary"
                    on:click={() => window.location.reload()}
                >
                    {$LL.profileShareTryAgain()}
                </button>
            </div>
        {:else if showChatSelection}
            <div class="chat-selection-content">
                <div class="selection-info">
                    <h3>{$LL.profileShareChooseContactHeading()}</h3>
                    <p id="share-dialog-description">
                        {$LL.profileShareChooseContactDescription()}
                    </p>
                </div>

                <div class="chat-list">
                    {#each $chatsStore as chat (chat.id)}
                        <button
                            type="button"
                            class="btn btn--secondary"
                            on:click={() => handleChatSelected(chat.id)}
                        >
                            <div class="chat-avatar">
                                {chat.name.charAt(0).toUpperCase()}
                            </div>
                            <div class="chat-info">
                                <div class="chat-name">{chat.name}</div>
                            </div>
                        </button>
                    {/each}

                    {#if $chatsStore.length === 0}
                        <div class="no-chats">
                            <div class="no-chats-icon">
                                <Icon name="chat" size={56} className="no-chats-icon-graphic" />
                            </div>
                            <p>{$LL.profileShareNoContacts()}</p>
                            <small>{$LL.profileShareNoContactsHint()}</small>
                        </div>
                    {/if}
                </div>

                <div class="selection-actions">
                    <button type="button" class="btn btn--secondary" on:click={handleClose}>
                        {$LL.profileSetupCancel()}
                    </button>
                </div>
            </div>
        {:else if showSelection}
            <div class="selection-content">
                <div class="selection-info">
                    <p id="share-dialog-description">
                        {$LL.profileShareSelectionDescription({ name: selectedChatName })}
                    </p>
                </div>

                <div class="selection-options">
                    {#if userProfile?.contacts && userProfile.contacts.length > 0}
                        {#each userProfile.contacts as contact, i}
                            <label class="checkbox-item">
                                <span class="checkbox-heading">
                                    <input type="checkbox" bind:checked={selectedContacts[i]} />
                                    <span class="checkbox-label"
                                        >{resolveAppLabel(contact, $LL)}</span
                                    >
                                </span>
                                <span class="checkbox-value">{contact.value}</span>
                            </label>
                        {/each}
                    {:else}
                        <p class="no-contacts">{$LL.profileShareNothingToShare()}</p>
                    {/if}
                </div>

                <div class="selection-actions">
                    {#if !chatId}
                        <button
                            type="button"
                            class="btn btn--secondary"
                            on:click={handleBackToChatSelection}
                        >
                            {$LL.profileShareBackToContacts()}
                        </button>
                    {:else}
                        <button type="button" class="btn btn--secondary" on:click={handleClose}>
                            {$LL.profileSetupCancel()}
                        </button>
                    {/if}
                    <button
                        type="button"
                        class="btn btn--primary"
                        on:click={handleContinue}
                        disabled={isLoading || !selectedContacts.some(Boolean)}
                    >
                        {#if isLoading}
                            {$LL.profileShareCreatingCode()}
                        {:else}
                            {$LL.profileShareContinue()}
                        {/if}
                    </button>
                </div>
            </div>
        {:else if showShareDialog}
            <div class="share-success">
                <div class="share-info">
                    <p id="share-dialog-description">
                        {$LL.profileShareCodeDescription({ name: selectedChatName })}
                    </p>
                </div>

                <div class="link-section">
                    <div class="link-container">
                        <input
                            type="text"
                            value={shareUrl}
                            readonly
                            class="input"
                            aria-label={$LL.a11yShareCode()}
                            aria-describedby="share-dialog-description"
                            on:click={selectText}
                        />
                        <button
                            type="button"
                            class="btn btn--secondary"
                            on:click={handleCopyLink}
                            class:copied={copySuccess}
                        >
                            {#if copySuccess}
                                {$LL.profileShareCopied()}
                            {:else}
                                {$LL.chatSetupCopySecondary()}
                            {/if}
                        </button>
                    </div>
                    <span class="sr-only" aria-live="polite"
                        >{copySuccess ? $LL.toastCopiedCodeToClipboard() : ''}</span
                    >
                </div>

                <div class="back-section">
                    <button type="button" class="btn btn--secondary" on:click={handleBack}>
                        {$LL.profileShareBackToSelection()}
                    </button>
                </div>
            </div>
        {/if}
    </div>
</dialog>

<style>
    .error-state {
        text-align: center;
        padding: 2rem 0;
    }

    .error-state :global(.btn) {
        margin-top: 1rem;
    }

    .share-info {
        text-align: center;
        margin-bottom: 2rem;
    }

    .share-info p {
        color: var(--color-text-muted);
        line-height: 1.5;
        margin: 0;
    }

    .link-section {
        margin-bottom: 2rem;
    }

    .link-container {
        display: flex;
        gap: 0.5rem;
    }

    .link-container :global(.btn) {
        font-size: 0.9rem;
        white-space: nowrap;
    }

    .link-container :global(.btn).copied {
        --btn-bg: #10b981;
        --btn-border: #10b981;
    }

    .chat-selection-content {
        padding: 1rem 0;
    }

    .chat-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-bottom: 2rem;
        max-height: 300px;
        overflow-y: auto;
    }

    .chat-list :global(.btn) {
        --btn-padding: 1rem;
        --btn-radius: 12px;
        --btn-bg: var(--color-bg-subtle);
        --btn-hover-bg: color-mix(in srgb, var(--color-accent-text) 8%, var(--color-bg));
        --btn-border: var(--color-border);
        --btn-color: var(--color-text);
        display: flex;
        align-items: center;
        gap: 1rem;
        width: 100%;
        text-align: left;
    }

    .chat-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #006de2;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 1.1rem;
        flex-shrink: 0;
    }

    .chat-info {
        flex: 1;
    }

    .chat-name {
        font-weight: 600;
        color: var(--color-text);
        margin-bottom: 0.25rem;
    }

    .no-chats {
        text-align: center;
        padding: 2rem;
        color: var(--color-text-muted);
    }

    .no-chats-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 3.5rem;
        height: 3.5rem;
        margin-bottom: 1rem;
        opacity: 0.5;
    }

    .no-chats-icon :global(.no-chats-icon-graphic) {
        width: 100%;
        height: 100%;
    }

    .no-chats p {
        font-weight: 500;
        margin-bottom: 0.5rem;
    }

    .no-chats small {
        font-size: 0.8rem;
        color: var(--color-text-subtle);
    }

    .selection-content {
        padding: 1rem 0;
    }

    .selection-info {
        text-align: center;
        margin-bottom: 2rem;
    }

    .selection-info p {
        color: var(--color-text-muted);
        line-height: 1.5;
        margin: 0;
    }

    .selection-options {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        margin-bottom: 2rem;
    }

    .no-contacts {
        color: var(--color-text-muted);
        font-size: 0.95rem;
        margin: 0;
    }

    .checkbox-item {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
        border: 2px solid var(--color-border);
        border-radius: 12px;
        background: var(--color-bg-subtle);
        cursor: pointer;
        transition: all 0.2s;
    }

    .checkbox-heading {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .checkbox-item:hover:not(:has(input:disabled)) {
        border-color: var(--color-accent-text);
        background: color-mix(in srgb, var(--color-accent-text) 8%, var(--color-bg));
    }

    .checkbox-item:has(input:checked) {
        border-color: var(--color-accent-text);
        background: color-mix(in srgb, var(--color-accent-text) 8%, var(--color-bg));
    }

    .checkbox-item:has(input:disabled) {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .checkbox-item input[type='checkbox'] {
        margin-top: 0;
    }

    .checkbox-label {
        font-weight: 600;
        color: var(--color-text);
    }

    .checkbox-value {
        color: var(--color-text-muted);
        font-family: monospace;
        background: var(--color-bg);
        padding: 0.5rem;
        border-radius: 6px;
        border: 1px solid var(--color-border);
        word-break: break-word;
    }

    .selection-actions {
        display: flex;
        gap: 1rem;
        justify-content: flex-end;
    }

    .selection-actions :global(.btn.btn--primary:disabled) {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .back-section {
        text-align: center;
        margin-bottom: 2rem;
    }

    .back-section :global(.btn) {
        --btn-padding: 0.35rem 0.75rem;
        --btn-radius: 999px;
        --btn-bg: transparent;
        --btn-hover-bg: color-mix(in srgb, var(--color-accent-text) 12%, transparent);
        --btn-border: transparent;
        --btn-color: var(--color-accent-text);
        font-size: 0.9rem;
        text-decoration: underline;
    }

    @media (max-width: 600px) {
        .link-container {
            flex-direction: column;
            gap: 0.75rem;
        }

        .link-container :global(.btn) {
            width: 100%;
        }

        .selection-actions {
            flex-direction: column;
        }

        .selection-actions :global(.btn) {
            width: 100%;
        }

        .checkbox-item {
            flex-direction: column;
            align-items: stretch;
            text-align: left;
        }

        .checkbox-label {
            min-width: unset;
        }

        .chat-list {
            max-height: 250px;
        }

        .chat-list :global(.btn) {
            padding: 0.75rem;
        }

        .chat-avatar {
            width: 35px;
            height: 35px;
            font-size: 1rem;
        }

        .chat-name {
            font-size: 0.9rem;
        }

        .no-chats {
            padding: 1.5rem;
        }

        .no-chats-icon {
            width: 3rem;
            height: 3rem;
        }
    }
</style>
