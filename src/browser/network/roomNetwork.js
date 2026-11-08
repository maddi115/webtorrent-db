// roomNetwork.js - A partial network of small cells inside each room.
// Each browser joins one home cell. In each cell, the first person links to the
// next cell in a ring, so every cell is connected, and the second adds a random
// shortcut. Links hop between cells, so each browser keeps few connections.
import { getRelaySockets, joinRoom, selfId } from 'trystero';
import { peerManager } from './peerManager.js';
import { getTopic, setTopic } from '../../shared/rooms.js';
import { recordShared } from '../../shared/shareStats.js';
import {
    getRelayUrls, getRtcConfig, getTurnConfig, loadTurnConfig, networkSettings, saveRelayHealth
} from '../../shared/networkConfig.js';
import { logger } from '../../shared/logger.js';

const APP_ID = 'maddi115-webtorrent-p2p-db';
const FULL_CELL_MS = 2 * 60 * 1000;
const SAVED_HOME_MS = 60 * 60 * 1000;
const MAX_CELLS = 100000;
const MAX_SHARED_FULL = 256;

const {
    roomPrefix, cellSize, visitorSlots, aloneMs, linkRetryMs, linkCheckMs, helperCells, isHelper
} = networkSettings;

const joinedAt = Date.now();
const rooms = new Map();
const links = new Set();
const linkKinds = new Map();
const fullCells = new Map();
const emptyCells = new Map();
let home = null;
let knownCells = 1;
let nextLinkAt = 0;
let rebalanceTimer = null;
let moving = false;

export const rejoinStats = { attempts: 0, moves: 0 };

function cellRoom(cell, topic = getTopic()) {
    return `${roomPrefix}${topic}-${cell}`;
}

function storageKey() {
    return `webtorrent-cells-${roomPrefix}${getTopic()}`;
}

function loadCells() {
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey())) || {};
        knownCells = Math.min(Math.max(1, saved.cells || 1), MAX_CELLS);
        const fresh = Date.now() - (saved.at || 0) < SAVED_HOME_MS;
        return fresh && Number.isInteger(saved.home) && saved.home < knownCells ? saved.home : 0;
    } catch {
        knownCells = 1;
        return 0;
    }
}

function saveCells() {
    try {
        localStorage.setItem(storageKey(), JSON.stringify({ cells: knownCells, home, at: Date.now() }));
    } catch {
        // Cell info is only a speed-up for the next visit
    }
}

export function getNetworkInfo() {
    const now = Date.now();
    const full = [...fullCells].filter(([, time]) => now - time < FULL_CELL_MS)
        .map(([cell]) => cell)
        .slice(0, MAX_SHARED_FULL);
    return {
        joinedAt,
        home: home === null ? null : cellRoom(home),
        role: isHelper ? 'helper' : null,
        ring: [...linkKinds].find(([, kind]) => kind === 'ring')?.[0] ?? null,
        cells: knownCells,
        full
    };
}

// Connections remember which open room they use, and move if that room closes
function createConnection(peerId, roomId) {
    const connection = {
        peer: peerId,
        room: roomId,
        open: true,
        joinedAt,
        info: getNetworkInfo,
        send: (message) => {
            if (message.type === 'entry') recordShared(1, JSON.stringify(message).length);
            if (message.type === 'thumb' || message.type === 'preview') {
                recordShared(0, JSON.stringify(message).length);
            }
            return rooms.get(connection.room)?.messages.send(message, { target: peerId });
        },
        sendChunk: (bytes, metadata) => {
            recordShared(0, bytes.length);
            return rooms.get(connection.room)?.chunks.send(bytes, { target: peerId, metadata });
        }
    };
    return connection;
}

function getConnection(peerId, roomId) {
    if (!peerManager.hasPeer(peerId)) {
        peerManager.addPeer(createConnection(peerId, roomId));
    }
    return peerManager.getPeer(peerId);
}

