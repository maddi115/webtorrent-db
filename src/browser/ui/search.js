// search.js - With online/offline status
import { searchEntries, getAllEntries, trackSearch, getStats } from '../storage/db.js';
import { contentDHT } from '../network/contentDHT.js';
import { peerManager } from '../network/peerManager.js';
import { presenceManager } from '../network/presence.js';
import { connectToPeer } from '../network/dht.js';
import { extractSlug, isURL, normalizeSearchQuery } from '../../shared/urlParser.js';
import { downloadManager } from '../downloads/downloadManager.js';
import { logger } from '../../shared/logger.js';

let searchTimeout;
const paginationState = {};
const downloadStates = {};
const threadStates = {};
const threadPageStates = {};
const PEERS_PER_PAGE = 13;
const THREAD_ENTRIES_PER_PAGE = 8;

function createSafeId(str) {
    return str.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
}

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
    
    const urlId = createSafeId(url);
    
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
    
    const userGroups = {};
    pageEntries.forEach((entry, index) => {
        const username = entry.addedBy || 'Anonymous';
        if (!userGroups[username]) {
            userGroups[username] = [];
        }
        userGroups[username].push({ entry, globalIndex: start + index });
    });
    
    return Object.entries(userGroups).map(([username, items]) => {
        if (items.length > 1) {
            return createPeerThread(urlId, username, items);
        } else {
            return createPeerCard(urlId, items[0].entry, items[0].globalIndex);
        }
    }).join('');
}

function createPeerThread(urlId, username, items) {
    const threadId = `thread-${urlId}-${createSafeId(username)}`;
    const isExpanded = threadStates[threadId] || false;
    
    if (!threadPageStates[threadId]) {
        threadPageStates[threadId] = 1;
    }
    
    const currentThreadPage = threadPageStates[threadId];
    const totalThreadPages = Math.ceil(items.length / THREAD_ENTRIES_PER_PAGE);
    
    const threadStart = (currentThreadPage - 1) * THREAD_ENTRIES_PER_PAGE;
    const threadEnd = threadStart + THREAD_ENTRIES_PER_PAGE;
    const paginatedItems = items.slice(threadStart, threadEnd);
    
    const startNum = threadStart + 1;
    const endNum = Math.min(threadEnd, items.length);
    
    // Check online status
    const isOnline = presenceManager.isOnline(username);
    const lastSeen = presenceManager.getLastSeen(username);
    
    const threadEntries = paginatedItems.map(({ entry, globalIndex }) => {
        const hasMagnet = entry.magnet && entry.magnet.trim();
        const hasInstantIO = entry.instantIOLink && entry.instantIOLink.trim();
        
        const buttonId = `${urlId}-${globalIndex}`;
        const buttonState = downloadStates[buttonId] || 'idle';
        
        let buttons = '';
        
        if (hasMagnet) {
            let buttonText = 'Download';
            let buttonClass = 'download-btn';
            let disabled = '';
            
            if (buttonState === 'downloading') {
                buttonText = 'Downloading';
                disabled = 'disabled';
            } else if (buttonState === 'downloaded') {
                buttonText = 'Downloaded';
                buttonClass = 'downloaded-btn';
                disabled = 'disabled';
            }
            
            buttons += `
                <button id="copy-${urlId}-${globalIndex}">Copy Magnet</button>
                <button id="download-${urlId}-${globalIndex}" class="${buttonClass}" ${disabled}>${buttonText}</button>
            `;
        }
        
        if (hasInstantIO) {
            buttons += `
                <a href="${entry.instantIOLink}" target="_blank" class="instantio-btn">instant.io ↗</a>
            `;
        }
        
        return `
            <div class="thread-entry">
                <div class="peer-actions">
                    ${buttons || '<span style="color: hsl(0 0% 64%); font-size: 12px;">No link</span>'}
                </div>
            </div>
        `;
    }).join('');
    
    return `
        <div class="peer-thread ${isExpanded ? 'expanded' : 'collapsed'}">
            <div class="thread-header" id="${threadId}-header">
                <div class="thread-user-info">
                    <span class="username">${username} (${items.length} entries)</span>
                    ${isOnline ? 
                        '<span class="status online">🟢 Online</span>' : 
                        `<span class="status offline">⚪ Offline</span>`
                    }
                    ${!isOnline && lastSeen ? `<span class="last-seen">${lastSeen}</span>` : ''}
                </div>
                <button class="expand-btn" id="${threadId}-btn">
                    ${isExpanded ? 'Collapse ▲' : 'Expand ▼'}
                </button>
            </div>
            <div class="thread-entries" id="${threadId}-entries" style="${isExpanded ? '' : 'display: none;'}">
                ${totalThreadPages > 1 ? `
                    <div class="thread-pagination">
                        <span class="thread-page-info">Showing ${startNum}-${endNum} of ${items.length}</span>
                        <div class="pagination-controls">
                            <button class="page-btn" id="thread-prev-${threadId}" ${currentThreadPage === 1 ? 'disabled' : ''}>‹ Prev</button>
                            <button class="page-btn" id="thread-next-${threadId}" ${currentThreadPage === totalThreadPages ? 'disabled' : ''}>Next ›</button>
                        </div>
                    </div>
                ` : ''}
                ${threadEntries}
            </div>
        </div>
    `;
}

