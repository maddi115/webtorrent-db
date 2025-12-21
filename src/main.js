// main.js - Bootstrap browser node
import './style.css';
import { initDB } from './browser/storage/db.js';
import { initNetwork } from './browser/network/dht.js';
import { initUI } from './browser/ui/search.js';
import { initAddEntry } from './browser/ui/addEntry.js';
import { initConnect } from './browser/ui/connect.js';
import { logger } from './shared/logger.js';

(async () => {
    try {
        logger.info('🚀 Initializing WebTorrent P2P DB...');
        
        await initDB();
        logger.info('✅ Storage initialized');
        
        await initNetwork();
        logger.info('✅ Network initialized');
        
        initUI();
        initAddEntry();
        initConnect();
        logger.info('✅ UI ready');
        
        logger.info('🎉 Browser node ready!');
    } catch (error) {
        logger.error('❌ Failed to initialize:', error);
    }
})();
