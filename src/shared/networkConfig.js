// networkConfig.js - Relay, TURN, and cell settings for the room network
// Public relays that only pass introductions along. The first three are known to work.
// Every browser starts from this same list, so they always share relays.
export const PUBLIC_RELAYS = [
    'wss://nos.lol',
    'wss://cdn.satellite.earth',
    'wss://nostr.chaima.info',
    'wss://relay.damus.io',
    'wss://nostr.rblb.it',
    'wss://nostr.robosats.org',
    'wss://nostr.stakey.net',
    'wss://relay.nostr.dev.br',
    'wss://relay.degmods.com',
    'wss://relay.layer.systems'
];
const DEAD_RELAYS_KEY = 'webtorrent-dead-relays';
const DEAD_FOR_MS = 24 * 60 * 60 * 1000;
const MIN_PUBLIC_RELAYS = 4;
const devOptions = new URLSearchParams(import.meta.env.DEV ? location.search : '');
const pageOptions = new URLSearchParams(location.search);

function listFromEnv(value) {
    return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function loadDeadRelays() {
    try {
        const saved = JSON.parse(localStorage.getItem(DEAD_RELAYS_KEY)) || {};
        const now = Date.now();
        return Object.fromEntries(Object.entries(saved).filter(([, time]) => now - time < DEAD_FOR_MS));
    } catch {
        return {};
    }
}

// Remembers which relays failed in this browser, so the next visit skips them for a day
export function saveRelayHealth(working, failed) {
    const dead = loadDeadRelays();
    working.forEach((url) => delete dead[url]);
    failed.forEach((url) => { if (PUBLIC_RELAYS.includes(url)) dead[url] = Date.now(); });
    try {
        localStorage.setItem(DEAD_RELAYS_KEY, JSON.stringify(dead));
    } catch {
        // Health is only a speed-up for the next visit
    }
}

// Public relays, minus any that failed here lately, but never fewer than a few
export function getPublicRelays() {
    const dead = loadDeadRelays();
    const alive = PUBLIC_RELAYS.filter((url) => !dead[url]);
    return alive.length >= MIN_PUBLIC_RELAYS ? alive : PUBLIC_RELAYS;
}

// Your own bootstrap relays come first, then the public ones
export function getRelayUrls() {
    const bootstrap = [
        ...listFromEnv(import.meta.env.VITE_BOOTSTRAP_RELAYS),
        ...devOptions.getAll('relay')
    ];
    const publicRelays = devOptions.get('publicRelays') === 'off' ? [] : getPublicRelays();
    return [...new Set([...bootstrap, ...publicRelays])];
}

// TURN is off until these settings are filled in
export function getTurnConfig() {
    const urls = listFromEnv(import.meta.env.VITE_TURN_URLS);
    if (!urls.length) return undefined;

    return [{
        urls,
        username: import.meta.env.VITE_TURN_USERNAME,
        credential: import.meta.env.VITE_TURN_CREDENTIAL
    }];
}

export const networkSettings = {
    roomPrefix: devOptions.get('testRoom') ? `${devOptions.get('testRoom')}-` : 'v1-',
    cellSize: Number(devOptions.get('capacity')) || 4,
    visitorSlots: Number(devOptions.get('visitors')) || 2,
    aloneMs: Number(devOptions.get('rejoinMs')) || 90000,
    linkRetryMs: Number(devOptions.get('linkRetryMs')) || 20000,
    linkCheckMs: Number(devOptions.get('linkCheckMs')) || 8000,
    helperCells: Number(devOptions.get('helperCells')) || 16,
    isHelper: pageOptions.get('role') === 'helper'
};
