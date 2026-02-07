// peerManager.js - WITH DEBUG LOGGING
import { logger } from '../../shared/logger.js';
import { gossipBinary } from './gossipBinary.js';
import { contentDHT } from './contentDHT.js';
import { presenceManager } from './presence.js';
import { getUsername } from '../../shared/username.js';

class PeerManager {
    constructor() {
        this.peers = new Map();
        this.peerIds = new Set();
    }

    addPeer(connection) {
        const shortId = connection.peer.split('-')[0];
        logger.info(`📞 Incoming connection from: ${connection.peer}`);

        connection.on('open', () => {
            logger.info(`✅ Incoming connection established: ${connection.peer}`);
            this.peers.set(connection.peer, connection);
            this.peerIds.add(shortId);
            this.updatePeerCount();
            
            // Send username handshake
            const myUsername = getUsername();
            console.log('🤝 SENDING handshake (incoming):', myUsername, 'to peer:', shortId);
            connection.send({
                type: 'handshake',
                username: myUsername
            });
            
            this.setupPeerListeners(connection);
        });

        connection.on('error', (err) => {
            logger.error('Connection error:', err);
        });

        connection.on('close', () => {
            logger.warn(`❌ Connection closed: ${connection.peer}`);
            
            // Mark user as offline
            const username = presenceManager.getUserByPeerId(connection.peer);
            if (username) {
                console.log('⚪ MARKING OFFLINE:', username, 'peerId:', connection.peer);
                presenceManager.setOffline(username);
            }
            
            this.peers.delete(connection.peer);
            this.peerIds.delete(shortId);
            this.updatePeerCount();
            logger.info(`Removed peer: ${connection.peer}`);
        });
    }

    setupPeerListeners(connection) {
        connection.on('data', (data) => {
            this.handlePeerData(data, connection);
        });
    }

    handlePeerData(data, connection) {
        logger.info(`🎯 Received data, type: ${data.type}`);

        switch (data.type) {
            case 'handshake':
                // Store username -> peerId mapping
                if (data.username) {
                    console.log('🤝 RECEIVED handshake from:', data.username, 'peerId:', connection.peer);
                    presenceManager.setOnline(data.username, connection.peer);
                } else {
                    console.warn('⚠️ Handshake missing username!', data);
                }
                break;
                
            case 'announce':
                if (data.contentId) {
                    const shortId = connection.peer.split('-')[0];
                    logger.info(`📥 Peer ${shortId} has: ${data.contentId}`);
                    contentDHT.addPeer(data.contentId, connection.peer);
                    
                    // Update last seen
                    const username = presenceManager.getUserByPeerId(connection.peer);
                    if (username) {
                        presenceManager.updateLastSeen(username);
                    }
                }
                break;

            case 'query':
                if (data.contentId) {
                    const hasContent = contentDHT.hasContent(data.contentId);
                    if (hasContent) {
                        const shortId = connection.peer.split('-')[0];
                        logger.info(`✅ I have ${data.contentId}, telling ${shortId}`);
                        connection.send({
                            type: 'announce',
                            contentId: data.contentId
                        });
                    }
                }
                break;

            case 'request_entry':
                this.handleEntryRequest(data.contentId, connection);
                break;

            case 'entry':
                this.handleEntryReceived(data.entry, connection);
                break;

            case 'entry_binary':
                this.handleBinaryEntryReceived(data, connection);
                break;
        }
    }

    async handleEntryRequest(contentId, connection) {
        const shortId = connection.peer.split('-')[0];
        logger.info(`📤 Peer ${shortId} requested: ${contentId}`);

        const { getAllEntries } = await import('../storage/db.js');
        const { extractSlug } = await import('../../shared/urlParser.js');

        const allEntries = await getAllEntries();
        const matchingEntry = allEntries.find(e => {
            const slug = extractSlug(e.sourceURL);
            return slug === contentId;
        });

        if (matchingEntry) {
            logger.info(`✅ Sending entry to ${shortId}`);
            connection.send({
                type: 'entry',
                entry: matchingEntry
            });
        }
    }

    async handleEntryReceived(entry, connection) {
        await gossipBinary.receiveEntry(entry, false);
    }

    async handleBinaryEntryReceived(data, connection) {
        const entry = gossipBinary.deserializeBinary(data.binary, data.preview);
        if (entry) {
            await gossipBinary.receiveEntry(entry, true);
        }
    }

    broadcast(message) {
        this.peers.forEach((peer, peerId) => {
            if (peer.open) {
                const shortId = peerId.split('-')[0];
                logger.info(`📤 Sending to ${peerId}: ${message.type}`);
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
        const count = this.peers.size;
        const countEl = document.getElementById('peer-count');
        if (countEl) countEl.textContent = count;
    }
}

export const peerManager = new PeerManager();
