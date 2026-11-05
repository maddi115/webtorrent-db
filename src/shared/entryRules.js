// entryRules.js - Check links from peers before saving them
import { isTopic } from './rooms.js';
import { safeLink, safeThumbHash, shortText } from './safe.js';

export function cleanRemoteEntry(rawEntry, expectedRoom) {
    if (typeof rawEntry?.sourceURL !== 'string' || !rawEntry.sourceURL) return null;
    if (!Number.isFinite(rawEntry.timestamp)) return null;

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
        room
    };
}
