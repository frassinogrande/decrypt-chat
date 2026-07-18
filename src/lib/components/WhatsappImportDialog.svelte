<script lang="ts">
    import { debug } from '$lib/utils/debug';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { createEventDispatcher, onMount, tick } from 'svelte';
    import { get } from 'svelte/store';
    import type { Chat, StoredMessage } from '../types';
    import { parseWhatsAppExport, type WhatsAppParsedMessage } from '../utils/whatsapp-import';
    import { parseTelegramExport, TelegramImportError } from '../utils/telegram-import';
    import { generateUUID } from '../utils/crypto';
    import { chatStorage } from '../utils/chat-storage';
    import { messageSearch } from '../utils/message-search';
    import { appStore } from '../stores/app';
    import { translations as LL } from '$lib/i18n/runtime';

    export let chat: Chat;

    const dispatch = createEventDispatcher();

    let dialogRef: HTMLDialogElement;
    let closeButtonRef: HTMLButtonElement;
    const titleId = `whatsapp-import-title-${Math.random().toString(36).slice(2, 10)}`;

    let fileInput: HTMLInputElement;
    let dropRef: HTMLDivElement;
    let isParsing = false;
    let parseError = '';
    let parsedMessages: WhatsAppParsedMessage[] = [];
    let uniqueNames: string[] = [];
    let ignoredCount = 0;
    let dragActive = false;
    let selectedFileName: string | null = null;

    type ImporterKey = 'whatsapp' | 'telegram';
    type ImporterConfig = {
        key: ImporterKey;
        label: string;
        accept: string; // for <input accept>
        acceptHint: string; // for UI like (e.g., .txt)
        parse: (text: string) => {
            messages: WhatsAppParsedMessage[];
            names: string[];
            ignoredCount: number;
        };
        validateFile: (file: File) => boolean;
    };

    const importers: Record<ImporterKey, ImporterConfig> = {
        whatsapp: {
            key: 'whatsapp',
            label: 'WhatsApp',
            accept: '.txt,text/plain',
            acceptHint: '(.txt)',
            parse: (text: string) => parseWhatsAppExport(text),
            validateFile: (file: File) =>
                file.name.toLowerCase().endsWith('.txt') ||
                !file.type ||
                file.type === 'text/plain',
        },
        telegram: {
            key: 'telegram',
            label: 'Telegram',
            accept: '.json,application/json',
            acceptHint: '(.json)',
            parse: (text: string) => parseTelegramExport(text),
            validateFile: (file: File) =>
                file.name.toLowerCase().endsWith('.json') ||
                !file.type ||
                file.type === 'application/json',
        },
    };

    let selectedImporter: ImporterKey | '' = '';
    $: currentImporter = selectedImporter ? importers[selectedImporter] : null;

    let selectedYou: string | null = null;
    let selectedContact: string | null = null;
    let importing = false;
    let importResult = '';
    let importCompleted = false;
    let importedCount = 0;
    let importSelectionError = '';

    // Text mirrored into a persistent sr-only role="status" node so parsing
    // progress and the import result are announced to screen readers.
    $: liveStatus = isParsing
        ? $LL.whatsappImportParsing()
        : importCompleted
          ? $LL.whatsappImportSuccess({ count: importedCount })
          : importResult;

    onMount(() => {
        if (dialogRef && !dialogRef.open) {
            dialogRef.showModal();
        }
    });

    $: allowedSet = selectedYou && selectedContact ? new Set([selectedYou, selectedContact]) : null;
    $: importCandidatesCount =
        selectedYou && selectedContact
            ? parsedMessages.filter((m) => m.name === selectedYou || m.name === selectedContact)
                  .length
            : 0;
    $: importEnabled = !!selectedYou && !!selectedContact && selectedYou !== selectedContact;
    $: debugLog('state', { buttonDisabled: !canImport() || importing });

    function debugLog(tag: string, extra: any = {}) {
        try {
            debug.log('[WA Import]', tag, {
                selectedYou,
                selectedContact,
                parsedCount: parsedMessages.length,
                uniqueNames,
                ignoredCount,
                importEnabled,
                importCandidatesCount,
                importing,
                importCompleted,
                ...extra,
            });
        } catch {
            /* debug logging is best-effort; never block import on it */
        }
    }

    function handleClose() {
        dialogRef?.close();
        dispatch('close');
    }

    function isAllowedFile(file: File) {
        if (!currentImporter) return false;
        return currentImporter.validateFile(file);
    }

    async function parseFile(file: File) {
        if (!currentImporter) {
            parseError = get(LL).whatsappImportErrorSelectApp();
            return;
        }
        if (!isAllowedFile(file)) {
            parseError = get(LL)
                .whatsappImportErrorInvalidFile({
                    app: currentImporter.label,
                    hint: currentImporter.acceptHint,
                })
                .trim();
            return;
        }
        selectedFileName = file.name || null;
        parseError = '';
        isParsing = true;
        parsedMessages = [];
        uniqueNames = [];
        ignoredCount = 0;
        selectedYou = null;
        selectedContact = null;
        importResult = '';
        importSelectionError = '';

        try {
            const text = await file.text();
            if (!currentImporter) {
                parseError = get(LL).whatsappImportErrorSelectApp();
                return;
            }
            const result = currentImporter.parse(text);
            parsedMessages = result.messages;
            uniqueNames = result.names;
            ignoredCount = result.ignoredCount;

            // Heuristics: if exactly two names, default contact to chat.name if present
            if (uniqueNames.length === 2) {
                if (uniqueNames.includes(chat.name)) {
                    selectedContact = chat.name;
                    selectedYou = uniqueNames.find((n) => n !== chat.name) || null;
                }
            }
            debugLog('after-parse');
        } catch (err: any) {
            if (err instanceof TelegramImportError) {
                parseError =
                    err.code === 'full-export'
                        ? get(LL).whatsappImportErrorTelegramFullExport()
                        : get(LL).whatsappImportErrorTelegramNotJson();
            } else {
                parseError =
                    err?.message ||
                    get(LL).whatsappImportErrorParseFailed({ app: currentImporter?.label ?? '' });
            }
        } finally {
            isParsing = false;
        }
    }

    async function handleFileChange(e: Event) {
        const input = e.target as HTMLInputElement;
        const file = input.files && input.files[0];
        if (!file) return;
        await parseFile(file);
    }

    function openFileDialog() {
        if (isParsing || importing || importCompleted) return;
        if (!currentImporter) {
            parseError = get(LL).whatsappImportErrorSelectApp();
            return;
        }
        fileInput?.click();
    }

    function clearSelectedFile() {
        if (isParsing || importing) return;
        selectedFileName = null;
        parsedMessages = [];
        uniqueNames = [];
        ignoredCount = 0;
        selectedYou = null;
        selectedContact = null;
        parseError = '';
        importResult = '';
        importSelectionError = '';
        if (fileInput) fileInput.value = '';
    }

    function handleDragOver(e: DragEvent) {
        if (isParsing || importing || importCompleted || !currentImporter) return;
        e.preventDefault();
        dragActive = true;
    }

    function handleDragLeave(_e: DragEvent) {
        dragActive = false;
    }

    async function handleDrop(e: DragEvent) {
        if (isParsing || importing || importCompleted) return;
        e.preventDefault();
        dragActive = false;
        if (!currentImporter) {
            parseError = get(LL).whatsappImportErrorSelectApp();
            return;
        }
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        await parseFile(file);
    }

    function canImport(): boolean {
        return importEnabled;
    }

    function handleYouChange(name: string) {
        selectedYou = name;
        importSelectionError = '';
        debugLog('you-changed');
    }

    function handleContactChange(name: string) {
        selectedContact = name;
        importSelectionError = '';
        debugLog('contact-changed');
    }

    function formatDate(ts: number): string {
        const d = new Date(ts);
        const date = d.toLocaleDateString();
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `${date} ${time}`;
    }

    async function importMessages() {
        if (!selectedYou || !selectedContact || selectedYou === selectedContact) {
            debugLog('import-blocked', { reason: 'invalid-selection' });
            importSelectionError = get(LL).whatsappImportErrorTwoParticipants();
            return;
        }
        importSelectionError = '';
        importing = true;
        importResult = '';
        try {
            debugLog('import-start');
            const allowed = new Set([selectedYou!, selectedContact!]);
            const toImport = parsedMessages.filter((m) => allowed.has(m.name));

            // Map to StoredMessage and persist via chatStorage to avoid appending out of order
            for (const m of toImport) {
                const isOwn = m.name === selectedYou;
                const stored: StoredMessage = {
                    id: generateUUID(),
                    from: isOwn ? 'You' : chat.name,
                    body: m.body,
                    timestamp: m.timestamp,
                    isOwn,
                    deliveryMethod: currentImporter
                        ? `imported via ${currentImporter.label}`
                        : 'imported via import',
                };
                await chatStorage.addMessage(chat.id, stored);
            }

            // Refresh the lazy message store so messages are ordered by timestamp
            await appStore.refreshChatMessages(chat.id);
            // Imported history changes what search and previews should show
            messageSearch.invalidateChat(chat.id);
            await appStore.loadChats();

            importedCount = toImport.length;
            importResult = get(LL).whatsappImportResultSummary({
                count: toImport.length,
                ignored: ignoredCount,
            });
            importCompleted = true;
            // Completion removes both the focused Import button and the header
            // close button from the DOM; move focus to the footer Close button
            // so keyboard and screen-reader users are not dropped on <body>.
            await tick();
            closeButtonRef?.focus();
            debugLog('import-done', { imported: toImport.length });
        } catch (err: any) {
            importResult = get(LL).whatsappImportResultFailed({
                error: err?.message || get(LL).whatsappImportErrorUnknown(),
            });
            debug.error('WhatsApp import failed:', err);
        } finally {
            importing = false;
        }
    }

    function handleDialogCancel(event: Event) {
        event.preventDefault();
        handleClose();
    }

    function handleDialogPointerDown(event: PointerEvent) {
        if (event.target === dialogRef) {
            handleClose();
        }
    }
