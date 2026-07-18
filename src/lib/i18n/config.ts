import type { RequestEvent } from '@sveltejs/kit';

export const SUPPORTED_LOCALES = ['en', 'es', 'de', 'fr', 'it', 'ru', 'pt-br', 'pt-pt'] as const;
export const DEFAULT_LOCALE: Locale = 'en';
/**
 * localStorage key holding the user's explicit language choice. The app is a
 * static site with client-side detection, so the preference lives in
 * localStorage like every other setting — no cookie is ever set.
 */
export const LOCALE_STORAGE_KEY = 'i18n-locale';

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Resolves a BCP-47 tag to a supported locale, or null if none matches.
 * Tries an exact match first, then falls back to the primary subtag: a bare
 * or regional tag matches the first supported entry sharing its primary subtag
 * (e.g. "de-AT" -> "de", and "pt" -> "pt-br" given the SUPPORTED_LOCALES order).
 */
export function matchSupportedLocale(tag: string | null | undefined): Locale | null {
    if (!tag) return null;
    const lowerTag = tag.toLowerCase();
    const directMatch = SUPPORTED_LOCALES.find((entry) => entry === lowerTag);
    if (directMatch) return directMatch;

    const primarySubtag = lowerTag.split('-')[0];
    const primaryMatch = SUPPORTED_LOCALES.find(
        (entry) => entry === primarySubtag || entry.split('-')[0] === primarySubtag
    );
    return primaryMatch ?? null;
}

export function normalizeLocale(tag: string | null | undefined): Locale {
    return matchSupportedLocale(tag) ?? DEFAULT_LOCALE;
}

/**
 * Parses an Accept-Language header into ordered locale tags.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
    if (!header) return [];
    return header
        .split(',')
        .map((part) => {
            const [tag, quality] = part.trim().split(';q=');
            return {
                tag: tag.toLowerCase(),
                quality: quality ? Number.parseFloat(quality) : 1,
            };
        })
        .filter((entry) => !Number.isNaN(entry.quality))
        .sort((a, b) => b.quality - a.quality)
        .map((entry) => entry.tag);
}

/**
 * Server-side locale hint from the Accept-Language header. On a static deploy
 * this only runs at build time (so it resolves to the default), and the real
 * per-visitor detection happens client-side in `detectClientLocale`. No cookie
 * is read or written: the app is entirely cookie-less.
 */
export function determineRequestLocale(event: RequestEvent): Locale {
    const acceptHeaderLocales = parseAcceptLanguage(event.request.headers.get('accept-language'));
    for (const candidate of acceptHeaderLocales) {
        const matched = matchSupportedLocale(candidate);
        if (matched) {
            return matched;
        }
    }

    return DEFAULT_LOCALE;
}
