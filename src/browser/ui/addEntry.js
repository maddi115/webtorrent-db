// addEntry.js - Either, both, or at least one
import { saveOwnEntry } from '../storage/db.js';
import { gossip } from '../network/gossip.js';
import { linkPeers } from '../network/linkPeers.js';
import { extractSlug, extractTitle } from '../../shared/urlParser.js';
import { getUsername } from '../../shared/username.js';
import { getTopic } from '../../shared/rooms.js';
import { signEntry } from '../../shared/signing.js';
import { addWork } from '../../shared/work.js';
import { savePost } from '../network/nostrStore.js';
import { makeThumbHash, resizeImage } from '../../shared/images.js';
import { cleanURL, getDownloadMagnet, normalizeMagnet } from '../../shared/links.js';

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
        const magnetInput = document.getElementById('magnet-link').value.trim();
        let instantIOLink = document.getElementById('instantio-link').value.trim();
        if (!instantIOLink && magnetInput.startsWith('https://instant.io/')) {
            instantIOLink = magnetInput;
        }
        const magnetLink = normalizeMagnet(
            getDownloadMagnet(magnetInput) || getDownloadMagnet(instantIOLink) || ''
        );

        if (magnetInput && !magnetLink && !instantIOLink) {
            showToast('Magnet links must start with magnet:?');
            return;
        }

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
        await signEntry(entry);

        // About a second of work, so spam is expensive. The button shows it is busy.
        const label = addBtn.textContent;
        addBtn.disabled = true;
        addBtn.textContent = '⏳ Posting...';
        try {
            await addWork(entry);
        } finally {
            addBtn.disabled = false;
            addBtn.textContent = label;
        }

        const status = await saveOwnEntry(entry);
        if (status === 'too-fast') {
            showToast('Slow down: you can post 10 links a minute');
            return;
        }
        if (status === 'name-taken') {
            showToast('Someone else already uses this name. Pick a new one.');
            return;
        }
        
        const slug = extractSlug(sourceURL);
        linkPeers.announceContent(slug);
        gossip.propagateEntry(entry);
        savePost(entry);
        
        showToast(`✅ Added: ${title}`);
        window.dispatchEvent(new CustomEvent('posts-changed'));
        
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
