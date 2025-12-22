// search.js - Paginated peer list
import { searchEntries, getAllEntries, trackSearch, getStats } from '../storage/db.js';
import { contentDHT } from '../network/contentDHT.js';
import { peerManager } from '../network/peerManager.js';
import { connectToPeer } from '../network/dht.js';
import { extractSlug, isURL, normalizeSearchQuery } from '../../shared/urlParser.js';
import { logger } from '../../shared/logger.js';

let searchTimeout;
const paginationState = {}; // Track current page per URL
const PEERS_PER_PAGE = 13;

export function initUI() {
    const searchInput = document.getElementById('search-input');
    
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            performSearch(e.target.value.trim());
        }, 300);
    });
    
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
    
    await trackSearch(query);
    
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
    
    console.log('Search results:', results);
    
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
    
    await displayResults(results, resultsContainer);
}

async function displayResults(results, container) {
    if (!results.length) {
        container.innerHTML = '<p style="color: hsl(0 0% 64%); font-size: 14px; padding: 16px; text-align: center;">No results found</p>';
        return;
    }
    
    const grouped = groupByURL(results);
    
    const cards = await Promise.all(
        Object.entries(grouped).map(([url, entries]) => createURLMatchCard(url, entries))
    );
    
    container.innerHTML = cards.join('');
    
    // Add event listeners for all URLs
    Object.entries(grouped).forEach(([url, entries]) => {
        setupEventListeners(url, entries);
    });
}

function groupByURL(results) {
    const grouped = {};
    
    results.forEach(entry => {
        if (!entry.sourceURL) return;
        
        if (!grouped[entry.sourceURL]) {
            grouped[entry.sourceURL] = [];
        }
        grouped[entry.sourceURL].push(entry);
    });
    
    return grouped;
}

async function createURLMatchCard(url, entries) {
    if (!entries.length) return '';
    
    const firstEntry = entries[0];
    const slug = extractSlug(url);
    const peersOnline = contentDHT.findPeers(slug).length;
    const stats = await getStats(slug);
    
    let hostname = url;
    try {
        const urlObj = new URL(url);
        hostname = urlObj.hostname;
    } catch (e) {
        hostname = url.substring(0, 40) + '...';
    }
    
    const urlId = btoa(url).replace(/[^a-zA-Z0-9]/g, '');
    
    // Initialize pagination
    if (!paginationState[urlId]) {
        paginationState[urlId] = 1;
    }
    
    const totalPages = Math.ceil(entries.length / PEERS_PER_PAGE);
    const currentPage = paginationState[urlId];
    
    return `
        <div class="url-match-card">
            <div class="url-match-summary">
                <div class="url-preview">
                    ${firstEntry.preview ? 
                        `<img src="${firstEntry.preview}" alt="Preview">` : 
                        '<div class="no-preview-large">📄</div>'
                    }
                </div>
                <div class="url-info">
                    <h3 class="url-title">${firstEntry.title || 'Untitled'}</h3>
                    <a href="${url}" target="_blank" class="url-source">${hostname}</a>
                    <div class="url-stats">
                        <span class="stat">👥 ${peersOnline} peer${peersOnline !== 1 ? 's' : ''} online</span>
                        <span class="stat">📥 ${stats.downloads} download${stats.downloads !== 1 ? 's' : ''}</span>
                        <span class="stat">🔍 ${stats.searches} search${stats.searches !== 1 ? 'es' : ''}</span>
                    </div>
                </div>
            </div>
            
            <div class="peer-list-section">
                <div class="peer-list-header">
                    <h4 class="peer-list-title">Peers who have this: ${currentPage}/${totalPages}</h4>
                    ${totalPages > 1 ? `
                        <div class="pagination-controls">
                            <button class="page-btn" id="prev-${urlId}" ${currentPage === 1 ? 'disabled' : ''}>‹ Prev</button>
                            <button class="page-btn" id="next-${urlId}" ${currentPage === totalPages ? 'disabled' : ''}>Next ›</button>
                        </div>
                    ` : ''}
                </div>
                <div class="peer-list" id="peer-list-${urlId}">
                    ${renderPeerPage(urlId, entries, currentPage)}
                </div>
            </div>
        </div>
    `;
}

function renderPeerPage(urlId, entries, page) {
    const start = (page - 1) * PEERS_PER_PAGE;
    const end = start + PEERS_PER_PAGE;
    const pageEntries = entries.slice(start, end);
    
    return pageEntries.map((entry, index) => createPeerCard(urlId, entry, start + index)).join('');
}

function createPeerCard(urlId, entry, globalIndex) {
    return `
        <div class="peer-card">
            <span class="username">${entry.addedBy || 'Anonymous'}</span>
            <div class="peer-actions">
                <button id="copy-${urlId}-${globalIndex}">Copy Magnet</button>
                <a id="open-${urlId}-${globalIndex}" href="${entry.magnet}" target="_blank">Open</a>
            </div>
        </div>
    `;
}

function setupEventListeners(url, entries) {
    const urlId = btoa(url).replace(/[^a-zA-Z0-9]/g, '');
    
    // Peer action buttons
    entries.forEach((entry, index) => {
        const copyBtn = document.getElementById(`copy-${urlId}-${index}`);
        const openBtn = document.getElementById(`open-${urlId}-${index}`);
        
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(entry.magnet);
                showToast('📋 Copied');
            });
        }
        
        if (openBtn) {
            openBtn.addEventListener('click', () => {
                trackDownload(url);
            });
        }
    });
    
    // Pagination buttons
    const prevBtn = document.getElementById(`prev-${urlId}`);
    const nextBtn = document.getElementById(`next-${urlId}`);
    
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            paginationState[urlId]--;
            updatePeerList(url, entries, urlId);
        });
    }
    
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            paginationState[urlId]++;
            updatePeerList(url, entries, urlId);
        });
    }
}

function updatePeerList(url, entries, urlId) {
    const peerListContainer = document.getElementById(`peer-list-${urlId}`);
    const currentPage = paginationState[urlId];
    const totalPages = Math.ceil(entries.length / PEERS_PER_PAGE);
    
    // Update peer list
    peerListContainer.innerHTML = renderPeerPage(urlId, entries, currentPage);
    
    // Update pagination controls
    const prevBtn = document.getElementById(`prev-${urlId}`);
    const nextBtn = document.getElementById(`next-${urlId}`);
    const title = document.querySelector(`#peer-list-${urlId}`).parentElement.querySelector('.peer-list-title');
    
    if (title) {
        title.textContent = `Peers who have this: ${currentPage}/${totalPages}`;
    }
    
    if (prevBtn) {
        prevBtn.disabled = currentPage === 1;
    }
    
    if (nextBtn) {
        nextBtn.disabled = currentPage === totalPages;
    }
    
    // Re-setup event listeners for new page
    setupEventListeners(url, entries);
}

async function trackDownload(url) {
    const { trackDownload: track } = await import('../storage/db.js');
    await track(extractSlug(url));
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
