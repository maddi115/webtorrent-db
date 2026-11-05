// snapshotManager.js - New users download a room in verified chunks from peers
import { getSnapshotChunk, getSnapshotInfo, importSnapshot, updateEntryCount } from '../storage/db.js';
import { refreshResults } from '../ui/search.js';
import { getTopic } from '../../shared/rooms.js';
import { logger } from '../../shared/logger.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const COLLECT_OFFERS_MS = 1500;
const OFFER_WAIT_MS = 4000;
const CHUNK_TIMEOUT_MS = 15000;
const REQUESTS_PER_PEER = 2;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_CHUNKS = 4096;

const devOptions = new URLSearchParams(import.meta.env.DEV ? location.search : '');
const MIN_GAP = Number(devOptions.get('snapshotMin')) || 500;
const CHUNK_BYTES = Number(devOptions.get('snapshotChunk')) || 256 * 1024;

export const snapshotStats = { restored: 0, chunks: 0, peers: new Set() };

const offers = new Map();
const waitingPeers = new Map();
let collectTimer = null;
let download = null;

function showMessage(message) {
    const toast = document.createElement('div');
    toast.className = 'toast show';
    toast.textContent = message;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 3000);
}

function getWeekCutoff() {
    return Math.floor(Date.now() / WEEK_MS) * WEEK_MS;
}

function isValidOffer(data) {
    return typeof data.hash === 'string'
        && data.room === getTopic()
        && Number.isSafeInteger(data.bytes)
        && data.bytes > 0
        && data.bytes <= MAX_SNAPSHOT_BYTES
        && Number.isSafeInteger(data.count)
        && Array.isArray(data.chunkHashes)
        && data.chunkHashes.length > 0
        && data.chunkHashes.length <= MAX_CHUNKS
        && data.chunkHashes.every((hash) => typeof hash === 'string');
}

// Returns true when the bigger peer sends an offer, or the smaller peer waits for one
export async function handleLinkGap(connection, myLinks, theirLinks, finishSync) {
    const gap = myLinks - theirLinks;

    if (gap >= MIN_GAP) {
        const info = await getSnapshotInfo(getWeekCutoff(), CHUNK_BYTES);
        if (info.count >= MIN_GAP) {
            connection.send({ type: 'snapshot_offer', room: getTopic(), ...info });
            return true;
        }
    }

    if (gap <= -MIN_GAP) {
        waitingPeers.set(connection.peer, setTimeout(() => {
            waitingPeers.delete(connection.peer);
            if (!download) finishSync(connection);
        }, OFFER_WAIT_MS));
        return true;
    }

    return false;
}

export function handleOffer(data, connection, finishSync) {
    if (!isValidOffer(data) || download) return;

    clearTimeout(waitingPeers.get(connection.peer));
    waitingPeers.delete(connection.peer);

    const offer = offers.get(data.hash) || { info: data, peers: new Map() };
    offer.peers.set(connection.peer, connection);
    offers.set(data.hash, offer);

    if (!collectTimer) {
        collectTimer = setTimeout(() => {
            collectTimer = null;
            startDownload(finishSync);
        }, COLLECT_OFFERS_MS);
    }
}

function startDownload(finishSync) {
    const best = [...offers.values()].sort((a, b) => (
        b.peers.size - a.peers.size || b.info.count - a.info.count
    ))[0];
    const allPeers = [...offers.values()].flatMap((offer) => [...offer.peers.values()]);
    offers.clear();
    if (!best) return;

    const { info } = best;
    showMessage(`Downloading ${info.count} links from ${best.peers.size} peer${best.peers.size === 1 ? '' : 's'}`);
    logger.info(`📦 Downloading snapshot from ${best.peers.size} peer(s)`);

    download = {
        info,
        finishSync,
        allPeers,
        peers: new Map([...best.peers].map(([peerId, connection]) => [peerId, { connection, active: 0 }])),
        chunks: new Array(info.chunkHashes.length).fill(null),
        queue: info.chunkHashes.map((_, index) => index),
        timers: new Map()
    };
    requestChunks();
}

function requestChunks() {
    if (!download) return;

    if (download.peers.size === 0) {
        finishDownload(null);
        return;
    }

    download.peers.forEach((peer, peerId) => {
        while (peer.active < REQUESTS_PER_PEER && download.queue.length) {
            const index = download.queue.shift();
            peer.active += 1;
            peer.connection.send({ type: 'snapshot_get', hash: download.info.hash, index });
            download.timers.set(index, {
                peerId,
                timer: setTimeout(() => dropPeer(peerId), CHUNK_TIMEOUT_MS)
            });
        }
    });
}

function dropPeer(peerId) {
    if (!download) return;

    download.peers.delete(peerId);
    download.timers.forEach(({ peerId: owner, timer }, index) => {
        if (owner === peerId) {
            clearTimeout(timer);
            download.timers.delete(index);
            download.queue.push(index);
        }
    });
    requestChunks();
}

export function handleChunkRequest(data, connection) {
    if (!Number.isSafeInteger(data.index)) return;

    getSnapshotChunk(getTopic(), data.hash, data.index).then((bytes) => {
        if (bytes) connection.sendChunk(bytes, { hash: data.hash, index: data.index });
    });
}

async function hashChunk(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash).slice(0, 8))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

export async function handleChunk(data, metadata, peerId) {
    if (!download || metadata?.hash !== download.info.hash) return;

    const { index } = metadata;
    const owner = download.timers.get(index);
    if (!owner || owner.peerId !== peerId) return;

    clearTimeout(owner.timer);
    download.timers.delete(index);

    const peer = download.peers.get(peerId);
    if (peer) peer.active -= 1;

    const bytes = new Uint8Array(data);
    if (await hashChunk(bytes) !== download.info.chunkHashes[index]) {
        download.queue.push(index);
        dropPeer(peerId);
        return;
    }

    download.chunks[index] = bytes;
    snapshotStats.chunks += 1;
    snapshotStats.peers.add(peerId);

    if (download.chunks.every(Boolean)) {
        finishDownload(download.chunks);
    } else {
        requestChunks();
    }
}

async function finishDownload(chunks) {
    const { info, finishSync, allPeers, timers } = download;
    timers.forEach(({ timer }) => clearTimeout(timer));
    download = null;

    if (chunks) {
        try {
            const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const bytes = new Uint8Array(total);
            let offset = 0;
            chunks.forEach((chunk) => {
                bytes.set(chunk, offset);
                offset += chunk.length;
            });

            snapshotStats.restored = await importSnapshot(info.room, bytes, info.hash);
            await updateEntryCount();
            refreshResults();
            showMessage(`Added ${snapshotStats.restored} links`);
        } catch (error) {
            logger.warn('⚠️ Snapshot was rejected, using normal sync', error);
        }
    }

    allPeers.forEach((connection) => {
        connection.send({ type: 'snapshot_done' });
        finishSync(connection);
    });
}
