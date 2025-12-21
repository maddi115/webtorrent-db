// gossipBinary.js - Smart binary: exclude previews
import { peerManager } from './peerManager.js';
import { addEntry, getEntryByURL } from '../storage/db.js';
import { contentDHT } from './contentDHT.js';
import { extractSlug } from '../../shared/urlParser.js';
import { getCRDTModule, getSerializerModule } from '../wasm/wasmLoader.js';
import { logger } from '../../shared/logger.js';

class GossipEngineBinary {
    constructor() {
        this.crdt = null;
        this.serializer = null;
        this.wasmReady = false;
        this.useBinary = false;
    }
    
    async init() {
        const crdtModule = getCRDTModule();
        const serializerModule = getSerializerModule();
        
        if (crdtModule && serializerModule) {
            this.crdt = new crdtModule.CRDTMerger();
            this.serializer = serializerModule;
            this.wasmReady = true;
            this.useBinary = true;
            logger.info('✅ Binary gossip initialized (FlatBuffers)');
        } else {
            logger.warn('⚠️  Binary serialization unavailable, using JSON');
        }
    }
    
    propagateEntry(entry) {
        if (this.wasmReady && this.crdt) {
            this.crdt.addEntry(
                entry.sourceURL,
                entry.magnet,
                entry.title || '',
                entry.addedBy || '',
                entry.preview || '',
                entry.timestamp
            );
        }
        
        let message;
        let messageType;
        
        if (this.useBinary && this.serializer) {
            try {
                // Serialize METADATA only (no preview - it's too big)
                const binary = this.serializer.serializeEntry(
                    entry.sourceURL,
                    entry.magnet,
                    entry.title || '',
                    entry.addedBy || '',
                    '', // Empty preview in binary
                    entry.timestamp
                );
                
                const base64 = this.uint8ArrayToBase64(binary);
                
                message = {
                    type: 'entry_binary',
                    binary: base64,
                    preview: entry.preview // Send preview separately
                };
                
                messageType = '📦 [BINARY]';
                
                const jsonSize = JSON.stringify({ type: 'entry', entry }).length;
                const metadataSize = base64.length;
                const previewSize = entry.preview ? entry.preview.length : 0;
                const totalSize = metadataSize + previewSize;
                const savings = ((1 - metadataSize / (jsonSize - previewSize)) * 100).toFixed(1);
                
                logger.info(`${messageType} Metadata: ${metadataSize}b (${savings}% smaller), Preview: ${previewSize}b, Total: ${totalSize}b`);
            } catch (error) {
                logger.error('❌ Binary serialization failed, falling back to JSON:', error);
                message = { type: 'entry', entry };
                messageType = '📤 [JSON]';
            }
        } else {
            message = { type: 'entry', entry };
            messageType = '📤 [JSON]';
            logger.info(`${messageType} Propagating entry:`, entry.sourceURL);
        }
        
        peerManager.broadcast(message);
    }
    
    async receiveEntry(entry, isBinary = false) {
        const format = isBinary ? '[BINARY]' : '[JSON]';
        logger.info(`🔍 ${format} Checking received entry:`, entry.sourceURL);
        
        const existingEntry = await getEntryByURL(entry.sourceURL);
        
        if (existingEntry) {
            if (this.wasmReady && this.crdt) {
                const existingTimestamp = this.crdt.getTimestamp(entry.sourceURL);
                
                if (entry.timestamp > existingTimestamp) {
                    logger.info(`⚡ ${format} Newer version, updating...`);
                    this.crdt.addEntry(
                        entry.sourceURL,
                        entry.magnet,
                        entry.title || '',
                        entry.addedBy || '',
                        entry.preview || '',
                        entry.timestamp
                    );
                } else {
                    logger.warn(`⚠️  ${format} Older version, skipping`);
                    return;
                }
            } else {
                logger.warn('⚠️  Entry already in local DB, skipping');
                return;
            }
        }
        
        logger.info(`📥 ${format} Received NEW entry:`, entry.sourceURL);
        
        try {
            if (this.wasmReady && this.crdt) {
                this.crdt.addEntry(
                    entry.sourceURL,
                    entry.magnet,
                    entry.title || '',
                    entry.addedBy || '',
                    entry.preview || '',
                    entry.timestamp
                );
                logger.info(`⚡ CRDT now has ${this.crdt.getCount()} entries`);
            }
            
            await addEntry(entry);
            logger.info('✅ Entry saved to local DB');
            
            const slug = extractSlug(entry.sourceURL);
            contentDHT.announceContent(slug);
            
            import('../ui/search.js').then(({ refreshResults }) => {
                refreshResults();
            });
            
            showToast(`📥 New: ${entry.title || 'Untitled'}`);
            
        } catch (error) {
            logger.error('Failed to save received entry:', error);
        }
    }
    
    deserializeBinary(base64String, preview) {
        if (!this.serializer) {
            throw new Error('Serializer not loaded');
        }
        
        try {
            const binaryString = atob(base64String);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            let dataString = '';
            for (let i = 0; i < bytes.length; i++) {
                dataString += String.fromCharCode(bytes[i]);
            }
            
            const entry = this.serializer.deserializeEntry(dataString);
            
            // Add preview back
            entry.preview = preview || null;
            
            logger.info(`📦 Deserialized metadata (${base64String.length} bytes) + preview`);
            
            return entry;
        } catch (error) {
            logger.error('❌ Deserialization failed:', error);
            return null;
        }
    }
    
    uint8ArrayToBase64(uint8Array) {
        let binary = '';
        for (let i = 0; i < uint8Array.length; i++) {
            binary += String.fromCharCode(uint8Array[i]);
        }
        return btoa(binary);
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

export const gossipBinary = new GossipEngineBinary();
