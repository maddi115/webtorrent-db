// thumbnails.js - Ask peers for thumbnails only when they appear on screen
import { getEntryById, saveThumb } from '../storage/db.js';
import { peerManager } from '../network/peerManager.js';
import { MAX_THUMB_CHARS, safeImage } from '../../shared/safe.js';

const RETRY_MS = 30000;
const lastRequest = new Map();

const observer = new IntersectionObserver((items) => {
    items.forEach((item) => {
        if (item.isIntersecting) {
            observer.unobserve(item.target);
            requestThumbnail(item.target.dataset.entryId);
        }
    });
});

function requestThumbnail(entryId) {
    if (Date.now() - (lastRequest.get(entryId) || 0) < RETRY_MS) return;

    lastRequest.set(entryId, Date.now());
    peerManager.broadcast({ type: 'request_thumb', entryId });
}

export function watchThumbnails(container) {
    container.querySelectorAll('img[data-needs-thumb]').forEach((image) => {
        observer.observe(image);
    });
}

export async function sendThumbnail(entryId, connection) {
    const entry = await getEntryById(entryId);
    if (entry?.thumb) {
        connection.send({ type: 'thumb', entryId, thumb: entry.thumb });
    }
}

export async function receiveThumbnail(entryId, value) {
    const thumb = safeImage(value, MAX_THUMB_CHARS);
    if (!thumb || !(await saveThumb(entryId, thumb))) return;

    document.querySelectorAll(`img[data-entry-id="${CSS.escape(entryId)}"]`).forEach((image) => {
        image.src = thumb;
        image.removeAttribute('data-needs-thumb');
    });
}
