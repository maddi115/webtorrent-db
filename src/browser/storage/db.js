// db.js - Add stats tracking
import { openDB } from 'idb';
import { extractSlug, extractTitle } from '../../shared/urlParser.js';
import { getEntryId } from '../../shared/entryId.js';
import { resizeImage } from '../../shared/images.js';

const DB_NAME = 'webtorrent-metadata-db-v2';
const STORE_NAME = 'entries';
const STATS_STORE = 'stats';

let db;
let markReady;
const dbReady = new Promise((resolve) => { markReady = resolve; });

export async function initDB() {
    db = await openDB(DB_NAME, 5, {
        upgrade(upgradeDb, oldVersion, newVersion, transaction) {
            // Entries store
            if (!upgradeDb.objectStoreNames.contains(STORE_NAME)) {
                const store = upgradeDb.createObjectStore(STORE_NAME, { 
                    keyPath: 'id', 
                    autoIncrement: true 
                });
                store.createIndex('sourceURL', 'sourceURL', { unique: false });
                store.createIndex('timestamp', 'timestamp');
            }

            const entries = transaction.objectStore(STORE_NAME);
            if (!entries.indexNames.contains('entryId')) {
                entries.createIndex('entryId', 'entryId');
            }
            
            // Stats store
            if (!upgradeDb.objectStoreNames.contains(STATS_STORE)) {
                const statsStore = upgradeDb.createObjectStore(STATS_STORE, {
                    keyPath: 'contentId'
                });
                statsStore.createIndex('searches', 'searches');
                statsStore.createIndex('downloads', 'downloads');
            }
        },
    });
    
    await backfillEntries();
    markReady();
    console.log('✅ Database initialized (v5)');
}

async function backfillEntries() {
    const entries = await db.getAll(STORE_NAME);

    for (const entry of entries) {
        if (entry.entryId && (entry.thumb || !entry.preview)) continue;

        entry.entryId = entry.entryId || await getEntryId(entry);
        entry.hasPreview = Boolean(entry.preview);
        if (entry.preview && !entry.thumb) {
            entry.thumb = await resizeImage(entry.preview, 160, 0.7).catch(() => null);
        }
        await db.put(STORE_NAME, entry);
    }
}

export async function getEntryById(entryId) {
    await dbReady;
    return db.getFromIndex(STORE_NAME, 'entryId', entryId);
}

export async function getEntrySummaries() {
    const entries = await getAllEntries();
    return entries.map((entry) => ({
        id: entry.entryId,
        slug: extractSlug(entry.sourceURL)
    }));
}

export async function getEntryCount() {
    await dbReady;
    return db.count(STORE_NAME);
}

export async function savePreview(entryId, preview) {
    const entry = await getEntryById(entryId);
    if (!entry?.hasPreview) return false;

    entry.preview = preview;
    await db.put(STORE_NAME, entry);
    return true;
}

export async function reannounceAllEntries() {
    const { contentDHT } = await import('../network/contentDHT.js');
    const { extractSlug } = await import('../../shared/urlParser.js');
    
    const allEntries = await getAllEntries();
    
    allEntries.forEach(entry => {
        const slug = extractSlug(entry.sourceURL);
        contentDHT.announceContent(slug);
    });
    
    console.log(`📢 Re-announced ${allEntries.length} existing entries to DHT`);
}

export async function addEntry(entry) {
    try {
        const id = await db.add(STORE_NAME, entry);
        console.log('✅ Entry added to DB with ID:', id);
        await updateEntryCount();
        return id;
    } catch (error) {
        console.error('❌ Failed to add entry:', error);
        throw error;
    }
}

export async function searchEntries(query) {
    const allEntries = await db.getAll(STORE_NAME);
    return allEntries.filter(e => 
        e.sourceURL.toLowerCase().includes(query.toLowerCase()) || 
        e.title?.toLowerCase().includes(query.toLowerCase())
    );
}

export async function getEntryByURL(url) {
    await dbReady;
    const allEntries = await db.getAll(STORE_NAME);
    return allEntries.find(e => e.sourceURL === url);
}

export async function getAllEntries() {
    await dbReady;
    return await db.getAll(STORE_NAME);
}

async function updateEntryCount() {
    const count = await db.count(STORE_NAME);
    const countEl = document.getElementById('entry-count');
    if (countEl) countEl.textContent = count;
    console.log('📊 Total entries in DB:', count);
}

// Stats tracking
export async function trackSearch(contentId) {
    try {
        const stats = await db.get(STATS_STORE, contentId);
        
        if (stats) {
            stats.searches++;
            await db.put(STATS_STORE, stats);
        } else {
            await db.add(STATS_STORE, {
                contentId,
                searches: 1,
                downloads: 0
            });
        }
    } catch (error) {
        console.error('Failed to track search:', error);
    }
}

export async function trackDownload(contentId) {
    try {
        const stats = await db.get(STATS_STORE, contentId);
        
        if (stats) {
            stats.downloads++;
            await db.put(STATS_STORE, stats);
        } else {
            await db.add(STATS_STORE, {
                contentId,
                searches: 0,
                downloads: 1
            });
        }
    } catch (error) {
        console.error('Failed to track download:', error);
    }
}

export async function getStats(contentId) {
    try {
        const stats = await db.get(STATS_STORE, contentId);
        return stats || { searches: 0, downloads: 0 };
    } catch (error) {
        return { searches: 0, downloads: 0 };
    }
}
