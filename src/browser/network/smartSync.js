// smartSync.js - Peers compare small fingerprints and swap only what differs
import { selfId } from 'trystero';
import { getSyncFingerprints, getSyncIds, getSyncItems, getEntryById } from '../storage/db.js';
import { toPublicEntry } from '../../shared/entryId.js';
import { bytesToHex, hexToBytes, Negentropy, Storage } from '../../shared/negentropy.js';

const MAX_LIST_SIZE = 64;
const MAX_PREFIXES = 4096;
const MAX_PREFIX_LENGTH = 32;
const HEX_DIGITS = '0123456789abcdef';

export const syncStats = { sentBytes: 0, messages: 0, negentropy: 0, fingerprints: 0 };

function sendSync(connection, message) {
    syncStats.sentBytes += JSON.stringify(message).length;
    syncStats.messages += 1;
    connection.send(message);
}

function isPrefix(value) {
    return typeof value === 'string'
        && value.length <= MAX_PREFIX_LENGTH
        && /^[0-9a-f]*$/.test(value);
}

// Newer browsers say they can use Negentropy. Older ones get the first sync method.
export const SYNC_VERSION = 2;
const STORAGE_REUSE_MS = 20000;
const MAX_NEG_HEX = 4 * 1024 * 1024;
const MAX_ENTRIES_SENT = 5000;
const sessions = new Map();
let cachedStorage = null;

async function getStorage() {
    if (cachedStorage && Date.now() - cachedStorage.at < STORAGE_REUSE_MS) return cachedStorage.storage;
    const rows = await getSyncItems();
    const storage = new Storage(rows.map(([timestamp, id]) => ({ timestamp, id })));
    cachedStorage = { at: Date.now(), storage };
    return storage;
}

// Something changed, so the next sync reads the database again
export function forgetSyncCache() {
    cachedStorage = null;
}

// One side starts, so two peers do not run the same sync twice
export async function startSync(connection, force = false, peerVersion = 1) {
    if (!force && selfId > connection.peer) return;

    if (peerVersion >= SYNC_VERSION) {
        forgetSyncCache();
        const negentropy = new Negentropy(await getStorage());
        sessions.set(connection.peer, negentropy);
        sendSync(connection, { type: 'neg', m: bytesToHex(await negentropy.initiate()) });
        syncStats.negentropy += 1;
        return;
    }
    syncStats.fingerprints += 1;

    const parts = await getSyncFingerprints(['']);
    sendSync(connection, { type: 'sync_fingerprints', parts });
}

function readMessage(data) {
    if (typeof data?.m !== 'string' || data.m.length > MAX_NEG_HEX) return null;
    try {
        return hexToBytes(data.m);
    } catch {
        return null;
    }
}

// The other side started a sync, so answer with ranges that differ
export async function handleNeg(data, connection) {
    const message = readMessage(data);
    if (!message) return;
    try {
        const { reply } = await new Negentropy(await getStorage()).reconcile(message);
        sendSync(connection, { type: 'neg_reply', m: bytesToHex(reply) });
    } catch {
        // A broken sync message is ignored
    }
}

// The answer to a sync we started: send what they lack, ask for what we lack
export async function handleNegReply(data, connection, requestMissing) {
    const negentropy = sessions.get(connection.peer);
    const message = readMessage(data);
    if (!negentropy || !message) return;

    try {
        const { reply, haveIds, needIds } = await negentropy.reconcile(message);
        for (const id of haveIds.slice(0, MAX_ENTRIES_SENT)) {
            const entry = await getEntryById(id);
            if (entry?.signature) sendSync(connection, { type: 'entry', entry: toPublicEntry(entry) });
        }
        if (needIds.length) requestMissing(needIds, connection);
        if (reply) sendSync(connection, { type: 'neg', m: bytesToHex(reply) });
        else sessions.delete(connection.peer);
    } catch {
        sessions.delete(connection.peer);
    }
}

export async function handleFingerprints(data, connection) {
    if (!Array.isArray(data.parts)) return;

    const theirs = data.parts
        .slice(0, MAX_PREFIXES)
        .filter((part) => isPrefix(part?.p));
    const mine = await getSyncFingerprints(theirs.map((part) => part.p));
    const nextPrefixes = [];
    const lists = [];

    for (let index = 0; index < theirs.length; index++) {
        const their = theirs[index];
        const my = mine[index];
        if (their.c === my.c && their.f === my.f) continue;

        const canList = my.c === 0
            || their.c === 0
            || my.c + their.c <= MAX_LIST_SIZE
            || my.p.length >= MAX_PREFIX_LENGTH;

        if (canList) {
            lists.push({ p: my.p, ids: my.c === 0 ? [] : await getSyncIds(my.p) });
        } else {
            for (const digit of HEX_DIGITS) nextPrefixes.push(my.p + digit);
        }
    }

    if (lists.length) {
        sendSync(connection, { type: 'sync_lists', lists });
    }
    if (nextPrefixes.length) {
        const parts = await getSyncFingerprints(nextPrefixes);
        sendSync(connection, { type: 'sync_fingerprints', parts });
    }
}

export async function handleLists(data, connection, requestMissing) {
    if (!Array.isArray(data.lists)) return;

    const missing = [];
    for (const list of data.lists.slice(0, MAX_PREFIXES)) {
        if (!isPrefix(list?.p) || !Array.isArray(list.ids)) continue;

        const theirIds = new Set(list.ids.filter((id) => typeof id === 'string'));
        const myIds = new Set(await getSyncIds(list.p));

        theirIds.forEach((id) => {
            if (!myIds.has(id)) missing.push(id);
        });

        for (const id of myIds) {
            if (theirIds.has(id)) continue;

            const entry = await getEntryById(id);
            if (entry) sendSync(connection, { type: 'entry', entry: toPublicEntry(entry) });
        }
    }

    requestMissing(missing, connection);
}
