// Post-process SvelteKit static build for file:// usage (no server)
// - Rewrites absolute asset URLs to relative
// - Removes CSP meta tag that can block file scheme
// Usage: node scripts/build-file.js

import fs from 'fs';
import path from 'path';

const buildDir = path.resolve('build');
const indexPath = path.join(buildDir, 'index.html');

if (!fs.existsSync(indexPath)) {
    console.error('build/index.html not found. Run `npm run build` first.');
    process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');

// Remove the CSP meta (it can block loading module files via file://)
html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][\s\S]*?\/>(\n)?/i, '');

// Make sure modulepreload and dynamic imports point to ./_app/...
html = html
    .replace(/(href|src)="\/(?!\/)/g, '$1="./')
    .replace(/"\/_app\//g, '"./_app/')
    .replace(/import\("\/_app\//g, 'import("./_app/');

fs.writeFileSync(indexPath, html);
console.log('Patched build/index.html for file:// usage.');
