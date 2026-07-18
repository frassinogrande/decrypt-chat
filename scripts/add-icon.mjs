#!/usr/bin/env node
// Add a Google Material Symbol to the icon sprite in this project's house format:
// a plain <path fill="currentColor"> inside a <symbol> on Google's uniform 0 0 24 24 grid.
// Material Symbols ship on a "0 -960 960 960" grid; this bakes the coordinates into a small
// positive box because the raw negative/large viewBox renders blank on Firefox for Android
// via external <use>.
//
// Usage:
//   node scripts/add-icon.mjs <material-name|url|file.svg> [sprite-id]
// Examples:
//   node scripts/add-icon.mjs mic                       -> icon-mic
//   node scripts/add-icon.mjs mic_off mic-disabled      -> icon-mic-disabled
//   node scripts/add-icon.mjs flip_camera_ios flip-camera
//
// The Material name is the icon's name on fonts.google.com/icons (lower_snake_case). The
// optional sprite-id is the id used in markup (<Icon name="..." />); it defaults to the
// material name with underscores turned into hyphens. Re-running with an existing id replaces it.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SPRITE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../static/assets/icons/sprite.svg'
);
const GRID = 24; // grid the glyph is scaled into

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const SEG = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;

const fnum = (v) => String(Math.round(v * 1000) / 1000);

function tokens(d) {
    const out = [];
    let m;
    SEG.lastIndex = 0;
    while ((m = SEG.exec(d))) out.push([m[1], (m[2].match(NUM) || []).map(Number)]);
    return out;
}

// Bake a source path with an affine transform: absolute coords -> coord*s + offset,
// relative coords -> coord*s. The first moveto pair is absolute even when written lowercase.
function bake(d, s, ox, oy) {
    let out = '';
    let first = true;
    for (const [cmd, n] of tokens(d)) {
        const u = cmd.toUpperCase();
        const rel = cmd !== u;
        let res = [];
        const pair = (x, y, abs) => [x * s + (abs ? ox : 0), y * s + (abs ? oy : 0)];
        if (u === 'Z') {
            out += cmd;
            first = false;
            continue;
        } else if (u === 'M' || u === 'L' || u === 'T') {
            for (let i = 0; i < n.length; i += 2)
                res.push(...pair(n[i], n[i + 1], !rel || (first && i === 0)));
        } else if (u === 'C') {
            for (let i = 0; i < n.length; i += 6)
                for (let k = 0; k < 6; k += 2) res.push(...pair(n[i + k], n[i + k + 1], !rel));
        } else if (u === 'S' || u === 'Q') {
            for (let i = 0; i < n.length; i += 4)
                for (let k = 0; k < 4; k += 2) res.push(...pair(n[i + k], n[i + k + 1], !rel));
        } else if (u === 'H') {
            res = n.map((v) => v * s + (!rel ? ox : 0));
        } else if (u === 'V') {
            res = n.map((v) => v * s + (!rel ? oy : 0));
        } else if (u === 'A') {
            for (let i = 0; i < n.length; i += 7) {
                const [ex, ey] = pair(n[i + 5], n[i + 6], !rel);
                res.push(n[i] * s, n[i + 1] * s, n[i + 2], n[i + 3], n[i + 4], ex, ey);
            }
        }
        out += cmd + res.map(fnum).join(' ');
        first = false;
    }
    return out;
}

async function loadSvg(arg) {
    if (existsSync(arg)) return readFileSync(arg, 'utf8');
    const url = /^https?:\/\//.test(arg)
        ? arg
        : `https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web/${arg}/materialsymbolsoutlined/${arg}_24px.svg`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed (${res.status}) for ${url}`);
    return res.text();
}

const [, , source, idArg] = process.argv;
if (!source) {
    console.error('usage: node scripts/add-icon.mjs <material-name|url|file.svg> [sprite-id]');
    process.exit(1);
}
const id = (
    idArg ||
    source
        .replace(/\.svg$/, '')
        .replace(/.*[\\/]/, '')
        .replace(/_/g, '-')
).trim();

const svg = await loadSvg(source);
const vb = svg.match(/viewBox="([^"]+)"/);
if (!vb) throw new Error('source svg has no viewBox');
const [minx, miny, w, h] = vb[1].split(/[\s,]+/).map(Number);
const s = GRID / Math.max(w, h);
const ox = -minx * s,
    oy = -miny * s;

const ds = [...svg.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
if (!ds.length) throw new Error('source svg has no <path>');

// Keep the full Google grid (no per-glyph crop). Material Symbols are designed to be optically
// consistent ON this grid; cropping each icon to its own bounds makes multi-state pairs (e.g.
// mic / mic-off, where the slash enlarges the bounds) render the base shape at different sizes.
const viewBox = `0 0 ${fnum(w * s)} ${fnum(h * s)}`;
const paths = ds.map((d) => `<path fill="currentColor" d="${bake(d, s, ox, oy)}"/>`).join('');
const symbol = `<symbol id="icon-${id}" viewBox="${viewBox}">\n        ${paths}\n    </symbol>`;

let sprite = readFileSync(SPRITE, 'utf8');
const existing = new RegExp(`<symbol id="icon-${id}" viewBox="[^"]*">[\\s\\S]*?</symbol>`);
if (existing.test(sprite)) {
    sprite = sprite.replace(existing, symbol);
    console.log(`replaced icon-${id}`);
} else {
    sprite = sprite.replace(/\s*<\/svg>\s*$/, `\n    ${symbol}\n</svg>\n`);
    console.log(`added icon-${id}`);
}
writeFileSync(SPRITE, sprite);
console.log(`  viewBox "${viewBox}"  ->  ${SPRITE}`);
