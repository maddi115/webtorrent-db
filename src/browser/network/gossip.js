// gossip.js - Share links between peers as JSON
import { peerManager } from './peerManager.js';
import { getEntryById, receiveEntries, updateEntryCount } from '../storage/db.js';
import { linkPeers } from './linkPeers.js';
import { extractSlug } from '../../shared/urlParser.js';
import { fromPublicEntry, toPublicEntry } from '../../shared/entryId.js';
import { logger } from '../../shared/logger.js';
import { sendDeletes } from './deletes.js';

// Counts why links from peers were turned away
export const trustStats = { saved: 0, rejected: {} };
const WARN_REASONS = new Set(['bad-signature', 'name-taken', 'too-fast', 'blocked']);

class GossipEngine {
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

        try {
            const { saved, rejected, deleted } = await receiveEntries([rawEntry]);
            // Someone offered a post its author deleted, so tell them about the delete
            sendDeletes(deleted, peerManager.getPeer(sourcePeerId));
            Object.entries(rejected).forEach(([reason, count]) => {
                trustStats.rejected[reason] = (trustStats.rejected[reason] || 0) + count;
                if (WARN_REASONS.has(reason)) logger.warn(`🚫 Link rejected: ${reason}`);
            });
            if (!saved.length) return;

            trustStats.saved += 1;
            const entry = await getEntryById(saved[0]);
            await updateEntryCount();
            logger.info('✅ Entry saved to local DB');
            linkPeers.announceContent(extractSlug(entry.sourceURL));
            peerManager.forwardEntry(toPublicEntry(entry), sourcePeerId);

            const { refreshResults } = await import('../ui/search.js');
            refreshResults();
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

export const gossip = new GossipEngine();
