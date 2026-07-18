export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_COLOR_LIGHT = '#006de2';
const THEME_COLOR_DARK = '#121212';

export function applyTheme(pref: ThemePreference): void {
    const root = document.documentElement;
    if (pref === 'dark') {
        root.setAttribute('data-theme', 'dark');
    } else if (pref === 'light') {
        root.setAttribute('data-theme', 'light');
    } else {
        root.removeAttribute('data-theme'); // falls back to @media query
    }
    syncThemeColorMeta(pref);
}

// Keeps the browser chrome (<meta name="theme-color">) in step with the app theme.
// The two tags in app.html are media-scoped for the 'system' case; an explicit
// preference overrides both so the chrome follows the app, not the OS.
function syncThemeColorMeta(pref: ThemePreference): void {
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    metas.forEach((meta) => {
        const forDark =
            pref === 'system'
                ? (meta.getAttribute('media') ?? '').includes('dark')
                : pref === 'dark';
        meta.setAttribute('content', forDark ? THEME_COLOR_DARK : THEME_COLOR_LIGHT);
    });
}
