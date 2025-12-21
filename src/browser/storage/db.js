// db.js - IndexedDB with migration for titles
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
                store.createIndex('sourceURL', 'sourceURL', { unique: true });
                store.createIndex('timestamp', 'timestamp');
            }
        },
    });
    
    // Migrate existing entries to fix titles
    await migrateExistingTitles();
}

async function migrateExistingTitles() {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const allEntries = await store.getAll();
    
    let migrated = 0;
    
    for (const entry of allEntries) {
        // If title is just numbers or empty, regenerate it
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

export async function addEntry(entry) {
    try {
        const id = await db.add(STORE_NAME, entry);
        updateEntryCount();
        return id;
    } catch (error) {
        if (error.name === 'ConstraintError') {
            console.warn('Entry already exists:', entry.sourceURL);
        } else {
            throw error;
        }
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
    return await db.getFromIndex(STORE_NAME, 'sourceURL', url);
}

export async function getAllEntries() {
    return await db.getAll(STORE_NAME);
}

async function updateEntryCount() {
    const count = await db.count(STORE_NAME);
    const countEl = document.getElementById('entry-count');
    if (countEl) countEl.textContent = count;
}
