// Ensure GitHub Pages-friendly output: copy the SPA fallback (404.html) to
// index.html so the site has an entry page.
//
// Deliberately NO URL rewriting here. The fallback's inline bootstrap script is
// covered by a CSP sha256 hash computed by SvelteKit at build time; editing the
// script after the fact changes its hash and the browser then blocks it, which
// breaks the entire app on production serves (blank page, no service worker).
// Absolute "/_app/..." URLs are correct for a root deploy, and a subpath deploy
// (GitHub Pages project site) must instead set BASE_PATH at build time so
// SvelteKit bakes the prefix in with the hash intact. Relative URLs would also
// misresolve when GitHub Pages serves 404.html for nested missing paths.

import fs from 'fs';
import path from 'path';

const buildDir = path.resolve('build');
const indexPath = path.join(buildDir, 'index.html');
const fallBackPath = path.join(buildDir, '404.html');

if (!fs.existsSync(buildDir)) {
    process.exit(0);
}

if (fs.existsSync(fallBackPath) && !fs.existsSync(indexPath)) {
    fs.copyFileSync(fallBackPath, indexPath);
    console.log('Created build/index.html from 404.html for GitHub Pages.');
}
