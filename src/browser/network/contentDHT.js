// contentDHT.js - Track which peers have which content
import { logger } from '../../shared/logger.js';
import { peerManager } from './peerManager.js';

class ContentDHT {
    constructor() {
        this.contentToPeers = new Map();
    }

    addPeer(contentId, peerId) {
        if (!this.contentToPeers.has(contentId)) {
            this.contentToPeers.set(contentId, new Set());
        }
        this.contentToPeers.get(contentId).add(peerId);
    }

    removePeer(peerId) {
        this.contentToPeers.forEach((peers, contentId) => {
            peers.delete(peerId);
            if (peers.size === 0) {
                this.contentToPeers.delete(contentId);
            }
        });
    }

    findPeers(contentId) {
        return Array.from(this.contentToPeers.get(contentId) || []);
    }

    hasContent(contentId) {
        return this.contentToPeers.has(contentId) && this.contentToPeers.get(contentId).size > 0;
    }

    announceContent(contentId) {
        logger.info(`📢 Announcing content: ${contentId}`);
        peerManager.broadcast({
            type: 'announce',
            contentId: contentId
        });
    }
}

export const contentDHT = new ContentDHT();
