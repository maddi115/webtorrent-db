// dht.js - Connect to OUR signaling server for auto-discovery
import Peer from 'peerjs';
import { peerManager } from './peerManager.js';
import { logger } from '../../shared/logger.js';

const SIGNALING_SERVER = 'ws://localhost:9000';

let peer;
let myPeerId;
let ws;

export async function initNetwork() {
    logger.info('📡 Initializing PeerJS...');
    
    return new Promise((resolve) => {
        // Create PeerJS instance
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
            
            // Connect to signaling server for discovery
            connectToSignalingServer();
            
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

function connectToSignalingServer() {
    logger.info('🔗 Connecting to signaling server for peer discovery...');
    
    ws = new WebSocket(SIGNALING_SERVER);
    
    ws.onopen = () => {
        logger.info('✅ Connected to signaling server');
        
        // Announce myself
        ws.send(JSON.stringify({
            type: 'announce',
            peerId: myPeerId
        }));
    };
    
    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleSignalingMessage(message);
        } catch (error) {
            logger.error('Failed to parse signaling message:', error);
        }
    };
    
    ws.onerror = (error) => {
        logger.error('WebSocket error:', error);
    };
    
    ws.onclose = () => {
        logger.warn('❌ Disconnected from signaling server');
        setTimeout(() => {
            logger.info('🔄 Reconnecting...');
            connectToSignalingServer();
        }, 3000);
    };
}

function handleSignalingMessage(message) {
    switch (message.type) {
        case 'peers':
            // Got list of all peers in the network
            const otherPeers = message.peers.filter(id => id !== myPeerId);
            logger.info(`📋 Discovered ${otherPeers.length} peers from signaling server`);
            
            // Auto-connect to all peers
            otherPeers.forEach(peerId => {
                if (!peerManager.hasPeer(peerId)) {
                    connectToPeer(peerId);
                }
            });
            break;
    }
}

export function connectToPeer(remotePeerId) {
    if (remotePeerId === myPeerId) {
        logger.warn('Cannot connect to yourself!');
        return;
    }
    
    if (peerManager.hasPeer(remotePeerId)) {
        logger.info(`Already connected to ${remotePeerId.slice(0, 8)}`);
        return;
    }
    
    logger.info(`🔗 Connecting to peer: ${remotePeerId.slice(0, 8)}`);
    const conn = peer.connect(remotePeerId, { reliable: true });
    peerManager.addOutgoingConnection(conn);
}

export function getMyPeerId() {
    return myPeerId;
}

export function getPeer() {
    return peer;
}
