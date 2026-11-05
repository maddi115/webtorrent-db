// entryId.js - The same link details always make the same ID
export async function getEntryId(entry) {
    const parts = [
        entry.sourceURL,
        entry.magnet || '',
        entry.instantIOLink || '',
        entry.title || '',
        entry.addedBy || '',
        entry.timestamp
    ];
    if (entry.room && entry.room !== 'general') parts.push(entry.room);

    const bytes = new TextEncoder().encode(parts.join('\n'));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash).slice(0, 16))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

// Peers get the thumbnail now and fetch the full image only when it is opened
export function toPublicEntry(entry) {
    const { id, preview, ...publicEntry } = entry;
    return { ...publicEntry, hasPreview: Boolean(preview || entry.hasPreview) };
}
