// snapshot.js - Pack a room's links into one small file, column by column
import { extractTitle } from './urlParser.js';
import { buildMagnet, getMagnetHash } from './links.js';

const MAGIC = 'WTDB';
const VERSION = 3;
const MAX_ENTRIES = 2000000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

const HAS_MAGNET_HASH = 1;
const HAS_MAGNET_TEXT = 2;
const HAS_INSTANT_IO = 4;
const HAS_TITLE = 8;
const HAS_THUMB_HASH = 16;
const HAS_PREVIEW = 32;
const HAS_SIGNATURE = 64;
const HAS_WORK = 128;
const SIGNATURE_BYTES = 64;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Writer {
    constructor() {
        this.bytes = new Uint8Array(4096);
        this.length = 0;
    }

    reserve(size) {
        if (this.length + size <= this.bytes.length) return;

        let capacity = this.bytes.length;
        while (capacity < this.length + size) capacity *= 2;
        const larger = new Uint8Array(capacity);
        larger.set(this.bytes.subarray(0, this.length));
        this.bytes = larger;
    }

    byte(value) {
        this.reserve(1);
        this.bytes[this.length++] = value;
    }

    number(value) {
        let remaining = value;
        while (remaining >= 128) {
            this.byte((remaining % 128) + 128);
            remaining = Math.floor(remaining / 128);
        }
        this.byte(remaining);
    }

    raw(bytes) {
        this.reserve(bytes.length);
        this.bytes.set(bytes, this.length);
        this.length += bytes.length;
    }

    block(bytes) {
        this.number(bytes.length);
        this.raw(bytes);
    }

    text(value) {
        this.block(encoder.encode(value));
    }

    result() {
        return this.bytes.subarray(0, this.length);
    }
}

class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.offset = 0;
    }

    byte() {
        if (this.offset >= this.bytes.length) throw new Error('Snapshot ended early');
        return this.bytes[this.offset++];
    }

    number() {
        let value = 0;
        let scale = 1;
        for (let index = 0; index < 8; index++) {
            const byte = this.byte();
            value += (byte % 128) * scale;
            if (byte < 128) return value;
            scale *= 128;
        }
        throw new Error('Snapshot number is too long');
    }

    raw(size) {
        if (this.offset + size > this.bytes.length) throw new Error('Snapshot ended early');
        const bytes = this.bytes.subarray(this.offset, this.offset + size);
        this.offset += size;
        return bytes;
    }

    block() {
        return this.raw(this.number());
    }

    text() {
        return decoder.decode(this.block());
    }
}

function sharedPrefixLength(a, b) {
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a[index] === b[index]) index++;
    return index;
}

function writeSortedText(values) {
    const writer = new Writer();
    let previous = new Uint8Array(0);

    values.forEach((value) => {
        const bytes = encoder.encode(value);
        const shared = sharedPrefixLength(previous, bytes);
        writer.number(shared);
        writer.block(bytes.subarray(shared));
        previous = bytes;
    });
    return writer.result();
}

function readSortedText(bytes, count) {
    const reader = new Reader(bytes);
    const values = [];
    let previous = new Uint8Array(0);

    for (let index = 0; index < count; index++) {
        const shared = reader.number();
        const suffix = reader.block();
        if (shared > previous.length) throw new Error('Invalid sorted text');

        const value = new Uint8Array(shared + suffix.length);
        value.set(previous.subarray(0, shared));
        value.set(suffix, shared);
        values.push(decoder.decode(value));
        previous = value;
    }
    return values;
}

function writeTextColumn(values) {
    const writer = new Writer();
    values.forEach((value) => writer.text(value));
    return writer.result();
}

function readTextColumn(bytes) {
    const reader = new Reader(bytes);
    const values = [];
    while (reader.offset < bytes.length) values.push(reader.text());
    return values;
}

function writeLookupColumn(values) {
    const lookup = [...new Set(values)];
    const positions = new Map(lookup.map((value, index) => [value, index]));
    const writer = new Writer();

    writer.block(writeTextColumn(lookup));
    values.forEach((value) => writer.number(positions.get(value)));
    return writer.result();
}

function readLookupColumn(bytes, count) {
    const reader = new Reader(bytes);
    const lookup = readTextColumn(reader.block());
    const values = [];

    for (let index = 0; index < count; index++) {
        const position = reader.number();
        if (position >= lookup.length) throw new Error('Invalid lookup value');
        values.push(lookup[position]);
    }
    return values;
}

