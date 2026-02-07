// presence.js - Track online/offline status (including self)
import { logger } from '../../shared/logger.js';
import { getUsername } from '../../shared/username.js';

class PresenceManager {
    constructor() {
        this.userPresence = new Map();
        this.myUsername = null;
    }
    
    init() {
        // Mark self as online
        this.myUsername = getUsername();
        this.setOnline(this.myUsername, 'self');
        logger.info(`👤 Marked self as ONLINE: ${this.myUsername}`);
    }
    
    setOnline(username, peerId) {
        logger.info(`👤 ${username} is now ONLINE (${peerId})`);
        this.userPresence.set(username, {
            peerId,
            online: true,
            lastSeen: Date.now()
        });
        this.notifyPresenceChange();
    }
    
    setOffline(username) {
        // Never mark self as offline
        if (username === this.myUsername) {
            return;
        }
        
        const presence = this.userPresence.get(username);
        if (presence) {
            logger.info(`👤 ${username} is now OFFLINE`);
            presence.online = false;
            presence.lastSeen = Date.now();
            this.userPresence.set(username, presence);
            this.notifyPresenceChange();
        }
    }
    
    updateLastSeen(username) {
        const presence = this.userPresence.get(username);
        if (presence && presence.online) {
            presence.lastSeen = Date.now();
            this.userPresence.set(username, presence);
        }
    }
    
    isOnline(username) {
        // Self is always online
        if (username === this.myUsername) {
            return true;
        }
        
        const presence = this.userPresence.get(username);
        return presence ? presence.online : false;
    }
    
    getLastSeen(username) {
        // Self is always "Online now"
        if (username === this.myUsername) {
            return 'Online now';
        }
        
        const presence = this.userPresence.get(username);
        if (!presence) return null;
        
        const seconds = Math.floor((Date.now() - presence.lastSeen) / 1000);
        
        if (presence.online) return 'Online now';
        if (seconds < 60) return 'Just now';
        if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
        }
        if (seconds < 86400) {
            const hours = Math.floor(seconds / 3600);
            return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
        }
        const days = Math.floor(seconds / 86400);
        return `${days} day${days !== 1 ? 's' : ''} ago`;
    }
    
    getUserByPeerId(peerId) {
        for (const [username, presence] of this.userPresence.entries()) {
            if (presence.peerId === peerId) {
                return username;
            }
        }
        return null;
    }
    
    notifyPresenceChange() {
        // Refresh UI
        import('../ui/search.js').then(({ refreshResults }) => {
            refreshResults();
        });
    }
}

export const presenceManager = new PresenceManager();
