// search.js - Card-style results with auto-search
import { searchEntries, getAllEntries } from '../storage/db.js';
import { contentDHT } from '../network/contentDHT.js';
import { peerManager } from '../network/peerManager.js';
import { connectToPeer } from '../network/dht.js';
import { extractSlug, isURL, normalizeSearchQuery } from '../../shared/urlParser.js';
import { logger } from '../../shared/logger.js';

let currentResults = [];
let searchTimeout;

export function initUI() {
    const searchInput = document.getElementById('search-input');
    
    // Auto-search on input with debounce
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            performSearch(e.target.value.trim());
        }, 300);
    });
    
    // Instant search on paste
    searchInput.addEventListener('paste', (e) => {
        setTimeout(() => {
            performSearch(searchInput.value.trim());
        }, 10);
    });
}

async function performSearch(query) {
    const resultsContainer = document.getElementById('results-container');
    
    if (!query) {
        resultsContainer.innerHTML = '';
        return;
    }
    
    let results = [];
    let contentId;
    
    if (isURL(query)) {
        const slug = extractSlug(query);
        contentId = slug;
        
        const allEntries = await getAllEntries();
        results = allEntries.filter(e => 
            e.sourceURL && (
                e.sourceURL.includes(query) || 
                extractSlug(e.sourceURL).includes(slug)
            )
        );
    } else {
        contentId = normalizeSearchQuery(query);
        results = await searchEntries(query);
    }
    
    contentDHT.queryContent(contentId);
    
    setTimeout(() => {
        const peersWithContent = contentDHT.findPeers(contentId);
        
        if (peersWithContent.length > 0) {
            const connectedPeersWithContent = peersWithContent.filter(peerId => 
                peerManager.hasPeer(peerId)
            );
            
            if (connectedPeersWithContent.length > 0) {
                connectedPeersWithContent.forEach(peerId => {
                    const peer = peerManager.getPeer(peerId);
                    if (peer && peer.connected) {
                        peer.send({
                            type: 'request_entry',
                            contentId: contentId
                        });
                    }
                });
            }
        }
    }, 1000);
    
    currentResults = results;
    displayResults(results, resultsContainer);
}

function displayResults(results, container) {
    if (!results.length) {
        container.innerHTML = '<p style="color: hsl(0 0% 64%); font-size: 14px; padding: 16px; text-align: center;">No results found</p>';
        return;
    }
    
    container.innerHTML = results.map(entry => createResultCard(entry)).join('');
    
    // Add event listeners
    results.forEach((entry, index) => {
        const copyBtn = document.getElementById(`copy-${index}`);
        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(entry.magnet);
                showToast('📋 Copied');
            });
        }
    });
}

function createResultCard(entry) {
    if (!entry.sourceURL || !entry.sourceURL.trim()) {
        return '';
    }
    
    const slug = extractSlug(entry.sourceURL);
    const peerCount = contentDHT.findPeers(slug).length;
    const index = currentResults.indexOf(entry);
    
    let hostname = entry.sourceURL;
    try {
        const url = new URL(entry.sourceURL);
        hostname = url.hostname;
    } catch (e) {
        hostname = entry.sourceURL.substring(0, 30) + '...';
    }
    
    let peerTagClass = 'peer-tag';
    if (peerCount >= 5) peerTagClass += ' tag-green';
    else if (peerCount >= 3) peerTagClass += ' tag-teal';
    
    return `
        <div class="result-card">
            <div class="result-header">
                <div class="result-preview">
                    ${entry.preview ? 
                        `<img src="${entry.preview}" alt="Preview" loading="lazy">` : 
                        '<div class="no-preview">📄</div>'
                    }
                </div>
                <div class="result-info">
                    <div class="result-title">${entry.title || 'Untitled'}</div>
                    <div class="result-meta">
                        <a href="${entry.sourceURL}" target="_blank" rel="noopener" class="result-source">${hostname}</a>
                        <span class="username">${entry.addedBy || 'Anonymous'}</span>
                        ${peerCount > 0 ? `<span class="${peerTagClass}">👥 ${peerCount}</span>` : ''}
                    </div>
                </div>
            </div>
            <div class="result-actions">
                <button id="copy-${index}">Copy Magnet</button>
                <a href="${entry.magnet}">Open</a>
            </div>
        </div>
    `;
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

export function refreshResults() {
    const searchInput = document.getElementById('search-input');
    if (searchInput && searchInput.value.trim()) {
        performSearch(searchInput.value.trim());
    }
}
