// roomPresence.js - Counts everyone in your room, and keeps each room to 50 people.
// Every browser says "I'm here" now and then. The message hops across the whole room,
// so everyone can count the room, not just the people they are connected to.
import { selfId } from 'trystero';
import { peerManager } from './peerManager.js';
import { getNextTopic, getRoomName, getTopic } from '../../shared/rooms.js';
import { networkSettings } from '../../shared/networkConfig.js';
import { logger } from '../../shared/logger.js';

const devOptions = new URLSearchParams(import.meta.env.DEV ? location.search : '');
export const ROOM_MAX = Number(devOptions.get('roomMax')) || 50;
const HERE_MS = Number(devOptions.get('hereMs')) || 15000;
const GONE_MS = HERE_MS * 3;
const SETTLE_MS = Number(devOptions.get('roomSettleMs')) || 10000;
const MAX_MOVES = 6;
const MAX_TRACKED = 500;

const members = new Map();
// People who just left. An older "I'm here" from them that arrives late must not count them again.
const goneAt = new Map();
let joinedAt = Date.now();
let moves = 0;
let onMove = () => {};

export const presenceStats = { moves: 0 };

export function onRoomMove(callback) {
    onMove = callback;
}

function prune() {
    const now = Date.now();
    for (const [id, member] of members) {
        if (now - member.seenAt > GONE_MS) members.delete(id);
    }
    for (const [id, time] of goneAt) {
        if (now - time > GONE_MS * 2) goneAt.delete(id);
    }
}

// Everyone in this room, you included. The helper bot is not counted.
export function getRoomCount() {
    prune();
    return members.size + (networkSettings.isHelper ? 0 : 1);
}

function sayHere() {
    if (networkSettings.isHelper || !peerManager.peers.size) return;
    peerManager.broadcast({ type: 'here', id: selfId, room: getTopic(), joinedAt, t: Date.now() });
}

export function receiveHere(data, connection) {
    if (typeof data.id !== 'string' || data.id.length > 64 || data.id === selfId) return;
    if (data.room !== getTopic() || !Number.isFinite(data.t) || !Number.isFinite(data.joinedAt)) return;
    if (Math.abs(Date.now() - data.t) > GONE_MS) return;

    const known = members.get(data.id);
    if (known && known.t >= data.t) return;
    if ((goneAt.get(data.id) || 0) >= data.t) return;
    if (data.gone === true) {
        goneAt.set(data.id, data.t);
        if (!known) return;
        members.delete(data.id);
    } else {
        if (!known && members.size >= MAX_TRACKED) return;
        members.set(data.id, { joinedAt: data.joinedAt, t: data.t, seenAt: Date.now() });
    }
    // Pass it on once, so the whole room hears it
    peerManager.peers.forEach((peer, peerId) => {
        if (peerId !== connection.peer) peer.send(data);
    });
}

// If the room is over the limit, the newest arrivals move to the next room
function checkCapacity() {
    if (networkSettings.isHelper || Date.now() - joinedAt < SETTLE_MS || moves >= MAX_MOVES) return;
    if (getRoomCount() <= ROOM_MAX) return;

    const order = [...members.entries()]
        .map(([id, member]) => ({ id, joinedAt: member.joinedAt }))
        .concat({ id: selfId, joinedAt })
        .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    if (order.findIndex((member) => member.id === selfId) < ROOM_MAX) return;

    const from = getRoomName();
    const next = getNextTopic();
    moves += 1;
    presenceStats.moves += 1;
    logger.info(`🚪 ${from} is full, moving to ${getRoomName(next)}`);
    onMove(from, next);
}

// Someone you were connected to left, so stop counting them right away
export function forgetMember(peerId) {
    members.delete(peerId);
    goneAt.set(peerId, Date.now());
}

// Tells the room you are leaving, so its count drops right away
export function sayGone() {
    if (networkSettings.isHelper || !peerManager.peers.size) return;
    peerManager.broadcast({ type: 'here', id: selfId, room: getTopic(), joinedAt, t: Date.now(), gone: true });
}

// Call this whenever you change rooms
export function resetRoomPresence() {
    members.clear();
    goneAt.clear();
    joinedAt = Date.now();
    setTimeout(sayHere, 1500);
}

export function resetMoves() {
    moves = 0;
}

setTimeout(sayHere, 1500);
setInterval(() => {
    sayHere();
    checkCapacity();
}, HERE_MS);
setInterval(checkCapacity, 2000);