function moveOrDropPeer(peerId, closingRoom) {
    const connection = peerManager.getPeer(peerId);
    if (!connection || connection.room !== closingRoom) return;

    const other = [...rooms].find(([roomId, entry]) => roomId !== closingRoom && entry.present.has(peerId));
    if (other) {
        connection.room = other[0];
    } else {
        logger.warn(`❌ Peer left: ${peerId}`);
        peerManager.removePeer(peerId);
    }
}

function openRoom(roomId) {
    if (rooms.has(roomId)) return;

    const config = { appId: APP_ID, relayConfig: { urls: getRelayUrls() } };
    const turnConfig = getTurnConfig();
    if (turnConfig) config.turnConfig = turnConfig;
    const rtcConfig = getRtcConfig();
    if (rtcConfig) config.rtcConfig = rtcConfig;

    const room = joinRoom(config, roomId);
    const messages = room.makeAction('message');
    const chunks = room.makeAction('chunk');
    const entry = { room, messages, chunks, present: new Set(), openedAt: Date.now() };
    rooms.set(roomId, entry);

    room.onPeerJoin = (peerId) => {
        entry.present.add(peerId);
        logger.info(`✅ Connected to peer: ${peerId}`);
        getConnection(peerId, roomId);
        scheduleRebalance();
    };

    room.onPeerLeave = (peerId) => {
        entry.present.delete(peerId);
        moveOrDropPeer(peerId, roomId);
        scheduleRebalance();
    };

    messages.onMessage = (data, { peerId }) => {
        entry.present.add(peerId);
        peerManager.handlePeerData(data, getConnection(peerId, roomId));
    };

    chunks.onMessage = (data, { peerId, metadata }) => {
        peerManager.handleChunk(data, metadata, peerId);
    };

    logger.info(`🔗 Looking for peers in room: ${roomId}`);
}

function closeRoom(roomId) {
    const entry = rooms.get(roomId);
    if (!entry) return;

    rooms.delete(roomId);
    entry.present.forEach((peerId) => moveOrDropPeer(peerId, roomId));
    entry.room.leave();
}

function closeAllRooms() {
    [...rooms.keys()].forEach(closeRoom);
    links.clear();
    linkKinds.clear();
}

function rememberCells(count) {
    if (!Number.isSafeInteger(count) || count <= knownCells) return false;
    knownCells = Math.min(count, MAX_CELLS);
    saveCells();
    return true;
}

// Called when peers share what they know about cells
function learnNetwork(data) {
    const now = Date.now();
    let changed = rememberCells(data.cells);

    if (Array.isArray(data.full)) {
        data.full.slice(0, MAX_SHARED_FULL).forEach((cell) => {
            if (Number.isSafeInteger(cell) && cell >= 0 && cell < MAX_CELLS && !fullCells.has(cell)) {
                fullCells.set(cell, now);
                changed = true;
            }
        });
    }

    if (changed) {
        peerManager.broadcast({ type: 'cells', ...getNetworkInfo() });
        scheduleRebalance();
    }
}

function profileOf(peerId) {
    return peerManager.profiles.get(peerId);
}

function byJoinOrder(a, b) {
    return a.joinedAt - b.joinedAt || a.peerId.localeCompare(b.peerId);
}

function membersOf(cell) {
    const roomId = cellRoom(cell);
    const present = rooms.get(roomId)?.present || new Set();
    const members = [...present]
        .map((peerId) => ({ peerId, ...profileOf(peerId) }))
        .filter((peer) => peer.home === roomId && peer.role !== 'helper' && Number.isFinite(peer.joinedAt));
    if (home === cell) members.push({ peerId: selfId, joinedAt });
    return members.sort(byJoinOrder);
}

