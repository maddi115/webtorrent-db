// search.js - With Airtable colored tags
import { searchEntries, getAllEntries } from '../storage/db.js';
import { contentDHT } from '../network/contentDHT.js';
import { peerManager } from '../network/peerManager.js';
import { connectToPeer } from '../network/dht.js';
import { extractSlug, isURL, normalizeSearchQuery } from '../../shared/urlParser.js';
import { logger } from '../../shared/logger.js';

let currentResults = [];
let autoRefreshEnabled = true;

export function initUI() {
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');
    
    searchBtn.addEventListener('click', async () => {
        await performSearch(searchInput.value.trim());
    });
    
    searchInput.addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
            await performSearch(searchInput.value.trim());
        }
    });
    
    setInterval(() => {
        if (autoRefreshEnabled && searchInput.value.trim()) {
            performSearch(searchInput.value.trim(), true);
        }
    }, 3000);
}

async function performSearch(query, silent = false) {
    const resultsContainer = document.getElementById('results-container');
    
    if (!query) {
        const all = await getAllEntries();
        const valid = all.filter(e => e.sourceURL && e.sourceURL.trim());
        displayResults(valid, resultsContainer);
        return;
    }
    
    if (!silent) {
        resultsContainer.innerHTML = '<p>🔍 Searching local DB + discovering peers...</p>';
    }
    
    let results = [];
    let contentId;
    
    if (isURL(query)) {
        const slug = extractSlug(query);
        contentId = slug;
        logger.info(`Searching for URL/slug: ${slug}`);
        
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
            logger.info(`📡 Found ${peersWithContent.length} peers with this content`);
            
            const connectedPeersWithContent = peersWithContent.filter(peerId => 
                peerManager.hasPeer(peerId)
            );
            
            if (connectedPeersWithContent.length > 0) {
                logger.info(`📥 Requesting entry from ${connectedPeersWithContent.length} connected peer(s)`);
                
                connectedPeersWithContent.forEach(peerId => {
                    const peer = peerManager.getPeer(peerId);
                    if (peer && peer.connected) {
                        peer.send({
                            type: 'request_entry',
                            contentId: contentId
                        });
                    }
                });
                
                if (!silent) {
                    showToast(`📥 Requesting data from ${connectedPeersWithContent.length} peer(s)...`);
                }
            }
            
            const disconnectedPeers = peersWithContent.filter(peerId => 
                !peerManager.hasPeer(peerId)
            );
            
            if (disconnectedPeers.length > 0) {
                logger.info(`🔗 Connecting to ${disconnectedPeers.length} new peer(s)`);
                
                disconnectedPeers.forEach(peerId => {
                    connectToPeer(peerId);
                });
            }
        }
    }, 1000);
    
    currentResults = results;
    displayResults(results, resultsContainer);
}

function displayResults(results, container) {
    if (!results.length) {
        container.innerHTML = '<p>No results found locally. Searching peers...</p>';
        return;
    }
    
    container.innerHTML = `
        <div class="results-table">
            <div class="table-header">
                <div class="col-preview">Preview</div>
                <div class="col-title">Title</div>
                <div class="col-source">Source</div>
                <div class="col-user">Added By</div>
                <div class="col-magnet">Magnet</div>
                <div class="col-actions">Actions</div>
            </div>
            ${results.map(entry => createResultRow(entry)).join('')}
        </div>
    `;
    
    results.forEach((entry, index) => {
        const copyBtn = document.getElementById(`copy-${index}`);
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(entry.magnet);
                showToast('📋 Copied');
            });
        }
    });
}

function createResultRow(entry) {
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
    
    // Pick tag color based on peer count
    let peerTagClass = 'peer-tag';
    if (peerCount >= 5) peerTagClass += ' tag-green';
    else if (peerCount >= 3) peerTagClass += ' tag-teal';
    else if (peerCount >= 1) peerTagClass += '';
    
    return `
        <div class="table-row">
            <div class="col-preview">
                ${entry.preview ? 
                    `<img src="${entry.preview}" alt="Preview" loading="lazy">` : 
                    '<div class="no-preview">📄</div>'
                }
            </div>
            <div class="col-title">
                <strong>${entry.title || 'Untitled'}</strong>
                ${peerCount > 0 ? `<small><span class="${peerTagClass}">👥 ${peerCount} peer${peerCount > 1 ? 's' : ''}</span></small>` : ''}
            </div>
            <div class="col-source">
                <a href="${entry.sourceURL}" target="_blank" rel="noopener">
                    ${hostname}
                </a>
                <small>${new Date(entry.timestamp).toLocaleString()}</small>
            </div>
            <div class="col-user">
                <span class="username">${entry.addedBy || 'Anonymous'}</span>
            </div>
            <div class="col-magnet">
                <code>${entry.magnet.slice(0, 40)}...</code>
            </div>
            <div class="col-actions">
                <button id="copy-${index}" class="btn-copy">Copy</button>
                <a href="${entry.magnet}" class="btn-open">Open</a>
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
        performSearch(searchInput.value.trim(), true);
    }
}
