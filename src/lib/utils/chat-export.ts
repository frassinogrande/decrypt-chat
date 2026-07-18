import { dataStorage } from './indexeddb-storage';
import { createZip, type ZipEntry } from './zip';
import type { Chat } from '../types';

/**
 * Plain-text chat export in the WhatsApp style:
 *
 *     DD/MM/YYYY, HH:MM - Sender: Message
 *
 * One .txt per chat; a single selected chat downloads as the bare .txt, more
 * than one is bundled into a zip. The line format deliberately matches the
 * regex in whatsapp-import.ts so an export round-trips through the app's own
 * WhatsApp importer.
 */

// Placeholder bodies written by the decryption layer; never real content.
const PLACEHOLDER_BODIES = new Set([
    '[Encrypted]',
    '[Message content unavailable]',
    '[Encrypted message - session locked]',
    '[Encrypted message - key not found]',
    '[Encrypted message - decryption failed]',
]);

// Decrypt this many messages per chunk, yielding to the event loop in between,
// so exporting a multi-thousand-message chat does not freeze the UI.
const DECRYPT_CHUNK_SIZE = 200;

export interface ChatExportFile {
    fileName: string;
    text: string;
}

export interface ChatExportResult {
    blob: Blob;
    fileName: string;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function formatHeader(timestamp: number, sender: string): string {
    const d = new Date(timestamp);
    const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `${date}, ${time} - ${sender}: `;
}

/** Strip characters that are invalid in file names across platforms. */
function sanitizeFileName(name: string): string {
    const cleaned = name
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+|\.+$/g, '');
    return cleaned || 'chat';
}

export function downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke on a later tick, not synchronously: revoking before the browser
    // has finished reading the blob can truncate the download (notably on
    // Firefox), producing a corrupt file.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Load, decrypt, and format one chat's full history as export text. */
export async function buildChatExportText(chat: Chat, ownName: string): Promise<string> {
    const stored = await dataStorage.getMessagesByChat(chat.id);
    const lines: string[] = [];

    for (let i = 0; i < stored.length; i += DECRYPT_CHUNK_SIZE) {
        const chunk = stored.slice(i, i + DECRYPT_CHUNK_SIZE);
        const decrypted = await dataStorage.decryptMessages(chunk);
        for (const message of decrypted) {
            // Call event records are system lines, not chat content.
            if (message.callEvent) {
                continue;
            }
            const body = message.body;
            if (!body || PLACEHOLDER_BODIES.has(body)) {
                continue;
            }
            const from = message.from?.trim();
            const sender = from || (message.isOwn ? ownName : chat.name);
            lines.push(formatHeader(message.timestamp, sender) + body);
        }
        // Yield so a long decrypt run cannot freeze the UI thread.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Export the given chats. One chat produces a bare .txt file, several are
 * packaged into a zip with one .txt per chat.
 */
export async function exportChats(chats: Chat[], ownName: string): Promise<ChatExportResult> {
    const files: ChatExportFile[] = [];
    const usedNames = new Set<string>();

    for (const chat of chats) {
        const base = sanitizeFileName(`Chat with ${chat.name}`);
        let fileName = `${base}.txt`;
        for (let n = 2; usedNames.has(fileName); n++) {
            fileName = `${base} (${n}).txt`;
        }
        usedNames.add(fileName);
        files.push({ fileName, text: await buildChatExportText(chat, ownName) });
    }

    if (files.length === 1) {
        return {
            blob: new Blob([files[0].text], { type: 'text/plain' }),
            fileName: files[0].fileName,
        };
    }

    const encoder = new TextEncoder();
    const entries: ZipEntry[] = files.map((file) => ({
        name: file.fileName,
        data: encoder.encode(file.text),
    }));
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    return {
        blob: createZip(entries, now),
        fileName: `chat-export-${stamp}.zip`,
    };
}
