// peerManager.js - Track connected peers and handle their messages
import { logger } from '../../shared/logger.js';
import { networkSettings } from '../../shared/networkConfig.js';
import { gossip } from './gossip.js';
import { linkPeers } from './linkPeers.js';
import { presenceManager } from './presence.js';
import { getUsername } from '../../shared/username.js';
import { getAvatar } from '../../shared/profile.js';
import { toPublicEntry } from '../../shared/entryId.js';
import { extractSlug } from '../../shared/urlParser.js';
import { MAX_AVATAR_CHARS, MAX_PREVIEW_CHARS, safeImage, shortText } from '../../shared/safe.js';
import { renderPeerTable } from '../ui/peerTable.js';
import { receiveThumbnail, sendThumbnail } from '../ui/thumbnails.js';
import { handleFingerprints, handleLists, handleNeg, handleNegReply, startSync, SYNC_VERSION } from './smartSync.js';
import { receiveDeletes, receiveWipe, sendWipe } from './deletes.js';
import { forgetMember, receiveHere } from './roomPresence.js';
import { receiveChat, receiveHistory, sendHistory } from './chat.js';
import { handleChunk, handleChunkRequest, handleLinkGap, handleOffer } from './snapshotManager.js';

const MAX_SYNC_ITEMS = 5000;
const MAX_WHO_HAS = 50;
const REQUEST_RETRY_MS = 15000;
const HEARTBEAT_MS = 10000;

