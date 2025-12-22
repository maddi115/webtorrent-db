// addEntry.js - Modal-based add entry
import { addEntry } from '../storage/db.js';
import { gossipBinary } from '../network/gossipBinary.js';
import { contentDHT } from '../network/contentDHT.js';
import { extractSlug, extractTitle } from '../../shared/urlParser.js';
import { getUsername } from '../../shared/username.js';

export function initAddEntry() {
    const addEntryBtn = document.getElementById('add-entry-btn');
    const modal = document.getElementById('add-modal');
    const closeBtn = modal.querySelector('.modal-close');
    const addBtn = document.getElementById('add-btn');
    
    // Show modal
    addEntryBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
    });
    
    // Close modal
    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    // Close on outside click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
    
    // Add entry
    addBtn.addEventListener('click', async () => {
        const sourceURL = document.getElementById('source-url').value;
        const magnetLink = document.getElementById('magnet-link').value;
        const previewFile = document.getElementById('preview-upload').files[0];
        
        if (!sourceURL || !magnetLink) {
            alert('Please provide both URL and magnet link');
            return;
        }
        
        const title = extractTitle(sourceURL);
        const username = getUsername();
        
        const entry = {
            sourceURL,
            magnet: magnetLink,
            timestamp: Date.now(),
            preview: previewFile ? await uploadPreview(previewFile) : null,
            title: title,
            addedBy: username
        };
        
        await addEntry(entry);
        
        const slug = extractSlug(sourceURL);
        contentDHT.announceContent(slug);
        gossipBinary.propagateEntry(entry);
        
        showToast(`✅ Added: ${title}`);
        
        // Clear and close
        document.getElementById('source-url').value = '';
        document.getElementById('magnet-link').value = '';
        document.getElementById('preview-upload').value = '';
        modal.style.display = 'none';
    });
}

async function uploadPreview(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
    });
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
