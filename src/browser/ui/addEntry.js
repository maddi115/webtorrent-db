// addEntry.js - Add link + optional preview to DB
import { addEntry } from '../storage/db.js';
import { gossip } from '../network/gossip.js';

export function initAddEntry() {
    const addBtn = document.getElementById('add-btn');
    
    addBtn.addEventListener('click', async () => {
        const sourceURL = document.getElementById('source-url').value;
        const magnetLink = document.getElementById('magnet-link').value;
        const previewFile = document.getElementById('preview-upload').files[0];
        
        if (!sourceURL || !magnetLink) {
            alert('Please provide both URL and magnet link');
            return;
        }
        
        const entry = {
            sourceURL,
            magnet: magnetLink,
            timestamp: Date.now(),
            preview: previewFile ? await uploadPreview(previewFile) : null,
            title: extractTitle(sourceURL)
        };
        
        // Store in IndexedDB
        await addEntry(entry);
        
        // Propagate via gossip
        gossip.propagateEntry(entry);
        
        alert('Entry added successfully!');
        
        // Clear form
        document.getElementById('source-url').value = '';
        document.getElementById('magnet-link').value = '';
        document.getElementById('preview-upload').value = '';
    });
}

async function uploadPreview(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
    });
}

function extractTitle(url) {
    try {
        const path = new URL(url).pathname;
        const parts = path.split('/').filter(Boolean);
        return parts[parts.length - 1].replace(/-/g, ' ') || 'Untitled';
    } catch {
        return 'Untitled';
    }
}
