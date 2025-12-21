// main.js - Use binary gossip
import './style.css';
import { initDB, reannounceAllEntries } from './browser/storage/db.js';
import { initNetwork } from './browser/network/dht.js';
import { initUI } from './browser/ui/search.js';
import { initAddEntry } from './browser/ui/addEntry.js';
import { initUsernameUI } from './browser/ui/username.js';
import { initWASM } from './browser/wasm/wasmLoader.js';
import { gossipBinary } from './browser/network/gossipBinary.js';
import { logger } from './shared/logger.js';

initUsernameUI();

const loadingIndicator = document.createElement('div');
loadingIndicator.id = 'loading-indicator';
loadingIndicator.innerHTML = `
    <div class="loading-content">
        <div class="spinner"></div>
        <p>🔄 Loading WASM modules...</p>
    </div>
`;
document.body.appendChild(loadingIndicator);

(async () => {
    try {
        logger.info('🚀 Initializing WebTorrent P2P DB...');
        
        await initWASM();
        await gossipBinary.init();
        
        loadingIndicator.querySelector('p').textContent = '🔄 Connecting to network...';
        
        await initDB();
        logger.info('✅ Storage initialized');
        
        await initNetwork();
        logger.info('✅ Network initialized');
        
        setTimeout(async () => {
            await reannounceAllEntries();
        }, 2000);
        
        initUI();
        initAddEntry();
        logger.info('✅ UI ready');
        
        loadingIndicator.classList.add('fade-out');
        setTimeout(() => loadingIndicator.remove(), 500);
        
        logger.info('🎉 Browser node ready with binary serialization!');
    } catch (error) {
        logger.error('❌ Failed to initialize:', error);
        loadingIndicator.innerHTML = `
            <div class="loading-content">
                <p>❌ Failed to connect</p>
            </div>
        `;
    }
})();
