<script lang="ts">
    import { translations as LL } from '$lib/i18n/runtime';
    import type { Locale } from '$lib/i18n/config';
    import Icon from '$lib/components/icons/Icon.svelte';
    import NewPasswordFields from '$lib/components/NewPasswordFields.svelte';
    import type { UserProfile, ProfileSettings, ContactMethod } from '../../types';
    import { CONTACT_APPS, resolveAppLabel, inputTypeFor } from '$lib/config/contact-apps';

    export let panelId: string;
    export let labelledBy: string;
    export let settings: ProfileSettings;
    export let selectedLocale: Locale;
    export let languageOptions: Array<{ tag: Locale; label: string }>;
    export let profile: UserProfile | undefined;
    export let editingProfile: boolean;
    export let editContacts: ContactMethod[];
    export let onAddContactField: () => void;
    export let onRemoveContactField: (index: number) => void;

    // Localized labels for the app dropdown; brand names stay literal.
    function appOptionLabel(key: string): string {
        if (key === 'email') return $LL.contactAppEmail();
        if (key === 'sms') return $LL.contactAppSms();
        if (key === 'other') return $LL.contactAppOther();
        return resolveAppLabel({ app: key, value: '' }, $LL);
    }
    export let currentPassword: string;
    export let newPassword: string;
    export let confirmNewPassword: string;
    export let changingPassword: boolean;
    export let isLoading: boolean;
    export let onUpdateSettings: () => void;
    export let onLanguageChange: (event: Event) => void;
    export let onStartEditingProfile: () => void;
    export let onCancelEditingProfile: () => void;
    export let onSaveProfileChanges: () => void;
    export let onOpenProfileShare: () => void;
    export let onStartChangingPassword: () => void;
    export let onCancelChangingPassword: () => void;
    export let onSaveNewPassword: () => void;
    export let onRedoTutorial: () => void;

    let showCurrentPassword = false;

    // Never leave a password revealed for the next time a form is opened.
    // The new/confirm pair manages its own reveal state in NewPasswordFields.
    $: if (!changingPassword) {
        showCurrentPassword = false;
    }
</script>

<div
    class="tab-content"
    data-tab="profile"
    role="tabpanel"
    id={panelId}
    aria-labelledby={labelledBy}
    tabindex="0"
