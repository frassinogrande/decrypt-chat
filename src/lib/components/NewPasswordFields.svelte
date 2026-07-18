<script lang="ts">
    import Icon from '$lib/components/icons/Icon.svelte';
    import PasswordStrengthGauge from './PasswordStrengthGauge.svelte';
    import { translations as LL } from '$lib/i18n/runtime';

    // A password + confirmation pair with a shared reveal toggle and an advisory
    // strength gauge. Strength is never enforced here; callers decide what to do
    // with a weak password (see isWeakPassword + WeakPasswordDialog).
    export let password: string;
    export let confirmPassword: string;
    export let passwordLabel: string;
    export let confirmLabel: string;
    export let passwordPlaceholder: string = '';
    export let confirmPlaceholder: string = '';
    export let help: string = '';
    export let idPrefix: string;
    export let disabled: boolean = false;
    export let required: boolean = false;
    // Set in narrow containers (e.g. the settings dialog) where the strength
    // checklist has no room for two columns.
    export let stackedRequirements: boolean = false;

    let showPassword = false;
    let showMismatch = false;

    // Never leave a password revealed once the fields are cleared (form closed
    // or submitted successfully).
    $: if (!password && !confirmPassword) showPassword = false;

    $: passwordId = `${idPrefix}-password`;
    $: confirmId = `${idPrefix}-confirm`;
    $: helpId = `${idPrefix}-password-help`;
    $: gaugeId = `${idPrefix}-password-gauge`;
    $: passwordDescribedBy = help ? `${helpId} ${gaugeId}` : gaugeId;
    $: toggleLabel = showPassword ? $LL.profileSetupToggleHide() : $LL.profileSetupToggleShow();

    function handleConfirmBlur() {
        showMismatch = password.length > 0 && confirmPassword.length > 0 && password !== confirmPassword;
    }
</script>

<div class="form-group">
    <label for={passwordId}>{passwordLabel}</label>
    <div class="password-input-container">
        <input
            id={passwordId}
            type={showPassword ? 'text' : 'password'}
            value={password}
            on:input={(e) => (password = e.currentTarget.value)}
            placeholder={passwordPlaceholder}
            {disabled}
            {required}
            autocomplete="new-password"
            class="input"
            aria-describedby={passwordDescribedBy}
        />
        <button
            type="button"
            class="btn btn--secondary password-toggle"
            on:click={() => (showPassword = !showPassword)}
            {disabled}
            title={toggleLabel}
            aria-label={toggleLabel}
        >
            <Icon
                name={showPassword ? 'eye-disabled' : 'eye'}
                size={20}
                className={`password-toggle-icon${showPassword ? ' password-toggle-icon--disabled' : ''}`}
            />
        </button>
    </div>
    {#if help}
        <small class="form-help" id={helpId}>{help}</small>
    {/if}
    <div id={gaugeId}>
        <PasswordStrengthGauge {password} stacked={stackedRequirements} />
    </div>
</div>

<div class="form-group">
    <label for={confirmId}>{confirmLabel}</label>
    <div class="password-input-container">
        <input
            id={confirmId}
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            on:input={(e) => {
                confirmPassword = e.currentTarget.value;
                showMismatch = false;
            }}
            on:blur={handleConfirmBlur}
            placeholder={confirmPlaceholder}
            {disabled}
            {required}
            autocomplete="new-password"
            class="input"
            aria-invalid={showMismatch ? 'true' : undefined}
        />
        <button
            type="button"
            class="btn btn--secondary password-toggle"
            on:click={() => (showPassword = !showPassword)}
            {disabled}
            title={toggleLabel}
            aria-label={toggleLabel}
        >
            <Icon
                name={showPassword ? 'eye-disabled' : 'eye'}
                size={20}
                className={`password-toggle-icon${showPassword ? ' password-toggle-icon--disabled' : ''}`}
            />
        </button>
    </div>
    <!-- Persistent live node: mounted from the start so screen readers announce
         the mismatch when its text appears. -->
    <div class="mismatch-message" role="status"
        >{#if showMismatch}{$LL.profileSetupErrorMismatch()}{/if}</div
    >
</div>

<style lang="scss">
    /* The two groups are laid out by the parent form's flex gap; inside a group
       the gap replaces the global label margin. */
    .form-group {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .form-group label {
        font-weight: 500;
        color: var(--color-text);
        font-size: 0.9rem;
        margin-bottom: 0;
    }

    .form-help {
        color: var(--color-text-muted);
        font-size: 0.8rem;
        line-height: 1.3;
        margin-top: 0;
        margin-bottom: 0.5rem;
    }

    /* Always mounted for the live region; takes no space while empty. */
    .mismatch-message {
        color: var(--color-error-text);
        font-size: 0.8rem;
        line-height: 1.3;

        &:empty {
            display: none;
        }
    }
</style>