function visitorsOf(cell) {
    const roomId = cellRoom(cell);
    const present = rooms.get(roomId)?.present || new Set();
    const visitors = [...present]
        .map((peerId) => ({ peerId, ...profileOf(peerId) }))
        .filter((peer) => typeof peer.home === 'string' && peer.home !== roomId
            && peer.role !== 'helper' && Number.isFinite(peer.joinedAt))
        .map((peer) => ({ ...peer, isRing: peer.ring === cell }));
    if (links.has(cell)) visitors.push({ peerId: selfId, joinedAt, isRing: linkKinds.get(cell) === 'ring' });

    // Ring links keep every cell connected, so they keep their slot first
    return visitors.sort((a, b) => Number(b.isRing) - Number(a.isRing) || byJoinOrder(a, b));
}

// Picks a random cell that is not known to be full, or starts a new one
function pickCell() {
    const now = Date.now();
    const choices = [];
    for (let cell = 0; cell <= knownCells && choices.length < 4096; cell++) {
        const fullAt = fullCells.get(cell);
        if (cell !== home && !(fullAt && now - fullAt < FULL_CELL_MS)) choices.push(cell);
    }
    return choices.length ? choices[Math.floor(Math.random() * choices.length)] : knownCells;
}

// Tells current peers about the new cell first, so they can link to it
function moveHome(cell) {
    if (moving) return;
    moving = true;
    rememberCells(cell + 1);
    peerManager.broadcast({ type: 'cells', ...getNetworkInfo() });

    setTimeout(() => {
        closeAllRooms();
        home = cell;
        saveCells();
        rejoinStats.moves += 1;
        nextLinkAt = Date.now() + 2000 + Math.random() * 2000;
        moving = false;
        openRoom(cellRoom(home));
        peerManager.statusChanged();
    }, 300);
}

function isRecentlyEmpty(cell) {
    const time = emptyCells.get(cell);
    return time && Date.now() - time < linkRetryMs;
}

// The next cell around the ring that is not known to be empty
function nextRingCell() {
    for (let step = 1; step < knownCells; step++) {
        const cell = (home + step) % knownCells;
        if (!isRecentlyEmpty(cell)) return cell;
    }
    return null;
}

function openLink(cell, kind = 'chord') {
    links.add(cell);
    linkKinds.set(cell, kind);
    openRoom(cellRoom(cell));
    setTimeout(() => checkLink(cell), linkCheckMs);
}

function closeLink(cell, retry = true) {
    links.delete(cell);
    linkKinds.delete(cell);
    closeRoom(cellRoom(cell));
    if (retry) nextLinkAt = Date.now() + linkRetryMs;
}

// A link is kept only if the other cell has people and a free visitor slot
function checkLink(cell) {
    if (!links.has(cell) || isHelper) return;
    if (membersOf(cell).length > 0) return;

    emptyCells.set(cell, Date.now());
    const isRing = linkKinds.get(cell) === 'ring';
    closeLink(cell, !isRing);
    if (isRing) scheduleRebalance();
}

function rebalanceHelper() {
    const wanted = Math.min(knownCells, helperCells);
    for (let cell = 0; cell < wanted; cell++) {
        if (!links.has(cell)) openLink(cell);
    }
}

function rebalance() {
    rebalanceTimer = null;
    if (moving) return;
    if (isHelper) {
        rebalanceHelper();
        return;
    }

    const members = membersOf(home);
    const rank = members.findIndex((member) => member.peerId === selfId);

    if (members.length >= cellSize) fullCells.set(home, Date.now());
    else fullCells.delete(home);

    if (rank >= cellSize) {
        const next = pickCell();
        logger.info(`➡️ Cell is full, moving to cell ${next + 1}`);
        moveHome(next);
        return;
    }

    for (const cell of links) {
        const visitors = visitorsOf(cell);
        if (visitors.findIndex((visitor) => visitor.peerId === selfId) >= visitorSlots) closeLink(cell);
    }

    const shouldLink = rank >= 0 && rank < visitorSlots && knownCells > 1;
    const kind = rank === 0 ? 'ring' : 'chord';
    if (!shouldLink) {
        [...links].forEach((cell) => closeLink(cell, false));
        return;
    }

    // A ring link moves when a closer cell around the ring fills up
    const ringTarget = kind === 'ring' ? nextRingCell() : null;
    for (const cell of links) {
        if (linkKinds.get(cell) !== kind || (kind === 'ring' && cell !== ringTarget)) {
            closeLink(cell, false);
        }
    }

    if (links.size === 0) {
        const wait = nextLinkAt - Date.now();
        if (wait > 0) {
            scheduleRebalance(wait + 50);
            return;
        }

        let cell = ringTarget;
        if (kind === 'chord') {
            cell = pickCell();
            if (cell === knownCells) cell = Math.floor(Math.random() * knownCells);
        }
        if (cell !== null && cell !== home) openLink(cell, kind);
    }
}

