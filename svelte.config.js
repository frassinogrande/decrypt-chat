import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
    preprocess: vitePreprocess(),

    kit: {
        adapter: adapter({
            pages: 'build',
            assets: 'build',
            // GitHub Pages SPA fallback
            fallback: '404.html',
            precompress: false,
            strict: true,
        }),
        // Make asset URLs relative so the site works from any subpath
        // Configure base for GitHub Pages project sites (e.g. "/repo-name") via env
        paths: {
            relative: true,
            base: process.env.BASE_PATH ?? '',
        },
        // Registered manually in +layout.svelte, production only: dev registration
        // fails with a SecurityError when the dev server is reached via a LAN IP the
        // local cert does not cover, and a dev service worker only causes stale caches.
        serviceWorker: {
            register: false,
        },
        alias: {
            '$paraglide/messages': './src/paraglide/messages.js',
            '$paraglide/runtime': './src/paraglide/runtime.js',
        },
        csp: {
            mode: 'hash',
            directives: {
                'default-src': ["'self'"],
                'base-uri': ["'none'"],
                'connect-src': ["'self'", 'blob:', 'data:'],
                'font-src': ["'self'"],
                'form-action': ["'none'"],
                'frame-ancestors': ["'none'"],
                'img-src': ["'self'", 'data:', 'blob:'],
                'manifest-src': ["'self'"],
                'media-src': ["'self'", 'blob:', 'data:'],
                'object-src': ["'none'"],
                'script-src': ["'self'", "'sha256-iNQ1WARzTwyowFUdIT9DyrujoLejB+kcSpywSu5OgP0='"],
                'style-src': ["'self'"],
                'style-src-attr': [
                    "'unsafe-hashes'",
                    "'sha256-tcbDxjMo+xKqM21aCGYbs/QAJqB7yUXC06oPWDapBgc='",
                ],
                'worker-src': ["'self'", 'data:', 'blob:'],
                'upgrade-insecure-requests': true,
            },
        },
    },
};

export default config;
