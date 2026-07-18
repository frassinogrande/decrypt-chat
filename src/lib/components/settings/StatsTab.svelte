<script lang="ts">
    import { translations as LL } from '$lib/i18n/runtime';
    import Icon from '$lib/components/icons/Icon.svelte';

    interface ReactionLeaderboardEntry {
        reactionType: 'laugh' | 'heart' | '100' | string;
        emoji: string;
        count: number;
    }

    interface LeaderboardEntry {
        name: string;
        count: number;
    }

    export let panelId: string;
    export let labelledBy: string;
    export let statsLoading: boolean;
    export let statsError: string;
    export let stats: {
        reactions: ReactionLeaderboardEntry[];
        messages: LeaderboardEntry[];
    };
</script>

<div
    class="tab-content"
    data-tab="stats"
    role="tabpanel"
    id={panelId}
    aria-labelledby={labelledBy}
    tabindex="0"
>
    <h3 class="tab-heading">
        <Icon name="stats" size={22} className="tab-heading-icon" />
        <span>{$LL.settingsMenuNavStats()}</span>
    </h3>
    {#if statsLoading}
        <p class="stats-loading">{$LL.settingsMenuStatsLoading()}</p>
    {:else if statsError}
        <div class="error-message" role="alert">{statsError}</div>
    {:else}
        <div class="stats-grid">
            <section class="settings-dialog__section">
                <h4 class="settings-dialog__heading">
                    {$LL.settingsMenuStatsMostReactions()}
                </h4>
                {#if stats.reactions.length === 0}
                    <p class="empty-leaderboard">
                        {$LL.settingsMenuStatsNoReactions()}
                    </p>
                {:else}
                    <ol class="leaderboard-list">
                        {#each stats.reactions as item}
                            <li class="leaderboard-row">
                                <span class="leaderboard-label leaderboard-emoji">{item.emoji}</span
                                >
                                <span class="leaderboard-count">{item.count}</span>
                            </li>
                        {/each}
                    </ol>
                {/if}
            </section>

            <section class="settings-dialog__section">
                <h4 class="settings-dialog__heading">
                    {$LL.settingsMenuStatsMostMessages()}
                </h4>
                {#if stats.messages.length === 0}
                    <p class="empty-leaderboard">
                        {$LL.settingsMenuStatsNoMessages()}
                    </p>
                {:else}
                    <ol class="leaderboard-list">
                        {#each stats.messages as item}
                            <li class="leaderboard-row">
                                <span class="leaderboard-label">{item.name}</span>
                                <span class="leaderboard-count">{item.count}</span>
                                <span class="leaderboard-meta"
                                    >{item.count === 1
                                        ? $LL.settingsMenuStatsMessageSingular()
                                        : $LL.settingsMenuStatsMessagePlural()}</span
                                >
                            </li>
                        {/each}
                    </ol>
                {/if}
            </section>
        </div>
    {/if}
</div>

<style lang="scss">
    .stats-loading {
        color: var(--color-text-muted);
        font-size: 0.9rem;
    }

    .stats-grid {
        display: grid;
        gap: 1.5rem;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));

        .settings-dialog__section {
            margin-bottom: 0;
        }
    }

    .leaderboard-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .leaderboard-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
        font-size: 0.95rem;
        color: var(--color-text);
    }

    .leaderboard-label {
        flex: 1 1 auto;
        font-weight: 500;
    }

    .leaderboard-emoji {
        font-size: 1.25rem;
    }

    .leaderboard-count {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        color: var(--color-text);
    }

    .leaderboard-meta {
        color: var(--color-text-muted);
        font-size: 0.85rem;
    }

    .empty-leaderboard {
        margin: 0;
        color: var(--color-text-muted);
        font-size: 0.9rem;
    }

    .error-message {
        background: var(--color-error-bg);
        border: 1px solid var(--color-error-border);
        color: var(--color-error-text);
        padding: 0.75rem;
        border-radius: 8px;
        margin-bottom: 1rem;
        font-size: 0.9rem;
    }
</style>
