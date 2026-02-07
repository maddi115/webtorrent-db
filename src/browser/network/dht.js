// dht.js - Wait for WebSocket to be open before sending
import Peer from 'peerjs';
import { peerManager } from './peerManager.js';
import { contentDHT } from './contentDHT.js';
import { logger } from '../../shared/logger.js';
import { getUsername } from '../../shared/username.js';

let myPeer;
let myPeerId;
const SIGNALING_SERVER = 'ws://localhost:9000';

const socket = new WebSocket(SIGNALING_SERVER);
let socketReady = false;

socket.addEventListener('open', () => {
    logger.info('✅ Connected to signaling server');
    socketReady = true;
    
    // If peer ID already exists, register now
    if (myPeerId) {
        registerWithServer();
    }
});

socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === 'peers') {
        const peerList = message.peers.filter(p => p !== myPeerId);
        logger.info(`📋 Discovered ${peerList.length} peers from signaling server`);

        peerList.forEach(peerId => {
            connectToPeer(peerId);
        });
    }
});

socket.addEventListener('error', (error) => {
    logger.error('Signaling server error:', error);
});

function registerWithServer() {
    if (socketReady && myPeerId) {
        console.log('📤 Registering with server, peerId:', myPeerId);
        socket.send(JSON.stringify({
            type: 'register',
            peerId: myPeerId
        }));
        logger.info('🔗 Registered with signaling server');
    }
}

myPeer = new Peer({
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    }
});

myPeer.on('open', (id) => {
    myPeerId = id;
    logger.info(`✅ My peer ID: ${id}`);
    
    // Register if socket is already open
    registerWithServer();
});

myPeer.on('connection', (conn) => {
    peerManager.addPeer(conn);
});

myPeer.on('error', (err) => {
    logger.error('PeerJS error:', err);
});

export function connectToPeer(peerId) {
    if (peerManager.hasPeer(peerId)) {
        const shortId = peerId.split('-')[0];
        logger.info(`✅✅ Connection already open: ${peerId}`);
        return;
    }

    const shortId = peerId.split('-')[0];
    logger.info(`🔗 Connecting to peer: ${shortId}`);

    const conn = myPeer.connect(peerId, {
        reliable: true
    });

    conn.on('open', async () => {
        logger.info(`✅ Outgoing connection established: ${peerId}`);
        peerManager.peers.set(peerId, conn);
        peerManager.peerIds.add(shortId);
        peerManager.updatePeerCount();
        
        // SEND HANDSHAKE ON OUTGOING CONNECTION
        const myUsername = getUsername();
        console.log('🤝 SENDING handshake (outgoing):', myUsername, 'to peer:', shortId);
        conn.send({
            type: 'handshake',
            username: myUsername
        });
        
        peerManager.setupPeerListeners(conn);

        contentDHT.announceAll();
    });

    conn.on('error', (err) => {
        logger.error(`Connection error with ${peerId}:`, err);
    });

    conn.on('close', async () => {
        logger.warn(`❌ Connection closed: ${peerId}`);
        
        // Mark user as offline
        const { presenceManager } = await import('./presence.js');
        const username = presenceManager.getUserByPeerId(peerId);
        if (username) {
            presenceManager.setOffline(username);
        }
        
        peerManager.peers.delete(peerId);
        peerManager.peerIds.delete(shortId);
        peerManager.updatePeerCount();
    });
}

export function getMyPeerId() {
    return myPeerId;
}
