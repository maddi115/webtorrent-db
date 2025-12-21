// contentDHT.js - Content-based peer discovery
import { getMyPeerId, getPeer } from './dht.js';
import { peerManager } from './peerManager.js';
import { logger } from '../../shared/logger.js';

class ContentDHT {
    constructor() {
        // Map: contentId -> Set of peer IDs who have it
        this.contentIndex = new Map();
        
        // Map: my contentIds that I'm announcing
        this.myContent = new Set();
    }
    
    // Announce that I have this content
    announceContent(contentId) {
        this.myContent.add(contentId);
        
        const myPeerId = getMyPeerId();
        if (!this.contentIndex.has(contentId)) {
            this.contentIndex.set(contentId, new Set());
        }
        this.contentIndex.get(contentId).add(myPeerId);
        
        logger.info(`📢 Announcing content: ${contentId}`);
        
        // Broadcast announcement to all peers
        this.broadcastAnnouncement(contentId);
    }
    
    broadcastAnnouncement(contentId) {
        peerManager.broadcast({
            type: 'announce',
            contentId,
            peerId: getMyPeerId()
        });
    }
    
    // Receive announcement from peer
    handleAnnouncement(contentId, peerId) {
        if (!this.contentIndex.has(contentId)) {
            this.contentIndex.set(contentId, new Set());
        }
        
        this.contentIndex.get(contentId).add(peerId);
        logger.info(`📥 Peer ${peerId.slice(0, 8)} has: ${contentId}`);
    }
    
    // Find peers who have this content
    findPeers(contentId) {
        const peers = this.contentIndex.get(contentId);
        if (!peers || peers.size === 0) {
            logger.info(`🔍 No peers found for: ${contentId}`);
            return [];
        }
        
        logger.info(`✅ Found ${peers.size} peers with: ${contentId}`);
        return Array.from(peers);
    }
    
    // Query: ask all connected peers if they have content
    queryContent(contentId) {
        logger.info(`🔍 Querying peers for: ${contentId}`);
        
        peerManager.broadcast({
            type: 'query',
            contentId,
            requesterId: getMyPeerId()
        });
    }
    
    // Handle query from peer
    handleQuery(contentId, requesterId) {
        if (this.myContent.has(contentId)) {
            logger.info(`✅ I have ${contentId}, telling ${requesterId.slice(0, 8)}`);
            
            // Tell requester I have it
            const peer = peerManager.getPeer(requesterId);
            if (peer) {
                peer.send({
                    type: 'announce',
                    contentId,
                    peerId: getMyPeerId()
                });
            }
        }
    }
    
    // Get all my announced content
    getMyContent() {
        return Array.from(this.myContent);
    }
    
    // Get stats
    getStats() {
        return {
            totalContent: this.contentIndex.size,
            myContent: this.myContent.size,
            totalPeers: new Set(
                Array.from(this.contentIndex.values())
                    .flatMap(peers => Array.from(peers))
            ).size
        };
    }
}

export const contentDHT = new ContentDHT();
