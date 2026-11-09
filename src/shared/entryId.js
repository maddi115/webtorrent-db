// entryId.js - IDs and the compact format links use between peers
import { extractTitle } from './urlParser.js';
import { buildMagnet, getMagnetHash } from './links.js';

// The exact text a link's signature covers
export function getSignedText(entry) {
    return [
        'wtdb-link-1',
        entry.sourceURL,
        entry.magnet || '',
        entry.instantIOLink || '',
        entry.title || '',
        entry.addedBy || '',
        entry.timestamp,
        entry.room || 'general',
        entry.thumbHash || '',
        entry.hasPreview ? 1 : 0,
        entry.authorKey || ''
    ].join('\n');
}

// The same link details always make the same ID
export async function getEntryId(entry) {
    const bytes = new TextEncoder().encode(getSignedText(entry));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash).slice(0, 16))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

// Send only what peers cannot rebuild. Images load later when needed.
export function toPublicEntry(entry) {
    const packed = { u: entry.sourceURL, a: entry.addedBy, s: entry.timestamp };
    const magnetHash = getMagnetHash(entry.magnet);

    if (magnetHash) packed.h = magnetHash;
    else if (entry.magnet) packed.m = entry.magnet;
    if (entry.instantIOLink) packed.i = entry.instantIOLink;
    if (entry.title !== extractTitle(entry.sourceURL)) packed.t = entry.title;
    if (entry.room && entry.room !== 'general') packed.r = entry.room;
    if (entry.thumbHash) packed.b = entry.thumbHash;
    if (entry.preview || entry.hasPreview) packed.p = 1;
    if (entry.authorKey) packed.k = entry.authorKey;
    if (entry.signature) packed.g = entry.signature;
    if (Number.isSafeInteger(entry.work)) packed.w = entry.work;
    return packed;
}

export function fromPublicEntry(packed) {
    return {
        sourceURL: packed?.u,
        addedBy: packed?.a,
        timestamp: packed?.s,
        magnet: packed?.h ? buildMagnet(packed.h) : packed?.m,
        instantIOLink: packed?.i,
        title: packed && 't' in packed ? packed.t : extractTitle(packed?.u),
        room: packed?.r,
        thumbHash: packed?.b,
        hasPreview: packed?.p === 1,
        authorKey: packed?.k,
        signature: packed?.g,
        work: packed?.w
    };
}
