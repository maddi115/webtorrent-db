// db.js - IndexedDB interface for metadata storage
import { openDB } from 'idb';

const DB_NAME = 'webtorrent-metadata-db';
const STORE_NAME = 'entries';

let db;

export async function initDB() {
    db = await openDB(DB_NAME, 1, {
        upgrade(upgradeDb) {
            const store = upgradeDb.createObjectStore(STORE_NAME, { 
                keyPath: 'id', 
                autoIncrement: true 
            });
            store.createIndex('sourceURL', 'sourceURL', { unique: true });
            store.createIndex('timestamp', 'timestamp');
        },
    });
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
