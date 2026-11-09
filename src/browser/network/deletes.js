// deletes.js - Authors can delete their own posts, and an admin can delete any post or clear them all.
// Deletes spread to every peer, and also through the shared relays so every room hears about them.
import { peerManager } from './peerManager.js';
import { applyDeletes, applyWipe, getWipe } from '../storage/db.js';
import { signDelete, signWipe } from '../../shared/signing.js';
import { publishChat } from './chatRelay.js';
import { saveDeletes, saveWipe } from './nostrStore.js';
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
    window.dispatchEvent(new CustomEvent('posts-changed'));
}

export function sendDeletes(notes, connection) {
    if (notes.length && connection) {
        connection.send({ type: 'delete', deletes: notes.slice(0, MAX_NOTES).map(pack) });
    }
}

// Works for your own posts, and for any post if you are the admin
export async function deleteOwnPost(entryId) {
    const note = await signDelete(entryId);
    const applied = await applyDeletes([note]);
    if (!applied.length) return false;

    const deletes = applied.map(pack);
    peerManager.broadcast({ type: 'delete', deletes });
    publishChat({ kind: 'delete', deletes }).catch(() => {});
    saveDeletes(deletes);
    logger.info('🗑️ Deleted a post');
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
    logger.info(`🗑️ ${applied.length} post${applied.length === 1 ? ' was' : 's were'} deleted`);
    await refresh();
}

function showMessage(text) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Admin only: removes every post made until now, in all 6 rooms, for everyone
export async function clearAllPosts() {
    const note = await signWipe(Date.now());
    if (!await applyWipe(note)) return false;

    peerManager.broadcast({ type: 'wipe', wipe: note });
    publishChat({ kind: 'wipe', wipe: note }).catch(() => {});
    saveWipe(note);
    logger.info('🧹 Cleared all posts');
    await refresh();
    return true;
}

export async function receiveWipe(note, sourcePeerId) {
    if (!note || typeof note !== 'object') return;
    if (!await applyWipe(note)) return;

    peerManager.peers.forEach((connection, peerId) => {
        if (peerId !== sourcePeerId) connection.send({ type: 'wipe', wipe: note });
    });
    logger.info('🧹 The admin cleared all posts');
    showMessage('The admin cleared all posts.');
    await refresh();
}

// Someone who missed the clear-out hears about it when they connect
export async function sendWipe(connection) {
    const note = await getWipe().catch(() => null);
    if (note) connection.send({ type: 'wipe', wipe: note });
}
