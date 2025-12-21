// dht.js - PeerJS for P2P connections
import Peer from 'peerjs';
import { peerManager } from './peerManager.js';
import { gossip } from './gossip.js';
import { logger } from '../../shared/logger.js';

let peer;
let myPeerId;

export async function initNetwork() {
    logger.info('📡 Initializing PeerJS...');
    
    return new Promise((resolve) => {
        // Create PeerJS instance (uses free PeerServer cloud)
        peer = new Peer({
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });
        
        peer.on('open', (id) => {
            myPeerId = id;
            logger.info(`✅ My peer ID: ${myPeerId}`);
            logger.info('📋 Share this ID with others to connect!');
            resolve();
        });
        
        peer.on('connection', (conn) => {
            logger.info(`📞 Incoming connection from: ${conn.peer}`);
            peerManager.addIncomingConnection(conn);
        });
        
        peer.on('error', (err) => {
            logger.error('PeerJS error:', err);
        });
    });
}

export function connectToPeer(remotePeerId) {
    if (remotePeerId === myPeerId) {
        logger.warn('Cannot connect to yourself!');
        return;
    }
    
    const conn = peer.connect(remotePeerId, { reliable: true });
    peerManager.addOutgoingConnection(conn);
}

export function getMyPeerId() {
    return myPeerId;
}

export function getPeer() {
    return peer;
}
