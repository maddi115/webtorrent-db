// main.js - Load UI immediately with loading indicator
import './style.css';
import { initDB } from './browser/storage/db.js';
import { initNetwork } from './browser/network/dht.js';
import { initUI } from './browser/ui/search.js';
import { initAddEntry } from './browser/ui/addEntry.js';
import { initUsernameUI } from './browser/ui/username.js';
import { logger } from './shared/logger.js';

// Load username UI immediately
initUsernameUI();

// Show loading indicator
const loadingIndicator = document.createElement('div');
loadingIndicator.id = 'loading-indicator';
loadingIndicator.innerHTML = `
    <div class="loading-content">
        <div class="spinner"></div>
        <p>🔄 Connecting to network...</p>
    </div>
`;
document.body.appendChild(loadingIndicator);

// Then do async initialization
(async () => {
    try {
        logger.info('🚀 Initializing WebTorrent P2P DB...');
        
        await initDB();
        logger.info('✅ Storage initialized');
        
        await initNetwork();
        logger.info('✅ Network initialized');
        
        initUI();
        initAddEntry();
        logger.info('✅ UI ready');
        
        // Remove loading indicator
        loadingIndicator.classList.add('fade-out');
        setTimeout(() => loadingIndicator.remove(), 500);
        
        logger.info('🎉 Browser node ready!');
    } catch (error) {
        logger.error('❌ Failed to initialize:', error);
        loadingIndicator.innerHTML = `
            <div class="loading-content">
                <p>❌ Failed to connect</p>
                <p style="font-size: 0.9rem; color: #888;">Check console for details</p>
            </div>
        `;
    }
})();
