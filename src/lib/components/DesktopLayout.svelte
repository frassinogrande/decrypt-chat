<script lang="ts">
    import { createEventDispatcher, tick } from 'svelte';
    import ChatList from './ChatList.svelte';
    import ChatInterface from './ChatInterface.svelte';
    import { currentChat } from '../stores/app';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { translations as LL } from '$lib/i18n/runtime';

    const dispatch = createEventDispatcher();

    let targetMessageId: string | null = null;
    let chatList: ChatList;
    let mainPanel: HTMLElement;

    const MOBILE_BREAKPOINT = 999;

    async function handleOpenChat(event: CustomEvent<{ id: string; messageId?: string }>) {
        const { id, messageId } = event.detail;
        // Always bubble event up so routing/state updates occur
        dispatch('open-chat', { id, messageId });
        // Force prop change even when clicking the same result repeatedly
        if (messageId) {
            targetMessageId = null;
            await tick();
            targetMessageId = messageId;
        } else {
            targetMessageId = null;
        }

        await focusChatPane();
    }

    /**
     * Move focus into the conversation region. Called after any deliberate activation
     * that opens a chat, so the user is not stranded on whatever they were on before.
     * Landing on the region and not the composer keeps the messages ahead of them in
     * the tab order, so a screen reader hears the conversation before the reply box.
     */
    export async function focusChatPane() {
        await tick();
        mainPanel?.focus({ preventScroll: true });
    }

    function handleAddChat() {
        dispatch('add-chat');
    }

    function handleOpenSettings() {
        dispatch('open-settings');
    }

    function handleSendMessage(event: CustomEvent<{ chatId: string; message: string }>) {
        dispatch('send-message', event.detail);
    }

    function handleDeleteChat(event: CustomEvent<{ id: string }>) {
        dispatch('delete-chat', event.detail);
    }

    async function handleGoBackFromChat() {
        dispatch('go-back-from-chat');
        await tick();
        chatList?.focusActiveRow();
    }

    function handleMainPanelKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || event.defaultPrevented || !$currentChat) return;

        // Dialogs, popovers and menus own Escape while they are open.
        const active = document.activeElement;
        if (active instanceof Element && active.closest('dialog, [popover]')) return;

        event.preventDefault();
        if (window.innerWidth <= MOBILE_BREAKPOINT) {
            // The list is off-screen here, so Escape has to bring it back first.
            void handleGoBackFromChat();
        } else {
            // Split view: the chat stays open, only focus returns to the list.
            chatList?.focusActiveRow();
        }
    }

    $: sidebarLabel = $LL.chatListHeading();
    $: mainRegionLabel = $currentChat
        ? $LL.chatInterfaceMessagesAria({ name: $currentChat.name })
        : $LL.desktopNoChatHeading();
</script>

<!-- First tab stop: lets keyboard and screen reader users jump straight past the
     header controls and list into the conversation region. Hidden until focused. -->
<a
    class="skip-link"
    href="#desktop-main-panel"
    on:click|preventDefault={() => mainPanel?.focus()}
>
    {$LL.skipToConversation()}
</a>

<div class="desktop-layout" role="presentation">
    <aside class="sidebar" aria-label={sidebarLabel}>
        <ChatList
            bind:this={chatList}
            on:open-chat={handleOpenChat}
            on:add-chat={handleAddChat}
            on:open-settings={handleOpenSettings}
        />
    </aside>

    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <section
        id="desktop-main-panel"
        class="main-panel"
        aria-label={mainRegionLabel}
        tabindex="-1"
        bind:this={mainPanel}
        on:keydown={handleMainPanelKeydown}
    >
        {#if $currentChat}
            <ChatInterface
                chat={$currentChat}
                {targetMessageId}
                on:go-back={handleGoBackFromChat}
                on:send-message={handleSendMessage}
                on:delete-chat={handleDeleteChat}
            />
        {:else}
            <!-- Not a live region: it mounts with content (announcement would be
                 unreliable and unprompted), and closing a chat already moves focus
                 back to the list row, which tells the user where they are. -->
            <div class="no-chat-selected">
                <div class="no-chat-content">
                    <div class="no-chat-icon" aria-hidden="true">
                        <Icon name="chat" size={64} className="no-chat-icon-graphic" />
                    </div>
                    <h2 id="no-chat-heading">{$LL.desktopNoChatHeading()}</h2>
                    <p>{$LL.desktopNoChatMessage()}</p>
                </div>
            </div>
        {/if}
    </section>
</div>

<style>
    .skip-link {
        position: absolute;
        left: -9999px;
        top: 0.5rem;
        z-index: 100;
        padding: 0.5rem 1rem;
        background: var(--color-surface);
        color: var(--color-accent-text);
        border: 1px solid var(--color-border-strong);
        border-radius: 6px;
        text-decoration: none;
    }

    .skip-link:focus {
        left: 0.5rem;
    }

    .desktop-layout {
        display: grid;
        grid-template-columns: 400px 1fr;
        height: 100vh;
        height: 100svh;
        background: var(--color-bg);
    }

    .sidebar {
        background: var(--color-bg);
        border-right: 1px solid var(--color-border);
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .main-panel {
        background: var(--color-bg);
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    /* The panel is a programmatic focus target when a chat is opened; only show the
       ring when the open came from the keyboard, not from a mouse click. */
    .main-panel:focus {
        outline: none;
    }

    .main-panel:focus-visible {
        outline: 2px solid #006de2;
        outline-offset: -2px;
    }

    .no-chat-selected {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        background: var(--color-surface);
    }

    .no-chat-content {
        text-align: center;
        color: var(--color-text-muted);
        max-width: 300px;
        padding: 2rem;
    }

    .no-chat-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 4rem;
        height: 4rem;
        margin: 0 auto 1rem;
        opacity: 0.5;
    }

    .no-chat-icon :global(.no-chat-icon-graphic) {
        width: 100%;
        height: 100%;
    }

    .no-chat-content h2 {
        margin: 0 0 0.5rem 0;
        color: var(--color-text);
        font-size: 1.5rem;
        font-weight: 300;
    }

    .no-chat-content p {
        margin: 0;
        font-size: 0.95rem;
        line-height: 1.4;
    }

    @media (max-width: 999px) {
        .desktop-layout {
            grid-template-columns: 1fr;
        }

        .main-panel {
            display: none;
        }

        .sidebar {
            border-right: none;
        }
    }

    :global(.mobile-chat-view) .desktop-layout .sidebar {
        display: none;
    }

    :global(.mobile-chat-view) .desktop-layout .main-panel {
        display: flex;
    }

    @media (max-width: 999px) {
        :global(.mobile-chat-view) .desktop-layout {
            grid-template-columns: 1fr;
        }
    }
</style>
