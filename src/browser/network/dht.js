// dht.js - Find peers through public Nostr relays with Trystero.
// Relays only make introductions. Browsers do the sharing work directly.
import { joinRoom, selfId } from 'trystero';
import { peerManager } from './peerManager.js';
import { getTopic, setTopic } from '../../shared/rooms.js';
import { logger } from '../../shared/logger.js';

const APP_ID = 'maddi115-webtorrent-p2p-db';
const DEFAULT_ROOM_CAPACITY = 12;

const testOptions = new URLSearchParams(import.meta.env.DEV ? location.search : '');
const roomPrefix = testOptions.get('testRoom') ? `${testOptions.get('testRoom')}-` : 'v1-';
const roomCapacity = Number(testOptions.get('capacity')) || DEFAULT_ROOM_CAPACITY;

const joinedAt = Date.now();
const rooms = new Map();
let shard = 1;
let bridgeRoom = null;

function getRoomId(topic, roomShard) {
    return `${roomPrefix}${topic}-${roomShard}`;
}

function getPrimaryRoom() {
    return getRoomId(getTopic(), shard);
}

// Same shape the rest of the app expects from a peer connection
function createConnection(peerId, roomId) {
    return {
        peer: peerId,
        room: roomId,
        open: true,
        joinedAt,
        bridge: roomId !== getPrimaryRoom(),
        send: (message) => rooms.get(roomId)?.messages.send(message, { target: peerId }),
        sendChunk: (bytes, metadata) => rooms.get(roomId)?.chunks.send(bytes, { target: peerId, metadata })
    };
}

function getConnection(peerId, roomId) {
    if (!peerManager.hasPeer(peerId)) {
        peerManager.addPeer(createConnection(peerId, roomId));
    }
    return peerManager.getPeer(peerId);
}

function openRoom(roomId) {
    if (rooms.has(roomId)) return;

    const room = joinRoom({ appId: APP_ID }, roomId);
    const messages = room.makeAction('message');
    const chunks = room.makeAction('chunk');
    rooms.set(roomId, { room, messages, chunks });

    room.onPeerJoin = (peerId) => {
        logger.info(`✅ Connected to peer: ${peerId}`);

        // Someone who moved rooms may arrive before their old room says goodbye
        if (peerManager.hasPeer(peerId) && peerManager.getPeer(peerId).room !== roomId) {
            peerManager.removePeer(peerId);
        }
        getConnection(peerId, roomId);
    };

    room.onPeerLeave = (peerId) => {
        if (peerManager.getPeer(peerId)?.room === roomId) {
            logger.warn(`❌ Peer left: ${peerId}`);
            peerManager.removePeer(peerId);
        }
    };

    messages.onMessage = (data, { peerId }) => {
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
    peerManager.removeRoomPeers(roomId);
    entry.room.leave();
}

function closeAllRooms() {
    [...rooms.keys()].forEach(closeRoom);
    bridgeRoom = null;
}

function moveToShard(nextShard) {
    closeAllRooms();
    shard = nextShard;
    openRoom(getPrimaryRoom());
    peerManager.statusChanged();
}

// Newest people move on when a room is full. The oldest person links the rooms.
function rebalanceRoom() {
    const primary = getPrimaryRoom();
    const members = [
        { peerId: selfId, joinedAt },
        ...peerManager.getRoomMembers(primary)
    ].sort((a, b) => a.joinedAt - b.joinedAt || a.peerId.localeCompare(b.peerId));
    const rank = members.findIndex((member) => member.peerId === selfId);

    if (rank >= roomCapacity) {
        logger.info(`➡️ Room is full, moving to part ${shard + 1}`);
        moveToShard(shard + 1);
        return;
    }

    const shouldBridge = rank === 0 && members.length >= roomCapacity;
    const nextRoom = getRoomId(getTopic(), shard + 1);

    if (shouldBridge && bridgeRoom !== nextRoom) {
        bridgeRoom = nextRoom;
        openRoom(nextRoom);
    } else if (!shouldBridge && bridgeRoom) {
        closeRoom(bridgeRoom);
        bridgeRoom = null;
    }
}

export function switchTopic(topic) {
    if (topic === getTopic()) return;

    closeAllRooms();
    peerManager.resetRequests();
    setTopic(topic);
    shard = 1;
    openRoom(getPrimaryRoom());
    peerManager.statusChanged();
}

export function getRoomLabel() {
    return `${getTopic()}${shard > 1 ? ` ${shard}` : ''}${bridgeRoom ? ' + bridge' : ''}`;
}

export function getMyPeerId() {
    return selfId;
}

peerManager.onMembersChanged = rebalanceRoom;
logger.info(`✅ My peer ID: ${selfId}`);
openRoom(getPrimaryRoom());
