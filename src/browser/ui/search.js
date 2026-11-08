// search.js - Search links and show them in a compact black table
import { getAvatars, searchEntries, trackDownload, trackSearch, getStats } from '../storage/db.js';
import { linkPeers } from '../network/linkPeers.js';
import { peerManager } from '../network/peerManager.js';
import { presenceManager } from '../network/presence.js';
import { extractSlug, isURL } from '../../shared/urlParser.js';
import { getDownloadMagnet } from '../../shared/links.js';
import { downloadManager } from '../downloads/downloadManager.js';
import {
    escapeHTML, MAX_AVATAR_CHARS, MAX_THUMB_CHARS, safeImage, safeLink, safeThumbHash
} from '../../shared/safe.js';
import { thumbHashToImage } from '../../shared/images.js';
import { openPreview } from './preview.js';
import { watchThumbnails } from './thumbnails.js';
import { getMyKeys } from '../../shared/signing.js';
import { deleteOwnPost } from '../network/deletes.js';

const ROWS_PER_PAGE = 20;
const WHO_HAS_LIMIT = 50;
const resultSlugs = new Map();
const downloadStates = new Map();

let searchTimeout;
let lastWhoHasKey = '';
let currentResults = [];
let currentPage = 1;
let myKey = null;
getMyKeys().then((keys) => { myKey = keys.publicKey; }).catch(() => {});
const CONFIRM_MS = 3000;

export function initUI() {
    const searchInput = document.getElementById('search-input');
    const container = document.getElementById('results-container');

    searchInput.addEventListener('input', (event) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            currentPage = 1;
            performSearch(event.target.value.trim());
        }, 300);
    });

    searchInput.addEventListener('paste', () => {
        setTimeout(() => {
            currentPage = 1;
            performSearch(searchInput.value.trim());
        }, 10);
    });

    container.addEventListener('click', handleTableClick);
}

async function performSearch(query) {
    const container = document.getElementById('results-container');

    if (!query) {
        currentResults = [];
        container.replaceChildren();
        return;
    }

    await trackSearch(query);

    let results;
    if (isURL(query)) {
        const slug = extractSlug(query);
        const matches = await searchEntries(slug);
        results = matches.filter((entry) => (
            entry.sourceURL.includes(query) || extractSlug(entry.sourceURL).includes(slug)
        ));
    } else {
        results = await searchEntries(query);
    }

    askWhoHas(results);
    currentResults = results;
    await renderResults();
}

// Asks once for what is on screen, so typing does not flood peers
function askWhoHas(results) {
    const entries = results.slice(0, WHO_HAS_LIMIT);
    const key = entries.map((entry) => entry.entryId).join('|');
    if (!key || key === lastWhoHasKey) return;

    lastWhoHasKey = key;
    resultSlugs.clear();
    entries.forEach((entry) => resultSlugs.set(entry.entryId, extractSlug(entry.sourceURL)));
    peerManager.broadcast({ type: 'who_has', ids: entries.map((entry) => entry.entryId) });
}

window.addEventListener('peer-has-ids', ({ detail }) => {
    let changed = false;
    detail.ids.forEach((id) => {
        const slug = resultSlugs.get(id);
        if (slug && !linkPeers.findPeers(slug).includes(detail.peerId)) {
            linkPeers.addPeer(slug, detail.peerId);
            changed = true;
        }
    });
    if (changed) refreshResults();
});

function getHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return url.slice(0, 40);
    }
}

function renderImage(entry) {
    const thumb = safeImage(entry.thumb, MAX_THUMB_CHARS);
    const thumbHash = safeThumbHash(entry.thumbHash);
    const blurred = !thumb && thumbHash ? thumbHashToImage(thumbHash) : null;
    const image = thumb || blurred;

    if (!image) return '<span class="result-no-image" aria-hidden="true">📄</span>';

    return `<button class="result-image-button" type="button" data-action="preview" data-entry-id="${escapeHTML(entry.entryId)}" aria-label="Open full image">
        <img class="preview-thumb" src="${image}" data-entry-id="${escapeHTML(entry.entryId)}" ${blurred ? 'data-needs-thumb="true"' : ''} alt="">
    </button>`;
}

function renderActions(entry) {
    const id = escapeHTML(entry.entryId);
    const state = downloadStates.get(entry.entryId) || 'idle';
    const buttons = [];

    if (getDownloadMagnet(entry.magnet)) {
        const label = { idle: 'Download', downloading: 'Downloading', downloaded: 'Downloaded' }[state];
        buttons.push(`<button type="button" data-action="copy" data-entry-id="${id}">Copy</button>`);
        buttons.push(`<button type="button" data-action="download" data-entry-id="${id}" ${state === 'idle' ? '' : 'disabled'}>${label}</button>`);
    }
    const instantLink = entry.instantIOLink
        || (entry.magnet?.startsWith('https://instant.io/') ? entry.magnet : null);
    if (instantLink) {
        buttons.push(`<a href="${escapeHTML(safeLink(instantLink))}" target="_blank" rel="noopener noreferrer">instant.io</a>`);
    }

    if (entry.signature && myKey && entry.authorKey === myKey) {
        buttons.push(`<button type="button" class="result-delete" data-action="delete" data-entry-id="${id}" aria-label="Delete your post">Delete</button>`);
    }

    return buttons.join('') || '<span class="result-muted">No link</span>';
}

