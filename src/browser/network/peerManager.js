// peerManager.js - Use WASM gossip
import { PeerConnection } from './transport.js';
import { contentDHT } from './contentDHT.js';
import { getMyPeerId } from './dht.js';
import { getAllEntries } from '../storage/db.js';
import { extractSlug } from '../../shared/urlParser.js';
import { gossipWASM } from './gossipWASM.js';
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
            this.handlePeerData(data, peerId);
        });
        
        peerConnection.setConnection(conn);
        this.peers.set(peerId, peerConnection);
        this.updatePeerCount();
        
        conn.on('close', () => {
            this.removePeer(peerId);
        });
        
        setTimeout(() => {
            this.shareMyContentIndex(peerConnection);
        }, 1500);
    }
    
    shareMyContentIndex(peerConnection) {
        const myContent = contentDHT.getMyContent();
        const myPeerId = getMyPeerId();
        
        if (!myPeerId || !peerConnection.connected) {
            return;
        }
        
        if (myContent.length > 0) {
            logger.info(`📤 Sharing ${myContent.length} content announcements with ${peerConnection.peerId.slice(0, 8)}`);
            
            myContent.forEach(contentId => {
                peerConnection.send({
                    type: 'announce',
                    contentId,
                    peerId: myPeerId
                });
            });
        }
    }
    
    async handlePeerData(data, fromPeerId) {
        logger.info('🎯 Received data, type:', data.type);
        
        switch (data.type) {
            case 'entry':
                // Use WASM gossip
                await gossipWASM.receiveEntry(data.entry);
                break;
                
            case 'announce':
                contentDHT.handleAnnouncement(data.contentId, data.peerId);
                break;
                
            case 'query':
                contentDHT.handleQuery(data.contentId, data.requesterId);
                break;
                
            case 'request_entry':
                await this.handleEntryRequest(data.contentId, fromPeerId);
                break;
        }
    }
    
    async handleEntryRequest(contentId, requesterId) {
        logger.info(`📤 Peer ${requesterId.slice(0, 8)} requested: ${contentId}`);
        
        const allEntries = await getAllEntries();
        const entry = allEntries.find(e => extractSlug(e.sourceURL) === contentId);
        
        if (entry) {
            const peer = this.getPeer(requesterId);
            if (peer && peer.connected) {
                logger.info(`✅ Sending entry to ${requesterId.slice(0, 8)}`);
                peer.send({
                    type: 'entry',
                    entry
                });
            }
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
