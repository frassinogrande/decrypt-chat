// Build a single self-contained index.html that runs from file:// with no server.
//
// Post-processing only: reads the normal `build/` output and writes
// `build-singlefile/index.html`. It never touches src/, so the production
// bundle deployed to Pages is unaffected by anything in here.
//
// Why a single file at all: module scripts are fetched under CORS, and a
// file:// page has origin "null", so a multi-file build cannot boot from disk.
// Inlining everything removes every runtime fetch. Inline <script type="module">
// itself is fine on file:// (verified in Chromium and Firefox).
//
// Usage: npm run build && node scripts/build-singlefile.js

import fs from 'fs';
import path from 'path';
import * as esbuild from 'esbuild';

const buildDir = path.resolve('build');
const outDir = path.resolve('build-singlefile');
const indexPath = path.join(buildDir, 'index.html');

if (!fs.existsSync(indexPath)) {
    console.error('build/index.html not found. Run `npm run build` first.');
    process.exit(1);
}

const html = fs.readFileSync(indexPath, 'utf8');

const MIME = {
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
};

const dataUri = (file) => {
    const buf = fs.readFileSync(file);
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
};

// The SvelteKit bootstrap assigns a per-build global (__sveltekit_xxxxx) that the
// client reads for `base`. The suffix is regenerated every build, so read it out
// rather than hardcoding.
const kitGlobal = html.match(/(__sveltekit_[a-z0-9]+)\s*=/i)?.[1];
if (!kitGlobal) {
    console.error('Could not find the __sveltekit_* global in build/index.html.');
    process.exit(1);
}

const entryDir = path.join(buildDir, '_app', 'immutable', 'entry');
const startFile = fs.readdirSync(entryDir).find((f) => f.startsWith('start.'));
const appFile = fs.readdirSync(entryDir).find((f) => f.startsWith('app.'));
if (!startFile || !appFile) {
    console.error('Could not find start.*.js / app.*.js in', entryDir);
    process.exit(1);
}

// document.currentScript is null inside a module, so the mount node is looked up
// explicitly rather than via currentScript.parentElement. The base global is set
// by a classic script emitted ahead of this one: ESM imports are evaluated before
// the module body runs, so assigning it here would be too late for the client to
// read it.
const entrySource = `
import * as kit from './${startFile}';
import * as app from './${appFile}';
kit.start(app, document.getElementById('sf-root'));
`;

// On file:// location.pathname is the full path to this document. Left as '',
// the router resolves /home/.../index.html against no known route and renders
// the 404 page, so base has to absorb the whole path.
//
// The router then normalises the root route to base + '/', and Chromium rejects
// replaceState to "…/index.html/" as a cross-document URL. The app's own
// navigation always calls pushState with no URL, so keeping the address bar
// unchanged costs nothing here; only SvelteKit's cosmetic normalisation is lost.
const baseScript = `window.${kitGlobal}={base:location.pathname};
(function(){for(const m of ['pushState','replaceState']){const f=history[m].bind(history);history[m]=function(s,t,u){try{return f(s,t,u)}catch(e){return f(s,t,location.href)}}}})();`;

const result = await esbuild.build({
    stdin: { contents: entrySource, resolveDir: entryDir, sourcefile: 'sf-entry.js' },
    bundle: true,
    format: 'esm',
    splitting: false,
    minify: true,
    write: false,
    legalComments: 'none',
    target: ['es2022'],
});

let js = result.outputFiles[0].text;

// Blanking a dep path to "" makes vite's preload helper resolve it against the
// document and refetch the page itself, which fails CORS on file://. An empty
// data: URL is inert and costs nothing to "load".
const INERT_URL = '"data:text/javascript,"';

const applied = [];
const replace = (label, pattern, replacement) => {
    const before = js;
    js = js.replace(pattern, replacement);
    applied.push(`${label}: ${before === js ? 'NO MATCH' : 'ok'}`);
};

// Icons resolve to `${base}/assets/icons/sprite.svg#icon-NAME`. The sprite is
// inlined into the document, so point <use> at the local fragment instead.
replace(
    'sprite -> inline fragment',
    /`\$\{\w+\}\/assets\/icons\/sprite\.svg#icon-\$\{(\w+)\}`/g,
    (_m, v) => '`#icon-${' + v + '}`'
);

const landingImage = path.join(buildDir, 'landing-image.jpg');
if (fs.existsSync(landingImage)) {
    const uri = dataUri(landingImage);
    replace('landing image -> data URI', /`\$\{\w+\}\/landing-image\.jpg`/g, () =>
        JSON.stringify(uri)
    );
}

