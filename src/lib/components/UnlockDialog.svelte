<script lang="ts">
    import { debug } from '$lib/utils/debug';
	import { get } from 'svelte/store';
    import { createEventDispatcher } from 'svelte';
    import { profileManager } from '../utils/profile-manager';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { translations as LL } from '$lib/i18n/runtime';

    const dispatch = createEventDispatcher();

    const fallbackUnlockUsername = 'decrypt-chat-local-profile';
    let masterPassword = '';
    let isLoading = false;
    let error = '';
    let showPassword = false;

    async function handleUnlock() {
        // In-flight guard: makes double submission impossible even if a second
        // submit sneaks in before the disabled state renders.
        if (isLoading) {
            return;
        }

        if (!masterPassword) {
            error = get(LL).unlockErrorMissingPassword();
            return;
        }

        isLoading = true;
        error = '';

        try {
            const profile = await profileManager.unlockProfile(masterPassword);

            if (profile) {
                dispatch('profile-unlocked', { profile, masterPassword });
            } else {
                error = get(LL).unlockErrorInvalidPassword();
            }
        } catch (err) {
            error = get(LL).unlockErrorGeneric();
            debug.error('Profile unlock error:', err);
        } finally {
            isLoading = false;
        }
    }

    function handleCancel() {
        dispatch('cancel');
    }

    function togglePasswordVisibility() {
        showPassword = !showPassword;
    }

    // Enter is handled by the form's native submit; a global Enter handler
    // would hijack Enter on the show-password toggle and double-fire.
    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            handleCancel();
        }
    }

    let passwordInput: HTMLInputElement;
    $: if (passwordInput) {
        passwordInput.focus();
    }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="unlock-overlay brand-backdrop">
    <div class="unlock-dialog">
        <div class="unlock-header">
            <div class="lock-icon">
                <Icon name="padlock" size={28} className="unlock-lock-icon" />
            </div>
            <h1>{$LL.unlockTitle()}</h1>
            <p>{$LL.unlockSubtitle()}</p>
        </div>

        <form on:submit|preventDefault={handleUnlock} class="unlock-form">
            <div class="visually-hidden unlock-username-field" aria-hidden="true">
                <label for="unlock-username">{$LL.profileSetupNameLabel()}</label>
                <input
                    id="unlock-username"
                    type="text"
                    name="username"
                    autocomplete="username"
                    value={fallbackUnlockUsername}
                    readonly
                    tabindex="-1"
                />
            </div>
            {#if error}
                <div class="error-message" role="alert">
                    {error}
                </div>
            {/if}

            <div class="password-group">
                <label for="master-password" class="visually-hidden">{$LL.unlockPasswordLabel()}</label>
                <div class="password-input-container">
                    <input
                        bind:this={passwordInput}
                        id="master-password"
                        type={showPassword ? 'text' : 'password'}
                        value={masterPassword}
                        on:input={(e) => (masterPassword = e.currentTarget.value)}
                        placeholder={$LL.unlockPasswordPlaceholder()}
                        disabled={isLoading}
                        required
                        autocomplete="current-password"
                        class="input"
                    />
                    <button
                        type="button"
                        class="btn btn--secondary password-toggle"
                        on:click={togglePasswordVisibility}
                        disabled={isLoading}
                        title={showPassword ? $LL.profileSetupToggleHide() : $LL.profileSetupToggleShow()}
                        aria-label={showPassword ? $LL.profileSetupToggleHide() : $LL.profileSetupToggleShow()}
                    >
                        <Icon
                            name={showPassword ? 'eye-disabled' : 'eye'}
                            size={20}
                            className={`password-toggle-icon${showPassword ? ' password-toggle-icon--disabled' : ''}`}
                        />
                    </button>
                </div>
            </div>

            <div class="unlock-actions">
                <button
                    type="submit"
                    class="btn btn--primary full-width"
                    disabled={isLoading || !masterPassword}
                >
                    {#if isLoading}
                        <span class="loading-spinner" aria-hidden="true"></span>
                        {$LL.unlockSubmitting()}
                    {:else}
                        <Icon name="padlock" size={18} className="unlock-button-icon" />
                        <span>{$LL.unlockButton()}</span>
                    {/if}
                </button>
            </div>
        </form>
    </div>
</div>

<style>
    .unlock-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        min-height: 100svh;
        padding: 1rem;
    }

    .unlock-dialog {
        background: var(--color-dialog-bg);
        border-radius: 20px;
        padding: 2.5rem;
        width: 100%;
        max-width: 450px;
        box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
        animation: slideIn 0.4s ease-out;
        backdrop-filter: blur(10px);
    }

    @keyframes slideIn {
        from {
            transform: translateY(-20px) scale(0.95);
        }
        to {
            transform: translateY(0) scale(1);
        }
    }

    .unlock-header {
        text-align: center;
        margin-bottom: 2rem;
    }

    .lock-icon {
        margin-bottom: 1rem;
        opacity: 0.8;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .lock-icon :global(.unlock-lock-icon) {
        width: 2.25rem;
        height: 2.25rem;
        color: var(--color-text);
    }

    .unlock-header h1 {
        margin: 0 0 0.5rem 0;
        color: var(--color-text);
        font-size: 1.5rem;
        font-weight: 600;
    }

    .unlock-header p {
        margin: 0;
        color: var(--color-text-muted);
        font-size: 0.9rem;
        line-height: 1.4;
        text-wrap: pretty;
    }

    .unlock-form {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }



    .unlock-actions {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        margin-top: 0.5rem;
    }

    .full-width {
        width: 100%;
    }


    .loading-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top: 2px solid white;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .error-message {
        background: var(--color-error-bg);
        border: 1px solid var(--color-error-border);
        color: var(--color-error-text);
        padding: 0.875rem;
        border-radius: 12px;
        font-size: 0.9rem;
        text-align: center;
        animation: shake 0.5s ease-in-out;
    }

    @keyframes shake {
        0%,
        100% {
            transform: translateX(0);
        }
        25% {
            transform: translateX(-4px);
        }
        75% {
            transform: translateX(4px);
        }
    }

    @media (max-width: 600px) {
        .unlock-dialog {
            padding: 1.5rem;
            margin: 0.5rem;
        }

        .unlock-header h1 {
            font-size: 1.3rem;
        }

        .lock-icon :global(.unlock-lock-icon) {
            width: 2rem;
            height: 2rem;
        }

        .unlock-actions {
            flex-direction: column;
        }
    }
</style>
