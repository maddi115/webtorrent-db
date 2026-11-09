// work.js - Each new post solves a small puzzle first, about a second of computer work.
// That is nothing for one post, but it makes posting thousands of spam links expensive.
const devOptions = new URLSearchParams(import.meta.env.DEV && typeof location !== 'undefined' ? location.search : '');
const encoder = new TextEncoder();

export const WORK_BITS = devOptions.has('powBits') ? Number(devOptions.get('powBits')) : 18;
// Posts from before this date were made without the puzzle, so they still count
export const WORK_REQUIRED_AFTER = devOptions.has('powAfter') ? Number(devOptions.get('powAfter')) : Date.UTC(2026, 10, 10);

function leadingZeroBits(bytes) {
    let bits = 0;
    for (const byte of bytes) {
        if (byte === 0) {
            bits += 8;
            continue;
        }
        return bits + Math.clz32(byte) - 24;
    }
    return bits;
}

async function workBits(entryId, nonce) {
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(`wtdb-work-1:${entryId}:${nonce}`));
    return leadingZeroBits(new Uint8Array(hash));
}

export function needsWork(timestamp, after = WORK_REQUIRED_AFTER) {
    return timestamp >= after;
}

export async function hasWork(entry, bits = WORK_BITS) {
    if (bits <= 0) return true;
    if (!Number.isSafeInteger(entry.work) || entry.work < 0) return false;
    return await workBits(entry.entryId, entry.work) >= bits;
}

// Tries numbers until the post's puzzle is solved. Call this after signing.
export async function addWork(entry, bits = WORK_BITS) {
    let nonce = 0;
    if (bits > 0) {
        while (await workBits(entry.entryId, nonce) < bits) nonce += 1;
    }
    entry.work = nonce;
    return entry;
}