// The KDF worker is loaded from a URL relative to import.meta.url, which a
// file:// page cannot construct a Worker from. Inline the worker source and
// hand it over as a blob instead. Without this the app still works, but falls
// back to 600k-iteration PBKDF2 on the main thread and locks the UI.
const workerDir = path.join(buildDir, '_app', 'immutable', 'workers');
if (fs.existsSync(workerDir)) {
    const workerFile = fs.readdirSync(workerDir).find((f) => f.endsWith('.js'));
    if (workerFile) {
        const workerSrc = fs.readFileSync(path.join(workerDir, workerFile), 'utf8');
        const blobExpr = `URL.createObjectURL(new Blob([${JSON.stringify(
            workerSrc
        )}],{type:"text/javascript"}))`;
        replace(
            'kdf worker -> blob URL',
            /""\s*\+\s*new URL\([^)]*workers\/[^)]*import\.meta\.url\)/g,
            () => blobExpr
        );
    }
}

// Relative url() references (e.g. ../../../brand-backdrop-tile.png) resolved
// against _app/immutable/assets/ originally; inlined into the document they
// resolve against the document's directory and miss. Inline the targets too.
const inlineCssUrls = (css, baseDir) =>
    css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (m, url) => {
        if (url.startsWith('data:') || url.startsWith('#')) return m;
        const file = path.resolve(baseDir, url.split(/[?#]/)[0]);
        return fs.existsSync(file) ? `url(${dataUri(file)})` : m;
    });

const cssAssetDir = path.join(buildDir, '_app', 'immutable', 'assets');
const cssFiles = (fs.existsSync(cssAssetDir) ? fs.readdirSync(cssAssetDir) : [])
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => inlineCssUrls(fs.readFileSync(path.join(cssAssetDir, f), 'utf8'), cssAssetDir));

// Route CSS is inlined below, but SvelteKit still injects <link> tags for it at
// runtime. Those 404 harmlessly on file://; blanking the paths keeps the console
// clean. Indices in the vite dep array must stay intact, so swap contents only.
replace('route css paths -> inert', /"\.\.\/assets\/[^"]+\.css"/g, () => INERT_URL);

// Same for the JS dep list vite hands to its preload helper: every chunk is
// already inlined, so the only thing left to do is stop it fetching them.
replace('chunk preload paths -> inert', /"\.\.\/(?:nodes|chunks|entry)\/[^"]+\.js"/g, () => INERT_URL);

// SvelteKit's built-in "check for a redeployed version" call fires on every
// navigation, including the first, and fetches `${base}/_app/version.json` —
// a cross-resource file:// fetch the browser's per-file-origin isolation
// blocks. The app's own try/catch swallows the rejection cleanly, but the
// browser still logs its own native security diagnostic straight to the
// console ahead of that, which is loud and alarming for something with no
// real effect. There is no redeployed version to check against in a
// downloaded single file, so drop the fetch target to something that always
// resolves and never parses as JSON, landing in the existing catch exactly
// like a real "no update available" response would.
replace(
    'version-check fetch -> inert',
    /`\$\{\w+\}\/_app\/version\.json`/g,
    () => INERT_URL
);

const fontCssPath = path.join(buildDir, 'fonts', 'open-sans.css');
let fontCss = '';
if (fs.existsSync(fontCssPath)) {
    fontCss = fs
        .readFileSync(fontCssPath, 'utf8')
        .replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (m, url) => {
            const file = path.join(buildDir, 'fonts', path.basename(url.split('?')[0]));
            return fs.existsSync(file) ? `url(${dataUri(file)})` : m;
        });
}

const spritePath = path.join(buildDir, 'assets', 'icons', 'sprite.svg');
let sprite = '';
if (fs.existsSync(spritePath)) {
    sprite = fs
        .readFileSync(spritePath, 'utf8')
        .replace(/<\?xml[\s\S]*?\?>/g, '')
        .replace(/<svg/, '<svg aria-hidden="true" style="display:none"');
}

const themeScript = html.match(/<script>([\s\S]*?profile-settings[\s\S]*?)<\/script>/)?.[1] ?? '';
const lang = html.match(/<html[^>]*lang="([^"]*)"/)?.[1] ?? 'en';
const themeColor = html.match(/<meta[^>]*name="theme-color"[^>]*>/g)?.join('\n        ') ?? '';

const favicon = fs.existsSync(path.join(buildDir, 'favicon.svg'))
    ? `<link rel="icon" type="image/svg+xml" href="${dataUri(path.join(buildDir, 'favicon.svg'))}" />`
    : '';

// No CSP meta here. The build's hash-based policy covers the original inline
// bootstrap, which no longer exists in this artifact, and 'self' plus
// upgrade-insecure-requests mean the wrong thing on file://.
const out = `<!doctype html>
<html lang="${lang}">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        ${themeColor}
        ${favicon}
        <style>${fontCss}</style>
        <style>${cssFiles.join('\n')}</style>
        <script>${themeScript}</script>
    </head>
    <body data-sveltekit-preload-data="hover">
        ${sprite}
        <div id="sf-root" style="display: contents"></div>
        <script>${baseScript}</script>
        <script type="module">${js}</script>
    </body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'index.html');
fs.writeFileSync(outPath, out);

console.log('Transforms:');
applied.forEach((a) => console.log('  ' + a));
console.log(`Wrote ${outPath} (${(out.length / 1024 / 1024).toFixed(2)} MB)`);
