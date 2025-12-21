// peerManager.js - Handle DHT messages
import { PeerConnection } from './transport.js';
import { contentDHT } from './contentDHT.js';
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
            
            // Share my content index
            this.shareMyContent(peerId);
        });
    }
    
    addOutgoingConnection(conn) {
        const peerId = conn.peer;
        
        conn.on('open', () => {
            logger.info(`✅ Outgoing connection established: ${peerId}`);
            this.createPeerConnection(peerId, conn);
            
            // Share my content index
            this.shareMyContent(peerId);
        });
    }
    
    shareMyContent(peerId) {
        const myContent = contentDHT.getMyContent();
        const peer = this.getPeer(peerId);
        
        if (peer && myContent.length > 0) {
            myContent.forEach(contentId => {
                peer.send({
                    type: 'announce',
                    contentId,
                    peerId: peerId
                });
            });
        }
    }
    
    createPeerConnection(peerId, conn) {
        if (this.peers.has(peerId)) {
            return;
        }
        
        const peerConnection = new PeerConnection(peerId, (data) => {
            this.handlePeerData(data, peerId);
        });
        
        peerConnection.setConnection(conn);
        this.peers.set(peerId, peerConnection);
        this.updatePeerCount();
        
        conn.on('close', () => {
            this.removePeer(peerId);
        });
    }
    
    handlePeerData(data, fromPeerId) {
        logger.info('🎯 Received data, type:', data.type);
        
        switch (data.type) {
            case 'entry':
                import('./gossip.js').then(({ gossip }) => {
                    gossip.receiveEntry(data.entry);
                });
                break;
                
            case 'announce':
                contentDHT.handleAnnouncement(data.contentId, data.peerId || fromPeerId);
                break;
                
            case 'query':
                contentDHT.handleQuery(data.contentId, data.requesterId);
                break;
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
