// deletes.js - Authors can delete their own posts, and the delete spreads to every peer
import { peerManager } from './peerManager.js';
import { applyDeletes } from '../storage/db.js';
import { signDelete } from '../../shared/signing.js';
import { logger } from '../../shared/logger.js';

const MAX_NOTES = 100;

function pack(note) {
    return { i: note.entryId, k: note.authorKey, g: note.signature };
}

function unpack(packed) {
    return { entryId: packed?.i, authorKey: packed?.k, signature: packed?.g };
}

async function refresh() {
    const { refreshResults } = await import('../ui/search.js');
    refreshResults();
}

export function sendDeletes(notes, connection) {
    if (notes.length && connection) {
        connection.send({ type: 'delete', deletes: notes.slice(0, MAX_NOTES).map(pack) });
    }
}

export async function deleteOwnPost(entryId) {
    const note = await signDelete(entryId);
    const applied = await applyDeletes([note]);
    if (!applied.length) return false;

    peerManager.broadcast({ type: 'delete', deletes: applied.map(pack) });
    logger.info('🗑️ Deleted your post');
    await refresh();
    return true;
}

export async function receiveDeletes(packedNotes, sourcePeerId) {
    if (!Array.isArray(packedNotes)) return;

    const applied = await applyDeletes(packedNotes.slice(0, MAX_NOTES).map(unpack));
    if (!applied.length) return;

    peerManager.peers.forEach((connection, peerId) => {
        if (peerId !== sourcePeerId) sendDeletes(applied, connection);
    });
    logger.info(`🗑️ ${applied.length} post${applied.length === 1 ? ' was' : 's were'} deleted by the author`);
    await refresh();
}
