// shareStats.js - Counts what this browser has shared with other people
const STATS_KEY = 'webtorrent-share-stats';
const stats = loadStats();

function loadStats() {
    try {
        return { links: 0, bytes: 0, ...JSON.parse(localStorage.getItem(STATS_KEY)) };
    } catch {
        return { links: 0, bytes: 0 };
    }
}

function saveStats() {
    try {
        localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch {
        // Stats still work until this page is closed
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderShareStats() {
    const links = document.getElementById('shared-links');
    const bytes = document.getElementById('shared-bytes');
    if (links) links.textContent = stats.links;
    if (bytes) bytes.textContent = formatBytes(stats.bytes);
}

export function recordShared(links, bytes) {
    stats.links += links;
    stats.bytes += bytes;
    saveStats();
    renderShareStats();
}
