// sqliteWorker.js - Runs SQLite away from the page so big searches stay smooth
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { getEntryId } from '../../shared/entryId.js';
import { cleanRemoteEntry } from '../../shared/entryRules.js';
import {
    compressSnapshot, decompressSnapshot, packSnapshot, unpackSnapshot
} from '../../shared/snapshot.js';

const LOCK_NAME = 'webtorrent-sqlite-owner';
const LOCK_WAIT_MS = 3000;
const SEARCH_LIMIT = 200;

const ENTRY_COLUMNS = `
    entry_id AS entryId, room, source_url AS sourceURL, magnet,
    instant_io_link AS instantIOLink, title, added_by AS addedBy, timestamp,
    thumb, thumb_hash AS thumbHash, has_preview AS hasPreview
`;

let db;
let storageMode = 'opfs';
const syncIndexes = new Map();
const snapshots = new Map();

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY,
        entry_id TEXT NOT NULL UNIQUE,
        room TEXT NOT NULL,
        source_url TEXT NOT NULL,
        magnet TEXT,
        instant_io_link TEXT,
        title TEXT,
        added_by TEXT,
        timestamp INTEGER NOT NULL,
        thumb TEXT,
        has_preview INTEGER NOT NULL DEFAULT 0,
        preview TEXT
    );
    CREATE INDEX IF NOT EXISTS entries_room_time ON entries(room, timestamp DESC);
    CREATE INDEX IF NOT EXISTS entries_url ON entries(source_url);

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_search USING fts5(
        title, source_url, content='entries', content_rowid='id', tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS entries_after_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_search(rowid, title, source_url)
        VALUES (new.id, new.title, new.source_url);
    END;
    CREATE TRIGGER IF NOT EXISTS entries_after_delete AFTER DELETE ON entries BEGIN
        INSERT INTO entries_search(entries_search, rowid, title, source_url)
        VALUES ('delete', old.id, old.title, old.source_url);
    END;
    CREATE TRIGGER IF NOT EXISTS entries_after_update AFTER UPDATE OF title, source_url ON entries BEGIN
        INSERT INTO entries_search(entries_search, rowid, title, source_url)
        VALUES ('delete', old.id, old.title, old.source_url);
        INSERT INTO entries_search(rowid, title, source_url)
        VALUES (new.id, new.title, new.source_url);
    END;

    CREATE TABLE IF NOT EXISTS stats (
        content_id TEXT PRIMARY KEY,
        searches INTEGER NOT NULL DEFAULT 0,
        downloads INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS avatars (
        username TEXT PRIMARY KEY,
        avatar TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`;

function acquireOwnerLock() {
    return new Promise((resolve, reject) => {
        const signal = AbortSignal.timeout(LOCK_WAIT_MS);
        navigator.locks.request(LOCK_NAME, { signal }, () => {
            resolve();
            return new Promise(() => {});
        }).catch(reject);
    });
}

async function openDatabase() {
    const sqlite3 = await sqlite3InitModule();

    try {
        await acquireOwnerLock();
        const pool = await sqlite3.installOpfsSAHPoolVfs({
            name: 'webtorrent-db',
            directory: '/webtorrent-db-sqlite'
        });
        db = new pool.OpfsSAHPoolDb('/links.sqlite3');
    } catch {
        // Another tab owns the file, so this tab works from memory
        storageMode = 'memory';
        db = new sqlite3.oo1.DB(':memory:');
    }

    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    const columns = db.selectObjects('PRAGMA table_info(entries)');
    if (!columns.some((column) => column.name === 'thumb_hash')) {
        db.exec('ALTER TABLE entries ADD COLUMN thumb_hash TEXT');
    }
    return { storageMode };
}

function selectAll(sql, bind = []) {
    return db.selectObjects(sql, bind).map((row) => {
        if ('hasPreview' in row) row.hasPreview = row.hasPreview === 1;
        return row;
    });
}

function selectOne(sql, bind = []) {
    return selectAll(sql, bind)[0] || null;
}

// Sorted IDs plus running totals make any fingerprint very quick to read
function getSyncIndex(room) {
    if (syncIndexes.has(room)) return syncIndexes.get(room);

    const ids = db.selectValues('SELECT entry_id FROM entries WHERE room = ? ORDER BY entry_id', [room]);
    const totals = new Uint32Array((ids.length + 1) * 4);

    ids.forEach((id, index) => {
        for (let part = 0; part < 4; part++) {
            const value = parseInt(id.slice(part * 8, part * 8 + 8), 16) || 0;
            totals[(index + 1) * 4 + part] = totals[index * 4 + part] ^ value;
        }
    });

    const index = { ids, totals };
    syncIndexes.set(room, index);
    return index;
}

function firstIndexAtOrAfter(ids, value) {
    let low = 0;
    let high = ids.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (ids[middle] < value) low = middle + 1;
        else high = middle;
    }
    return low;
}

function getPrefixRange(ids, prefix) {
    return [firstIndexAtOrAfter(ids, prefix), firstIndexAtOrAfter(ids, `${prefix}g`)];
}

async function hashBytes(bytes, size) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash).slice(0, size))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function insertEntry(entry) {
    syncIndexes.delete(entry.room || 'general');
    snapshots.delete(entry.room || 'general');
    db.exec({
        sql: `INSERT OR IGNORE INTO entries (
            entry_id, room, source_url, magnet, instant_io_link, title,
            added_by, timestamp, thumb, thumb_hash, has_preview, preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
            entry.entryId,
            entry.room || 'general',
            entry.sourceURL,
            entry.magnet || null,
            entry.instantIOLink || null,
            entry.title || null,
            entry.addedBy || null,
            entry.timestamp,
            entry.thumb || null,
            entry.thumbHash || null,
            entry.hasPreview ? 1 : 0,
            entry.preview || null
        ]
    });
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, '\\$&');
}

