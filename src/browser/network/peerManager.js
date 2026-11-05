// peerManager.js - Track connected peers and handle their messages
import { logger } from '../../shared/logger.js';
import { gossipBinary } from './gossipBinary.js';
import { contentDHT } from './contentDHT.js';
import { presenceManager } from './presence.js';
import { getUsername } from '../../shared/username.js';
import { getAvatar } from '../../shared/profile.js';
import { toPublicEntry } from '../../shared/entryId.js';
import { extractSlug } from '../../shared/urlParser.js';
import { MAX_AVATAR_CHARS, MAX_PREVIEW_CHARS, safeImage, shortText } from '../../shared/safe.js';
import { renderPeerTable } from '../ui/peerTable.js';
import { receiveThumbnail, sendThumbnail } from '../ui/thumbnails.js';
import { handleFingerprints, handleLists, startSync } from './smartSync.js';

const MAX_SYNC_ITEMS = 5000;
const MAX_WHO_HAS = 50;
const REQUEST_RETRY_MS = 15000;

class PeerManager {
    constructor() {
        this.peers = new Map();
        this.peerIds = new Set();
        this.profiles = new Map();
        this.requested = new Set();
        this.onMembersChanged = () => {};
    }

    resetRequests() {
        this.requested.clear();
    }

    getRoomMembers(roomId) {
        return [...this.profiles.entries()]
            .filter(([peerId, profile]) => (
                this.peers.get(peerId)?.room === roomId
                && !profile.bridge
                && Number.isFinite(profile.joinedAt)
            ))
            .map(([peerId, profile]) => ({ peerId, joinedAt: profile.joinedAt }));
    }

    removeRoomPeers(roomId) {
        [...this.peers.values()]
            .filter((connection) => connection.room === roomId)
            .forEach((connection) => this.removePeer(connection.peer));
    }

    forwardEntry(entry, sourcePeerId) {
        const sourceRoom = this.peers.get(sourcePeerId)?.room;
        this.peers.forEach((connection) => {
            if (connection.room !== sourceRoom) {
                connection.send({ type: 'entry', entry });
            }
        });
    }

    addPeer(connection) {
        const peerId = connection.peer;
        this.peers.set(peerId, connection);
        this.peerIds.add(peerId);
        this.profiles.set(peerId, {
            username: 'Connecting...',
            avatar: null,
            connections: 1,
            links: 0,
            connectedAt: Date.now(),
            joinedAt: null,
            bridge: false
        });

        connection.send({
            type: 'handshake',
            username: getUsername(),
            avatar: getAvatar(),
            joinedAt: connection.joinedAt,
            bridge: connection.bridge
        });
        startSync(connection);
        this.statusChanged();
    }

    removePeer(peerId) {
        const username = presenceManager.getUserByPeerId(peerId);
        if (username) {
            presenceManager.setOffline(username);
        }

        contentDHT.removePeer(peerId);
        this.peers.delete(peerId);
        this.peerIds.delete(peerId);
        this.profiles.delete(peerId);
        this.statusChanged();
        this.onMembersChanged();
    }

    async statusChanged() {
        this.updatePeerCount();
        renderPeerTable();

        const { getEntryCount } = await import('../storage/db.js');
        this.broadcast({
            type: 'peer_status',
            connections: this.peers.size,
            links: await getEntryCount()
        });
    }

    handlePeerData(data, connection) {
        logger.info(`🎯 Received data, type: ${data.type}`);

        switch (data.type) {
            case 'handshake':
                this.handleHandshake(data, connection);
                break;

            case 'profile':
                this.handleProfile(data, connection);
                break;

            case 'peer_status':
                this.handlePeerStatus(data, connection);
                break;

            case 'sync_fingerprints':
                handleFingerprints(data, connection);
                break;

            case 'sync_lists':
                handleLists(data, connection, (ids, peer) => this.requestMissing(ids, peer));
                break;

            case 'who_has':
                this.handleWhoHas(data, connection);
                break;

            case 'has_ids':
                this.handleHasIds(data, connection);
                break;

            case 'request_entries':
                this.handleEntriesRequest(data, connection);
                break;

            case 'announce':
                if (typeof data.contentId === 'string' && data.contentId) {
                    contentDHT.addPeer(data.contentId, connection.peer);

                    const username = presenceManager.getUserByPeerId(connection.peer);
                    if (username) {
                        presenceManager.updateLastSeen(username);
                    }
                }
                break;

            case 'request_entry':
                this.handleEntryRequest(data.contentId, connection);
                break;

            case 'entry':
                gossipBinary.receiveEntry(data.entry, connection.peer);
                break;

            case 'request_thumb':
                sendThumbnail(data.entryId, connection);
                break;

            case 'thumb':
                receiveThumbnail(data.entryId, data.thumb);
                break;

            case 'request_preview':
                this.handlePreviewRequest(data.entryId, connection);
                break;

            case 'preview':
                this.handlePreview(data);
                break;
        }
    }

