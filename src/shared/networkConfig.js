// networkConfig.js - Relay, TURN, and cell settings for the room network
import { defaultRelayUrls } from 'trystero';

const PUBLIC_RELAY_COUNT = 6;
const devOptions = new URLSearchParams(import.meta.env.DEV ? location.search : '');
const pageOptions = new URLSearchParams(location.search);

function listFromEnv(value) {
    return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

// Your own bootstrap relays come first, then a fixed set of public ones
export function getRelayUrls() {
    const bootstrap = [
        ...listFromEnv(import.meta.env.VITE_BOOTSTRAP_RELAYS),
        ...devOptions.getAll('relay')
    ];
    const publicRelays = devOptions.get('publicRelays') === 'off'
        ? []
        : defaultRelayUrls.slice(0, PUBLIC_RELAY_COUNT);
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
