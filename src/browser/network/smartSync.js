// smartSync.js - Peers compare small fingerprints and swap only what differs
import { selfId } from 'trystero';
import { getSyncFingerprints, getSyncIds, getEntryById } from '../storage/db.js';
import { toPublicEntry } from '../../shared/entryId.js';

const MAX_LIST_SIZE = 64;
const MAX_PREFIXES = 4096;
const MAX_PREFIX_LENGTH = 32;
const HEX_DIGITS = '0123456789abcdef';

export const syncStats = { sentBytes: 0, messages: 0 };

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

// One side starts, so two peers do not run the same sync twice
export async function startSync(connection) {
    if (selfId > connection.peer) return;

    const parts = await getSyncFingerprints(['']);
    sendSync(connection, { type: 'sync_fingerprints', parts });
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
