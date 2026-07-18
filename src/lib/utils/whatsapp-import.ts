export interface WhatsAppParsedMessage {
    timestamp: number; // ms since epoch
    name: string;
    body: string;
}

export interface WhatsAppParseResult {
    messages: WhatsAppParsedMessage[];
    names: string[]; // unique sender names detected
    ignoredCount: number; // lines ignored due to system/format/media rules
}

// Regex to match WhatsApp export lines of the form:
// DD/MM/YYYY, HH:MM - Name: Message
// Also supports two-digit year and optional AM/PM (varies by locale)
const lineHeaderRe =
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?:\s*([APap][Mm]))?\s+-\s+([^:]+?):\s(.*)$/;

function toTimestamp(
    d: string,
    m: string,
    y: string,
    hh: string,
    mm: string,
    ampm?: string
): number {
    let year = parseInt(y, 10);
    if (year < 100) {
        // Heuristic: assume 2000s for two-digit years
        year += 2000;
    }
    let hour = parseInt(hh, 10);
    const minute = parseInt(mm, 10);
    if (ampm) {
        const up = ampm.toUpperCase();
        if (up === 'PM' && hour < 12) hour += 12;
        if (up === 'AM' && hour === 12) hour = 0;
    }
    const day = parseInt(d, 10);
    const monthIndex = parseInt(m, 10) - 1; // JS months 0-11

    // Interpret as local time
    return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

export function parseWhatsAppExport(text: string): WhatsAppParseResult {
    const lines = text.split(/\r?\n/);
    const messages: WhatsAppParsedMessage[] = [];
    const namesSet = new Set<string>();
    let ignoredCount = 0;

    let current: WhatsAppParsedMessage | null = null;

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();

        const m = line.match(lineHeaderRe);
        if (m) {
            // If we were assembling a previous multi-line message, push it now
            if (current) {
                messages.push(current);
                current = null;
            }

            const [_, d, mo, y, hh, mm, ampm, name, body] = m;

            if (body.includes('<Media omitted>')) {
                ignoredCount++;
                continue;
            }

            const ts = toTimestamp(d, mo, y, hh, mm, ampm);
            const trimmedName = name.trim();
            namesSet.add(trimmedName);

            current = {
                timestamp: ts,
                name: trimmedName,
                body: body,
            };
        } else {
            // Not a header line. If part of a previous message, append as continuation.
            if (current) {
                current.body += '\n' + line;
            } else {
                // System/info line (no name:), ignore
                ignoredCount++;
            }
        }
    }

    if (current) messages.push(current);

    const filtered = messages.filter((m) => !m.body.includes('<Media omitted>'));
    const filteredIgnored = messages.length - filtered.length;

    return {
        messages: filtered,
        names: Array.from(namesSet).sort(),
        ignoredCount: ignoredCount + filteredIgnored,
    };
}