    handleHandshake(data, connection) {
        const profile = this.profiles.get(connection.peer);
        if (!profile) return;

        profile.joinedAt = Number.isFinite(data.joinedAt) ? data.joinedAt : Date.now();
        profile.bridge = data.bridge === true;
        this.handleProfile(data, connection);
        this.onMembersChanged();
    }

    handleProfile(data, connection) {
        const profile = this.profiles.get(connection.peer);
        if (!profile) return;

        const username = shortText(data.username, 100);
        if (username) {
            profile.username = username;
            presenceManager.setOnline(username, connection.peer);
        }
        profile.avatar = safeImage(data.avatar, MAX_AVATAR_CHARS);
        renderPeerTable();
    }

    handlePeerStatus(data, connection) {
        const profile = this.profiles.get(connection.peer);
        if (!profile) return;

        if (Number.isSafeInteger(data.connections) && data.connections >= 0) {
            profile.connections = data.connections;
        }
        if (Number.isSafeInteger(data.links) && data.links >= 0) {
            profile.links = data.links;
        }
        renderPeerTable();
    }

    requestMissing(ids, connection) {
        const missing = ids.slice(0, MAX_SYNC_ITEMS).filter((id) => !this.requested.has(id));

        missing.forEach((id) => {
            this.requested.add(id);
            setTimeout(() => this.requested.delete(id), REQUEST_RETRY_MS);
        });

        if (missing.length) {
            connection.send({ type: 'request_entries', ids: missing });
        }
    }

    async handleWhoHas(data, connection) {
        if (!Array.isArray(data.ids)) return;
        const { getExistingIds } = await import('../storage/db.js');
        const ids = data.ids
            .slice(0, MAX_WHO_HAS)
            .filter((id) => typeof id === 'string');

        const existing = await getExistingIds(ids);
        if (existing.length) {
            connection.send({ type: 'has_ids', ids: existing });
        }
    }

    handleHasIds(data, connection) {
        if (!Array.isArray(data.ids)) return;
        window.dispatchEvent(new CustomEvent('peer-has-ids', {
            detail: { ids: data.ids, peerId: connection.peer }
        }));
    }

    async handleEntriesRequest(data, connection) {
        if (!Array.isArray(data.ids)) return;
        const { getEntryById } = await import('../storage/db.js');

        for (const id of data.ids.slice(0, MAX_SYNC_ITEMS)) {
            const entry = await getEntryById(id);
            if (entry) {
                connection.send({ type: 'entry', entry: toPublicEntry(entry) });
            }
        }
    }

    async handleEntryRequest(contentId, connection) {
        const { getRoomEntries } = await import('../storage/db.js');
        const entries = await getRoomEntries();
        const match = entries.find((entry) => extractSlug(entry.sourceURL) === contentId);

        if (match) {
            connection.send({ type: 'entry', entry: toPublicEntry(match) });
        }
    }

    async handlePreviewRequest(entryId, connection) {
        const { getEntryById } = await import('../storage/db.js');
        const entry = await getEntryById(entryId);

        if (entry?.preview) {
            connection.send({ type: 'preview', entryId, preview: entry.preview });
        }
    }

    async handlePreview(data) {
        const preview = safeImage(data.preview, MAX_PREVIEW_CHARS);
        if (!preview) return;

        const { savePreview } = await import('../storage/db.js');
        if (await savePreview(data.entryId, preview)) {
            window.dispatchEvent(new CustomEvent('preview-ready', {
                detail: { entryId: data.entryId, preview }
            }));
        }
    }

    broadcast(message) {
        this.peers.forEach((peer) => {
            if (peer.open) {
                peer.send(message);
            }
        });
    }

    sendTo(peerId, message) {
        const peer = this.peers.get(peerId);
        if (peer && peer.open) {
            peer.send(message);
        }
    }

    hasPeer(peerId) {
        return this.peers.has(peerId);
    }

    getPeer(peerId) {
        return this.peers.get(peerId);
    }

    updatePeerCount() {
        const countEl = document.getElementById('peer-count');
        if (countEl) countEl.textContent = this.peers.size;
    }
}

export const peerManager = new PeerManager();
