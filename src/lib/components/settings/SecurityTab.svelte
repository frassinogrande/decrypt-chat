<script lang="ts">
    import { translations as LL } from '$lib/i18n/runtime';
    import Icon from '$lib/components/icons/Icon.svelte';
    import type { UserProfile, ProfileSettings } from '../../types';

    export let panelId: string;
    export let labelledBy: string;
    export let settings: ProfileSettings;
    export let profile: UserProfile | undefined;
    export let autoLockOptions: Array<{ value: number; label: () => string }>;
    export let onUpdateSettings: () => void;
    export let onLockProfile: () => void;
</script>

<div
    class="tab-content"
    data-tab="security"
    role="tabpanel"
    id={panelId}
    aria-labelledby={labelledBy}
    tabindex="0"
>
    <h3 class="tab-heading">
        <Icon name="padlock" size={22} className="tab-heading-icon" />
        <span>{$LL.settingsMenuNavSecurity()}</span>
    </h3>

    <div class="settings-dialog__section">
        <h4 class="settings-dialog__heading">
            {$LL.settingsMenuSecurityAutoLockTitle()}
        </h4>
        <div class="form-group">
            <label for="auto-lock-timeout">{$LL.settingsMenuSecurityAutoLockLabel()}</label>
            <select
                id="auto-lock-timeout"
                bind:value={settings.autoLockTimeout}
                on:change={onUpdateSettings}
                class="form-select"
            >
                {#each autoLockOptions as option}
                    <option value={option.value}>{option.label()}</option>
                {/each}
            </select>
            {#if settings.autoLockTimeout === -3}
                <small class="form-warning">
                    {$LL.settingsMenuSecurityAutoLockWarningInsecure()}
                </small>
            {/if}
        </div>
    </div>

    <div class="settings-dialog__section">
        <h4 class="settings-dialog__heading">
            {$LL.settingsMenuSecurityOptionsTitle()}
        </h4>
        <div class="form-group">
            <label class="checkbox-label">
                <input
                    type="checkbox"
                    bind:checked={settings.hideMessagesOnHomepage}
                    on:change={onUpdateSettings}
                />
                <span class="checkbox-text">{$LL.settingsMenuSecurityHideHomepageLabel()}</span>
            </label>
            <small class="form-help">
                {$LL.settingsMenuSecurityHideHomepageDescription()}
            </small>
        </div>
        <div class="form-group">
            <label class="checkbox-label">
                <input
                    type="checkbox"
                    bind:checked={settings.showInstantLockButton}
                    on:change={onUpdateSettings}
                />
                <span class="checkbox-text">{$LL.settingsMenuSecurityInstantLockLabel()}</span>
            </label>
            <small class="form-help">
                {$LL.settingsMenuSecurityInstantLockDescription()}
            </small>
        </div>
    </div>

    {#if profile}
        <div class="settings-dialog__section">
            <h4 class="settings-dialog__heading">
                {$LL.settingsMenuSecurityManualLockTitle()}
            </h4>
            <p>{$LL.settingsMenuSecurityManualLockDescription()}</p>
            <button type="button" class="btn btn--warning" on:click={onLockProfile}>
                <Icon name="padlock" size={18} className="lock-button-icon" />
                <span>{$LL.settingsMenuSecurityManualLockButton()}</span>
            </button>
        </div>
    {/if}

    <div class="settings-dialog__section security-info">
        <h4 class="settings-dialog__heading">
            <span>{$LL.settingsMenuSecurityInfoHeading()}</span>
        </h4>
        <ul>
            <li>{$LL.settingsMenuSecurityInfoItem1()}</li>
            <li>{$LL.settingsMenuSecurityInfoItem2()}</li>
            <li>{$LL.settingsMenuSecurityInfoItem3()}</li>
            <li>{$LL.settingsMenuSecurityInfoItem4()}</li>
        </ul>
    </div>
</div>

<style lang="scss">
    .settings-dialog__section :global(.lock-button-icon) {
        width: 1rem;
        height: 1rem;
    }

    .form-warning {
        color: #b45309;
        font-size: 0.8rem;
        margin-top: 0.5rem;
        display: block;
    }

    .security-info {
        ul {
            color: var(--color-text-muted);
            font-size: 0.9rem;
            line-height: 1.5;
            padding-left: 1.25rem;
        }

        li {
            margin-bottom: 0.5rem;
        }
    }
</style>
