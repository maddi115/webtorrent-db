// nostrStore.js - Saves signed posts on Nostr relays, so new visitors get links even when nobody is online.
// The relays only hold copies. Every copy is checked like any post from a peer:
// signed, not changed, not deleted, and not too many from one person.
import { schnorr } from '@noble/secp256k1';
import { getRelayUrls, networkSettings } from '../../shared/networkConfig.js';
import { toPublicEntry } from '../../shared/entryId.js';
import { logger } from '../../shared/logger.js';

const KIND = 30078;
const KEY_STORAGE = 'webtorrent-nostr-key';
const SOCKET_TIMEOUT_MS = 5000;
const MAX_CONTENT_CHARS = 8000;
const MAX_RELAYS = 6;
const POST_LIMIT = 500;
const devOptions = new URLSearchParams(import.meta.env.DEV ? location.search : '');
const encoder = new TextEncoder();

export const storeStats = { published: 0, loaded: 0 };

function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
    return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
}

// Relays need their own kind of signature. This key is only for that, not for your posts.
function getNostrKey() {
    try {
        const saved = localStorage.getItem(KEY_STORAGE);
        if (saved && /^[0-9a-f]{64}$/.test(saved)) return fromHex(saved);
    } catch {
        // A new key is made below
    }
    const { secretKey } = schnorr.keygen();
    try {
        localStorage.setItem(KEY_STORAGE, toHex(secretKey));
    } catch {
        // The key still works until this page closes
    }
    return secretKey;
}

function tagFor(name) {
    return `${networkSettings.roomPrefix}${name}`;
}

function storeRelays() {
    const custom = devOptions.getAll('storeRelay');
    if (custom.length) return custom;
    return getRelayUrls().filter((url) => url.startsWith('wss://')).slice(0, MAX_RELAYS);
}

async function makeEvent(d, t, content) {
    const secretKey = getNostrKey();
    const event = {
        kind: KIND,
        tags: [['d', d], ['t', t]],
        created_at: Math.floor(Date.now() / 1000),
        content,
        pubkey: toHex(schnorr.getPublicKey(secretKey))
    };
    const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const id = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(serialized)));
    return { ...event, id: toHex(id), sig: toHex(await schnorr.signAsync(id, secretKey)) };
}

function publish(event) {
    storeRelays().forEach((url) => {
        let socket;
        try {
            socket = new WebSocket(url);
        } catch {
            return;
        }
        const timer = setTimeout(() => socket.close(), SOCKET_TIMEOUT_MS);
        socket.onopen = () => socket.send(JSON.stringify(['EVENT', event]));
        socket.onmessage = ({ data }) => {
            try {
                if (JSON.parse(data)[0] === 'OK') {
                    clearTimeout(timer);
                    socket.close();
                }
            } catch {
                // Ignored
            }
        };
        socket.onerror = () => {};
    });
    storeStats.published += 1;
}

async function save(d, t, payload) {
    const content = JSON.stringify(payload);
    if (content.length > MAX_CONTENT_CHARS) return;
    try {
        publish(await makeEvent(d, t, content));
    } catch (error) {
        logger.warn('⚠️ Could not save to relays', error);
    }
}

export function savePost(entry) {
    return save(entry.entryId, tagFor(entry.room || 'general'), toPublicEntry(entry));
}

export function saveDeletes(packedNotes) {
    return Promise.all(packedNotes.map((note) => save(`del-${note.i}`, tagFor('deletes'), { deletes: [note] })));
}

export function saveWipe(note) {
    return save('wipe', tagFor('wipe'), { wipe: note });
}

// Asks each relay for saved events and collects them until it says it has sent everything
function fetchEvents(filters) {
    const found = new Map();
    return Promise.all(storeRelays().map((url) => new Promise((resolve) => {
        let socket;
        try {
            socket = new WebSocket(url);
        } catch {
            resolve();
            return;
        }
        const subId = `load-${Math.random().toString(36).slice(2, 10)}`;
        const finish = () => {
            clearTimeout(timer);
            try {
                socket.close();
            } catch {
                // Already closed
            }
            resolve();
        };
        const timer = setTimeout(finish, SOCKET_TIMEOUT_MS);
        socket.onopen = () => socket.send(JSON.stringify(['REQ', subId, ...filters]));
        socket.onmessage = ({ data }) => {
            try {
                const [type, id, event] = JSON.parse(data);
                if (id !== subId) return;
                if (type === 'EOSE') finish();
                if (type === 'EVENT' && event?.kind === KIND && typeof event.content === 'string'
                    && event.content.length <= MAX_CONTENT_CHARS && !found.has(event.id)) {
                    found.set(event.id, event);
                }
            } catch {
                // Broken messages from a relay are ignored
            }
        };
        socket.onerror = finish;
        socket.onclose = finish;
    }))).then(() => [...found.values()]);
}

function readTag(event, name) {
    return (event.tags || []).find((tag) => tag[0] === name)?.[1];
}

// Loads saved posts for this room, then deletes and clear-alls, and checks every one
export async function loadFromRelays(room) {
    if (!storeRelays().length) return 0;
    const events = await fetchEvents([
        { kinds: [KIND], '#t': [tagFor(room)], limit: POST_LIMIT },
        { kinds: [KIND], '#t': [tagFor('deletes')], limit: POST_LIMIT },
        { kinds: [KIND], '#t': [tagFor('wipe')], limit: 10 }
    ]);
    const posts = [];
    const deletes = [];
    const wipes = [];
    events.forEach((event) => {
        try {
            const content = JSON.parse(event.content);
            const tag = readTag(event, 't');
            if (tag === tagFor(room)) posts.push(content);
            else if (tag === tagFor('deletes') && Array.isArray(content.deletes)) deletes.push(...content.deletes);
            else if (tag === tagFor('wipe') && content.wipe) wipes.push(content.wipe);
        } catch {
            // Not ours
        }
    });

    const { receiveEntries, updateEntryCount } = await import('../storage/db.js');
    const { fromPublicEntry } = await import('../../shared/entryId.js');
    const { receiveDeletes, receiveWipe } = await import('./deletes.js');
    let saved = 0;
    if (posts.length) {
        const rawEntries = posts.flatMap((packed) => {
            try {
                return [fromPublicEntry(packed)];
            } catch {
                return [];
            }
        });
        saved = (await receiveEntries(rawEntries)).saved.length;
    }
    if (deletes.length) await receiveDeletes(deletes, null);
    for (const wipe of wipes) await receiveWipe(wipe, null);

    storeStats.loaded += saved;
    if (saved) {
        logger.info(`📦 Loaded ${saved} saved links from relays`);
        await updateEntryCount();
        const { refreshResults } = await import('../ui/search.js');
        refreshResults();
    }
    return saved;
}