function base64ToBytes(value) {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

function base64UrlToBytes(value) {
    return base64ToBytes(value.replaceAll('-', '+').replaceAll('_', '/'));
}

function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// Sorted URLs and sorted times sit in separate columns, which compress best
export function packSnapshot(room, entries) {
    const sorted = [...entries].sort((a, b) => (
        a.sourceURL < b.sourceURL ? -1
            : a.sourceURL > b.sourceURL ? 1
                : a.timestamp - b.timestamp || String(a.entryId).localeCompare(String(b.entryId))
    ));

    const flags = new Writer();
    const times = new Writer();
    const hashes = new Writer();
    const thumbHashes = new Writer();
    const signatures = new Writer();
    const works = new Writer();
    const magnetTexts = [];
    const instantLinks = [];
    const titles = [];
    let previousTime = 0;

    sorted.forEach((entry) => {
        const magnetHash = getMagnetHash(entry.magnet);
        const title = entry.title ?? '';
        let flag = 0;

        if (magnetHash) {
            flag |= HAS_MAGNET_HASH;
            hashes.raw(base64ToBytes(magnetHash));
        } else if (entry.magnet) {
            flag |= HAS_MAGNET_TEXT;
            magnetTexts.push(entry.magnet);
        }
        if (entry.instantIOLink) {
            flag |= HAS_INSTANT_IO;
            instantLinks.push(entry.instantIOLink);
        }
        if (title !== extractTitle(entry.sourceURL)) {
            flag |= HAS_TITLE;
            titles.push(title);
        }
        if (entry.thumbHash) {
            flag |= HAS_THUMB_HASH;
            thumbHashes.block(base64ToBytes(entry.thumbHash));
        }
        if (entry.hasPreview) flag |= HAS_PREVIEW;
        if (entry.signature) {
            flag |= HAS_SIGNATURE;
            signatures.raw(base64UrlToBytes(entry.signature));
        }
        if (Number.isSafeInteger(entry.work) && entry.work >= 0) {
            flag |= HAS_WORK;
            works.number(entry.work);
        }

        flags.byte(flag);
        const change = entry.timestamp - previousTime;
        times.number(change >= 0 ? change * 2 : -change * 2 - 1);
        previousTime = entry.timestamp;
    });

    const output = new Writer();
    output.raw(encoder.encode(MAGIC));
    output.byte(VERSION);
    output.text(room);
    output.number(sorted.length);
    output.block(writeSortedText(sorted.map((entry) => entry.sourceURL)));
    output.block(writeLookupColumn(sorted.map((entry) => entry.addedBy || '')));
    output.block(times.result());
    output.block(flags.result());
    output.block(hashes.result());
    output.block(writeTextColumn(magnetTexts));
    output.block(writeTextColumn(instantLinks));
    output.block(writeTextColumn(titles));
    output.block(thumbHashes.result());
    output.block(writeLookupColumn(sorted.map((entry) => entry.authorKey || '')));
    output.block(signatures.result());
    output.block(works.result());
    return output.result();
}

export function unpackSnapshot(bytes) {
    const reader = new Reader(bytes);
    if (decoder.decode(reader.raw(MAGIC.length)) !== MAGIC) throw new Error('Not a snapshot');
    const version = reader.byte();
    if (version !== 2 && version !== VERSION) throw new Error('Unknown snapshot version');

    const room = reader.text();
    const count = reader.number();
    if (count > MAX_ENTRIES) throw new Error('Snapshot is too large');

    const urls = readSortedText(reader.block(), count);
    const users = readLookupColumn(reader.block(), count);
    const times = new Reader(reader.block());
    const flags = reader.block();
    const hashes = new Reader(reader.block());
    const magnetTexts = readTextColumn(reader.block());
    const instantLinks = readTextColumn(reader.block());
    const titles = readTextColumn(reader.block());
    const thumbHashes = new Reader(reader.block());
    const authorKeys = readLookupColumn(reader.block(), count);
    const signatures = new Reader(reader.block());
    const works = new Reader(version >= 3 ? reader.block() : new Uint8Array(0));

    if (flags.length !== count) throw new Error('Invalid snapshot flags');

    const next = (column) => {
        if (column.index === undefined) column.index = 0;
        if (column.index >= column.length) throw new Error('Snapshot column ended early');
        return column[column.index++];
    };

    let time = 0;
    const entries = urls.map((sourceURL, index) => {
        const flag = flags[index];
        const change = times.number();
        time += change % 2 === 0 ? change / 2 : -(change + 1) / 2;

        return {
            sourceURL,
            addedBy: users[index],
            timestamp: time,
            room,
            magnet: flag & HAS_MAGNET_HASH
                ? buildMagnet(bytesToBase64(hashes.raw(20)))
                : flag & HAS_MAGNET_TEXT ? next(magnetTexts) : null,
            instantIOLink: flag & HAS_INSTANT_IO ? next(instantLinks) : null,
            title: flag & HAS_TITLE ? next(titles) : extractTitle(sourceURL),
            thumbHash: flag & HAS_THUMB_HASH ? bytesToBase64(thumbHashes.block()) : null,
            hasPreview: (flag & HAS_PREVIEW) !== 0,
            authorKey: authorKeys[index] || null,
            signature: flag & HAS_SIGNATURE ? bytesToBase64Url(signatures.raw(SIGNATURE_BYTES)) : null,
            work: flag & HAS_WORK ? works.number() : null
        };
    });

    return { room, entries };
}

async function transform(bytes, stream) {
    const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await response.arrayBuffer());
}

export function compressSnapshot(bytes) {
    return transform(bytes, new CompressionStream('gzip'));
}

// Stops a tiny file from expanding into something huge
export async function decompressSnapshot(bytes) {
    const reader = new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream('gzip'))
        .getReader();
    const chunks = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        total += value.length;
        if (total > MAX_UNPACKED_BYTES) {
            await reader.cancel();
            throw new Error('Snapshot is too large');
        }
        chunks.push(value);
    }

    const output = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
        output.set(chunk, offset);
        offset += chunk.length;
    });
    return output;
}