function scheduleRebalance(delay = 300) {
    if (rebalanceTimer) clearTimeout(rebalanceTimer);
    rebalanceTimer = setTimeout(rebalance, delay);
}

export function switchTopic(topic) {
    if (topic === getTopic()) return;

    closeAllRooms();
    fullCells.clear();
    emptyCells.clear();
    peerManager.resetRequests();
    setTopic(topic);
    start();
    peerManager.statusChanged();
}

export function getRoomLabel() {
    if (isHelper) return `${getTopic()} helper (${links.size} cells)`;
    return `${getTopic()}${home > 0 ? ` ${home + 1}` : ''}${links.size ? ' + link' : ''}`;
}

export function getCellStats() {
    return { home, links: [...links], knownCells, rooms: rooms.size };
}

export function getRelayCount() {
    return Object.values(getRelaySockets()).filter((socket) => socket.readyState === 1).length;
}

// Relay connections can quietly fail, so an empty browser joins again
function rejoinIfAlone() {
    if (peerManager.peers.size > 0) return;

    rejoinStats.attempts += 1;
    if (isHelper || home === 0) {
        closeAllRooms();
        if (isHelper) rebalanceHelper();
        else openRoom(cellRoom(home));
    } else {
        moveHome(0);
    }
}

function start() {
    const startCell = loadCells();
    if (isHelper) {
        home = null;
        rebalanceHelper();
    } else {
        home = startCell;
        saveCells();
        nextLinkAt = Date.now() + 500 + Math.random() * 1500;
        openRoom(cellRoom(home));
    }
}

export function getMyPeerId() {
    return selfId;
}

// After a short wait, note which relays answered, so dead ones are skipped next time
const RELAY_CHECK_MS = 20000;
function checkRelays() {
    const sockets = Object.entries(getRelaySockets());
    const working = sockets.filter(([, socket]) => socket.readyState === 1).map(([url]) => url);
    const failed = sockets.filter(([, socket]) => socket.readyState !== 1).map(([url]) => url);
    saveRelayHealth(working, failed);
    logger.info(`📡 Relays working: ${working.length} of ${sockets.length}`
        + (failed.length ? ` (not answering: ${failed.map((url) => url.replace('wss://', '')).join(', ')})` : ''));
}
setTimeout(checkRelays, RELAY_CHECK_MS);
setInterval(checkRelays, 10 * RELAY_CHECK_MS);

setInterval(rejoinIfAlone, aloneMs);
setInterval(() => scheduleRebalance(), 5000);

// Say goodbye when the page closes, so others drop you right away
window.addEventListener('pagehide', () => {
    peerManager.broadcast({ type: 'bye' });
    closeAllRooms();
});
window.addEventListener('pageshow', (event) => {
    if (event.persisted) start();
});

peerManager.onMembersChanged = () => scheduleRebalance();
peerManager.onNetworkInfo = learnNetwork;
logger.info(`✅ My peer ID: ${selfId}`);
loadTurnConfig().then((turnOn) => {
    logger.info(`🧭 TURN: ${turnOn ? 'on' : 'off'}${getRtcConfig() ? ' (TURN only)' : ''}`);
}).finally(start);
