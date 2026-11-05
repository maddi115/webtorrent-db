// main.js - Use correct initDB export
import './browser/network/dht.js';
import { initUI } from './browser/ui/search.js';
import { initAddEntry } from './browser/ui/addEntry.js';
import { initProfile } from './browser/ui/profile.js';
import { initRoomPicker } from './browser/ui/roomPicker.js';
import { initUsernameEditor } from './browser/ui/usernameEditor.js';
import { initSeedingMode } from './browser/ui/seedingMode.js';
import { renderShareStats } from './shared/shareStats.js';
import { initPeerTable } from './browser/ui/peerTable.js';
import { getStorageMode, initDB } from './browser/storage/db.js';
import { initWASM } from './browser/wasm/wasmLoader.js';
import { gossipBinary } from './browser/network/gossipBinary.js';
import { downloadManager } from './browser/downloads/downloadManager.js';
import { presenceManager } from './browser/network/presence.js';
import { logger } from './shared/logger.js';
import { getUsername } from './shared/username.js';

function showStorageWarning() {
    const warning = document.createElement('p');
    warning.id = 'storage-warning';
    warning.className = 'storage-warning';
    warning.textContent = 'This app is open in another tab, so changes here will not be saved.';
    document.querySelector('.search-container').prepend(warning);
}

async function init() {
    logger.info('🚀 Initializing WebTorrent P2P DB...');
    
    logger.info('🔧 Initializing WASM modules...');
    await initWASM();
    
    await gossipBinary.init();
    // Link sharing still works if the download library cannot load
    await downloadManager.init().catch((error) => {
        logger.warn('⚠️ Downloads are unavailable', error);
    });
    
    await initDB();
    logger.info('✅ Storage initialized');
    if (getStorageMode() === 'memory') {
        showStorageWarning();
    }
    
    // DHT auto-initializes on import
    logger.info('✅ Network initialized');
    
    // Initialize presence - mark self as online
    presenceManager.init();
    
    initUI();
    initAddEntry();
    initRoomPicker();
    initSeedingMode();
    renderShareStats();
    initProfile();
    initPeerTable();
    
    const username = getUsername();
    const usernameDisplay = document.getElementById('username-display');
    if (usernameDisplay) {
        usernameDisplay.textContent = username;
    }
    initUsernameEditor();
    
    logger.info('✅ UI ready');
    logger.info('🎉 Browser node ready with WebTorrent streaming!');
}

init();
