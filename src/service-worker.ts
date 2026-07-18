/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { base, build, files, version } from '$service-worker';

// `self` inside a service worker is the ServiceWorkerGlobalScope, not Window.
const sw = self as unknown as ServiceWorkerGlobalScope;

// A unique cache name per deploy so old assets are evicted on activate.
const CACHE = `cache-${version}`;

// The SPA entry document. The app is not prerendered, so this page is the static adapter's
// fallback and appears in NEITHER `build` nor `files`. It has to be precached by hand: the
// first ever page load happens before this worker is active, so the document never passes
// through the fetch handler, and without this an offline launch would have no shell to serve.
// Cached as the root URL, not "/index.html": a static host serves index.html for "/", while
// `vite preview` runs the app as an SSR server where "/index.html" does not exist (and one
// failed URL aborts the whole atomic addAll install). "/" is a valid document on both.
const SHELL = `${base}/`;

// Deploy markers like /.nojekyll live in static/ but are not app assets: some servers
// (vite preview's static handler among them) refuse dotfiles, and a single failing URL
// aborts the whole atomic addAll() install, killing offline support. Exclude them.
const ASSETS = files.filter((file) => !file.split('/').pop()?.startsWith('.'));

// The full app shell: SvelteKit's built JS/CSS (`build`), everything in `static/` (`ASSETS`),
// and the entry document. This is all static app code — no messages, keys, or other sensitive
// data is ever fetched over HTTP, so nothing private is cached.
const PRECACHE = [...build, ...ASSETS, SHELL];

sw.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
    sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
            )
            .then(() => sw.clients.claim())
    );
});

sw.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only handle GET over http(s); ignore POST, chrome-extension:, data:, blob:, etc.
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    event.respondWith(handle(request, url));
});

async function handle(request: Request, url: URL): Promise<Response> {
    const cache = await caches.open(CACHE);

    // Page navigations (including the installed PWA launching at its start_url) always resolve
    // to the app shell. Every route is client-rendered from the same document, so any navigation
    // can be satisfied by it. Network-first keeps the shell fresh on a new deploy; offline, the
    // precached copy is what makes the PWA open at all.
    if (request.mode === 'navigate') {
        try {
            const response = await fetch(request);
            if (response.ok && response.type === 'basic') {
                cache.put(SHELL, response.clone());
            }
            return response;
        } catch (err) {
            const cached = await cache.match(SHELL);
            if (cached) return cached;
            throw err;
        }
    }

    // Precached app-shell assets: cache-first, they are content-hashed/static.
    if (url.origin === sw.location.origin && PRECACHE.includes(url.pathname)) {
        const cached = await cache.match(request);
        if (cached) return cached;
    }

    // Everything else: network-first, fall back to cache when offline, and
    // cache successful same-origin responses for later offline loads.
    try {
        const response = await fetch(request);
        if (url.origin === sw.location.origin && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw err;
    }
}