>
    <h3 class="tab-heading">
        <Icon name="person-shield" size={22} className="tab-heading-icon" />
        <span>{$LL.settingsMenuNavChats()}</span>
    </h3>

    <section class="settings-dialog__section">
        <h4 class="settings-dialog__heading">{$LL.settingsThemeHeading()}</h4>
        <div class="form-group">
            <label for="settings-theme">{$LL.settingsThemeLabel()}</label>
            <select
                id="settings-theme"
                bind:value={settings.themePreference}
                on:change={onUpdateSettings}
            >
                <option value="system">{$LL.settingsThemeSystem()}</option>
                <option value="light">{$LL.settingsThemeLight()}</option>
                <option value="dark">{$LL.settingsThemeDark()}</option>
            </select>
        </div>
    </section>

    <section class="settings-dialog__section">
        <h4 class="settings-dialog__heading">{$LL.settingsLanguageHeading()}</h4>
        <div class="form-group">
            <label for="settings-language">{$LL.settingsLanguageLabel()}</label>
            <select id="settings-language" bind:value={selectedLocale} on:change={onLanguageChange}>
                {#each languageOptions as option}
                    <option value={option.tag}>{option.label}</option>
                {/each}
            </select>
        </div>
    </section>

    {#if profile}
        <div class="settings-dialog__section">
            <h4 class="settings-dialog__heading">
                {$LL.settingsMenuProfileHeading()}
            </h4>
            <p class="language-helper contacts-description">
                {$LL.settingsProfileContactsDescription()}
            </p>

            {#if editingProfile}
                <div class="contact-fields">
                    {#each editContacts as contact, i (i)}
                        <div class="contact-row">
                            <select
                                class="contact-app-select"
                                bind:value={contact.app}
                                disabled={isLoading}
                                aria-label={$LL.settingsContactAppLabel()}
                            >
                                <option value="" disabled>
                                    {$LL.settingsContactChooseMethod()}
                                </option>
                                {#each CONTACT_APPS as app}
                                    <option value={app.key}>{appOptionLabel(app.key)}</option>
                                {/each}
                            </select>

                            {#if contact.app === 'other'}
                                <input
                                    type="text"
                                    class="input contact-label-input"
                                    value={contact.label ?? ''}
                                    on:input={(e) => (contact.label = e.currentTarget.value)}
                                    placeholder={$LL.settingsContactOtherLabelPlaceholder()}
                                    aria-label={$LL.settingsContactLabelAria({
                                        method: appOptionLabel('other'),
                                    })}
                                    disabled={isLoading}
                                />
                            {/if}

                            <input
                                type={inputTypeFor(contact.app)}
                                class="input contact-value-input"
                                value={contact.value}
                                on:input={(e) => (contact.value = e.currentTarget.value)}
                                placeholder={$LL.settingsContactValuePlaceholder()}
                                aria-label={contact.app
                                    ? $LL.settingsContactValueAria({
                                          method: appOptionLabel(contact.app),
                                      })
                                    : $LL.settingsContactValuePlaceholder()}
                                disabled={isLoading}
                            />

                            <button
                                type="button"
                                class="btn btn--secondary contact-remove"
                                on:click={() => onRemoveContactField(i)}
                                disabled={isLoading}
                                title={$LL.settingsRemoveContactField()}
                                aria-label={$LL.settingsRemoveContactField()}
                            >
                                <Icon name="close" size={18} />
                            </button>
                        </div>
                    {/each}

                    <button
                        type="button"
                        class="btn btn--secondary contact-add"
                        on:click={onAddContactField}
                        disabled={isLoading}
                    >
                        <span class="contact-add-glyph" aria-hidden="true">+</span>
                        <span>{$LL.settingsAddContactField()}</span>
                    </button>
                </div>

                <div class="form-actions">
                    <button
                        type="button"
                        class="btn btn--secondary"
                        on:click={onCancelEditingProfile}
                        disabled={isLoading}
                    >
                        {$LL.profileSetupCancel()}
                    </button>
                    <button
                        type="button"
                        class="btn btn--primary"
                        on:click={onSaveProfileChanges}
                        disabled={isLoading}
                    >
                        {isLoading
                            ? $LL.settingsMenuProfileSaving()
                            : $LL.settingsMenuProfileSave()}
                    </button>
                </div>
            {:else}
                {#if profile.contacts && profile.contacts.length > 0}
                    {#each profile.contacts as contact}
                        <div class="profile-field">
                            <span class="profile-label">{resolveAppLabel(contact, $LL)}</span>
                            <div class="profile-value">{contact.value}</div>
                        </div>
                    {/each}
                {:else}
                    <div class="profile-field">
                        <div class="profile-value">
                            {$LL.settingsMenuProfileContactsFallback()}
                        </div>
                    </div>
                {/if}

                <div class="profile-field">
                    <span class="profile-label">{$LL.settingsMenuProfileCreatedLabel()}</span>
                    <div class="profile-value">
                        {new Date(profile.createdAt).toLocaleDateString()}
                    </div>
                </div>

                <div class="profile-actions">
                    <button
                        type="button"
                        class="btn btn--secondary"
                        on:click={onStartEditingProfile}
                    >
                        {$LL.settingsMenuProfileEdit()}
                    </button>
                    <button type="button" class="btn btn--primary" on:click={onOpenProfileShare}>
                        {$LL.settingsMenuProfileShare()}
                    </button>
                </div>
            {/if}
        </div>

        <div class="settings-dialog__section">
            <h4 class="settings-dialog__heading">
                {$LL.settingsMenuPasswordSectionTitle()}
            </h4>
            <p class="password-info">{$LL.settingsMenuPasswordInfo()}</p>
            {#if changingPassword}
                <div class="password-change-form">
                    <div class="form-group">
                        <label for="current-pwd"
                            >{$LL.settingsMenuProfileCurrentPasswordLabel()}</label
                        >
                        <div class="password-input-container">
                            <input
                                id="current-pwd"
                                type={showCurrentPassword ? 'text' : 'password'}
                                value={currentPassword}
                                on:input={(e) => (currentPassword = e.currentTarget.value)}
                                placeholder={$LL.settingsMenuPasswordCurrentPlaceholder()}
                                disabled={isLoading}
                                class="input"
                            />
                            <button
                                type="button"
                                class="btn btn--secondary password-toggle"
                                on:click={() => (showCurrentPassword = !showCurrentPassword)}
                                disabled={isLoading}
                                title={showCurrentPassword
                                    ? $LL.profileSetupToggleHide()
                                    : $LL.profileSetupToggleShow()}
                                aria-label={showCurrentPassword
                                    ? $LL.profileSetupToggleHide()
                                    : $LL.profileSetupToggleShow()}
                            >
                                <Icon
                                    name={showCurrentPassword ? 'eye-disabled' : 'eye'}
                                    size={20}
                                    className={`password-toggle-icon${showCurrentPassword ? ' password-toggle-icon--disabled' : ''}`}
                                />
                            </button>
                        </div>
                    </div>

                    <NewPasswordFields
                        bind:password={newPassword}
                        bind:confirmPassword={confirmNewPassword}
                        idPrefix="new-master"
                        passwordLabel={$LL.settingsMenuPasswordNewLabel()}
                        confirmLabel={$LL.settingsMenuPasswordConfirmLabel()}
                        passwordPlaceholder={$LL.settingsMenuPasswordNewPlaceholder()}
                        confirmPlaceholder={$LL.settingsMenuPasswordConfirmPlaceholder()}
                        disabled={isLoading}
                        stackedRequirements
                    />

                    <div class="form-actions">
                        <button
                            type="button"
                            class="btn btn--secondary"
                            on:click={onCancelChangingPassword}
                            disabled={isLoading}
                        >
                            {$LL.profileSetupCancel()}
                        </button>
                        <button
                            type="button"
                            class="btn btn--primary"
                            on:click={onSaveNewPassword}
                            disabled={isLoading ||
                                !currentPassword ||
                                !newPassword ||
                                !confirmNewPassword}
                        >
                            {isLoading
                                ? $LL.settingsMenuPasswordChanging()
                                : $LL.settingsMenuPasswordChange()}
                        </button>
                    </div>
                </div>
            {:else}
                <button type="button" class="btn btn--secondary" on:click={onStartChangingPassword}>
                    {$LL.settingsMenuPasswordChangeAction()}
                </button>
            {/if}
        </div>

        <div class="settings-dialog__section">
            <h4 class="settings-dialog__heading">
                {$LL.settingsMenuOptionsTitle()}
            </h4>
            <div class="form-group">
                <label class="checkbox-label">
                    <input
                        type="checkbox"
                        bind:checked={settings.enterKeySendsMessage}
                        on:change={onUpdateSettings}
                    />
                    <span class="checkbox-text">{$LL.settingsMenuOptionsEnterKeyLabel()}</span>
                </label>
                <small class="form-help">
                    {$LL.settingsMenuOptionsEnterKeyDescription()}
                </small>
            </div>
            <div class="form-group">
                <label class="checkbox-label">
                    <input
                        type="checkbox"
                        bind:checked={settings.use24HourTime}
                        on:change={onUpdateSettings}
                    />
                    <span class="checkbox-text">{$LL.settingsMenuUse24HourTime()}</span>
                </label>
            </div>
        </div>

        <div class="settings-dialog__section">
            <h4 class="settings-dialog__heading">
                {$LL.settingsMenuTutorialTitle()}
            </h4>
            <p class="password-info">{$LL.settingsMenuTutorialInfo()}</p>
            <button type="button" class="btn btn--secondary" on:click={onRedoTutorial}>
                {$LL.settingsMenuTutorialAction()}
            </button>
        </div>
    {:else}
        <div class="no-profile">
            <p>{$LL.settingsMenuNoProfile()}</p>
        </div>
    {/if}
</div>

<style lang="scss">
    .language-helper {
        margin-top: 0.5rem;
        color: var(--color-text-muted);
        font-size: 0.9rem;
    }

    .password-change-form {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;

        /* The flex gap already separates the last field; keep the button row
           from stacking its own margin on top of it. */
        .form-actions {
            margin-top: 0.25rem;
        }
    }

    .form-actions {
        display: flex;
        gap: 1rem;
        margin-top: 1.5rem;
        flex-wrap: wrap;

        @media (max-width: 600px) {
            flex-direction: column;
        }
    }

    .profile-field .profile-label {
        display: block;
        font-size: 0.8rem;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 0.25rem;
    }

    .profile-field {
        margin-bottom: 1rem;
    }

    .profile-value {
        font-size: 1rem;
        color: var(--color-text);
        font-weight: 500;
    }

    .contacts-description {
        margin-top: 0;
        margin-bottom: 1.25rem;
    }

    .contact-fields {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .contact-row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
    }

    .contact-app-select {
        flex: 0 0 auto;
        width: auto;
        min-width: 8.5rem;
    }

    .contact-label-input {
        flex: 1 1 8rem;
        min-width: 0;
    }

    .contact-value-input {
        flex: 1 1 10rem;
        min-width: 0;
    }

    .contact-remove {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.5rem;
    }

    .contact-add {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        margin-top: 0.25rem;
    }

    .contact-add-glyph {
        font-size: 1.15rem;
        line-height: 1;
    }

    .password-info {
        color: var(--color-text-muted);
        font-size: 0.9rem;
        margin-bottom: 1rem;
    }

    .no-profile {
        text-align: center;
        color: var(--color-text-muted);
        font-size: 0.9rem;
        font-style: italic;
    }
</style>