function createPeerCard(urlId, entry, globalIndex) {
    const hasMagnet = entry.magnet && entry.magnet.trim();
    const hasInstantIO = entry.instantIOLink && entry.instantIOLink.trim();
    const username = entry.addedBy || 'Anonymous';
    
    const buttonId = `${urlId}-${globalIndex}`;
    const buttonState = downloadStates[buttonId] || 'idle';
    
    // Check online status
    const isOnline = presenceManager.isOnline(username);
    const lastSeen = presenceManager.getLastSeen(username);
    
    let buttons = '';
    
    if (hasMagnet) {
        let buttonText = 'Download';
        let buttonClass = 'download-btn';
        let disabled = '';
        
        if (buttonState === 'downloading') {
            buttonText = 'Downloading';
            disabled = 'disabled';
        } else if (buttonState === 'downloaded') {
            buttonText = 'Downloaded';
            buttonClass = 'downloaded-btn';
            disabled = 'disabled';
        }
        
        buttons += `
            <button id="copy-${urlId}-${globalIndex}">Copy Magnet</button>
            <button id="download-${urlId}-${globalIndex}" class="${buttonClass}" ${disabled}>${buttonText}</button>
        `;
    }
    
    if (hasInstantIO) {
        buttons += `
            <a href="${entry.instantIOLink}" target="_blank" class="instantio-btn">instant.io ↗</a>
        `;
    }
    
    if (!hasMagnet && !hasInstantIO) {
        buttons = '<span style="color: hsl(0 0% 64%); font-size: 12px;">No link provided</span>';
    }
    
    return `
        <div class="peer-card">
            <div class="peer-card-header">
                <span class="username">${username}</span>
                ${isOnline ? 
                    '<span class="status online">🟢 Online</span>' : 
                    `<span class="status offline">⚪ Offline</span>`
                }
                ${!isOnline && lastSeen ? `<span class="last-seen">${lastSeen}</span>` : ''}
            </div>
            <div class="peer-actions">
                ${buttons}
            </div>
        </div>
    `;
}

function setupEventListeners(url, entries) {
    const urlId = createSafeId(url);
    
    entries.forEach((entry, index) => {
        if (entry.magnet && entry.magnet.trim()) {
            const copyBtn = document.getElementById(`copy-${urlId}-${index}`);
            const downloadBtn = document.getElementById(`download-${urlId}-${index}`);
            const buttonId = `${urlId}-${index}`;
            
            if (copyBtn) {
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(entry.magnet);
                    showToast('📋 Magnet link copied');
                });
            }
            
            if (downloadBtn) {
                downloadBtn.addEventListener('click', async () => {
                    downloadStates[buttonId] = 'downloading';
                    downloadBtn.textContent = 'Downloading';
                    downloadBtn.disabled = true;
                    downloadBtn.classList.remove('download-btn');
                    
                    downloadManager.startDownload(
                        entry.magnet, 
                        entry.sourceURL, 
                        entry.title,
                        () => {
                            downloadStates[buttonId] = 'downloaded';
                            downloadBtn.textContent = 'Downloaded';
                            downloadBtn.classList.add('downloaded-btn');
                            
                            import('../storage/db.js').then(({ trackDownload }) => {
                                trackDownload(extractSlug(url));
                            });
                        }
                    );
                });
            }
        }
    });
    
    const userGroups = {};
    entries.forEach(entry => {
        const username = entry.addedBy || 'Anonymous';
        if (!userGroups[username]) {
            userGroups[username] = [];
        }
        userGroups[username].push(entry);
    });
    
    Object.entries(userGroups).forEach(([username, userEntries]) => {
        if (userEntries.length > 1) {
            const threadId = `thread-${urlId}-${createSafeId(username)}`;
            const expandBtn = document.getElementById(`${threadId}-btn`);
            const entriesDiv = document.getElementById(`${threadId}-entries`);
            
            if (expandBtn && entriesDiv) {
                expandBtn.addEventListener('click', () => {
                    const isExpanded = threadStates[threadId] || false;
                    threadStates[threadId] = !isExpanded;
                    
                    if (threadStates[threadId]) {
                        entriesDiv.style.display = 'block';
                        expandBtn.textContent = 'Collapse ▲';
                    } else {
                        entriesDiv.style.display = 'none';
                        expandBtn.textContent = 'Expand ▼';
                    }
                });
            }
            
            const threadPrevBtn = document.getElementById(`thread-prev-${threadId}`);
            const threadNextBtn = document.getElementById(`thread-next-${threadId}`);
            
            if (threadPrevBtn) {
                threadPrevBtn.addEventListener('click', () => {
                    threadPageStates[threadId]--;
                    updatePeerList(url, entries, urlId);
                });
            }
            
            if (threadNextBtn) {
                threadNextBtn.addEventListener('click', () => {
                    threadPageStates[threadId]++;
                    updatePeerList(url, entries, urlId);
                });
            }
        }
    });
    
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
    
    peerListContainer.innerHTML = renderPeerPage(urlId, entries, currentPage);
    
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
    
    setupEventListeners(url, entries);
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
