<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { translations as LL } from '$lib/i18n/runtime';

    const dispatch = createEventDispatcher<{
        'session-unlocked': { password: string };
        cancel: void;
    }>();

    export let error = '';

    let password = '';
    let isLoading = false;
    let showPassword = false;

    // Reset loading state when error changes (indicates completion of unlock attempt)
    $: if (error) {
        isLoading = false;
    }

    async function handleUnlock() {
        // In-flight guard against double submission.
        if (isLoading) {
            return;
        }

        if (!password) {
            return;
        }

        isLoading = true;

        try {
            dispatch('session-unlocked', { password });
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
    // would trigger an unlock attempt from the Cancel button.
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

<div class="unlock-overlay">
    <div class="unlock-dialog">
        <div class="unlock-header">
            <div class="lock-icon" aria-hidden="true">
                <Icon name="padlock" size={40} className="lock-icon-graphic" />
            </div>
            <h2>{$LL.sessionUnlockTitle()}</h2>
            <p>{$LL.sessionUnlockSubtitle()}</p>
        </div>

        <form on:submit|preventDefault={handleUnlock} class="unlock-form">
            {#if error}
                <div class="error-message" role="alert">
                    {error}
                </div>
            {/if}

            <div class="password-group">
                <label for="session-password" class="visually-hidden"
                    >{$LL.sessionUnlockPasswordLabel()}</label
                >
                <div class="password-input-container">
                    <input
                        bind:this={passwordInput}
                        id="session-password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        on:input={(e) => (password = e.currentTarget.value)}
                        placeholder={$LL.sessionUnlockPasswordPlaceholder()}
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
                        title={showPassword
                            ? $LL.sessionUnlockToggleHide()
                            : $LL.sessionUnlockToggleShow()}
                        aria-label={showPassword
                            ? $LL.sessionUnlockToggleHide()
                            : $LL.sessionUnlockToggleShow()}
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
                    type="button"
                    class="btn btn--secondary"
                    on:click={handleCancel}
                    disabled={isLoading}
                >
                    {$LL.sessionUnlockCancel()}
                </button>
                <button
                    type="submit"
                    class="btn btn--primary"
                    disabled={isLoading || !password}
                >
                    {#if isLoading}
                        <span class="loading-spinner" aria-hidden="true"></span>
                        {$LL.sessionUnlockSubmitting()}
                    {:else}
                        <Icon name="padlock" size={18} /> {$LL.sessionUnlockSubmit()}
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
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        min-height: 100svh;
        padding: 1rem;
        z-index: 2000;
    }

    .unlock-dialog {
        background: var(--color-dialog-bg);
        border-radius: 20px;
        padding: 2rem;
        width: 100%;
        max-width: 420px;
        box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
        animation: slideIn 0.3s ease-out;
        backdrop-filter: blur(10px);
    }

    @keyframes slideIn {
        from {
            opacity: 0;
            transform: translateY(-20px) scale(0.95);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    .unlock-header {
        text-align: center;
        margin-bottom: 1.5rem;
    }

    .lock-icon {
        margin-bottom: 0.75rem;
        opacity: 0.8;
        color: var(--color-text);
    }

    .lock-icon :global(.lock-icon-graphic) {
        width: 2.5rem;
        height: 2.5rem;
    }

    .unlock-header h2 {
        margin: 0 0 0.5rem 0;
        color: var(--color-text);
        font-size: 1.3rem;
        font-weight: 600;
    }

    .unlock-header p {
        margin: 0;
        color: var(--color-text-muted);
        font-size: 0.85rem;
        line-height: 1.4;
        text-wrap: pretty;
    }

    .unlock-form {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
    }

    .unlock-actions {
        display: flex;
        gap: 0.75rem;
        margin-top: 0.5rem;
    }

    .unlock-actions .btn {
        flex: 1;
    }

    .loading-spinner {
        width: 14px;
        height: 14px;
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
        padding: 0.75rem;
        border-radius: 12px;
        font-size: 0.85rem;
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
            padding: 1.25rem;
            margin: 0.5rem;
        }

        .unlock-header h2 {
            font-size: 1.2rem;
        }

        .lock-icon :global(.lock-icon-graphic) {
            width: 2rem;
            height: 2rem;
        }

        .unlock-actions {
            flex-direction: column;
        }
    }
</style>
