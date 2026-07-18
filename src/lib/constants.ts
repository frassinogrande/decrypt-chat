// Single source of truth for the product name in runtime UI (document titles, etc).
// Static assets can't import this, so when renaming also update: src/app.html
// (<title> and apple-mobile-web-app-title) and static/manifest.json (name/short_name).
export const APP_NAME = 'Decrypt Chat';
