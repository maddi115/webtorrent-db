// transport.js - WebRTC peer connections via PeerJS (FIXED)
import Peer from 'peerjs';
import { logger } from '../../shared/logger.js';

export class PeerConnection {
    constructor(peerId, onData) {
        this.peerId = peerId;
        this.connected = false;
        this.onDataCallback = onData;
        this.conn = null;
    }
    
    connect(peer, remotePeerId) {
        logger.info(`Connecting to peer: ${remotePeerId}`);
        this.conn = peer.connect(remotePeerId, { reliable: true });
        this.setupHandlers();
    }
    
    setConnection(conn) {
        this.conn = conn;
        
        // Check if already open
        if (conn.open) {
            this.connected = true;
            logger.info(`✅✅ Connection already open: ${this.peerId}`);
        }
        
        this.setupHandlers();
    }
    
    setupHandlers() {
        if (!this.conn) return;
        
        this.conn.on('open', () => {
            this.connected = true;
            logger.info(`✅ Connection opened: ${this.peerId}`);
        });
        
        this.conn.on('data', (data) => {
            try {
                if (this.onDataCallback) {
                    this.onDataCallback(data);
                }
            } catch (error) {
                logger.error('Failed to parse peer data:', error);
            }
        });
        
        this.conn.on('close', () => {
            this.connected = false;
            logger.warn(`❌ Connection closed: ${this.peerId}`);
        });
        
        this.conn.on('error', (err) => {
            logger.error(`Peer error (${this.peerId}):`, err);
        });
    }
    
    send(message) {
        if (this.connected && this.conn) {
            logger.info(`📤 Sending to ${this.peerId}:`, message.type);
            this.conn.send(message);
        } else {
            logger.warn(`Cannot send to ${this.peerId} - not connected`);
        }
    }
    
    destroy() {
        if (this.conn) {
            this.conn.close();
        }
    }
}
