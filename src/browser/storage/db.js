// db.js - The app's database, stored in SQLite inside a worker
import { openDB } from 'idb';
import { extractSlug } from '../../shared/urlParser.js';
import { getEntryId } from '../../shared/entryId.js';
import { resizeImage } from '../../shared/images.js';
import { getTopic } from '../../shared/rooms.js';

const OLD_DB_NAME = 'webtorrent-metadata-db-v2';
const IMPORT_BATCH_SIZE = 200;

const worker = new Worker(new URL('./sqliteWorker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextCallId = 1;
let storageMode = null;
let markReady;
const dbReady = new Promise((resolve) => { markReady = resolve; });

worker.onmessage = ({ data: { id, result, error } }) => {
    const call = pending.get(id);
    pending.delete(id);
    if (error) {
        call.reject(new Error(error));
    } else {
        call.resolve(result);
    }
};

function call(method, ...args) {
    return new Promise((resolve, reject) => {
        const id = nextCallId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args });
    });
}

async function ready(method, ...args) {
    await dbReady;
    return call(method, ...args);
}

async function prepareOldEntry(entry) {
    const copy = { ...entry };
    copy.entryId = copy.entryId || await getEntryId(copy);
    copy.hasPreview = Boolean(copy.preview || copy.hasPreview);
    if (copy.preview && !copy.thumb) {
        copy.thumb = await resizeImage(copy.preview, 160, 0.7).catch(() => null);
    }
    return copy;
}

// Copies old links once. The old database stays in place as a backup.
async function migrateOldDatabase() {
    if (await call('getMeta', 'indexeddb_migrated')) return;

    const databases = await indexedDB.databases();
    if (databases.some((database) => database.name === OLD_DB_NAME)) {
        const oldDb = await openDB(OLD_DB_NAME);
        const entries = oldDb.objectStoreNames.contains('entries')
            ? await oldDb.getAll('entries')
            : [];
        const stats = oldDb.objectStoreNames.contains('stats')
            ? await oldDb.getAll('stats')
            : [];
        oldDb.close();

        for (let start = 0; start < entries.length; start += IMPORT_BATCH_SIZE) {
            const batch = entries.slice(start, start + IMPORT_BATCH_SIZE);
            await call('importEntries', await Promise.all(batch.map(prepareOldEntry)));
        }
        await call('importStats', stats);
    }

    await call('setMeta', 'indexeddb_migrated', '1');
}

export async function initDB() {
    ({ storageMode } = await call('open'));
    await migrateOldDatabase();
    markReady();
    console.log(`✅ SQLite database ready (${storageMode})`);
}

export function getStorageMode() {
    return storageMode;
}

export function getEntryById(entryId) {
    return ready('getEntryById', entryId);
}

export function getEntryByURL(url) {
    return ready('getEntryByURL', url);
}

export function getAllEntries() {
    return ready('getAllEntries');
}

export function getRoomEntries() {
    return ready('getRoomEntries', getTopic());
}

export async function getEntrySummaries() {
    const links = await ready('getRoomLinks', getTopic());
    return links.map(({ id, sourceURL }) => ({ id, slug: extractSlug(sourceURL) }));
}

export function getEntryCount() {
    return ready('getEntryCount', getTopic());
}

export function savePreview(entryId, preview) {
    return ready('savePreview', entryId, preview);
}

export async function addEntry(entry) {
    await ready('addEntry', entry);
    await updateEntryCount();
}

export function searchEntries(query) {
    return ready('searchEntries', getTopic(), query);
}

export async function updateEntryCount() {
    const count = await getEntryCount();
    const countEl = document.getElementById('entry-count');
    if (countEl) countEl.textContent = count;
}

export function trackSearch(contentId) {
    return ready('trackStat', contentId, 'searches');
}

export function trackDownload(contentId) {
    return ready('trackStat', contentId, 'downloads');
}

export function getStats(contentId) {
    return ready('getStats', contentId);
}
