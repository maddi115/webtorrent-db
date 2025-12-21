// search.js - Enhanced search with usernames in results
import { searchEntries, getAllEntries } from '../storage/db.js';
import { contentDHT } from '../network/contentDHT.js';
import { peerManager } from '../network/peerManager.js';
import { extractSlug, isURL, normalizeSearchQuery } from '../../shared/urlParser.js';
import { logger } from '../../shared/logger.js';

let currentResults = [];
let autoRefreshEnabled = true;

export function initUI() {
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');
    const resultsContainer = document.getElementById('results-container');
    
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
        displayResults(all, resultsContainer);
        return;
    }
    
    if (!silent) {
        resultsContainer.innerHTML = '<p>🔍 Searching local DB + peers...</p>';
    }
    
    let results = [];
    
    if (isURL(query)) {
        const slug = extractSlug(query);
        logger.info(`Searching for URL/slug: ${slug}`);
        
        const allEntries = await getAllEntries();
        results = allEntries.filter(e => 
            e.sourceURL.includes(query) || 
            extractSlug(e.sourceURL).includes(slug)
        );
        
        contentDHT.queryContent(slug);
        
    } else {
        results = await searchEntries(query);
        const normalized = normalizeSearchQuery(query);
        contentDHT.queryContent(normalized);
    }
    
    currentResults = results;
    displayResults(results, resultsContainer);
    
    if (!silent) {
        const peerCount = contentDHT.findPeers(
            isURL(query) ? extractSlug(query) : normalizeSearchQuery(query)
        ).length;
        
        if (peerCount > 0) {
            logger.info(`✅ Found ${results.length} local + ${peerCount} peers with this content`);
        }
    }
}

function displayResults(results, container) {
    if (!results.length) {
        container.innerHTML = '<p>No results found</p>';
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
                showToast('📋 Magnet link copied!');
            });
        }
    });
}

function createResultRow(entry) {
    const slug = extractSlug(entry.sourceURL);
    const peerCount = contentDHT.findPeers(slug).length;
    const index = currentResults.indexOf(entry);
    
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
                ${peerCount > 0 ? `<br><small>👥 ${peerCount} peer(s)</small>` : ''}
            </div>
            <div class="col-source">
                <a href="${entry.sourceURL}" target="_blank" rel="noopener">
                    ${new URL(entry.sourceURL).hostname}
                </a>
                <br><small>${new Date(entry.timestamp).toLocaleString()}</small>
            </div>
            <div class="col-user">
                <span class="username">${entry.addedBy || 'Anonymous'}</span>
            </div>
            <div class="col-magnet">
                <code>${entry.magnet.slice(0, 40)}...</code>
            </div>
            <div class="col-actions">
                <button id="copy-${index}" class="btn-copy">📋 Copy</button>
                <a href="${entry.magnet}" class="btn-open">🔗 Open</a>
            </div>
        </div>
    `;
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('show');
    }, 100);
    
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
