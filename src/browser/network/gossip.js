// gossip.js - Delta-based gossip with better logging
import { peerManager } from './peerManager.js';
import { addEntry } from '../storage/db.js';
import { logger } from '../../shared/logger.js';

class GossipEngine {
    constructor() {
        this.knownEntries = new Set();
    }
    
    propagateEntry(entry) {
        const entryId = this.getEntryId(entry);
        
        if (this.knownEntries.has(entryId)) {
            logger.warn('Entry already propagated:', entryId);
            return;
        }
        
        this.knownEntries.add(entryId);
        
        logger.info('📤 Propagating entry to peers:', entry.sourceURL);
        
        // Broadcast to all connected peers
        peerManager.broadcast({
            type: 'entry',
            entry
        });
    }
    
    async receiveEntry(entry) {
        const entryId = this.getEntryId(entry);
        
        logger.info('🔍 Checking received entry:', entryId);
        
        if (this.knownEntries.has(entryId)) {
            logger.warn('⚠️  Entry already known, skipping:', entryId);
            return;
        }
        
        this.knownEntries.add(entryId);
        
        logger.info('📥 Received NEW entry from peer:', entry.sourceURL);
        
        try {
            await addEntry(entry);
            logger.info('✅ Entry saved to local DB');
        } catch (error) {
            logger.error('Failed to save received entry:', error);
        }
    }
    
    getEntryId(entry) {
        return `${entry.sourceURL}_${entry.timestamp}`;
    }
}

export const gossip = new GossipEngine();
