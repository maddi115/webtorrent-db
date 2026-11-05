// gossip.js - Share links between peers as JSON
import { peerManager } from './peerManager.js';
import { addEntry, getEntryById } from '../storage/db.js';
import { linkPeers } from './linkPeers.js';
import { extractSlug } from '../../shared/urlParser.js';
import { fromPublicEntry, getEntryId, toPublicEntry } from '../../shared/entryId.js';
import { cleanRemoteEntry } from '../../shared/entryRules.js';
import { getTopic } from '../../shared/rooms.js';
import { logger } from '../../shared/logger.js';

class GossipEngine {
    constructor() {
        this.receiving = new Set();
    }

    async init() {
        logger.info('✅ Gossip initialized (JSON)');
    }

    propagateEntry(entry) {
        peerManager.broadcast({ type: 'entry', entry: toPublicEntry(entry) });
    }

    async receiveEntry(packedEntry, sourcePeerId) {
        let rawEntry;
        try {
            rawEntry = fromPublicEntry(packedEntry);
        } catch {
            return;
        }

        const entry = cleanRemoteEntry(rawEntry, getTopic());
        if (!entry) return;

        entry.entryId = await getEntryId(entry);

        if (this.receiving.has(entry.entryId)) return;
        this.receiving.add(entry.entryId);

        try {
            if (await getEntryById(entry.entryId)) return;

            await addEntry(entry);
            logger.info('✅ Entry saved to local DB');
            linkPeers.announceContent(extractSlug(entry.sourceURL));
            peerManager.forwardEntry(toPublicEntry(entry), sourcePeerId);

            const { refreshResults } = await import('../ui/search.js');
            refreshResults();
            showToast(`📥 New: ${entry.title || 'Untitled'}`);
        } catch (error) {
            logger.error('Failed to save received entry:', error);
        } finally {
            this.receiving.delete(entry.entryId);
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

export const gossip = new GossipEngine();
