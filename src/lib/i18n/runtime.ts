import { browser } from '$app/environment';
import { derived, writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import {
    DEFAULT_LOCALE,
    LOCALE_STORAGE_KEY,
    matchSupportedLocale,
    normalizeLocale,
} from './config';
import type { Locale } from './config';
import { availableLanguageTags, setLanguageTag, sourceLanguageTag } from '$paraglide/runtime';
import * as messages from '$paraglide/messages';

const localeStore = writable<Locale>(DEFAULT_LOCALE);

export const locale: Readable<Locale> = derived(localeStore, ($locale) => $locale);

export const translations: Readable<typeof messages> = derived(localeStore, () => ({
    ...messages,
}));

export const SUPPORTED_LANGUAGE_TAGS = availableLanguageTags as readonly string[];
export const SOURCE_LANGUAGE_TAG = sourceLanguageTag;

/**
 * Switch the active locale in Paraglide, the store, and the DOM without
 * persisting it. Use for applying an auto-detected locale that should not stick.
 */
export async function applyLocale(tag: Locale) {
    const normalized = normalizeLocale(tag);
    await setLanguageTag(normalized);
    localeStore.set(normalized);
    if (browser) {
        document.documentElement.lang = normalized;
    }
}

/**
 * Update the active locale and persist it as the user's explicit choice in
 * localStorage. The app sets no cookies, so the preference is stored the same
 * way as every other setting.
 */
export async function setLocale(tag: Locale) {
    const normalized = normalizeLocale(tag);
    await applyLocale(normalized);
    if (browser) {
        try {
            localStorage.setItem(LOCALE_STORAGE_KEY, normalized);
        } catch {
            // Storage can be unavailable (private mode, quota); the choice simply
            // won't persist across visits, which is acceptable.
        }
    }
}

function readStoredLocale(): string | null {
    if (!browser) return null;
    try {
        return localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
        return null;
    }
}

/**
 * Determines the locale to hydrate with on the client.
 *
 * On a static deploy the server-negotiated `serverLocale` is baked at build
 * time (always the default), so real detection has to happen here. An explicit
 * prior choice (localStorage) always wins; otherwise the browser's preferred
 * languages are matched against the supported set. Auto-detected locales are
 * NOT persisted, so detection re-runs each visit until the user picks one.
 */
export function detectClientLocale(serverLocale: Locale): Locale {
    if (!browser) return serverLocale;

    const storedLocale = matchSupportedLocale(readStoredLocale());
    if (storedLocale) return storedLocale;

    const preferred = navigator.languages ?? [navigator.language];
    for (const candidate of preferred) {
        const matched = matchSupportedLocale(candidate);
        if (matched) return matched;
    }

    return serverLocale;
}

/**
 * Hydrate the locale early in the client lifecycle. Does not persist anything:
 * only an explicit choice via setLocale should stick.
 *
 * On the client, the Paraglide tag is switched BEFORE the store update so the
 * derived `translations` store re-computes against the correct language on the
 * first render. Order matters: if the store were set first (or set to a value
 * it already holds), Svelte's equality check would skip notifying and the UI
 * would keep rendering the previous language even after the tag changed.
 * Guarded to the browser so SSR/prerender never mutates the shared module tag.
 */
export function initializeLocale(tag: Locale) {
    const normalized = normalizeLocale(tag);
    if (browser) {
        setLanguageTag(normalized);
    }
    localeStore.set(normalized);
    if (browser) {
        document.documentElement.lang = normalized;
    }
}
