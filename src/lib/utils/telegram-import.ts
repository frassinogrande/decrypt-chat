export interface TelegramParsedMessage {
    timestamp: number; // ms since epoch
    name: string;
    body: string;
}

export interface TelegramParseResult {
    messages: TelegramParsedMessage[];
    names: string[]; // unique sender names detected
    ignoredCount: number; // entries ignored (service messages, media without text, ...)
}

export type TelegramImportErrorCode = 'invalid' | 'full-export';

export class TelegramImportError extends Error {
    code: TelegramImportErrorCode;

    constructor(code: TelegramImportErrorCode, message: string) {
        super(message);
        this.name = 'TelegramImportError';
        this.code = code;
    }
}

// Telegram Desktop's "Export chat history" JSON (schema: core.telegram.org/import-export).
// `text` is a plain string when the message has no formatting entities, otherwise a
// mixed array of strings and entity objects like { type: "bold", text: "hi" }.
function flattenText(text: unknown): string {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) {
        let out = '';
        for (const part of text) {
            if (typeof part === 'string') {
                out += part;
            } else if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
                out += (part as any).text;
            }
        }
        return out;
    }
    return '';
}

function toTimestamp(entry: any): number | null {
    const unix = Number(entry?.date_unixtime);
    if (Number.isFinite(unix) && unix > 0) return unix * 1000;
    if (typeof entry?.date === 'string') {
        // Exported dates have no timezone suffix; Date.parse interprets them as local
        // time, matching how the WhatsApp importer treats its timestamps.
        const parsed = Date.parse(entry.date);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

export function parseTelegramExport(text: string): TelegramParseResult {
    let root: any;
    try {
        root = JSON.parse(text);
    } catch {
        throw new TelegramImportError('invalid', 'Not a Telegram JSON export');
    }

    if (!root || typeof root !== 'object') {
        throw new TelegramImportError('invalid', 'Not a Telegram JSON export');
    }

    // A full-account export wraps every conversation in `chats.list`; the import
    // targets one conversation, so ask for a single-chat export instead.
    if (!Array.isArray(root.messages)) {
        if (Array.isArray(root?.chats?.list)) {
            throw new TelegramImportError('full-export', 'Full account export');
        }
        throw new TelegramImportError('invalid', 'Not a Telegram JSON export');
    }

    const messages: TelegramParsedMessage[] = [];
    const namesSet = new Set<string>();
    let ignoredCount = 0;

    for (const entry of root.messages) {
        if (!entry || typeof entry !== 'object' || entry.type !== 'message') {
            ignoredCount++;
            continue;
        }

        const body = flattenText(entry.text);
        if (!body.trim()) {
            // Media-only messages (photos, stickers, files) carry no importable text
            ignoredCount++;
            continue;
        }

        const name =
            (typeof entry.from === 'string' && entry.from.trim()) ||
            (typeof entry.from_id === 'string' && entry.from_id.trim()) ||
            '';
        const timestamp = toTimestamp(entry);
        if (!name || timestamp === null) {
            ignoredCount++;
            continue;
        }

        namesSet.add(name);
        messages.push({ timestamp, name, body });
    }

    return {
        messages,
        names: Array.from(namesSet).sort(),
        ignoredCount,
    };
}
