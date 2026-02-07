// main.js - Use correct initDB export
import './browser/network/dht.js';
import { initUI } from './browser/ui/search.js';
import { initAddEntry } from './browser/ui/addEntry.js';
import { initDB } from './browser/storage/db.js';
import { initWASM } from './browser/wasm/wasmLoader.js';
import { gossipBinary } from './browser/network/gossipBinary.js';
import { downloadManager } from './browser/downloads/downloadManager.js';
import { presenceManager } from './browser/network/presence.js';
import { logger } from './shared/logger.js';
import { getUsername } from './shared/username.js';

async function init() {
    logger.info('🚀 Initializing WebTorrent P2P DB...');
    
    logger.info('🔧 Initializing WASM modules...');
    await initWASM();
    
    await gossipBinary.init();
    await downloadManager.init();
    
    await initDB();
    logger.info('✅ Storage initialized');
    
    // DHT auto-initializes on import
    logger.info('✅ Network initialized');
    
    // Initialize presence - mark self as online
    presenceManager.init();
    
    initUI();
    initAddEntry();
    
    const username = getUsername();
    const usernameDisplay = document.getElementById('username-display');
    if (usernameDisplay) {
        usernameDisplay.textContent = username;
    }
    
    logger.info('✅ UI ready');
    logger.info('🎉 Browser node ready with WebTorrent streaming!');
}

init();
