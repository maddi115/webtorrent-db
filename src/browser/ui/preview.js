// preview.js - Show a full image, fetching it from a peer when needed
import { getEntryById } from '../storage/db.js';
import { peerManager } from '../network/peerManager.js';
import { MAX_PREVIEW_CHARS, safeImage } from '../../shared/safe.js';

const REQUEST_TIMEOUT_MS = 8000;
let waitingFor = null;
let timeoutId = null;

function showOverlay(preview) {
    document.getElementById('preview-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'preview-overlay';
    overlay.className = 'preview-overlay';

    const image = document.createElement('img');
    image.src = preview;
    image.alt = 'Full preview';
    overlay.append(image);

    overlay.addEventListener('click', () => overlay.remove());
    document.body.append(overlay);
}

function showMessage(message) {
    const toast = document.createElement('div');
    toast.className = 'toast show';
    toast.textContent = message;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 3000);
}

export async function openPreview(entryId) {
    const entry = await getEntryById(entryId);
    if (!entry) return;

    const preview = safeImage(entry.preview, MAX_PREVIEW_CHARS);
    if (preview) {
        showOverlay(preview);
        return;
    }

    if (!entry.hasPreview) return;
    if (peerManager.peers.size === 0) {
        showMessage('Nobody is online to send the full image');
        return;
    }

    waitingFor = entryId;
    showMessage('Getting full image...');
    peerManager.broadcast({ type: 'request_preview', entryId });

    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
        if (waitingFor === entryId) {
            waitingFor = null;
            showMessage('Nobody online has the full image');
        }
    }, REQUEST_TIMEOUT_MS);
}

window.addEventListener('preview-ready', (event) => {
    if (event.detail.entryId === waitingFor) {
        waitingFor = null;
        clearTimeout(timeoutId);
        showOverlay(event.detail.preview);
    }
});
