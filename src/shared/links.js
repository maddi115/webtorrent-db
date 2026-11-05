// links.js - Clean URLs and store magnet links in their smallest form
const TRACKING_PARAMS = new Set([
    'fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid', 'ref_src', 'si'
]);
const MAGNET_PREFIX = 'magnet:?xt=urn:btih:';
const CANONICAL_MAGNET = /^magnet:\?xt=urn:btih:[0-9a-f]{40}$/;

export function cleanURL(value) {
    try {
        const url = new URL(value);
        [...url.searchParams.keys()].forEach((key) => {
            if (key.startsWith('utm_') || TRACKING_PARAMS.has(key)) {
                url.searchParams.delete(key);
            }
        });
        return url.href;
    } catch {
        return value;
    }
}

// Keeps only the file's hash. Trackers are added again when downloading.
export function normalizeMagnet(value) {
    const match = value.match(/^magnet:\?(?:.*&)?xt=urn:btih:([0-9a-f]{40})(?:&|$)/i);
    return match ? `${MAGNET_PREFIX}${match[1].toLowerCase()}` : value;
}

export function getMagnetHash(magnet) {
    if (!magnet || !CANONICAL_MAGNET.test(magnet)) return null;

    const hex = magnet.slice(MAGNET_PREFIX.length);
    const bytes = hex.match(/../g).map((byte) => parseInt(byte, 16));
    return btoa(String.fromCharCode(...bytes));
}

export function buildMagnet(hash) {
    const bytes = atob(hash);
    if (bytes.length !== 20) throw new Error('Invalid magnet hash');

    const hex = Array.from(bytes, (char) => (
        char.charCodeAt(0).toString(16).padStart(2, '0')
    )).join('');
    return `${MAGNET_PREFIX}${hex}`;
}

// Accepts a magnet, or an instant.io link that contains a torrent hash
export function getDownloadMagnet(value) {
    if (typeof value !== 'string') return null;
    if (value.startsWith('magnet:?')) return value;

    const match = value.match(/^https:\/\/instant\.io\/#([0-9a-f]{40})/i);
    return match ? `${MAGNET_PREFIX}${match[1].toLowerCase()}` : null;
}
