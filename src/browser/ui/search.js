// search.js - Search local DB + peers, display results
import { searchEntries } from '../storage/db.js';

export function initUI() {
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');
    const resultsContainer = document.getElementById('results-container');
    
    searchBtn.addEventListener('click', async () => {
        const query = searchInput.value.trim();
        if (!query) return;
        
        resultsContainer.innerHTML = '<p>Searching...</p>';
        
        // Search local DB
        const results = await searchEntries(query);
        
        // TODO: Also query peers via DHT
        
        displayResults(results, resultsContainer);
    });
}

function displayResults(results, container) {
    if (!results.length) {
        container.innerHTML = '<p>No results found</p>';
        return;
    }
    
    container.innerHTML = results.map(entry => `
        <div class="result-card">
            <h3>${entry.title || 'Untitled'}</h3>
            <p><a href="${entry.sourceURL}" target="_blank">${entry.sourceURL}</a></p>
            <p><strong>Magnet:</strong> <code>${entry.magnet.slice(0, 50)}...</code></p>
            ${entry.preview ? `<img src="${entry.preview}" alt="Preview" loading="lazy">` : ''}
            <p><small>Added: ${new Date(entry.timestamp).toLocaleString()}</small></p>
        </div>
    `).join('');
}