class PeerManager {
    constructor() {
        this.peers = new Map();
        this.peerIds = new Set();
        this.profiles = new Map();
        this.requested = new Set();
        this.onMembersChanged = () => {};
        this.onNetworkInfo = () => {};
        this.onStalePeer = () => {};
        // Ask who is still there. Background tabs slow their timers down,
        // but they still answer messages right away, so a reply is reliable.
        setInterval(() => this.checkAlive(), HEARTBEAT_MS);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.checkAlive();
        });
    }

    resetRequests() {
        this.requested.clear();
    }

    forwardEntry(entry, sourcePeerId) {
        this.forwardMessage({ type: 'entry', entry }, sourcePeerId);
    }

    // Passes a message on to the other cells this browser is linked to
    forwardMessage(message, sourcePeerId) {
        const sourceRoom = this.peers.get(sourcePeerId)?.room;
        this.peers.forEach((connection) => {
            if (connection.room !== sourceRoom) connection.send(message);
        });
    }

    async addPeer(connection) {
        const peerId = connection.peer;
        this.peers.set(peerId, connection);
        this.peerIds.add(peerId);
        this.profiles.set(peerId, {
            username: 'Connecting...',
            avatar: null,
            connections: 1,
            links: 0,
            connectedAt: Date.now(),
            lastSeen: Date.now(),
            ready: false,
            joinedAt: null,
            home: undefined,
            role: null
        });

        this.statusChanged();

        const { getEntryCount } = await import('../storage/db.js');
        connection.send({
            type: 'handshake',
            username: getUsername(),
            avatar: getAvatar(),
            ...connection.info(),
            links: await getEntryCount(),
            sync: SYNC_VERSION
        });
    }

    removePeer(peerId) {
        if (!this.peers.has(peerId) && !this.profiles.has(peerId)) return;
        const username = presenceManager.getUserByPeerId(peerId);
        if (username) {
            presenceManager.setOffline(username);
        }

        linkPeers.removePeer(peerId);
        forgetMember(peerId);
        this.peers.delete(peerId);
        this.peerIds.delete(peerId);
        this.profiles.delete(peerId);
        this.statusChanged();
        this.onMembersChanged();
    }

    async statusChanged() {
        this.updatePeerCount();
        renderPeerTable();
        await this.sendStatus();
    }

    checkAlive() {
        if (!this.peers.size) return;

        // A phone that went to sleep can leave a dead connection behind.
        // Someone who does not answer "are you there?" for a while is gone, so the old
        // connection is closed and they can connect again fresh when they come back.
        const now = Date.now();
        [...this.profiles.entries()].forEach(([peerId, profile]) => {
            if (this.peers.has(peerId) && profile.pingedAt && now - profile.pingedAt > networkSettings.staleMs) {
                logger.warn(`⏱️ ${profile.username} stopped answering, closing the old connection`);
                this.onStalePeer(peerId);
                this.removePeer(peerId);
            }
        });

        this.broadcast({ type: 'ping' });
        this.profiles.forEach((profile) => {
            if (!profile.pingedAt) profile.pingedAt = now;
        });
        this.sendStatus();
        setTimeout(() => renderPeerTable(), 1000);
    }

    async sendStatus() {
        if (!this.peers.size) return;
        const { getEntryCount } = await import('../storage/db.js');
        this.broadcast({
            type: 'peer_status',
            connections: this.peers.size,
            links: await getEntryCount()
        });
    }

    handlePeerData(data, connection) {
        const seen = this.profiles.get(connection.peer);
        if (seen) {
            seen.lastSeen = Date.now();
            seen.pingedAt = null;
        }
        if (!['peer_status', 'ping', 'pong', 'here'].includes(data.type)) logger.info(`🎯 Received data, type: ${data.type}`);

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

            case 'bye':
                this.removePeer(connection.peer);
                break;

            case 'ping':
                connection.send({ type: 'pong' });
                break;

            case 'here':
                receiveHere(data, connection);
                break;

            case 'delete':
                receiveDeletes(data.deletes, connection.peer);
                break;

            case 'wipe':
                receiveWipe(data.wipe, connection.peer);
                break;

            case 'chat':
                receiveChat(data.message, connection.peer);
                break;

            case 'chat_history':
                receiveHistory(data.messages);
                break;

            case 'pong':
                break;

            case 'cells':
                this.onNetworkInfo(data);
                break;

            case 'sync_fingerprints':
                handleFingerprints(data, connection);
                break;

            case 'sync_lists':
                handleLists(data, connection, (ids, peer) => this.requestMissing(ids, peer));
                break;

            case 'neg':
                handleNeg(data, connection);
                break;

            case 'neg_reply':
                handleNegReply(data, connection, (ids, peer) => this.requestMissing(ids, peer));
                break;

            case 'snapshot_offer':
                handleOffer(data, connection, (peer) => startSync(peer, true, this.syncVersionOf(peer)));
                break;

            case 'snapshot_get':
                handleChunkRequest(data, connection);
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
                    linkPeers.addPeer(data.contentId, connection.peer);

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
                gossip.receiveEntry(data.entry, connection.peer);
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
        profile.home = typeof data.home === 'string' ? data.home.slice(0, 200) : null;
        profile.role = data.role === 'helper' ? 'helper' : null;
        profile.sync = data.sync === SYNC_VERSION ? SYNC_VERSION : 1;
        profile.ring = Number.isSafeInteger(data.ring) ? data.ring : null;
        this.onNetworkInfo(data);
        this.handleProfile(data, connection);
        sendHistory(connection);
        sendWipe(connection);
        this.onMembersChanged();
        this.chooseSync(data, connection);
    }

    // Big gaps use a snapshot first. Small gaps go straight to smart sync.
    async chooseSync(data, connection) {
        const { getEntryCount } = await import('../storage/db.js');
        const theirLinks = Number.isSafeInteger(data.links) ? data.links : 0;
        const waiting = await handleLinkGap(
            connection,
            await getEntryCount(),
            theirLinks,
            (peer) => startSync(peer, true, this.syncVersionOf(peer))
        );

        if (!waiting) startSync(connection, false, this.syncVersionOf(connection));
    }

    handleChunk(data, metadata, peerId) {
        handleChunk(data, metadata, peerId);
    }

    handleProfile(data, connection) {
        const profile = this.profiles.get(connection.peer);
        if (!profile) return;

        const username = shortText(data.username, 100);
        if (username) {
            if (profile.username !== username) {
                presenceManager.setOffline(profile.username);
            }
            profile.username = username;
            profile.ready = true;
            presenceManager.setOnline(username, connection.peer);
        }
        profile.avatar = safeImage(data.avatar, MAX_AVATAR_CHARS);
        renderPeerTable();

        if (username && profile.avatar) {
            import('../storage/db.js').then(async ({ saveAvatar }) => {
                await saveAvatar(username, profile.avatar);
                const { refreshResults } = await import('../ui/search.js');
                refreshResults();
            });
        }
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

    syncVersionOf(connection) {
        return this.profiles.get(connection.peer)?.sync || 1;
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
            if (entry?.signature) {
                connection.send({ type: 'entry', entry: toPublicEntry(entry) });
            }
        }
    }

    async handleEntryRequest(contentId, connection) {
        const { getRoomEntries } = await import('../storage/db.js');
        const entries = await getRoomEntries();
        const match = entries.find((entry) => (
            entry.signature && extractSlug(entry.sourceURL) === contentId
        ));

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
