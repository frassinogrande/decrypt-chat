<script lang="ts">
    import { debug } from '$lib/utils/debug';
    import { createEventDispatcher, onMount, onDestroy } from 'svelte';
    import { sortedChats, appStore } from '../stores/app';
    import { profileManager } from '../utils/profile-manager';
    import { chatStorage } from '../utils/chat-storage';
    import { messageSearch } from '../utils/message-search';
    import type { Chat, StoredMessage } from '../types';
    import { createTrustedHTML } from '../utils/safe-html';
    import type { TrustedHTML } from '../utils/safe-html';
    import { stripInlineMarkdown } from '../utils/inline-markdown';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { get } from 'svelte/store';
    import { translations as LL, locale } from '$lib/i18n/runtime';
    import { callEventLabel } from '$lib/utils/call-event-label';

    const dispatch = createEventDispatcher();
    const instanceId = Math.random().toString(36).slice(2, 8);
    const headingId = `chat-list-heading-${instanceId}`;
    const searchId = `chat-list-search-${instanceId}`;

    let isLoading = true;

    let searchQuery: string = '';
    let searchInput: HTMLInputElement;

    function clearSearch() {
        searchQuery = '';
        searchInput?.focus();
    }

    let hideMessages = false;
    let showInstantLock = false;
    let isSessionUnlocked = false;

    // Newest message per chat for previews (null = confirmed empty, undefined = not fetched)
    let chatLastMessages: Record<string, StoredMessage | null> = {};
    // Memo of the lastActivity value each preview was fetched at, so the reactive
    // trigger below cannot loop (fetch -> store update -> emission -> fetch).
    const previewMemo = new Map<string, number>();
    let chatPreviews: Record<string, string> = {};
    let filteredChats: Chat[] = [];
    let searchMatches: Record<string, { id: string; snippet: string; timestamp: number }[]> = {};
    // The query searchMatches was produced for; anything else makes them stale.
    let matchesQuery = '';
    let searchPending = false;
    let searchDebounce: ReturnType<typeof setTimeout> | null = null;

    let currentLL = get(LL);
    $: currentLL = $LL;

    // Ensure status updates reactively when peer connection state changes
    $: _peerConnectionsRef = $appStore.peerConnections;

    // Wait for chats to load before showing empty state
    $: if ($sortedChats.length > 0) {
        isLoading = false;
    }

    // Also stop loading after a short delay even if no chats
    let hasInitialized = false;
    onMount(() => {
        setTimeout(() => {
            isLoading = false;
        }, 100);

        const unsubscribeSettings = profileManager.settings.subscribe((settings) => {
            hideMessages = settings?.hideMessagesOnHomepage || false;
            showInstantLock = settings?.showInstantLockButton || false;
        });

        const unsubscribeLockState = profileManager.lockState.subscribe((lockState) => {
            const wasLocked = isSessionUnlocked === false;
            isSessionUnlocked = !lockState.isLocked;

            if (wasLocked && isSessionUnlocked && $sortedChats.length > 0) {
                // ProfileManager now ensures SecureKeyManager is ready before setting isLocked: false
                previewMemo.clear();
                void refreshPreviews($sortedChats);
            }
        });

        // Mark as initialized immediately since ProfileManager now handles timing properly
        hasInitialized = true;

        return () => {
            unsubscribeSettings();
            unsubscribeLockState();
        };
    });

    onDestroy(() => {
        if (searchDebounce) {
            clearTimeout(searchDebounce);
        }
    });

    function openChat(conversation: Chat) {
        dispatch('open-chat', { id: conversation.id });
    }

    function addNewChat() {
        dispatch('add-chat');
    }

    function openSettings() {
        dispatch('open-settings');
    }

    function formatLastActivity(timestamp: number): string {
        const ll = currentLL;
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        const diffDays = diffHours / 24;

        if (diffHours < 1) {
            return ll.chatListTimeJustNow();
        } else if (diffHours < 24) {
            return ll.chatListTimeHoursAgo({ hours: Math.floor(diffHours) });
        } else if (diffDays < 7) {
            return ll.chatListTimeDaysAgo({ days: Math.floor(diffDays) });
        } else {
            return date.toLocaleDateString();
        }
    }

    // Long-form counterpart of formatLastActivity for accessible names: the visible
    // strings are deliberately compact ("3d ago"), which a screen reader speaks as
    // "3 d". Intl.RelativeTimeFormat produces a fully spoken, correctly pluralized
    // form in every supported locale, so no extra i18n keys are needed. The branching
    // must mirror formatLastActivity so the spoken and visible values always agree.
    function formatLastActivitySpoken(timestamp: number, localeTag: string): string {
        const diffMs = Date.now() - timestamp;
        const diffHours = diffMs / (1000 * 60 * 60);
        const diffDays = diffHours / 24;

        if (diffHours < 1) {
            return currentLL.chatListTimeJustNow();
        }
        const rtf = new Intl.RelativeTimeFormat(localeTag, { numeric: 'auto', style: 'long' });
        if (diffHours < 24) {
            return rtf.format(-Math.floor(diffHours), 'hour');
        } else if (diffDays < 7) {
            return rtf.format(-Math.floor(diffDays), 'day');
        }
        return new Date(timestamp).toLocaleDateString(localeTag);
    }

    function formatTimestamp(ts: number): string {
        const d = new Date(ts);
        return d.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    // Spoken counterpart for aria-labels: abbreviated months can read literally.
    function formatTimestampSpoken(ts: number): string {
        const d = new Date(ts);
        return d.toLocaleString([], {
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    $: {
        // Trigger reactivity on chatLastMessages, locale, or sortedChats change
        const _ = chatLastMessages;
        const ll = currentLL;
        chatPreviews = $sortedChats.reduce(
            (previews, chat) => {
                previews[chat.id] = getLastMessage(chat, ll);
                return previews;
            },
            {} as Record<string, string>
        );
    }

    // Escape HTML entities to avoid injection when using {@html}
    function escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function highlightMatch(text: string, query: string): string | TrustedHTML {
        if (!query) return createTrustedHTML(escapeHtml(text));
        const q = query.toLowerCase();
        const lower = text.toLowerCase();
        let i = 0;
        let result = '';
        // eslint-disable-next-line no-constant-condition -- scan loop terminates via the break when no further match is found
        while (true) {
            const idx = lower.indexOf(q, i);
            if (idx === -1) {
                result += escapeHtml(text.slice(i));
                break;
            }
            result += escapeHtml(text.slice(i, idx));
            result += `<mark class="highlight">${escapeHtml(text.slice(idx, idx + q.length))}</mark>`;
            i = idx + q.length;
        }
        return createTrustedHTML(result);
    }

    // Matches belong to the query that produced them, so staleness is derived rather
    // than cleared imperatively. A `$:` statement cannot clear searchMatches for us:
    // it would do so from inside onQueryChanged(), a write the compiler cannot see
    // when it orders reactive statements, so filteredChats would still run first on
    // the stale map and would not re-run until the next invalidation. That is what
    // held non-matching chats in the list until the debounce fired.
    //
    // hideMessages is deliberately not consulted here: it hides the idle preview from
    // passers-by, but a search the user just typed should still find and show its hits.
    $: activeMatches =
        matchesQuery === searchQuery.trim() ? searchMatches : ({} as typeof searchMatches);

    // Preview text a query is allowed to match. chatPreviews holds display strings,
    // which for an empty or hidden chat is a placeholder ("No messages yet"), and
    // matching those would list every chat for a query like "no" or "tap".
    $: searchablePreviews = (() => {
        const ll = currentLL;
        const placeholders = new Set([ll.chatListPreviewTap(), ll.chatListPreviewNoMessages()]);
        const searchable: Record<string, string> = {};
        for (const chat of $sortedChats) {
            const preview = chatPreviews[chat.id];
            searchable[chat.id] =
                !preview || placeholders.has(preview) ? '' : preview.toLowerCase();
        }
        return searchable;
    })();

    $: filteredChats = (() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return $sortedChats;
        return $sortedChats.filter((chat) => {
            const name = chat.name.toLowerCase();
            const preview = searchablePreviews[chat.id] ?? '';
            const hasMessageMatches = !!activeMatches[chat.id]?.length;
            return hasMessageMatches || name.includes(q) || preview.includes(q);
        });
    })();

    // Refresh previews when chats change or their lastActivity moves. Only the newest
    // message of each chat is read and decrypted; full histories stay in IndexedDB.
    $: if ($sortedChats.length > 0 && hasInitialized && isSessionUnlocked) {
        void refreshPreviews($sortedChats);
    }

    async function refreshPreviews(chats: Chat[]) {
        const fetched: Record<string, StoredMessage | null> = {};

        for (const chat of chats) {
            if (previewMemo.get(chat.id) === chat.lastActivity) {
                continue;
            }
            previewMemo.set(chat.id, chat.lastActivity);
            try {
                const latest = await chatStorage.getLatestMessageDecrypted(chat.id);
                // A locked body is transient (keys may still be loading during
                // startup); forget the memo so a later emission retries instead of
                // latching the placeholder until the next chat activity.
                if (latest?.body === '[Encrypted message - session locked]') {
                    previewMemo.delete(chat.id);
                }
                fetched[chat.id] = latest;
            } catch (error) {
                debug.warn(`Failed to load preview for chat ${chat.id}:`, error);
                previewMemo.delete(chat.id);
            }
        }

        if (Object.keys(fetched).length > 0) {
            // Merge this run's results onto the CURRENT map. Runs can overlap (the
            // reactive trigger fires on every chats-store emission); merging a stale
            // snapshot instead would drop entries a concurrent run just wrote.
            chatLastMessages = { ...chatLastMessages, ...fetched };
        }
    }

    function getLastMessage(conversation: Chat, ll = currentLL): string {
        if (hideMessages) {
            return ll.chatListPreviewTap();
        }

        // null = storage confirmed empty; undefined = preview not fetched yet
        const lastMessage = chatLastMessages[conversation.id];
        if (lastMessage === null) {
            return ll.chatListPreviewNoMessages();
        }

        if (!lastMessage) {
            return ll.chatListPreviewTap();
        }

        // Call event records carry no body; show their label.
        if (lastMessage.callEvent) {
            return callEventLabel(lastMessage.callEvent, ll, $locale || 'en');
        }

        const body = lastMessage.body;

        if (body && body.includes('[Encrypted message - session locked]')) {
            return ll.chatListPreviewTap();
        }

        if (!body || body.trim() === '') {
            return ll.chatListPreviewTap();
        }

        // Hide generic encrypted/unavailable placeholders
        if (body === '[Encrypted]' || body === '[Message content unavailable]') {
            return ll.chatListPreviewTap();
        }

        // Strip inline-markdown markers so the preview reads "hello", not "**hello**".
        const plain = stripInlineMarkdown(body);

        const words = plain.split(' ');
        if (words.length > 5) {
            return words.slice(0, 5).join(' ') + '...';
        }

        return plain;
    }

    function getMessageSnippet(rawBody: string, query: string, maxWords = 12): string {
        // Strip markdown markers so search snippets read cleanly; the query (plain
        // text) still resolves in the stripped snippet, so highlighting is unaffected.
        const body = stripInlineMarkdown(rawBody);
        const words = body.split(/\s+/);
        if (!query) {
            return words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '...' : '');
        }
        const lowerBody = body.toLowerCase();
        const idx = lowerBody.indexOf(query.toLowerCase());
        if (idx === -1) {
            return words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '...' : '');
        }
        const prefix = body.slice(0, idx);
        const startWords = prefix.trim().split(/\s+/);
        const start = Math.max(0, startWords.length - Math.floor(maxWords / 2));
        const allWords = body.trim().split(/\s+/);
        const snippet = allWords.slice(start, start + maxWords).join(' ');
        return (
            (start > 0 ? '...' : '') + snippet + (start + maxWords < allWords.length ? '...' : '')
        );
    }

    // On-demand message search: histories are read from IndexedDB and decrypted only
    // when a query is typed, so old messages beyond any loaded page are still found.
    $: onQueryChanged(searchQuery);

    function onQueryChanged(query: string) {
        if (searchDebounce) {
            clearTimeout(searchDebounce);
            searchDebounce = null;
        }

        const trimmed = query.trim();
        if (!trimmed) {
            searchPending = false;
            return;
        }

        searchPending = true;
        searchDebounce = setTimeout(() => {
            searchDebounce = null;
            void runSearch(trimmed);
        }, 250);
    }

    async function runSearch(query: string) {
        searchPending = true;
        const next: Record<string, { id: string; snippet: string; timestamp: number }[]> = {};
        try {
            await messageSearch.search(
                $sortedChats.map((chat) => chat.id),
                query,
                (chatId, matches) => {
                    if (searchQuery.trim() !== query) {
                        return; // superseded by a newer query
                    }
                    next[chatId] = matches.map((match) => ({
                        id: match.id,
                        snippet: getMessageSnippet(match.body, query),
                        timestamp: match.timestamp,
                    }));
                    // Stream results per chat as they arrive
                    searchMatches = { ...next };
                    matchesQuery = query;
                }
            );
        } catch (error) {
            debug.warn('Message search failed:', error);
        }
        if (searchQuery.trim() === query) {
            searchMatches = { ...next };
            matchesQuery = query;
            searchPending = false;
        }
    }

    function openChatAtMessage(conversation: Chat, messageId: string) {
        dispatch('open-chat', { id: conversation.id, messageId });
    }

    // The conversation list is a single tab stop: Tab moves between the list and
    // the chat pane, arrow keys move within the list (roving tabindex). Rows are
    // the conversations plus any search matches rendered under them, in DOM order.
    let listEl: HTMLElement | undefined;
    let rovingId: string | null = null;

    $: navIds = filteredChats.flatMap((chat) => [
        chat.id,
        ...(activeMatches[chat.id] ?? []).map((match) => `${chat.id}:${match.id}`),
    ]);

    // A roving target that stopped rendering (search narrowed, chat deleted) would
    // leave the list with no tabbable row at all.
    $: if (rovingId && !navIds.includes(rovingId)) {
        rovingId = null;
    }

    // Opening, creating or switching a chat makes it current, and the list's tabbable
    // row should follow so Shift-Tab out of the pane returns to that chat, not to
    // wherever the roving cursor was parked before. Cleared (not set to the id) so the
    // derivation below owns the value. Guarded on an actual change of currentChatId:
    // the appStore emits for unrelated reasons (peer state), and wiping rovingId on
    // those would yank the cursor mid arrow-key browse.
    let lastCurrentChatId = $appStore.currentChatId;
    $: if ($appStore.currentChatId !== lastCurrentChatId) {
        lastCurrentChatId = $appStore.currentChatId;
        rovingId = null;
    }

    $: activeNavId =
        rovingId ??
        ($appStore.currentChatId && navIds.includes($appStore.currentChatId)
            ? $appStore.currentChatId
            : (navIds[0] ?? null));

    function navRows(): HTMLElement[] {
        return Array.from(listEl?.querySelectorAll<HTMLElement>('[data-nav-row]') ?? []);
    }

    /** Called by the parent to bring focus back to the list from the chat pane. */
    export function focusActiveRow() {
        const rows = navRows();
        const target = rows.find((row) => row.dataset.navRow === activeNavId) ?? rows[0];
        target?.focus();
    }

    function handleListKeydown(event: KeyboardEvent) {
        const rows = navRows();
        if (rows.length === 0) return;

        const index = rows.indexOf(document.activeElement as HTMLElement);
        let next: number;
        switch (event.key) {
            case 'ArrowDown':
                next = index < 0 ? 0 : Math.min(index + 1, rows.length - 1);
                break;
            case 'ArrowUp':
                next = index < 0 ? 0 : Math.max(index - 1, 0);
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = rows.length - 1;
                break;
            default:
                return;
        }

        event.preventDefault();
        rows[next]?.focus();
    }

    // Spoken search feedback: "Searching" while pending, then the result count.
    // Empty when no query, so idle typing in an empty field stays silent.
    $: searchAnnouncement = !searchQuery.trim()
        ? ''
        : searchPending
          ? currentLL.chatListSearching()
          : currentLL.chatListSearchResults({ count: filteredChats.length });

    let chatStatuses: Map<string, string> = new Map();
    $: chatStatuses = (() => {
        const ll = currentLL;
        const pc = $appStore.peerConnections;
        return new Map(
            $sortedChats.map((c) => {
                const state = pc.get(c.id)?.state;
                const text =
                    state === 'connected'
                        ? ll.chatListStatusOnline()
                        : state === 'connecting'
                          ? ll.chatListStatusConnecting()
                          : state === 'failed'
                            ? ll.chatListStatusFailed()
                            : ll.chatListStatusOffline();
                return [c.id, text] as const;
            })
        );
    })();

    // Curated accessible name per row. The button's visual content reads badly when
    // flattened by a screen reader ("Alice, just now, tap to view messages, offline"),
    // so each row gets an explicit aria-label: name first (label-in-name), then the
    // preview only when it is a real message (the "tap to view" placeholder is a
    // sighted-user affordance), then the time, then the status only when it is
    // notable (offline is the default state of every chat and would be pure noise).
    // All parts are already localized, so the label is a plain comma join.
    let rowLabels: Map<string, string> = new Map();
    $: rowLabels = (() => {
        const ll = currentLL;
        const placeholders = new Set([ll.chatListPreviewTap(), ll.chatListPreviewNoMessages()]);
        return new Map(
            $sortedChats.map((c) => {
                const parts = [c.name];
                const preview = chatPreviews[c.id];
                if (preview && !placeholders.has(preview)) {
                    parts.push(preview);
                }
                parts.push(formatLastActivitySpoken(c.lastActivity, $locale));
                const status = chatStatuses.get(c.id);
                if (status && status !== ll.chatListStatusOffline()) {
                    parts.push(status);
                }
                return [c.id, parts.join(', ')] as const;
            })
        );
    })();
</script>

<nav class="chats-container" aria-labelledby={headingId}>
    <header class="chats-header">
        <h1 id={headingId}>{$LL.chatListHeading()}</h1>
        <div class="header-actions">
            <button
                type="button"
                class="btn btn--secondary btn--icon settings-button"
                on:click={openSettings}
                title={$LL.chatListSettingsAria()}
                aria-label={$LL.chatListSettingsAria()}
            >
                <Icon name="cog" size={20} className="settings-icon" />
            </button>
            {#if showInstantLock}
                <button
                    type="button"
                    class="btn btn--icon instant-lock-button"
                    on:click={() => void profileManager.lockProfile()}
                    title={$LL.chatListInstantLockAria()}
                    aria-label={$LL.chatListInstantLockAria()}
                >
                    <Icon name="padlock" size={20} className="instant-lock-icon" />
                </button>
            {/if}
            <button
                type="button"
                class="btn btn--primary add-button"
                on:click={addNewChat}
                title={$LL.chatListAddChatAria()}
                aria-label={$LL.chatListAddChatAria()}
            >
                +
            </button>
        </div>
    </header>

    <div class="chats-list" aria-busy={isLoading}>
        <div class="search-container">
            <!-- type=text, not type=search: Chrome renders its own clear button for
                 type=search, which would sit on top of the custom one below. -->
            <input
                type="text"
                id={searchId}
                name="chat-search"
                class="input"
                autocomplete="off"
                placeholder={$LL.chatListSearchPlaceholder()}
                bind:value={searchQuery}
                bind:this={searchInput}
                aria-label={$LL.chatListSearchAria()}
            />
            {#if searchQuery}
                <button
                    type="button"
                    class="btn btn--secondary clear-button"
                    data-modal-close
                    title={$LL.chatListClearSearch()}
                    aria-label={$LL.chatListClearSearch()}
                    on:mousedown|preventDefault
                    on:click={clearSearch}
                >
                    ×
                </button>
            {/if}
        </div>

        <!-- Permanently mounted so text changes announce reliably; a live region
             created together with its content is frequently skipped by VoiceOver.
             Also announces the result count, which the visual list conveys only
             by its length. -->
        <div class="sr-only" role="status">{searchAnnouncement}</div>
        {#if searchQuery && searchPending}
            <div class="search-pending">{$LL.chatListSearching()}</div>
        {/if}

        {#if isLoading}
            <div class="loading-state">
                <div class="loading-spinner"></div>
                <p>{$LL.chatListLoading()}</p>
            </div>
        {:else if $sortedChats.length === 0}
            <div class="empty-state">
                <div class="empty-icon">
                    <Icon name="chat" size={64} className="empty-icon-graphic" />
                </div>
                <p>{$LL.chatListEmpty()}</p>
                <button type="button" class="btn btn--primary empty-action" on:click={addNewChat}>
                    {$LL.chatListAddFirstButton()}
                </button>
            </div>
            <!-- Suppressed while a search is in flight, so the "no matches" state cannot
                 flash on every keystroke before the message matches arrive. -->
        {:else if filteredChats.length === 0 && !searchPending}
            <div class="empty-state">
                <p>{$LL.chatListNoMatches({ query: searchQuery })}</p>
            </div>
        {:else}
            <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
            <ul class="conversation-list" bind:this={listEl} on:keydown={handleListKeydown}>
                {#each filteredChats as conversation (conversation.id)}
                    {@const matches = activeMatches[conversation.id] ?? []}
                    <li
                        class="conversation-item"
                        class:active={$appStore.currentChatId === conversation.id}
                    >
                        <button
                            type="button"
                            class="btn btn--secondary conversation-button"
                            data-nav-row={conversation.id}
                            tabindex={activeNavId === conversation.id ? 0 : -1}
                            on:focus={() => (rovingId = conversation.id)}
                            on:click={() => openChat(conversation)}
                            aria-current={$appStore.currentChatId === conversation.id
                                ? 'page'
                                : undefined}
                            aria-label={rowLabels.get(conversation.id) ?? conversation.name}
                        >
                            <!-- The button is named by its aria-label; hiding the visual
                                 content stops screen readers that voice both name and
                                 contents from reading the compact strings a second time. -->
                            <span class="conversation-content" aria-hidden="true">
                                <span class="conversation-header">
                                    <span class="conversation-name">
                                        {#if searchQuery}
                                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- highlightMatch HTML-escapes all text and returns TrustedHTML; only the <mark> wrapper is markup -->
                                            {@html highlightMatch(conversation.name, searchQuery)}
                                        {:else}
                                            {conversation.name}
                                        {/if}
                                    </span>
                                    <span class="last-activity">
                                        {formatLastActivity(conversation.lastActivity)}
                                    </span>
                                </span>
                                {#if !matches.length}
                                    <span class="conversation-preview">
                                        {#if searchQuery && !hideMessages}
                                            <span class="last-message">
                                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- highlightMatch HTML-escapes all text and returns TrustedHTML; only the <mark> wrapper is markup -->
                                                {@html highlightMatch(
                                                    chatPreviews[conversation.id] ||
                                                        $LL.chatListPreviewTap(),
                                                    searchQuery
                                                )}
                                            </span>
                                        {:else}
                                            <span class="last-message"
                                                >{chatPreviews[conversation.id] ||
                                                    $LL.chatListPreviewTap()}</span
                                            >
                                        {/if}
                                        {#if !searchQuery}
                                            <span
                                                class="conversation-status"
                                                class:online={chatStatuses.get(conversation.id) ===
                                                    $LL.chatListStatusOnline()}
                                                class:connecting={chatStatuses.get(
                                                    conversation.id
                                                ) === $LL.chatListStatusConnecting()}
                                                class:failed={chatStatuses.get(conversation.id) ===
                                                    $LL.chatListStatusFailed()}
                                                class:offline={chatStatuses.get(conversation.id) ===
                                                    $LL.chatListStatusOffline()}
                                            >
                                                {chatStatuses.get(conversation.id) ||
                                                    $LL.chatListStatusOffline()}
                                            </span>
                                        {/if}
                                    </span>
                                {/if}
                            </span>
                        </button>

                        <!-- Sibling of the button, not a child: a button may only hold
                             phrasing content, and nested buttons are exposed
                             unpredictably by assistive tech. -->
                        {#if matches.length}
                            <ul
                                class="search-matches"
                                aria-label={$LL.chatListMatchesAria({ name: conversation.name })}
                            >
                                {#each matches as match (match.id)}
                                    <li>
                                        <button
                                            type="button"
                                            class="btn btn--secondary search-match"
                                            data-nav-row={`${conversation.id}:${match.id}`}
                                            tabindex={activeNavId ===
                                            `${conversation.id}:${match.id}`
                                                ? 0
                                                : -1}
                                            on:focus={() =>
                                                (rovingId = `${conversation.id}:${match.id}`)}
                                            on:click={() =>
                                                openChatAtMessage(conversation, match.id)}
                                            aria-label={`${conversation.name}: ${match.snippet}, ${formatTimestampSpoken(match.timestamp)}`}
                                        >
                                            <span class="match-text" aria-hidden="true"
                                                ><!-- eslint-disable-line svelte/no-at-html-tags -- highlightMatch HTML-escapes all text and returns TrustedHTML; only the <mark> wrapper is markup -->{@html highlightMatch(
                                                    match.snippet,
                                                    searchQuery
                                                )}</span
                                            >
                                            <span class="match-time" aria-hidden="true"
                                                >{formatTimestamp(match.timestamp)}</span
                                            >
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</nav>

<style>
    .chats-container {
        height: 100%;
        background: var(--color-bg);
        display: flex;
        flex-direction: column;
    }

    .chats-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 1.5rem;
        border-bottom: 1px solid var(--color-border);
    }

    .chats-header h1 {
        margin: 0;
        color: var(--color-text);
        font-size: 1.5rem;
    }

    .header-actions {
        display: flex;
        gap: 0.75rem;
        align-items: center;
    }

    .instant-lock-button,
    .settings-button,
    .add-button {
        --btn-padding: 0;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        font-size: 1.2rem;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .settings-button {
        --btn-bg: var(--color-bg-muted);
        --btn-hover-bg: var(--color-border);
        --btn-color: var(--color-text-muted);
        --btn-border: var(--color-border);
    }

    .settings-button :global(.settings-icon) {
        width: 1.25rem;
        height: 1.25rem;
    }

    .instant-lock-button {
        --btn-bg: var(--color-error-bg);
        --btn-hover-bg: color-mix(in srgb, #dc3545 20%, var(--color-bg));
        --btn-color: var(--color-error-text);
        --btn-border: var(--color-error-border);
    }

    .instant-lock-button :global(.instant-lock-icon) {
        width: 1.25rem;
        height: 1.25rem;
    }

    .add-button {
        --btn-radius: 50%;
        font-size: 1.5rem;
    }

    .add-button:not(:disabled):hover {
        transform: scale(1.05);
    }

    .chats-list {
        flex: 1;
        overflow-y: auto;
    }

    .search-container {
        position: sticky;
        top: 0;
        padding: 0.75rem 1rem 0.5rem 1rem;
        border-bottom: 1px solid var(--color-border);
        background-color: var(--color-bg);
    }

    .search-pending {
        padding: 0.4rem 1rem;
        color: var(--color-text-muted);
        font-size: 0.85rem;
    }

    /* Shares the close-button treatment from _dialog.scss with the toast and dialog
       "x": circular chip, blue hover fill, focus ring. Only size and placement are
       overridden. :not(:disabled) matches that rule's specificity so these win. */
    .clear-button[data-modal-close]:not(:disabled) {
        position: absolute;
        right: 1.5rem;
        top: 50%;
        transform: translateY(-50%);
        width: 1.75rem;
        height: 1.75rem;
        font-size: 1.25rem;
    }

    /* The shared rule scales on hover, which would drop the button out of vertical
       centering; recompose the scale with the centering translate. */
    .clear-button[data-modal-close]:not(:disabled):hover {
        transform: translateY(-50%) scale(1.05);
    }

    :global(.highlight) {
        background-color: color-mix(in srgb, #fbbf24 35%, var(--color-bg));
        padding: 0 0.1rem;
        border-radius: 2px;
    }

    /* Aligns with the button's text: the row's 4px bar plus the button's 1rem inset. */
    .search-matches {
        display: flex;
        flex-direction: column;
        gap: 4px;
        list-style: none;
        margin: 0;
        padding: 0 1rem 0.75rem 1rem;
    }

    .search-match {
        --btn-bg: var(--color-bg-subtle);
        --btn-border: var(--color-border);
        --btn-radius: 6px;
        --btn-hover-bg: var(--color-bg-muted);
        --btn-color: var(--color-text-muted);
        --btn-padding: 6px 8px;
        width: 100%;
        text-align: left;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
    }

    .match-text {
        color: var(--color-text-muted);
        font-size: 0.9rem;
        line-height: 1.25;
    }

    .match-time {
        color: var(--color-text-subtle);
        font-size: 0.8rem;
        white-space: nowrap;
    }

    .loading-state,
    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        text-align: center;
        padding: 2rem;
        color: var(--color-text-muted);
    }

    .loading-spinner {
        width: 40px;
        height: 40px;
        border: 4px solid var(--color-input-border);
        border-top: 4px solid #006de2;
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin-bottom: 1rem;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .empty-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 4rem;
        height: 4rem;
        margin-bottom: 1rem;
        opacity: 0.5;
    }

    .empty-icon :global(.empty-icon-graphic) {
        width: 100%;
        height: 100%;
    }

    .empty-state p {
        margin-bottom: 1.5rem;
        font-size: 1.1rem;
    }

    .empty-action {
        margin-top: 0.5rem;
    }

    .conversation-list {
        list-style: none;
        margin: 0;
        padding: 0;
    }

    /* The active bar and tint live on the row, not the button, so they also span the
       search matches rendered beneath it. */
    .conversation-item {
        list-style: none;
        margin: 0;
        border-bottom: 1px solid var(--color-border);
        border-left: 4px solid transparent;
    }

    .conversation-item.active {
        background: color-mix(in srgb, #006de2 10%, var(--color-bg));
        border-left-color: #006de2;
    }

    .conversation-button {
        --btn-padding: 0;
        --btn-border: transparent;
        --btn-radius: 0;
        --btn-bg: transparent;
        --btn-hover-bg: var(--color-bg-subtle);
        display: block;
        width: 100%;
        padding: 0.75rem 1rem;
        text-align: left;
        font-weight: 400;
        color: inherit;
    }

    .conversation-button:focus-visible {
        outline: 2px solid #006de2;
        outline-offset: -2px;
    }

    .conversation-content {
        display: block;
        min-width: 0;
    }

    .conversation-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 0.25rem;
    }

    .conversation-name {
        margin: 0;
        font-size: 1.1rem;
        color: var(--color-text);
        font-weight: 600;
    }

    .last-activity {
        color: var(--color-text-muted);
        font-size: 0.8rem;
        flex-shrink: 0;
        margin-left: 1rem;
    }

    .conversation-preview {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .last-message {
        color: var(--color-text-muted);
        font-size: 0.9rem;
        flex: 1;
    }

    .conversation-status {
        font-size: 0.8rem;
        margin-left: 0.5rem;
        flex-shrink: 0;
        font-weight: 500;
        color: var(--color-text-muted);
    }

    .conversation-status.online {
        color: #28a745;
    }
    .conversation-status.connecting {
        color: #ffc107;
    }
    .conversation-status.failed {
        color: #dc3545;
    }

    @media (max-width: 600px) {
        .chats-header {
            padding: 1rem;
        }

        .chats-header h1 {
            font-size: 1.3rem;
        }

        .conversation-item .conversation-button {
            padding: 0.75rem 1rem;
        }

        .last-activity {
            font-size: 0.75rem;
        }

        .last-message {
            font-size: 0.85rem;
        }
    }
</style>
