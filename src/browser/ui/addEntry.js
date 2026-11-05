// addEntry.js - Either, both, or at least one
import { addEntry } from '../storage/db.js';
import { gossipBinary } from '../network/gossipBinary.js';
import { contentDHT } from '../network/contentDHT.js';
import { extractSlug, extractTitle } from '../../shared/urlParser.js';
import { getUsername } from '../../shared/username.js';
import { getTopic } from '../../shared/rooms.js';
import { getEntryId } from '../../shared/entryId.js';
import { makeThumbHash, resizeImage } from '../../shared/images.js';
import { cleanURL, normalizeMagnet } from '../../shared/links.js';

export function initAddEntry() {
    const addEntryBtn = document.getElementById('add-entry-btn');
    const modal = document.getElementById('add-modal');
    const closeBtn = modal.querySelector('.modal-close');
    const addBtn = document.getElementById('add-btn');
    
    addEntryBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
    });
    
    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
    
    addBtn.addEventListener('click', async () => {
        const customTitle = document.getElementById('entry-title').value.trim();
        const sourceURL = cleanURL(document.getElementById('source-url').value.trim());
        const magnetLink = normalizeMagnet(document.getElementById('magnet-link').value.trim());
        const instantIOLink = document.getElementById('instantio-link').value.trim();
        const previewFile = document.getElementById('preview-upload').files[0];
        
        if (!sourceURL) {
            alert('Please provide a source URL');
            return;
        }
        
        // Validate: at least one must be filled
        if (!magnetLink && !instantIOLink) {
            alert('Please provide at least one: magnet link or instant.io link');
            return;
        }
        
        const title = customTitle || extractTitle(sourceURL);
        const username = getUsername();
        
        const entry = {
            sourceURL,
            magnet: magnetLink || null,
            instantIOLink: instantIOLink || null,
            timestamp: Date.now(),
            preview: previewFile ? await resizeImage(previewFile, 1600, 0.85) : null,
            thumb: previewFile ? await resizeImage(previewFile, 160, 0.7) : null,
            thumbHash: previewFile ? await makeThumbHash(previewFile) : null,
            hasPreview: Boolean(previewFile),
            title: title,
            addedBy: username,
            room: getTopic()
        };
        entry.entryId = await getEntryId(entry);
        
        await addEntry(entry);
        
        const slug = extractSlug(sourceURL);
        contentDHT.announceContent(slug);
        gossipBinary.propagateEntry(entry);
        
        showToast(`✅ Added: ${title}`);
        
        document.getElementById('entry-title').value = '';
        document.getElementById('source-url').value = '';
        document.getElementById('magnet-link').value = '';
        document.getElementById('instantio-link').value = '';
        document.getElementById('preview-upload').value = '';
        modal.style.display = 'none';
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
