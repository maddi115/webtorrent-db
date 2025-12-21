// gossipWASM.js - WASM-powered gossip with CRDT
import { peerManager } from './peerManager.js';
import { addEntry, getEntryByURL } from '../storage/db.js';
import { contentDHT } from './contentDHT.js';
import { extractSlug } from '../../shared/urlParser.js';
import { getCRDTModule } from '../wasm/wasmLoader.js';
import { logger } from '../../shared/logger.js';

class GossipEngineWASM {
    constructor() {
        this.crdt = null;
        this.wasmReady = false;
    }
    
    async init() {
        const crdtModule = getCRDTModule();
        if (crdtModule) {
            this.crdt = new crdtModule.CRDTMerger();
            this.wasmReady = true;
            logger.info('✅ WASM CRDT initialized');
        } else {
            logger.warn('⚠️  WASM not available, using JS fallback');
        }
    }
    
    propagateEntry(entry) {
        if (this.wasmReady && this.crdt) {
            // Use WASM CRDT
            this.crdt.addEntry(
                entry.sourceURL,
                entry.magnet,
                entry.title || '',
                entry.addedBy || '',
                entry.preview || '',
                entry.timestamp
            );
            
            logger.info('📤 [WASM] Propagating entry:', entry.sourceURL);
        } else {
            logger.info('📤 [JS] Propagating entry:', entry.sourceURL);
        }
        
        peerManager.broadcast({
            type: 'entry',
            entry
        });
    }
    
    async receiveEntry(entry) {
        logger.info('🔍 Checking received entry:', entry.sourceURL);
        
        // Check if entry exists in local DB
        const existingEntry = await getEntryByURL(entry.sourceURL);
        
        if (existingEntry) {
            // WASM CRDT conflict resolution
            if (this.wasmReady && this.crdt) {
                const existingTimestamp = this.crdt.getTimestamp(entry.sourceURL);
                
                if (entry.timestamp > existingTimestamp) {
                    logger.info('⚡ [WASM] Newer version, updating...');
                    this.crdt.addEntry(
                        entry.sourceURL,
                        entry.magnet,
                        entry.title || '',
                        entry.addedBy || '',
                        entry.preview || '',
                        entry.timestamp
                    );
                } else {
                    logger.warn('⚠️  [WASM] Older version, skipping');
                    return;
                }
            } else {
                logger.warn('⚠️  Entry already in local DB, skipping');
                return;
            }
        }
        
        logger.info('📥 Received NEW entry from peer:', entry.sourceURL);
        
        try {
            // Add to WASM CRDT
            if (this.wasmReady && this.crdt) {
                this.crdt.addEntry(
                    entry.sourceURL,
                    entry.magnet,
                    entry.title || '',
                    entry.addedBy || '',
                    entry.preview || '',
                    entry.timestamp
                );
                logger.info(`⚡ WASM CRDT now has ${this.crdt.getCount()} entries`);
            }
            
            // Save to IndexedDB
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

export const gossipWASM = new GossipEngineWASM();
