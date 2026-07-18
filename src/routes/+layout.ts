import type { LayoutLoad } from './$types';
import { DEFAULT_LOCALE } from '$lib/i18n/config';

// No server load here (and none in a +layout.server.ts): on the static deploy a
// server load would make the client fetch /__data.json at runtime, which 404s on
// a static host and prevents the app from ever mounting. The locale seed is the
// build-time default; detectClientLocale in +layout.svelte does the real
// per-visitor detection in the browser.
export const load: LayoutLoad = async () => {
    return {
        locale: DEFAULT_LOCALE,
    };
};
