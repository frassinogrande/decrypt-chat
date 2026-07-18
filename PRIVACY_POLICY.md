# Privacy Policy

Last updated: 2026-07-18

This site is a decentralized, privacy-first chat application that runs locally in the browser. There is no centralized message storage and your account exists purely to protect data held in your own browser.

The app makes no network requests of its own. It sends no analytics, telemetry, error reports, or third-party scripts, and there is no server-side component that could receive your data.

## Data This Site Stores Locally

- Conversation data, contact names, wrapped (encrypted) keys, and messages are stored on the device using `localStorage` and `IndexedDB`. Message bodies and conversation keys are stored encrypted.
- Some data is stored unencrypted, because it is needed before the app is unlocked or is not message content: chat and contact display names, app settings, and your language preference.
- Declined, missed, cancelled, and completed calls leave a record in the conversation, stored encrypted at rest like any other message. The record for a completed call includes how long the call lasted. Each participant's device measures and stores this independently; no call duration is sent between devices.
- Profile details (a display name and any contact methods you add, such as email, phone, WhatsApp, Signal, or Telegram) are stored locally and leave the device only when you generate a share code and send it to a contact yourself.
- A master password protects your local profile. It is never transmitted, and never stored in plain form. The device keeps a random salt, the key-derivation settings, and the encrypted profile data.
- Session unlock state is normally kept in `sessionStorage` and discarded when the tab is closed. If you choose the "manual lock" auto-lock option, an encrypted copy of your unlock material is written to `localStorage` instead, so it survives closing the tab and restarting the browser. This is why that option is labelled as less secure in Settings.
- When you have more than one tab open on this site, unlock state is shared between them over an in-browser `BroadcastChannel` so a new tab does not force you to unlock again. This never touches the network and is never written to disk.
- The app may ask the browser for persistent storage, which requests that your data be exempt from automatic eviction when disk space runs low.

## Data This Site Transmits

- Share codes are encrypted payloads (a bare `#secure=...` fragment) that you copy and paste into another messenger by hand. They are generated and read entirely in the browser and are never sent to this site's web server.
- Copying a share code places it on your system clipboard, where other applications may be able to read it, and it stays there until you copy something else. Clear it yourself if that matters to you. If you use your device's share sheet instead, the code is handed to whichever app you pick, and that app's own privacy policy then applies.
- Messages and calls use direct peer-to-peer connections when available. Content is encrypted before transmission.
- If voice or video calls are used, the browser may request microphone, camera, or screen-sharing access. Media streams are sent directly to the peer and are not relayed through any server.

## WebRTC and STUN

This site uses WebRTC to establish direct peer-to-peer connections. Public STUN servers help establish those connections; they do not store personal data and are used solely to facilitate peer-to-peer communication.

The WebRTC configuration references two public STUN servers: `stun.cloudflare.com:3478`, operated by Cloudflare, and `stun.nextcloud.com:443`, operated by Nextcloud. STUN servers may receive IP addresses and network metadata needed to establish connectivity, and peers may learn each other's IP addresses as part of the connection process.

The in-app guided tutorial connects only to a stand-in running on your own device, so it does not contact any STUN server and nothing leaves your machine during it.

## Data You Can Export or Import

- You can export an encrypted backup of your profile and conversations. The backup file is protected by a password you choose and is written to wherever you save it; keeping it safe is up to you.
- You can export selected chats as plain text files. These exports are **not** encrypted: they contain your readable message history and anyone with the file can read it.
- You can import history from a WhatsApp or Telegram chat export. The file is read and parsed entirely in your browser and is not uploaded anywhere.

## Third-Party Requests

- Fonts are self-hosted and served from this site's own origin, so no font provider (or other third party) receives your IP address or user agent when the page loads.
- The hosting provider for this site may receive standard web server logs (such as IP address, user agent, and request time) when pages or assets are requested.
- Opening a live peer-to-peer connection (a call or real-time messaging) contacts public STUN servers, which receive your IP address. This does not happen on page load or when using share codes; see the WebRTC and STUN section above for details.

## Cookies and Similar Storage

- This site sets no cookies of any kind: no functional, advertising, or analytics cookies.
- Your language preference is remembered in `localStorage`, the same as every other setting.
- `localStorage`, `sessionStorage`, and `IndexedDB` are used for app data and encrypted content as described above.
- A service worker caches this site's own files so it loads quickly and works offline. It only ever caches responses served from this site's own origin, and each new release replaces the old cache. Your messages and keys live in `IndexedDB` and are never written to the cache.
- The app can be installed to your home screen or desktop. An installed copy stores its data the same way, but clearing it may require removing the app rather than clearing your browser's site data.

## Data Retention and Deletion

- Data stored locally remains on the device until deleted by the user (for example, clearing chats, removing the profile, or clearing browser storage).
- Clearing site data in the browser will remove all stored data, including encrypted keys. There is no recovery mechanism, so keep a backup if you need one.
- Anything you have already exported (a backup file, a plain-text chat export, or a share code you sent to someone) is outside the app's control and is not affected by deleting data here.

## Changes to This Policy

This site may update this Privacy Policy to reflect changes in the app. Updates will be published with a revised "Last updated" date.