function renderAvatar(username, avatars) {
    const avatar = safeImage(avatars[username], MAX_AVATAR_CHARS);
    if (avatar) return `<img class="result-avatar" src="${avatar}" alt="">`;

    return `<span class="result-avatar result-avatar-empty" aria-hidden="true">${escapeHTML(username.charAt(0).toUpperCase())}</span>`;
}

async function renderRow(entry, avatars) {
    const slug = extractSlug(entry.sourceURL);
    const stats = await getStats(slug);
    const peers = linkPeers.findPeers(slug).length;
    const username = entry.addedBy || 'Anonymous';
    const online = presenceManager.isOnline(username);

    return `<tr>
        <td class="result-image">${renderImage(entry)}</td>
        <td class="result-title-cell">
            <a class="url-title" href="${escapeHTML(safeLink(entry.sourceURL))}" target="_blank" rel="noopener noreferrer">${escapeHTML(entry.title || 'Untitled')}</a>
            <span class="result-host">${escapeHTML(getHostname(entry.sourceURL))}</span>
        </td>
        <td class="result-user">
            <span class="result-user-row">
                ${renderAvatar(username, avatars)}
                <span class="result-user-name">${escapeHTML(username)}</span>
                <span class="result-dot ${online ? 'online' : ''}" role="img" aria-label="${online ? 'Online' : 'Offline'}"></span>
            </span>
        </td>
        <td class="result-number">${peers}</td>
        <td class="result-number">${stats.downloads}</td>
        <td class="result-actions">${renderActions(entry)}</td>
    </tr>`;
}

async function renderResults() {
    const container = document.getElementById('results-container');

    if (!currentResults.length) {
        container.innerHTML = '<p class="results-empty">No results found</p>';
        return;
    }

    const totalPages = Math.ceil(currentResults.length / ROWS_PER_PAGE);
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * ROWS_PER_PAGE;
    const pageResults = currentResults.slice(start, start + ROWS_PER_PAGE);
    const usernames = [...new Set(pageResults.map((entry) => entry.addedBy || 'Anonymous'))];
    const avatars = await getAvatars(usernames);
    const rows = await Promise.all(pageResults.map((entry) => renderRow(entry, avatars)));
    const label = `${currentResults.length} result${currentResults.length === 1 ? '' : 's'}`;

    container.innerHTML = `<section class="results-panel" aria-label="Search results">
        <div class="results-summary">${label}</div>
        <div class="results-scroll">
            <table class="results-table">
                <thead>
                    <tr>
                        <th></th>
                        <th>Title</th>
                        <th>Posted by</th>
                        <th>Peers</th>
                        <th>DLs</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>${rows.join('')}</tbody>
            </table>
        </div>
        ${totalPages > 1 ? `<div class="results-pagination">
            <button type="button" data-action="previous-page" ${currentPage === 1 ? 'disabled' : ''}>Prev</button>
            <span>Page ${currentPage} of ${totalPages}</span>
            <button type="button" data-action="next-page" ${currentPage === totalPages ? 'disabled' : ''}>Next</button>
        </div>` : ''}
    </section>`;

    watchThumbnails(container);
}

function handleTableClick(event) {
    const control = event.target.closest('[data-action]');
    if (!control) return;

    const { action, entryId } = control.dataset;
    const entry = currentResults.find((item) => item.entryId === entryId);

    if (action === 'previous-page' || action === 'next-page') {
        currentPage += action === 'next-page' ? 1 : -1;
        renderResults();
    } else if (action === 'preview') {
        openPreview(entryId);
    } else if (action === 'copy' && entry) {
        navigator.clipboard.writeText(getDownloadMagnet(entry.magnet));
        showToast('📋 Magnet link copied');
    } else if (action === 'download' && entry) {
        startDownload(entry);
    } else if (action === 'delete' && entry) {
        confirmDelete(control, entry);
    }
}

// The first click asks "Sure?", the second click deletes
async function confirmDelete(button, entry) {
    if (button.dataset.confirm !== 'yes') {
        button.dataset.confirm = 'yes';
        button.textContent = 'Sure?';
        setTimeout(() => {
            if (button.isConnected) {
                delete button.dataset.confirm;
                button.textContent = 'Delete';
            }
        }, CONFIRM_MS);
        return;
    }

    button.disabled = true;
    const deleted = await deleteOwnPost(entry.entryId).catch(() => false);
    showToast(deleted ? '🗑️ Post deleted' : 'Could not delete this post');
}

function startDownload(entry) {
    downloadStates.set(entry.entryId, 'downloading');
    renderResults();

    downloadManager.startDownload(getDownloadMagnet(entry.magnet), entry.sourceURL, entry.title, () => {
        downloadStates.set(entry.entryId, 'downloaded');
        trackDownload(extractSlug(entry.sourceURL));
        renderResults();
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

export function refreshResults() {
    const searchInput = document.getElementById('search-input');
    if (searchInput && searchInput.value.trim()) {
        performSearch(searchInput.value.trim());
    }
}
