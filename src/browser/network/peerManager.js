// peerManager.js - Better logging
import { PeerConnection } from './transport.js';
import { logger } from '../../shared/logger.js';

export class PeerManager {
    constructor() {
        this.peers = new Map();
    }
    
    addIncomingConnection(conn) {
        const peerId = conn.peer;
        
        conn.on('open', () => {
            logger.info(`✅ Incoming connection established: ${peerId}`);
            this.createPeerConnection(peerId, conn);
        });
    }
    
    addOutgoingConnection(conn) {
        const peerId = conn.peer;
        
        conn.on('open', () => {
            logger.info(`✅ Outgoing connection established: ${peerId}`);
            this.createPeerConnection(peerId, conn);
        });
    }
    
    createPeerConnection(peerId, conn) {
        if (this.peers.has(peerId)) {
            return;
        }
        
        const peerConnection = new PeerConnection(peerId, (data) => {
            logger.info('🎯 Received data from peer:', data);
            this.handlePeerData(data);
        });
        
        peerConnection.setConnection(conn);
        this.peers.set(peerId, peerConnection);
        this.updatePeerCount();
        
        conn.on('close', () => {
            this.removePeer(peerId);
        });
    }
    
    handlePeerData(data) {
        logger.info('🔧 Handling peer data, type:', data.type);
        
        if (data.type === 'entry') {
            import('./gossip.js').then(({ gossip }) => {
                gossip.receiveEntry(data.entry);
            });
        }
    }
    
    getPeer(peerId) {
        return this.peers.get(peerId);
    }
    
    hasPeer(peerId) {
        return this.peers.has(peerId);
    }
    
    removePeer(peerId) {
        const connection = this.peers.get(peerId);
        if (connection) {
            connection.destroy();
            this.peers.delete(peerId);
            this.updatePeerCount();
            logger.info(`Removed peer: ${peerId}`);
        }
    }
    
    getAllPeers() {
        return Array.from(this.peers.values());
    }
    
    getConnectedPeers() {
        return this.getAllPeers().filter(p => p.connected);
    }
    
    broadcast(message) {
        const connected = this.getConnectedPeers();
        logger.info(`📡 Broadcasting to ${connected.length} peers`);
        connected.forEach(peer => {
            peer.send(message);
        });
    }
    
    updatePeerCount() {
        const countEl = document.getElementById('peer-count');
        if (countEl) {
            const connected = this.getConnectedPeers().length;
            countEl.textContent = connected;
        }
    }
}

export const peerManager = new PeerManager();
