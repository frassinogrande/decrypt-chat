/**
 * Minimal ZIP archive writer (store method, no compression). Chat exports are
 * small text files, so a dependency-free writer keeps the bundle lean and the
 * supply-chain surface at zero. Filenames are encoded as UTF-8 with the
 * language-encoding flag set so non-ASCII chat names extract correctly.
 */

export interface ZipEntry {
    /** Path inside the archive, forward slashes, no leading slash. */
    name: string;
    data: Uint8Array;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Encode a Date into MS-DOS time/date words as used by the ZIP format. */
function dosDateTime(date: Date): { time: number; date: number } {
    const year = Math.max(date.getFullYear(), 1980);
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

export function createZip(entries: ZipEntry[], mtime: Date = new Date()): Blob {
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(mtime);
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name);
        const crc = crc32(entry.data);
        const size = entry.data.length;

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true); // local file header signature
        local.setUint16(4, 20, true); // version needed to extract
        local.setUint16(6, 0x0800, true); // general purpose flags: UTF-8 names
        local.setUint16(8, 0, true); // compression method: store
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, size, true); // compressed size (= uncompressed for store)
        local.setUint32(22, size, true); // uncompressed size
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true); // extra field length
        localParts.push(new Uint8Array(local.buffer), nameBytes, entry.data);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true); // central directory header signature
        central.setUint16(4, 20, true); // version made by
        central.setUint16(6, 20, true); // version needed to extract
        central.setUint16(8, 0x0800, true); // general purpose flags: UTF-8 names
        central.setUint16(10, 0, true); // compression method: store
        central.setUint16(12, time, true);
        central.setUint16(14, date, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, size, true);
        central.setUint32(24, size, true);
        central.setUint16(28, nameBytes.length, true);
        // extra/comment lengths, disk number, internal/external attributes: all zero
        central.setUint32(42, offset, true); // relative offset of local header
        centralParts.push(new Uint8Array(central.buffer), nameBytes);

        offset += 30 + nameBytes.length + size;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); // end of central directory signature
    eocd.setUint16(8, entries.length, true); // entries on this disk
    eocd.setUint16(10, entries.length, true); // total entries
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true); // offset of central directory
    eocd.setUint16(20, 0, true); // comment length

    const archive = new Uint8Array(offset + centralSize + 22);
    let position = 0;
    for (const part of [...localParts, ...centralParts, new Uint8Array(eocd.buffer)]) {
        archive.set(part, position);
        position += part.length;
    }
    return new Blob([archive.buffer], { type: 'application/zip' });
}
