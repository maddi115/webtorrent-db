// entryRules.js - Check links from peers before saving them
import { isTopic } from './rooms.js';
import { safeLink, safeThumbHash, shortText } from './safe.js';

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export function isPublicKey(value) {
    return typeof value === 'string' && PUBLIC_KEY.test(value);
}

export function isSignature(value) {
    return typeof value === 'string' && SIGNATURE.test(value);
}

export function cleanRemoteEntry(rawEntry, expectedRoom) {
    if (typeof rawEntry?.sourceURL !== 'string' || !rawEntry.sourceURL) return null;
    if (!Number.isSafeInteger(rawEntry.timestamp) || rawEntry.timestamp < 0) return null;

    const room = rawEntry.room || 'general';
    if (!isTopic(room) || room !== expectedRoom) return null;

    return {
        sourceURL: shortText(rawEntry.sourceURL, 2000),
        magnet: shortText(rawEntry.magnet, 4000) || null,
        instantIOLink: safeLink(rawEntry.instantIOLink) === '#' ? null : shortText(rawEntry.instantIOLink, 2000),
        title: shortText(rawEntry.title, 200),
        addedBy: shortText(rawEntry.addedBy, 100),
        timestamp: rawEntry.timestamp,
        thumb: null,
        thumbHash: safeThumbHash(rawEntry.thumbHash),
        hasPreview: rawEntry.hasPreview === true,
        preview: null,
        room,
        authorKey: isPublicKey(rawEntry.authorKey) ? rawEntry.authorKey : null,
        signature: isSignature(rawEntry.signature) ? rawEntry.signature : null
    };
}
