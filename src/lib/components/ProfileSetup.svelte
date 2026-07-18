<script lang="ts">
    import { debug } from '$lib/utils/debug';
    import { get } from 'svelte/store';
    import { createEventDispatcher } from 'svelte';
    import { profileManager } from '../utils/profile-manager';
    import NewPasswordFields from './NewPasswordFields.svelte';
    import WeakPasswordDialog from './WeakPasswordDialog.svelte';
    import { isWeakPassword } from '../utils/password-strength';
    import { translations as LL } from '$lib/i18n/runtime';

    const dispatch = createEventDispatcher();

    export let isRequired: boolean = false; // When true, hide cancel button

    let masterPassword = '';
    let confirmPassword = '';
    let isLoading = false;
    let error = '';
    let showWeakPasswordDialog = false;

    // The strength gauge is advisory only; the password is not required to meet
    // any strength bar. We just need a non-empty password that matches its confirmation.
    $: canSubmit = masterPassword.length > 0 && masterPassword === confirmPassword;

    async function handleSubmit() {
        error = '';

        if (!masterPassword) {
            error = get(LL).profileSetupErrorPasswordRequired();
            return;
        }

        if (masterPassword !== confirmPassword) {
            error = get(LL).profileSetupErrorMismatch();
            return;
        }

        // Soft nudge: if the password is weak, confirm before going ahead.
        if (isWeakPassword(masterPassword)) {
            showWeakPasswordDialog = true;
            return;
        }

        await createProfile();
    }

    function confirmWeakPassword() {
        showWeakPasswordDialog = false;
        createProfile();
    }

    function cancelWeakPassword() {
        showWeakPasswordDialog = false;
    }

    async function createProfile() {
        isLoading = true;

        try {
            const profile = await profileManager.createProfile(masterPassword);

            dispatch('profile-created', { profile, masterPassword });
        } catch (err) {
            error = get(LL).profileSetupErrorCreateFailed();
            debug.error('Profile creation error:', err);
        } finally {
            isLoading = false;
        }
    }

    function handleCancel() {
        dispatch('cancel');
    }
</script>

<div class="profile-setup-container brand-backdrop">
    <div class="profile-setup-card">
        <div class="header">
            <h1>{$LL.profileSetupTitle()}</h1>
            <p>{$LL.profileSetupSubtitle()}</p>
        </div>

        <form on:submit|preventDefault={handleSubmit} class="profile-form">
            {#if error}
                <div class="error-message" role="alert">
                    {error}
                </div>
            {/if}

            <NewPasswordFields
                bind:password={masterPassword}
                bind:confirmPassword
                idPrefix="master"
                passwordLabel={$LL.profileSetupMasterLabel()}
                confirmLabel={$LL.profileSetupConfirmLabel()}
                passwordPlaceholder={$LL.profileSetupMasterPlaceholder()}
                confirmPlaceholder={$LL.profileSetupConfirmPlaceholder()}
                help={$LL.profileSetupPasswordHelp()}
                disabled={isLoading}
                required
            />

            <div class="form-actions">
                {#if !isRequired}
                    <button
                        type="button"
                        class="btn btn--secondary"
                        on:click={handleCancel}
                        disabled={isLoading}
                    >
                        {$LL.profileSetupCancel()}
                    </button>
                {/if}
                <button
                    type="submit"
                    class="btn btn--primary"
                    data-full-width={isRequired ? 'true' : undefined}
                    disabled={isLoading || !canSubmit}
                >
                    {#if isLoading}
                        {$LL.profileSetupSubmitting()}
                    {:else}
                        {$LL.profileSetupSubmit()}
                    {/if}
                </button>
            </div>
        </form>
    </div>
</div>

<WeakPasswordDialog
    show={showWeakPasswordDialog}
    on:confirm={confirmWeakPassword}
    on:cancel={cancelWeakPassword}
/>

<style>
    .profile-setup-container {
        min-height: 100vh;
        min-height: 100svh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
    }

    .profile-setup-card {
        background: var(--color-dialog-bg);
        border-radius: 16px;
        padding: 2rem;
        width: 100%;
        max-width: 500px;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
    }

    .header {
        text-align: center;
        margin-bottom: 2rem;
    }

    .header h1 {
        margin: 0 0 0.5rem 0;
        color: var(--color-text);
        font-size: 1.75rem;
        font-weight: 600;
    }

    .header p {
        margin: 0;
        color: var(--color-text-muted);
        font-size: 1rem;
        line-height: 1.4;
    }

    .profile-form {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .form-actions {
        display: flex;
        gap: 1rem;
    }

    .form-actions :global(.btn.btn--secondary) {
        flex: 1;
    }

    .form-actions :global(.btn.btn--primary) {
        flex: 2;
    }

    .form-actions :global(.btn.btn--primary[data-full-width]) {
        flex: 1;
        width: 100%;
    }

    .error-message {
        background: var(--color-error-bg);
        border: 1px solid var(--color-error-border);
        color: var(--color-error-text);
        padding: 0.75rem;
        border-radius: 8px;
        font-size: 0.9rem;
        text-align: center;
    }

    @media (max-width: 600px) {
        .profile-setup-card {
            padding: 1.5rem;
            margin: 0.5rem;
        }

        .header h1 {
            font-size: 1.5rem;
        }

        .form-actions {
            flex-direction: column;
        }

        .form-actions :global(.btn.btn--primary) {
            flex: 1;
        }
    }
</style>