</script>

<dialog
    bind:this={dialogRef}
    class="dialog"
    aria-labelledby={titleId}
    on:cancel|preventDefault={handleDialogCancel}
    on:pointerdown={handleDialogPointerDown}
    aria-modal="true"
>
    <div class="dialog__header">
        <h3 id={titleId} class="dialog__title">{$LL.whatsappImportTitle()}</h3>
        {#if !importCompleted}
            <button
                type="button"
                class="btn btn--secondary"
                data-modal-close
                on:click={handleClose}
                aria-label={$LL.whatsappImportCloseAria()}>×</button
            >
        {/if}
    </div>

    <div class="dialog__body">
        <!-- Persistent live region: mounted with the dialog, text swapped, so
             parsing and import-result updates are reliably announced. -->
        <span class="sr-only" role="status">{liveStatus}</span>
        {#if !importCompleted}
            <div class="section">
                <div class="section-header">
                    <h4>{$LL.whatsappImportChooseAppHeader()}</h4>
                </div>
                <div class="importer-row">
                    <label for="importer-select" class="importer-label"
                        >{$LL.whatsappImportAppLabel()}</label
                    >
                    <select
                        id="importer-select"
                        bind:value={selectedImporter}
                        on:change={() => clearSelectedFile()}
                    >
                        <option value="" disabled selected hidden
                            >{$LL.whatsappImportSelectAppPlaceholder()}</option
                        >
                        <option value="whatsapp">WhatsApp</option>
                        <option value="telegram">Telegram</option>
                    </select>
                </div>
                {#if selectedImporter === 'whatsapp'}
                    <p class="importer-hint">{$LL.whatsappImportHintWhatsapp()}</p>
                {:else if selectedImporter === 'telegram'}
                    <p class="importer-hint">{$LL.whatsappImportHintTelegram()}</p>
                {/if}
            </div>

            {#if currentImporter}
                <div class="section">
                    <div class="section-header">
                        <h4>
                            {$LL.whatsappImportUploadHeader({ hint: currentImporter.acceptHint })}
                        </h4>
                    </div>
                    {#if !selectedFileName}
                        <div
                            class="dropzone {dragActive ? 'active' : ''} {isParsing ||
                            importing ||
                            importCompleted
                                ? 'disabled'
                                : ''}"
                            bind:this={dropRef}
                            role="button"
                            aria-label={$LL.whatsappImportUploadAria({
                                app: currentImporter.label,
                            })}
                            tabindex={isParsing || importing || importCompleted ? -1 : 0}
                            on:click={openFileDialog}
                            on:keydown={(e) =>
                                (e.key === 'Enter' || e.key === ' ') && openFileDialog()}
                            on:dragover={handleDragOver}
                            on:dragleave={handleDragLeave}
                            on:drop={handleDrop}
                        >
                            <div class="dropzone-inner">
                                <Icon name="upload" size={32} className="dz-icon" />
                                <div class="dz-title">
                                    {$LL.whatsappImportDropHere({ app: currentImporter.label })}
                                </div>
                                <div class="dz-subtitle">{$LL.whatsappImportDropSubtitle()}</div>
                            </div>
                            <input
                                bind:this={fileInput}
                                class="file-input"
                                type="file"
                                accept={currentImporter.accept}
                                on:change={handleFileChange}
                                disabled={isParsing || importing || importCompleted}
                                tabindex="-1"
                            />
                        </div>
                    {:else}
                        <div class="file-row">
                            <div class="file-name">
                                <Icon name="description" size={18} className="file-icon" />
                                <span>{selectedFileName}</span>
                            </div>
                            <button
                                type="button"
                                class="btn btn--secondary clear-file"
                                on:click={clearSelectedFile}
                                disabled={isParsing || importing}
                                aria-label={$LL.whatsappImportRemoveFileAria()}>×</button
                            >
                        </div>
                    {/if}

                    {#if isParsing}
                        <p>{$LL.whatsappImportParsing()}</p>
                    {/if}
                    {#if parseError}
                        <p class="error" role="alert">{parseError}</p>
                    {/if}
                </div>
            {/if}

            {#if parsedMessages.length > 0}
                <div class="section">
                    <div class="section-header">
                        <h4>{$LL.whatsappImportIdentifyHeader()}</h4>
                    </div>
                    <p>{$LL.whatsappImportNamesHelp({ name: chat.name })}</p>
                    <div class="picker-grid">
                        <fieldset class="picker-group">
                            <legend class="picker-label">{$LL.whatsappImportYouLabel()}</legend>
                            <div class="name-options">
                                {#each uniqueNames as name}
                                    <label
                                        class="name-option"
                                        class:selected={selectedYou === name}
                                    >
                                        <input
                                            class="visually-hidden"
                                            type="radio"
                                            name="you-selection"
                                            value={name}
                                            disabled={importCompleted}
                                            on:change={() => handleYouChange(name)}
                                        />
                                        <span class="name-chip">{name}</span>
                                    </label>
                                {/each}
                            </div>
                        </fieldset>
                        <fieldset class="picker-group">
                            <legend class="picker-label">{chat.name}</legend>
                            <div class="name-options">
                                {#each uniqueNames as name}
                                    <label
                                        class="name-option"
                                        class:selected={selectedContact === name}
                                    >
                                        <input
                                            class="visually-hidden"
                                            type="radio"
                                            name="contact-selection"
                                            value={name}
                                            disabled={importCompleted}
                                            on:change={() => handleContactChange(name)}
                                        />
                                        <span class="name-chip">{name}</span>
                                    </label>
                                {/each}
                            </div>
                        </fieldset>
                    </div>
                    {#if selectedYou && selectedContact && selectedYou === selectedContact}
                        <p class="error" role="alert">
                            {$LL.whatsappImportSelectionsDifferentError()}
                        </p>
                    {/if}
                    {#if importSelectionError}
                        <p class="error" role="alert">{importSelectionError}</p>
                    {/if}
                </div>

                <div class="section">
                    <div class="section-header">
                        <h4>{$LL.whatsappImportPreviewHeader()}</h4>
                    </div>
                    {#if selectedYou && selectedContact}
                        <p>
                            {$LL.whatsappImportPreviewSummary({
                                total: parsedMessages.length,
                                count: importCandidatesCount,
                                you: selectedYou,
                                contact: selectedContact,
                            })}
                            {#if ignoredCount > 0}
                                {$LL.whatsappImportPreviewIgnored({ count: ignoredCount })}
                            {/if}
                            {#if importCandidatesCount === 0}
                                <span class="error">{$LL.whatsappImportPreviewNone()}</span>
                            {/if}
                        </p>
                        <div class="preview-box">
                            {#each parsedMessages.slice(0, 5) as m}
                                <div class="preview-item">
                                    <div class="preview-meta">
                                        {formatDate(m.timestamp)}, {m.name}
                                    </div>
                                    <div class="preview-body">{m.body}</div>
                                </div>
                            {/each}
                        </div>
                    {:else}
                        <p>{$LL.whatsappImportPreviewSelectPrompt()}</p>
                    {/if}
                </div>

                {#if importResult}
                    <div class="result">{importResult}</div>
                {/if}
            {/if}
        {:else}
            <div class="section">
                <p>{$LL.whatsappImportSuccess({ count: importedCount })}</p>
            </div>
        {/if}
    </div>
    <div class="dialog__footer">
        {#if !importCompleted}
            <button
                class="btn btn--primary"
                type="button"
                on:click={importMessages}
                disabled={importing || parsedMessages.length === 0}
            >
                {#if importing}{$LL.whatsappImportButtonImporting()}{:else}{$LL.whatsappImportButtonImport()}{/if}
            </button>
            <button
                type="button"
                class="btn btn--secondary"
                on:click={handleClose}
                disabled={importing}>{$LL.whatsappImportButtonCancel()}</button
            >
        {:else}
            <button
                type="button"
                class="btn btn--primary"
                bind:this={closeButtonRef}
                on:click={handleClose}>{$LL.whatsappImportButtonClose()}</button
            >
        {/if}
    </div>
</dialog>

<style>
    .section {
        margin-bottom: 1rem;
    }
    .section-header {
        margin-bottom: 0.5rem;
    }
    .importer-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }
    .importer-label {
        font-weight: 600;
    }
    .importer-hint {
        margin: 0.5rem 0 0;
        color: var(--color-text-muted);
        font-size: 0.85rem;
    }
    select#importer-select {
        padding: 0.35rem 0.5rem;
        border-radius: 6px;
        border: 1px solid var(--color-border);
        background: var(--color-bg);
        color: var(--color-text);
    }
    /* Dropzone, file-row, dz-* and clear-file styles are shared globally in
       src/styles/_forms.scss. */
    .picker-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1.25rem;
    }
    .picker-group {
        border: none;
        padding: 0;
        margin: 0;
        min-width: 0;
    }
    .picker-label {
        padding: 0;
        font-weight: 700;
        margin-bottom: 0.5rem;
        color: var(--color-text);
    }
    .name-options {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }
    .name-option {
        display: inline-flex;
        align-items: center;
        cursor: pointer;
    }
    .name-chip {
        border: 1px solid var(--color-border);
        padding: 0.35rem 0.6rem;
        border-radius: 999px;
        background: var(--color-bg);
        color: var(--color-text);
        transition: all 0.15s ease;
    }
    .name-option.selected .name-chip {
        border-color: var(--color-accent-text);
        background: color-mix(in srgb, var(--color-accent-text) 10%, var(--color-bg));
        color: var(--color-accent-text);
        box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.12);
    }
    .name-option .name-chip:hover {
        transform: translateY(-1px);
    }
    .preview-box {
        border: 1px solid var(--color-border);
        border-radius: 8px;
        padding: 0.5rem;
        background: var(--color-bg-subtle);
    }
    .preview-item {
        border-bottom: 1px solid var(--color-border);
        padding: 0.4rem 0;
    }
    .preview-item:last-child {
        border-bottom: none;
    }
    .preview-meta {
        color: var(--color-text-muted);
        font-size: 0.85rem;
        margin-bottom: 0.25rem;
    }
    .preview-body {
        white-space: pre-wrap;
    }
    .error {
        color: var(--color-danger-text);
    }
    .result {
        margin-top: 0.5rem;
        color: var(--color-success-text);
    }
</style>