const methods = {
    open: openDatabase,

    addEntry(entry) {
        insertEntry(entry);
    },

    importEntries(entries) {
        db.transaction(() => entries.forEach(insertEntry));
    },

    importStats(stats) {
        db.transaction(() => stats.forEach((item) => {
            db.exec({
                sql: `INSERT OR IGNORE INTO stats (content_id, searches, downloads)
                      VALUES (?, ?, ?)`,
                bind: [item.contentId, item.searches || 0, item.downloads || 0]
            });
        }));
    },

    getEntryById(entryId) {
        return selectOne(
            `SELECT ${ENTRY_COLUMNS}, preview FROM entries WHERE entry_id = ?`,
            [entryId]
        );
    },

    getEntryByURL(sourceURL) {
        return selectOne(
            `SELECT ${ENTRY_COLUMNS}, preview FROM entries WHERE source_url = ? LIMIT 1`,
            [sourceURL]
        );
    },

    getAllEntries() {
        return selectAll(`SELECT ${ENTRY_COLUMNS} FROM entries`);
    },

    getRoomEntries(room) {
        return selectAll(
            `SELECT ${ENTRY_COLUMNS} FROM entries WHERE room = ? ORDER BY timestamp DESC`,
            [room]
        );
    },

    getRoomLinks(room) {
        return selectAll(
            'SELECT entry_id AS id, source_url AS sourceURL FROM entries WHERE room = ?',
            [room]
        );
    },

    getEntryCount(room) {
        return db.selectValue('SELECT COUNT(*) FROM entries WHERE room = ?', [room]);
    },

    searchEntries(room, query) {
        if (query.length >= 3) {
            return selectAll(
                `SELECT ${ENTRY_COLUMNS}
                 FROM entries
                 WHERE room = ? AND id IN (
                     SELECT rowid FROM entries_search WHERE entries_search MATCH ?
                 )
                 ORDER BY timestamp DESC
                 LIMIT ${SEARCH_LIMIT}`,
                [room, `"${query.replaceAll('"', '""')}"`]
            );
        }

        const pattern = `%${escapeLike(query)}%`;
        return selectAll(
            `SELECT ${ENTRY_COLUMNS} FROM entries
             WHERE room = ? AND (source_url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
             ORDER BY timestamp DESC
             LIMIT ${SEARCH_LIMIT}`,
            [room, pattern, pattern]
        );
    },

    getSyncFingerprints(room, prefixes) {
        const { ids, totals } = getSyncIndex(room);

        return prefixes.map((prefix) => {
            const [start, end] = getPrefixRange(ids, prefix);
            let fingerprint = '';
            for (let part = 0; part < 4; part++) {
                const value = (totals[start * 4 + part] ^ totals[end * 4 + part]) >>> 0;
                fingerprint += value.toString(16).padStart(8, '0');
            }
            return { p: prefix, c: end - start, f: fingerprint };
        });
    },

    getSyncIds(room, prefix) {
        const { ids } = getSyncIndex(room);
        const [start, end] = getPrefixRange(ids, prefix);
        return ids.slice(start, end);
    },

    getExistingIds(ids) {
        return ids.filter((id) => db.selectValue(
            'SELECT 1 FROM entries WHERE entry_id = ?',
            [id]
        ) === 1);
    },

    async getSnapshotInfo(room, cutoff, chunkBytes) {
        const cached = snapshots.get(room);
        if (cached?.cutoff === cutoff) return cached.info;

        const entries = selectAll(
            `SELECT ${ENTRY_COLUMNS} FROM entries WHERE room = ? AND timestamp < ?`,
            [room, cutoff]
        );
        const bytes = await compressSnapshot(packSnapshot(room, entries));
        const chunkHashes = [];

        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            chunkHashes.push(await hashBytes(bytes.subarray(offset, offset + chunkBytes), 8));
        }

        const info = {
            hash: await hashBytes(bytes, 16),
            bytes: bytes.length,
            count: entries.length,
            chunkHashes
        };
        snapshots.set(room, { cutoff, chunkBytes, bytes, info });
        return info;
    },

    getSnapshotChunk(room, hash, index) {
        const snapshot = snapshots.get(room);
        if (snapshot?.info.hash !== hash) return null;

        const start = index * snapshot.chunkBytes;
        return snapshot.bytes.slice(start, start + snapshot.chunkBytes);
    },

    async importSnapshot(room, bytes, expectedHash) {
        if (await hashBytes(bytes, 16) !== expectedHash) throw new Error('Snapshot hash mismatch');

        const snapshot = unpackSnapshot(await decompressSnapshot(bytes));
        if (snapshot.room !== room) throw new Error('Snapshot is for another room');

        const entries = [];
        for (const rawEntry of snapshot.entries) {
            const entry = cleanRemoteEntry(rawEntry, room);
            if (entry) {
                entry.entryId = await getEntryId(entry);
                entries.push(entry);
            }
        }

        db.transaction(() => entries.forEach(insertEntry));
        return entries.length;
    },

    saveAvatar(username, avatar) {
        db.exec({
            sql: 'INSERT OR REPLACE INTO avatars (username, avatar) VALUES (?, ?)',
            bind: [username, avatar]
        });
    },

    getAvatars(usernames) {
        return Object.fromEntries(usernames.flatMap((username) => {
            const avatar = db.selectValue(
                'SELECT avatar FROM avatars WHERE username = ?',
                [username]
            );
            return avatar ? [[username, avatar]] : [];
        }));
    },

    getThumbsWithoutHash() {
        return selectAll(
            'SELECT entry_id AS entryId, thumb FROM entries WHERE thumb IS NOT NULL AND thumb_hash IS NULL'
        );
    },

    saveThumbHash(entryId, thumbHash) {
        db.exec({
            sql: 'UPDATE entries SET thumb_hash = ? WHERE entry_id = ?',
            bind: [thumbHash, entryId]
        });
    },

    saveThumb(entryId, thumb) {
        db.exec({
            sql: `UPDATE entries SET thumb = ?
                  WHERE entry_id = ? AND thumb IS NULL AND thumb_hash IS NOT NULL`,
            bind: [thumb, entryId]
        });
        return db.changes() > 0;
    },

    savePreview(entryId, preview) {
        db.exec({
            sql: 'UPDATE entries SET preview = ? WHERE entry_id = ? AND has_preview = 1',
            bind: [preview, entryId]
        });
        return db.changes() > 0;
    },

    trackStat(contentId, column) {
        if (column !== 'searches' && column !== 'downloads') return;
        db.exec({
            sql: `INSERT INTO stats (content_id, ${column}) VALUES (?, 1)
                  ON CONFLICT(content_id) DO UPDATE SET ${column} = ${column} + 1`,
            bind: [contentId]
        });
    },

    getStats(contentId) {
        return selectOne(
            'SELECT searches, downloads FROM stats WHERE content_id = ?',
            [contentId]
        ) || { searches: 0, downloads: 0 };
    },

    getMeta(key) {
        return selectOne('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null;
    },

    setMeta(key, value) {
        db.exec({
            sql: 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
            bind: [key, value]
        });
    }
};

self.onmessage = async ({ data: { id, method, args } }) => {
    try {
        const result = await methods[method](...args);
        self.postMessage({ id, result });
    } catch (error) {
        self.postMessage({ id, error: error.message });
    }
};
