<script lang="ts">
    import { translations as LL } from '$lib/i18n/runtime';
    import Icon from '$lib/components/icons/Icon.svelte';

    export let panelId: string;
    export let labelledBy: string;
    export let indexedDbHeadingId: string;
    export let localStorageHeadingId: string;
    export let storageInfo: any;
    export let storagePersisted = false;
    export let showPersistence = false;
    export let chatStorageBreakdown: Array<{
        chatId: string;
        name: string;
        bytes: number;
        percentage: number;
        color: string;
    }>;
    export let onRequestPersistence: () => void;
    export let onOpenBackupDialog: () => void;
    export let onOpenRestoreDialog: () => void;
    export let onOpenExportDialog: () => void;
    export let onOpenDeleteConfirmation: () => void;

    function formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function getStoragePercentage(used: number, total: number): number {
        return total > 0 ? Math.round((used / total) * 100 * 100) / 100 : 0;
    }

    function resolveProgressMax(used: number, total: number): number {
        return Math.max(total || 0, used || 0, 1);
    }
</script>

<div
    class="tab-content"
    data-tab="storage"
    role="tabpanel"
    id={panelId}
    aria-labelledby={labelledBy}
    tabindex="0"
>
    <h3 class="tab-heading">
        <Icon name="data-usage" size={22} className="tab-heading-icon" />
        <span>{$LL.settingsMenuNavStorage()}</span>
    </h3>

    {#if storageInfo}
        <div class="settings-dialog__section">
            <h4 class="settings-dialog__heading" id={indexedDbHeadingId}>
                <span>{$LL.settingsMenuStorageChatHeading()}</span>
            </h4>
            <div class="storage-bar">
                <div
                    class="storage-fill"
                    style="width: {getStoragePercentage(
                        storageInfo.indexedDB.used,
                        storageInfo.indexedDB.quota
                    )}%"
                    role="progressbar"
                    aria-valuemin="0"
                    aria-valuemax={resolveProgressMax(
                        storageInfo.indexedDB.used,
                        storageInfo.indexedDB.quota
                    )}
                    aria-valuenow={storageInfo.indexedDB.used}
                    aria-labelledby={indexedDbHeadingId}
                    aria-valuetext={$LL.settingsMenuStorageUsedAria({
                        used: formatBytes(storageInfo.indexedDB.used),
                        total: formatBytes(storageInfo.indexedDB.quota),
                    })}
                ></div>
            </div>
            <div class="storage-details">
                <span
                    >{formatBytes(storageInfo.indexedDB.used)} / {formatBytes(
                        storageInfo.indexedDB.quota
                    )}</span
                >
                <span
                    >{$LL.settingsMenuStoragePercentUsed({
                        percent:
                            storageInfo.indexedDB.quota > 0
                                ? (
                                      (storageInfo.indexedDB.used / storageInfo.indexedDB.quota) *
                                      100
                                  ).toFixed(3)
                                : '0.000',
                    })}</span
                >
            </div>
            <div class="storage-stats">
                <div>
                    {$LL.settingsMenuStorageConversationsStat({
                        count: storageInfo.indexedDB.conversations,
                    })}
                </div>
                <div>
                    <span>
                        {$LL.settingsMenuStorageMessagesStat({
                            count: storageInfo.indexedDB.messages,
                        })}
                    </span>
                </div>
            </div>
            {#if chatStorageBreakdown.length > 0}
                <details class="storage-breakdown">
                    <summary>
                        <span class="breakdown-summary-title"
                            >{$LL.settingsMenuStorageBreakdownTitle()}</span
                        >
                        <span class="breakdown-summary-count"
                            >{chatStorageBreakdown.length}
                            {chatStorageBreakdown.length === 1
                                ? $LL.settingsMenuStorageBreakdownCountSingular()
                                : $LL.settingsMenuStorageBreakdownCountPlural()}</span
                        >
                    </summary>
                    <ul>
                        {#each chatStorageBreakdown as chat}
                            <li>
                                <span
                                    class="breakdown-color"
                                    style="background-color: {chat.color};"
                                ></span>
                                <span class="breakdown-name">{chat.name}</span>
                                <span class="breakdown-bytes">{formatBytes(chat.bytes)}</span>
                                <span class="breakdown-percent">{chat.percentage.toFixed(4)}%</span>
                            </li>
                        {/each}
                    </ul>
                </details>
            {:else}
                <p class="storage-breakdown-empty">
                    {$LL.settingsMenuStorageBreakdownEmpty()}
                </p>
            {/if}
        </div>

        <div class="settings-dialog__section">
            <h4 class="settings-dialog__heading" id={localStorageHeadingId}>
                <span>{$LL.settingsMenuStorageAppHeading()}</span>
            </h4>
            <div class="storage-bar">
                <div
                    class="storage-fill"
                    style="width: {getStoragePercentage(
                        storageInfo.localStorage.used,
                        storageInfo.localStorage.quota
                    )}%"
                    role="progressbar"
                    aria-valuemin="0"
                    aria-valuemax={resolveProgressMax(
                        storageInfo.localStorage.used,
                        storageInfo.localStorage.quota
                    )}
                    aria-valuenow={storageInfo.localStorage.used}
                    aria-labelledby={localStorageHeadingId}
                    aria-valuetext={$LL.settingsMenuStorageUsedAria({
                        used: formatBytes(storageInfo.localStorage.used),
                        total: formatBytes(storageInfo.localStorage.quota),
                    })}
                ></div>
            </div>
            <div class="storage-details">
                <span
                    >{formatBytes(storageInfo.localStorage.used)} / {formatBytes(
                        storageInfo.localStorage.quota
                    )}</span
                >
                <span
                    >{$LL.settingsMenuStoragePercentUsed({
                        percent:
                            storageInfo.localStorage.quota > 0
                                ? (
                                      (storageInfo.localStorage.used /
                                          storageInfo.localStorage.quota) *
                                      100
                                  ).toFixed(3)
                                : '0.000',
                    })}</span
                >
            </div>
        </div>

        {#if showPersistence}
            <div class="settings-dialog__section">
                <h4 class="settings-dialog__heading">
                    <span>{$LL.settingsMenuStoragePersistenceHeading()}</span>
                </h4>
                <p class="persistence-status" class:persistence-status--on={storagePersisted}>
                    {storagePersisted
                        ? $LL.settingsMenuStoragePersistenceOn()
                        : $LL.settingsMenuStoragePersistenceOff()}
                </p>
                <p class="persistence-removal-note">
                    {$LL.settingsMenuStoragePersistenceRemovalNote()}
                </p>
                {#if !storagePersisted}
                    <div class="profile-actions">
                        <button
                            type="button"
                            class="btn btn--primary"
                            on:click={onRequestPersistence}
                        >
                            {$LL.settingsMenuStoragePersistenceEnable()}
                        </button>
                    </div>
                {/if}
            </div>
        {/if}
    {:else}
        <p>{$LL.settingsMenuStorageLoading()}</p>
    {/if}

    <!-- Backup & Restore -->
    <div class="settings-dialog__section">
        <h4 class="settings-dialog__heading">
            {$LL.settingsMenuStorageBackupTitle()}
        </h4>
        <p>{$LL.settingsMenuStorageBackupDescription()}</p>
        <div class="profile-actions">
            <button type="button" class="btn btn--primary" on:click={onOpenBackupDialog}>
                {$LL.settingsMenuBackupTitle()}
            </button>
            <button type="button" class="btn btn--secondary" on:click={onOpenRestoreDialog}
                >{$LL.restoreProfileSubmit()}</button
            >
        </div>
    </div>

    <!-- Export -->
    <div class="settings-dialog__section">
        <h4 class="settings-dialog__heading">
            {$LL.settingsMenuStorageExportTitle()}
        </h4>
        <p>{$LL.settingsMenuStorageExportDescription()}</p>
        <div class="profile-actions">
            <button type="button" class="btn btn--secondary" on:click={onOpenExportDialog}>
                {$LL.settingsMenuStorageExportButton()}
            </button>
        </div>
    </div>

    <div class="settings-dialog__section danger-section">
        <h4 class="settings-dialog__heading">
            {$LL.settingsMenuStorageDeleteTitle()}
        </h4>
        <p class="danger-warning">{$LL.settingsMenuStorageDeleteDescription()}</p>
        <button type="button" class="btn btn--warning" on:click={onOpenDeleteConfirmation}>
            <Icon name="bin" size={18} className="delete-all-icon" />
            <span>{$LL.settingsMenuStorageDeleteButton()}</span>
        </button>
    </div>
</div>

<style lang="scss">
    .storage-bar {
        background: var(--color-border);
        border-radius: 4px;
        height: 8px;
        margin: 0.5rem 0;
        overflow: hidden;
    }

    .storage-fill {
        background: #10b981;
        height: 100%;
        transition: width 0.3s ease;
    }

    .storage-details {
        display: flex;
        justify-content: space-between;
        font-size: 0.9rem;
        color: var(--color-text-muted);
    }

    .storage-stats {
        display: flex;
        gap: 1rem;
        font-size: 0.8rem;
        color: var(--color-text-muted);

        div {
            display: flex;
            align-items: center;
            gap: 0.35rem;
        }
    }

    .storage-breakdown {
        summary {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
            padding: 0.5rem 0.75rem;
            margin: 0;
            cursor: pointer;
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--color-text);
            border: 1px solid var(--color-border);
            border-radius: 8px;
            background: var(--color-bg-muted);
            list-style: none;

            &::-webkit-details-marker {
                display: none;
            }
        }

        ul {
            list-style: none;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        li {
            display: grid;
            grid-template-columns: auto 1fr auto auto;
            align-items: center;
            gap: 0.75rem;
            padding: 0.5rem 0.75rem;
            border: 1px solid var(--color-border);
            border-radius: 8px;
            background: var(--color-bg-subtle);
            font-size: 14px;
        }

        &[open] summary {
            border-bottom-left-radius: 0;
            border-bottom-right-radius: 0;
            border-bottom-color: transparent;
        }

        &[open] ul {
            border: 1px solid var(--color-border);
            border-top: none;
            border-bottom-left-radius: 8px;
            border-bottom-right-radius: 8px;
            padding: 0.75rem 0.75rem 0.85rem 0.75rem;
            background: var(--color-surface);
        }
    }

    .breakdown-summary-title {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
    }

    .breakdown-summary-count {
        font-size: 0.8rem;
        font-weight: 500;
        color: var(--color-text-muted);
        background: rgba(67, 56, 202, 0.08);
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
    }

    .breakdown-color {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.1);
    }

    .breakdown-name {
        font-weight: 500;
        color: var(--color-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .breakdown-bytes {
        font-variant-numeric: tabular-nums;
        color: var(--color-text);
        font-weight: 500;
    }

    .breakdown-percent {
        font-variant-numeric: tabular-nums;
        color: var(--color-text-muted);
    }

    .persistence-status {
        margin: 0;
        font-size: 0.9rem;
        color: var(--color-text-muted);
        line-height: 1.4;

        &--on {
            color: var(--color-text);
        }
    }

    .persistence-removal-note {
        margin: 0;
        font-size: 0.9rem;
        color: var(--color-text-muted);
        line-height: 1.4;
    }

    .storage-breakdown-empty {
        margin-top: 1rem;
        color: var(--color-text-muted);
        font-size: 0.9rem;
    }

    .danger-section {
        border: 2px solid var(--color-error-border);
        background: var(--color-error-bg);
    }

    .danger-warning {
        color: var(--color-error-text);
        font-size: 0.9rem;
        margin-bottom: 1rem;
        line-height: 1.4;
    }

    .danger-section > :global(.btn.btn--warning) {
        width: 100%;
    }

    .danger-section > :global(.btn.btn--warning):not(:disabled):hover {
        transform: translateY(-1px);
    }

    .danger-section > :global(.btn.btn--warning:disabled) {
        cursor: not-allowed;
    }

    .danger-section :global(.delete-all-icon) {
        width: 1.1rem;
        height: 1.1rem;
    }

    @media (max-width: 600px) {
        .storage-stats {
            flex-direction: column;
            gap: 0.25rem;
        }

        .storage-breakdown ul {
            gap: 0.35rem;
        }

        .storage-breakdown li {
            grid-template-columns: auto 1fr auto;
            gap: 0.4rem;
        }

        .storage-breakdown summary {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.3rem;
        }

        .storage-breakdown[open] ul {
            padding: 0.65rem;
        }

        .breakdown-summary-count {
            font-size: 0.75rem;
        }
    }
</style>
