// db.js - Better duplicate handling
import { openDB } from 'idb';
import { extractTitle } from '../../shared/urlParser.js';

const DB_NAME = 'webtorrent-metadata-db';
const STORE_NAME = 'entries';

let db;

export async function initDB() {
    db = await openDB(DB_NAME, 2, {
        upgrade(upgradeDb, oldVersion) {
            if (!upgradeDb.objectStoreNames.contains(STORE_NAME)) {
                const store = upgradeDb.createObjectStore(STORE_NAME, { 
                    keyPath: 'id', 
                    autoIncrement: true 
                });
                store.createIndex('sourceURL', 'sourceURL', { unique: false }); // NOT unique!
                store.createIndex('timestamp', 'timestamp');
            }
        },
    });
    
    await migrateExistingTitles();
}

async function migrateExistingTitles() {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const allEntries = await store.getAll();
    
    let migrated = 0;
    
    for (const entry of allEntries) {
        if (!entry.title || /^\d+$/.test(entry.title)) {
            const newTitle = extractTitle(entry.sourceURL);
            entry.title = newTitle;
            await store.put(entry);
            migrated++;
        }
    }
    
    await tx.done;
    
    if (migrated > 0) {
        console.log(`✅ Migrated ${migrated} entries with proper titles`);
    }
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
    const allEntries = await db.getAll(STORE_NAME);
    return allEntries.find(e => e.sourceURL === url);
}

export async function getAllEntries() {
    return await db.getAll(STORE_NAME);
}

async function updateEntryCount() {
    const count = await db.count(STORE_NAME);
    const countEl = document.getElementById('entry-count');
    if (countEl) countEl.textContent = count;
    console.log('📊 Total entries in DB:', count);
}
