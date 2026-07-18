<script lang="ts">
    import { debug } from '$lib/utils/debug';
    import { onMount } from 'svelte';
    import { browser, dev } from '$app/environment';
    import { base } from '$app/paths';
    import '../app.scss';
    import { enforceFrameGuard, initializeSecurityMonitor } from '$lib/utils/security-monitor';
    import { detectClientLocale, initializeLocale } from '$lib/i18n/runtime';
    import { profileManager } from '$lib/utils/profile-manager';
    import { storageMonitor } from '$lib/utils/storage-monitor';
    import { applyTheme } from '$lib/utils/theme';
    import type { LayoutData } from './$types';

    export let data: LayoutData;
    // SvelteKit passes params to route components; declare it to avoid the dev-mode
    // "unknown prop" warning. This app has a single route, so it is always empty.
    // The trace read keeps the compiler from flagging the prop unused; it prints
    // nothing at the default debug level and is stripped from production builds.
    export let params: Record<string, string> | undefined = undefined;
    debug.trace('route params', params);

    // Clickjacking defense — run as early as possible (before onMount), since static
    // hosting can't send X-Frame-Options and frame-ancestors is ignored via <meta>.
    enforceFrameGuard();

    // Dev-only: SvelteKit warns on every native history.pushState/replaceState call,
    // with no config to opt out. Ours are deliberate (see navigateTo in +page.svelte:
    // views are UI state, not routes, and a past migration to SvelteKit's shallow
    // routing broke back/forward navigation). Drop exactly that warning, pass the rest.
    if (dev && browser) {
        const kitHistoryWarning = 'Avoid using `history.pushState(...)`';
        // eslint-disable-next-line no-console -- dev-only filter around SvelteKit's own console.warn
        const originalWarn = console.warn.bind(console);
        // eslint-disable-next-line no-console -- dev-only filter around SvelteKit's own console.warn
        console.warn = (...args: unknown[]) => {
            if (typeof args[0] === 'string' && args[0].startsWith(kitHistoryWarning)) {
                return;
            }
            originalWarn(...args);
        };
    }

    // On a static deploy the server-negotiated locale is baked at build time
    // (always the default), so detect the real locale on the client. An explicit
    // prior choice (localStorage) wins; otherwise the browser's languages decide.
    const initialLocale = detectClientLocale(data.locale);
    initializeLocale(initialLocale);

    onMount(() => {
        initializeSecurityMonitor();

        // Offline support: register the service worker in production builds only.
        // kit.serviceWorker.register is off in svelte.config.js because dev-server
        // registration fails over LAN IPs the local cert does not cover, and a dev
        // service worker only causes stale-cache confusion.
        if (!dev && 'serviceWorker' in navigator) {
            navigator.serviceWorker.register(`${base}/service-worker.js`).catch((error) => {
                debug.warn('Service worker registration failed', error);
            });
        }

        // Ask the browser not to evict our IndexedDB/localStorage (message history and
        // encryption keys) under storage pressure. Silently granted on Chromium/Safari
        // when heuristics allow; Firefox needs a user gesture (see Settings > Storage).
        storageMonitor.requestPersistence().catch(() => {});

        const unsubscribe = profileManager.settings.subscribe((s) => {
            applyTheme(s.themePreference ?? 'system');
        });
        return unsubscribe;
    });
</script>

<div style="display: block; width: 100%;">
    <!-- tabindex="-1" lets navigateTo() move focus here on view changes without
         adding main to the tab order. -->
    <main tabindex="-1">
        <slot />
    </main>
</div>

<style lang="scss">
    main:focus {
        outline: none;
    }
</style>
