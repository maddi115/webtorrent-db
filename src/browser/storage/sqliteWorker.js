// sqliteWorker.js - Runs SQLite away from the page so big searches stay smooth
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { getEntryId } from '../../shared/entryId.js';
import { cleanRemoteEntry } from '../../shared/entryRules.js';
import { verifyDelete, verifyEntry, verifyWipe } from '../../shared/signing.js';
import {
    compressSnapshot, decompressSnapshot, packSnapshot, unpackSnapshot
} from '../../shared/snapshot.js';

const LOCK_NAME = 'webtorrent-sqlite-owner';
const LOCK_WAIT_MS = 3000;
const SEARCH_LIMIT = 200;
const POSTS_PER_MINUTE = 10;
const MINUTE_MS = 60 * 1000;
const FUTURE_LIMIT_MS = 2 * 60 * 1000;
const BLOCK_MS = 10 * 60 * 1000;

const ENTRY_COLUMNS = `
    entry_id AS entryId, room, source_url AS sourceURL, magnet,
    instant_io_link AS instantIOLink, title, added_by AS addedBy, timestamp,
    thumb, thumb_hash AS thumbHash, has_preview AS hasPreview,
    author_key AS authorKey, signature
`;

let db;
let storageMode = 'opfs';
const syncIndexes = new Map();
const snapshots = new Map();
const blockedKeys = new Map();
let adminKeys = new Set();
let wipeBefore = null;

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
    CREATE TABLE IF NOT EXISTS deletions (
        entry_id TEXT PRIMARY KEY,
        author_key TEXT NOT NULL,
        signature TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS authors (
        name TEXT PRIMARY KEY,
        author_key TEXT NOT NULL
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
    const addColumn = (name) => {
        if (!columns.some((column) => column.name === name)) {
            db.exec(`ALTER TABLE entries ADD COLUMN ${name} TEXT`);
        }
    };
    addColumn('thumb_hash');
    addColumn('author_key');
    addColumn('signature');
    db.exec('CREATE INDEX IF NOT EXISTS entries_author_time ON entries(author_key, timestamp)');
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

    const ids = db.selectValues(
        'SELECT entry_id FROM entries WHERE room = ? AND signature IS NOT NULL ORDER BY entry_id',
        [room]
    );
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

// Returns true when the link was new
function insertEntry(entry) {
    syncIndexes.delete(entry.room || 'general');
    snapshots.delete(entry.room || 'general');
    db.exec({
        sql: `INSERT OR IGNORE INTO entries (
            entry_id, room, source_url, magnet, instant_io_link, title,
            added_by, timestamp, thumb, thumb_hash, has_preview, preview,
            author_key, signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            entry.preview || null,
            entry.signature ? entry.authorKey : null,
            entry.signature || null
        ]
    });
    const added = db.changes() > 0;
    if (!added || !entry.signature) return added;

    if (entry.addedBy) {
        db.exec({
            sql: 'INSERT OR IGNORE INTO authors (name, author_key) VALUES (?, ?)',
            bind: [entry.addedBy, entry.authorKey]
        });
    }
    // A signed copy replaces an old unsigned copy of the same link
    db.exec({
        sql: `DELETE FROM entries WHERE signature IS NULL AND room = ? AND source_url = ?
              AND IFNULL(added_by, '') = ?`,
        bind: [entry.room || 'general', entry.sourceURL, entry.addedBy || '']
    });
    return true;
}

function nameOwner(name) {
    if (!name) return null;
    return db.selectValue('SELECT author_key FROM authors WHERE name = ?', [name]) ?? null;
}

function postsNear(authorKey, timestamp) {
    return db.selectValue(
        `SELECT COUNT(*) FROM entries
         WHERE author_key = ? AND timestamp > ? AND timestamp < ? AND signature IS NOT NULL`,
        [authorKey, timestamp - MINUTE_MS, timestamp + MINUTE_MS]
    );
}

function isBlocked(authorKey, now) {
    const blockedAt = blockedKeys.get(authorKey);
    if (!blockedAt) return false;
    if (now - blockedAt < BLOCK_MS) return true;
    blockedKeys.delete(authorKey);
    return false;
}

// The post's author, or an admin, may delete it
function mayDelete(noteKey, postKey) {
    return noteKey === postKey || adminKeys.has(noteKey);
}

// A delete note, if this link's author or an admin deleted it
function deletionFor(entryId, authorKey) {
    const note = selectOne(
        'SELECT entry_id AS entryId, author_key AS authorKey, signature FROM deletions WHERE entry_id = ?',
        [entryId]
    );
    return note && mayDelete(note.authorKey, authorKey) ? note : null;
}

// The newest "clear all posts" note from an admin, kept so cleared posts cannot come back
function getWipe() {
    if (wipeBefore !== null) return wipeBefore;
    try {
        const saved = JSON.parse(selectOne("SELECT value FROM meta WHERE key = 'wipe'")?.value || 'null');
        wipeBefore = saved && adminKeys.has(saved.authorKey) ? saved : false;
    } catch {
        wipeBefore = false;
    }
    return wipeBefore;
}

// Only an admin can clear everything. Every post made before the note's time is removed, in every room.
async function applyWipe(note) {
    if (!adminKeys.has(note?.authorKey) || note.before > Date.now() + FUTURE_LIMIT_MS) return false;
    const current = getWipe();
    if (current && current.before >= note.before) return false;
    if (!await verifyWipe(note)) return false;

    const saved = { before: note.before, authorKey: note.authorKey, signature: note.signature };
    db.transaction(() => {
        db.exec({ sql: 'DELETE FROM entries WHERE timestamp < ?', bind: [note.before] });
        db.exec({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('wipe', ?)", bind: [JSON.stringify(saved)] });
    });
    wipeBefore = saved;
    syncIndexes.clear();
    snapshots.clear();
    return true;
}

// Only the key that signed a post, or an admin, can delete it. The note is kept, so the post cannot come back.
// Notes are only kept for posts this browser has, so nobody can flood peers with junk notes.
async function applyDeletes(notes) {
    const applied = [];
    for (const note of notes) {
        const entry = selectOne('SELECT room, author_key AS authorKey FROM entries WHERE entry_id = ?', [note?.entryId]);
        if (!entry || !mayDelete(note.authorKey, entry.authorKey)) continue;
        if (!await verifyDelete(note)) continue;

        db.transaction(() => {
            db.exec({
                sql: `INSERT OR IGNORE INTO deletions (entry_id, author_key, signature, deleted_at)
                      VALUES (?, ?, ?, ?)`,
                bind: [note.entryId, note.authorKey, note.signature, Date.now()]
            });
            db.exec({ sql: 'DELETE FROM entries WHERE entry_id = ?', bind: [note.entryId] });
        });
        syncIndexes.delete(entry.room);
        snapshots.delete(entry.room);
        applied.push({ entryId: note.entryId, authorKey: note.authorKey, signature: note.signature });
    }
    return applied;
}

// The same rules for every link from peers: signed, not changed, not too many
async function receiveEntries(room, rawEntries) {
    const now = Date.now();
    const result = { saved: [], rejected: {}, deleted: [] };
    const reject = (reason) => { result.rejected[reason] = (result.rejected[reason] || 0) + 1; };
    const checked = [];

    for (const rawEntry of rawEntries) {
        const entry = cleanRemoteEntry(rawEntry, room);
        if (!entry) { reject('invalid'); continue; }
        if (!entry.signature) { reject('unsigned'); continue; }
        if (entry.timestamp > now + FUTURE_LIMIT_MS) { reject('future'); continue; }
        if (isBlocked(entry.authorKey, now)) { reject('blocked'); continue; }
        const wipe = getWipe();
        if (wipe && entry.timestamp < wipe.before) { reject('cleared'); continue; }

        entry.entryId = await getEntryId(entry);
        const note = deletionFor(entry.entryId, entry.authorKey);
        if (note) {
            reject('deleted');
            result.deleted.push(note);
            continue;
        }
        if (db.selectValue('SELECT 1 FROM entries WHERE entry_id = ?', [entry.entryId]) === 1) {
            reject('known');
            continue;
        }
        if (!await verifyEntry(entry)) { reject('bad-signature'); continue; }
        checked.push(entry);
    }

    checked.sort((a, b) => a.timestamp - b.timestamp);
    db.transaction(() => checked.forEach((entry) => {
        const owner = nameOwner(entry.addedBy);
        if (owner && owner !== entry.authorKey) return reject('name-taken');
        if (isBlocked(entry.authorKey, now)) return reject('blocked');
        if (postsNear(entry.authorKey, entry.timestamp) >= POSTS_PER_MINUTE) {
            blockedKeys.set(entry.authorKey, now);
            return reject('too-fast');
        }
        if (insertEntry(entry)) result.saved.push(entry.entryId);
        else reject('known');
    }));
    return result;
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, '\\$&');
}

const methods = {
    open: openDatabase,

    addEntry(entry) {
        insertEntry(entry);
    },

    // Your own posts follow the same limits peers check
    saveOwnEntry(entry) {
        const owner = nameOwner(entry.addedBy);
        if (owner && owner !== entry.authorKey) return 'name-taken';
        if (postsNear(entry.authorKey, entry.timestamp) >= POSTS_PER_MINUTE) return 'too-fast';
        insertEntry(entry);
        return 'saved';
    },

    receiveEntries,

    claimName(name, key) {
        if (!name || !key) return false;
        db.exec({ sql: 'INSERT OR IGNORE INTO authors (name, author_key) VALUES (?, ?)', bind: [name, key] });
        return nameOwner(name) === key;
    },

    applyDeletes,

    applyWipe,

    setAdminKeys(keys) {
        adminKeys = new Set(Array.isArray(keys) ? keys : []);
        wipeBefore = null;
    },

    getWipe() {
        return getWipe() || null;
    },

    getEntriesByAuthor(authorKey) {
        return selectAll(
            `SELECT ${ENTRY_COLUMNS} FROM entries
             WHERE author_key = ? AND signature IS NOT NULL
             ORDER BY timestamp DESC LIMIT 1000`,
            [authorKey]
        );
    },

    getUnsignedEntries() {
        return selectAll(`SELECT ${ENTRY_COLUMNS}, preview FROM entries WHERE signature IS NULL`);
    },

    replaceEntry(oldId, entry) {
        db.transaction(() => {
            db.exec({ sql: 'DELETE FROM entries WHERE entry_id = ?', bind: [oldId] });
            insertEntry(entry);
        });
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
        return db.selectValue(
            'SELECT COUNT(*) FROM entries WHERE room = ? AND signature IS NOT NULL',
            [room]
        );
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
            `SELECT ${ENTRY_COLUMNS} FROM entries
             WHERE room = ? AND timestamp < ? AND signature IS NOT NULL`,
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

        const { saved } = await receiveEntries(room, snapshot.entries);
        return saved.length;
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
