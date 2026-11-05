// dht.js - Find peers through public Nostr relays with Trystero.
// Trystero introduces the browsers, then WebRTC connects them directly.
import { joinRoom, selfId } from 'trystero';
import { peerManager } from './peerManager.js';
import { logger } from '../../shared/logger.js';

const APP_ID = 'maddi115-webtorrent-p2p-db';
const ROOM_ID = 'public-v1';

const room = joinRoom({ appId: APP_ID }, ROOM_ID);
const messages = room.makeAction('message');

// Same shape the rest of the app expects from a peer connection
function createConnection(peerId) {
    return {
        peer: peerId,
        open: true,
        send: (message) => messages.send(message, { target: peerId })
    };
}

function getConnection(peerId) {
    if (!peerManager.hasPeer(peerId)) {
        peerManager.addPeer(createConnection(peerId));
    }
    return peerManager.getPeer(peerId);
}

room.onPeerJoin = (peerId) => {
    logger.info(`✅ Connected to peer: ${peerId}`);
    getConnection(peerId);
};

room.onPeerLeave = (peerId) => {
    logger.warn(`❌ Peer left: ${peerId}`);
    peerManager.removePeer(peerId);
};

messages.onMessage = (data, { peerId }) => {
    peerManager.handlePeerData(data, getConnection(peerId));
};

logger.info(`✅ My peer ID: ${selfId}`);
logger.info(`🔗 Looking for peers in room: ${ROOM_ID}`);

export function getMyPeerId() {
    return selfId;
}
