# Bring your own encryption into any chat

Live at **[decrypt.chat](https://decrypt.chat)**.

Turn your private messages into encrypted code, then send through your favourite messaging apps, email, or SMS. The carrier only ever sees the code, only you and your contact hold the key.

A fully decentralized, privacy-first chat app where only you and your recipient can ever read your messages. There is no backend: everything happens locally and client-side.

---

## Core Philosophy

At first glance, copying codes around looks like a step backwards from a normal chat app. It
is a deliberate trade, and here is what you get for it:

- **End-to-end encryption, with no trusted middleman.** Each conversation has one manually
  shared key, and only you and your contact ever hold it. Other messengers exchange keys for
  you through their servers, which is convenient, but it means the provider could in principle
  get in between. In this app, the key reaches your contact by a channel _you_ chose, in person
  or on paper, so if it arrived safely there is no point at which anyone can interpose.
- **No backend.** Static site only, with no server to read your messages, metadata, or keys,
  and no server-side account, phone number, email, or directory to tie them to you. There is
  nobody running this who could be subpoenaed, breached, or bought, because nothing about you
  was ever collected in the first place.
- **Metadata obfuscation.** Timestamps, sender IDs, and message length are encrypted or
  padded, so the codes themselves give away nothing about who is talking to whom, or when.
- **Your data stays yours.** Everything lives in the browser (IndexedDB + localStorage) and is
  never synced anywhere. Nothing leaves the device unless you send it.
- **No cookies, no trackers.** The app sets no cookies of any kind, and every asset (including
  fonts) is served from its own origin, so loading and browsing the app sends nothing to any
  third party. No consent banner needed, because there is nothing to consent to. The one
  exception is opening a live peer-to-peer connection (a call or real-time messaging): that
  uses public STUN servers to connect, which necessarily see your IP, as the
  [privacy policy](PRIVACY_POLICY.md) explains.
- **Carrier compromise reveals nothing.** If the everyday messenger you send codes through is
  hacked or quietly mined, all anyone finds in the thread is encrypted codes, not a trove of
  readable messages, and nothing the platform itself can check.

---

## Features

### Share codes

Messages are encrypted using AES-GCM and shared as a code.

```
#secure=ENCRYPTED_STRING
```

`#secure=` is the single marker for all shared encrypted content: messages, call invitations,
and profile shares all use it and are dispatched by content type after decryption. WebRTC
connection setup uses the same code approach (`#webrtc-offer=` / `#webrtc-answer=`).

To receive, paste a code into the message box (or anywhere on the page on desktop) and the
app decrypts it in place.

The encrypted payload contains:

```json
{
    "magic": "trusted-chat",
    "from": "Alice",
    "timestamp": 1725107341,
    "body": "Message",
    "uuid": "...",
    "pad": "RandomStuffToObfuscateLength"
}
```

### WebRTC Peer-to-Peer Messaging

- Real-time messaging directly between browsers, with no server relay.
- Connections are set up by swapping two codes (`#webrtc-offer=`, `#webrtc-answer=`), with a
  guided wizard for each side and diagnostics if the connection fails.
- Supports messages, reactions, typing indicators, and heartbeats.
- One persistent WebRTC connection per chat.

### Audio & Video Calls

- Real-time voice and video calls over WebRTC.
- Incoming call notifications with accept/reject.
- Declined, missed, cancelled, and completed calls leave a system line in the conversation, encrypted at rest like any other message. A completed call's line shows how long it lasted, measured independently by each side rather than sent between devices.
- Requires HTTPS (secure context).
- Calls (and live peer-to-peer messaging) connect your device directly to your contact, with no
  relay in between, keeping with the no-backend design. The trade-off is that the two of you can
  see each other's IP addresses, and the public STUN servers used to establish the connection may
  see yours. The call's audio/video is end-to-end encrypted; only the network-level IP is exposed.
  If that matters for a given contact, stick to the offline share-code path, which reveals nothing
  to anyone but the messenger you paste it into.

### Deleting Messages

- **Delete for me** removes a message from this device only.
- **Delete for everyone** removes it from your contact's device too. It covers your own messages,
  and works only while you are connected peer-to-peer, since the request travels over the
  WebRTC data channel. A message that never reached your contact can't be recalled this way.

### Auto-Delete Messages

- Per-conversation timer that automatically deletes messages after a set period (1 hour, 1 day, 1 week, 1 month, or off).
- Deletion is local only, so each device enforces its own timer independently.

### Message Reactions

- Three reactions (😂, ❤️, 💯), sent in real time over the WebRTC data channel when
  connected, or carried inside the next share code when not.

### Typing Indicators

- See when your contact is typing (WebRTC-connected chats).

### Automatic message decryption

- Paste a share code and it decrypts and lands in the right conversation on its own, with no
  chat to pick and nothing to configure.
- Codes carry no chat identifier, so the app trial-decrypts across your conversations and only
  the one holding the right key opens it.
- Decrypted messages are saved to IndexedDB, still encrypted at rest.

### Storage

- Keys encrypted at rest using PBKDF2 (600,000 iterations) with a master password.
- Messages stored in IndexedDB, loaded a page at a time so long histories stay fast.
- Search runs across full history, decrypting on demand rather than keeping an index.
- Message bodies are encrypted again before they are written, with a device-specific key that never leaves the browser.

### Profile & Authentication

- Master password protects all keys at rest.
- Auto-lock policies: after a new session (default), on every page refresh, after 5, 15, 30, or
  60 minutes of inactivity, or manual only.
- Session unlock with configurable timeout.

### Forward Secrecy

Each conversation's key is rotated **daily** and old key material is discarded, so a leaked
key can only ever unlock a narrow recent window rather than the entire history. This matters
because the codes you send linger on someone else's messenger indefinitely, so without it a
single key leak would expose the whole back-archive.

- Messages are encrypted with a one-way **daily key chain** derived from the shared
  conversation key. Both devices derive the same daily key independently: nothing extra is
  exchanged, and no date is written to the wire (the receiver trial-decrypts).
- Each device keeps only the last 7 daily keys and cannot recompute older ones, so a seized
  device exposes at most about a week of history.
- The conversation root key is not stored on the device after setup; only the rolling chain
  and a separate connection-signaling key are kept.
- Known limit: the paper mnemonic backup _is_ the root, so anyone holding the 12 words can
  still re-derive everything. Live calls ride on WebRTC/DTLS, which already provides forward
  secrecy of its own.

### Replay Protection

- Every share code, whether a message, a call invitation, or a profile share, includes a UUID recorded once the code has been handled.
- Replayed codes (same UUID, within a 30-day window) are silently ignored, so an old code pulled out of the messenger you sent it through can't be used again.
- Records older than 30 days fall outside the window and are pruned as new ones are added.
- Call invitations expire after 10 minutes on top of this.

### Magic String Validation

- Decrypted payloads must contain `"magic": "trusted-chat"`.
- Prevents false positives when decrypting with the wrong key.

### Obfuscation

- All metadata (timestamp, sender, etc.) is inside the encrypted blob.
- Random padding (50 to 150 chars, generated with `crypto.getRandomValues()`) equalizes message sizes.

### Timestamp Validation

- Decrypted message timestamps are validated against the receiver's clock.
- Messages with timestamps more than 30 days in the past or 5 minutes in the future are rejected.

### Chat Import

- Import message history from a WhatsApp chat export (.txt) or a Telegram Desktop chat export (machine-readable JSON).
- Imported messages are labeled with their source, e.g. "imported via Telegram".

### Backup & Restore

- Export an encrypted backup of your profile and conversations.
- Restore from backup on a new device.

### Chat Export

- Export selected chats as plain text files in the format: date, time, sender, message.
- A single chat downloads as a .txt file; multiple chats are bundled into a zip archive.
- Available from Settings > Storage (multi-chat picker) or a chat's menu (direct .txt download).
- Exported files are not encrypted.

### Internationalization

- UI available in English, Spanish, German, French, Italian, Russian, Brazilian Portuguese, and European Portuguese.
- Language auto-detected from the browser's preferred languages on first visit; an explicit choice in Settings is remembered in local storage. The app sets no cookies.

### Accessibility

- Full keyboard operation: roving focus in the conversation list and message feed, skip link, focus managed across view changes and dialogs.
- Screen reader support: curated labels on chat rows and messages, spoken long-form dates and durations, live announcements for new messages, connection state, call state, and copy confirmations, localized across all supported languages.
- Native dialogs with proper naming, respected reduced-motion preference, and status conveyed as text rather than color or symbols alone.

### Progressive Web App

- Installable to the home screen on Android, iOS, and desktop (web app manifest with maskable icons).
- Service worker precaches the app shell, so the installed app launches and runs offline.
- Only app code and static assets are cached. Messages and keys live in IndexedDB and are never fetched over HTTP, so they cannot end up in the cache.

### Also Included

- **Profile sharing**: store contact methods (email, SMS, WhatsApp, Signal, Telegram, other), pick which to include, and send them to a contact as an encrypted code.
- **Contact info**: rename a contact, see the details they shared, and view per-chat message and storage counts.
- **Themes**: light, dark, or follow the system setting.
- **Message search**: across the full history of every conversation. Clicking a result opens that chat, pages back through the history until the message is loaded, and scrolls straight to it with a brief highlight.
- **Inline formatting**: `**bold**` and `*italic*` render in message bubbles.
- **Storage controls**: quota meter with a per-chat breakdown, and a request for persistent storage so the browser won't evict your data.
- **Privacy toggles**: hide message previews on the chat list, and a one-tap lock button.
- **Stats**: most-used reactions and most-messaged contacts.
- **Hardening**: clickjacking frame guard, automatic lock on a CSP violation, and encrypted fragments scrubbed from browser history after processing.

---

## Planned / Not Yet Implemented

- File attachments (send and receive encrypted files peer-to-peer via WebRTC)
- Passkey / biometric unlock (WebAuthn)
- A wider set of reaction emojis (currently limited to 😂, ❤️, and 💯)

---

## Tech Stack

| Tool                              | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| Svelte 4 / SvelteKit 2            | UI framework, routing, static site generation      |
| TypeScript 5                      | Language                                           |
| Vite 5                            | Build tool (Terser, CSP headers, HTTPS dev server) |
| Sass                              | SCSS styling, with design tokens in `src/styles/`  |
| Web Crypto API                    | AES-GCM encryption, PBKDF2 key derivation          |
| BIP39                             | Mnemonic key generation                            |
| Pako                              | Compression                                        |
| IndexedDB                         | Persistent message and key storage                 |
| WebRTC                            | Peer-to-peer messaging, audio and video calls      |
| Service worker + web app manifest | Installable PWA, offline app shell                 |
| Paraglide JS                      | i18n (en, es, de, fr, it, ru, pt-br, pt-pt)        |

---

## Running Your Own Instance

The app builds to a fully static site. There is no backend, so any static file host can serve it.

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (includes npm)
- Optional, for development only: [mkcert](https://github.com/FiloSottile/mkcert) to generate a locally-trusted HTTPS certificate. Browsers only allow camera and microphone access in a secure context, so HTTPS is required to test audio/video calls locally. Everything else works over plain HTTP.

### Development

```bash
git clone https://github.com/frassinogrande/decrypt-chat.git
cd decrypt-chat
npm install
npm run dev
```

Other useful scripts: `npm run check` (type checking), `npm run lint` (Prettier and ESLint),
and `npm run format` (auto-format).

The dev server runs over plain HTTP by default. To test calls, generate local certificates once:

```bash
mkcert -install
mkdir -p .certs
cd .certs && mkcert localhost 192.168.x.x ::1   # use your machine's LAN IP
```

This produces `localhost+2.pem` and `localhost+2-key.pem` (mkcert names the files after the first hostname plus the number of extra names, so pass exactly two extra names for the filenames to match). The dev server detects them automatically and switches to HTTPS. `.certs/` is gitignored.

### Icons

Icons render through `<Icon name="..." />`, which references a symbol in the sprite at `static/assets/icons/sprite.svg`. Add new ones with the script rather than editing the sprite by hand:

```bash
node scripts/add-icon.mjs <material-name|url|file.svg> [sprite-id]

node scripts/add-icon.mjs flip_camera_ios flip-camera   # -> <Icon name="flip-camera" />
```

Icons are Google Material Symbols (Outlined, FILL 0, weight 400), stored as a single `<path fill="currentColor">` inside a `<symbol>` on the full `0 0 24 24` grid. Two rules matter if you ever edit the sprite manually:

- Keep the full 24x24 viewBox. Cropping it to the glyph makes paired icons (`mic` and `mic-disabled`, where the slash widens the bounds) render at different sizes.
- Do not paste raw Material Symbols markup. Its `0 -960 960 960` viewBox renders blank on Firefox for Android when loaded through an external `<use>`.

A few older icons still use tight viewBoxes. Those are legacy, not a pattern to copy.

### Building and Deploying

```bash
npm run build
```

The static site is written to `build/`. A post-build step copies the SPA fallback (`404.html`) to `index.html` so the output works on GitHub Pages as-is. It deliberately does not rewrite any URLs in the built HTML, because the inline bootstrap script is covered by a CSP hash and editing it would get the script blocked.

- **GitHub Pages**: publish the `build/` directory. For a _project_ site (served from `https://user.github.io/repo-name/`), set the base path at build time: `BASE_PATH=/repo-name npm run build`. This is the only supported way to deploy under a subpath. Serving from a domain root, as `decrypt.chat` does, needs no base path at all.

  This repository deploys itself on every push to `main` via `.github/workflows/deploy.yml`, which builds without a base path and publishes to Pages. `static/CNAME` carries the custom domain into the build output.
- **Any other static host** (Netlify, Cloudflare Pages, your own server): just serve the `build/` directory.

Serve the site over HTTPS in production, since calls, clipboard features, and the service worker all require a secure context. A Content Security Policy is embedded in the pages at build time via hashed meta tags, so no server configuration is needed for it.

Preview a production build locally with `npm run preview`.

#### Offline `file://` build

`npm run build:file` produces a variant that opens directly from disk with no server, by rewriting asset URLs to relative paths and stripping the CSP meta tag (browsers block module loading under the `file://` scheme otherwise).

**Never serve the output of `build:file` over HTTP or HTTPS.** It has no Content Security Policy, so it loses the protection the normal build relies on. Use `npm run build` for anything reachable over a network, and treat `build:file` purely as a local, single-machine convenience.

---

## Internationalization

Translations are managed through Paraglide JS with message files in `project.inlang/messages/{lang}.json`. English is the source language, and locale tags are lowercase (`pt-br`, not `pt-BR`).

- Run `npm install` to set up the i18n toolchain.
- Run `npm run dev` or `npm run build` to compile messages into `src/paraglide/`. The app imports the compiled output, so edits to the JSON files do nothing until a compile runs.
- Weblate integration is configured via `weblate.ini`.

The language is detected client-side from the browser's preferred languages on first visit. There is no server-side negotiation: the site is static, so an `Accept-Language` header would only ever be seen at build time. An explicit pick in Settings is stored in localStorage under `i18n-locale`; an auto-detected language is not persisted.

To add a language:

1. Copy `project.inlang/messages/en.json` to `{lang}.json` and translate the values.
2. Add the tag to `languageTags` in `project.inlang/settings.json`.
3. Add it to `SUPPORTED_LOCALES` in `src/lib/i18n/config.ts`.
4. Add its display name to the language list in `src/lib/components/SettingsMenu.svelte`.
5. Recompile with `npm run dev` or `npm run build` and commit. `src/paraglide/` is generated output and is gitignored.

---

## Privacy

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for what the app stores locally and what (little) it transmits.

---

## Contributing

Bug reports and bug fixes are welcome. Feature requests and enhancements are not being prioritised right now, so please open an issue to discuss before sending a pull request for anything beyond a bug fix.

---

## License

Free and open source under the [GNU AGPL v3](LICENSE) license.
