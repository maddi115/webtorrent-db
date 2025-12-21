// gossip.js - Check local DB, not just memory
import { peerManager } from './peerManager.js';
import { addEntry, getEntryByURL } from '../storage/db.js';
import { contentDHT } from './contentDHT.js';
import { extractSlug } from '../../shared/urlParser.js';
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
        
        peerManager.broadcast({
            type: 'entry',
            entry
        });
    }
    
    async receiveEntry(entry) {
        const entryId = this.getEntryId(entry);
        
        logger.info('🔍 Checking received entry:', entryId);
        
        // Check if entry exists in LOCAL DB (not just memory)
        const existingEntry = await getEntryByURL(entry.sourceURL);
        
        if (existingEntry) {
            logger.warn('⚠️  Entry already in local DB, skipping');
            this.knownEntries.add(entryId); // Mark as known
            return;
        }
        
        this.knownEntries.add(entryId);
        
        logger.info('📥 Received NEW entry from peer:', entry.sourceURL);
        
        try {
            await addEntry(entry);
            logger.info('✅ Entry saved to local DB');
            
            // Announce to DHT
            const slug = extractSlug(entry.sourceURL);
            contentDHT.announceContent(slug);
            
            // Trigger auto-refresh
            import('../ui/search.js').then(({ refreshResults }) => {
                refreshResults();
            });
            
            // Show toast
            showToast(`📥 New: ${entry.title || 'Untitled'}`);
            
        } catch (error) {
            logger.error('Failed to save received entry:', error);
        }
    }
    
    getEntryId(entry) {
        return `${entry.sourceURL}_${entry.timestamp}`;
    }
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

export const gossip = new GossipEngine();
