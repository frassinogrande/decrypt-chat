<script lang="ts">
    import { base } from '$app/paths';
    import { page } from '$app/stores';
    import { translations as LL } from '$lib/i18n/runtime';

    $: status = $page.status;
    $: title = status === 404 ? $LL.errorNotFoundTitle() : $LL.errorGenericTitle();
</script>

<svelte:head>
    <title>{title}</title>
</svelte:head>

<main class="error-page">
    <p class="error-page__status">{status}</p>
    <h1 class="error-page__title">{title}</h1>
    <a class="btn btn--primary" href="{base}/">{$LL.errorBackHome()}</a>
</main>

<style lang="scss">
    .error-page {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1rem;
        min-height: 100vh;
        min-height: 100svh;
        padding: 2rem;
        text-align: center;
        background: var(--color-bg);
        color: var(--color-text);
    }

    .error-page__status {
        margin: 0;
        font-size: 3rem;
        font-weight: 600;
        line-height: 1;
        color: var(--color-text-subtle);
    }

    .error-page__title {
        margin: 0 0 0.5rem;
        font-size: 1.35rem;
        font-weight: 600;
    }
</style>
