// peerTable.js - Small online bar that opens a live table of connected peers
import { getUsername } from '../../shared/username.js';
import { getAvatar } from '../../shared/profile.js';

const ROWS_PER_PAGE = 13;
const BAR_PROFILES = 4;
let currentPage = 1;

function makeAvatar(avatar, username) {
    if (avatar) {
        const image = document.createElement('img');
        image.className = 'peer-avatar';
        image.alt = '';
        image.src = avatar;
        return image;
    }

    const fallback = document.createElement('span');
    fallback.className = 'peer-avatar peer-avatar-empty';
    fallback.textContent = (username || '?').charAt(0).toUpperCase();
    return fallback;
}

function formatConnectedTime(connectedAt) {
    const seconds = Math.floor((Date.now() - connectedAt) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
}

function addRow(body, { avatar, username, peerId, connections, links, time, isSelf }) {
    const row = document.createElement('tr');
    if (isSelf) row.className = 'peer-self';

    const photo = document.createElement('td');
    photo.append(makeAvatar(avatar, username));
    row.append(photo);

    const name = isSelf ? `${username} (you)` : username;
    [name, peerId, connections, links, time].forEach((value) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
    });

    body.append(row);
}

function renderBar(people) {
    const avatars = document.createDocumentFragment();
    people.slice(0, BAR_PROFILES).forEach((person) => {
        avatars.append(makeAvatar(person.avatar, person.username));
    });

    document.getElementById('peer-bar-avatars').replaceChildren(avatars);
    document.getElementById('peer-bar-count').textContent = `${people.length} online`;
}

function renderPagination(totalRows) {
    const totalPages = Math.max(1, Math.ceil(totalRows / ROWS_PER_PAGE));
    currentPage = Math.min(currentPage, totalPages);

    document.getElementById('peer-pagination').hidden = totalPages === 1;
    document.getElementById('peer-page-info').textContent = `Page ${currentPage} of ${totalPages}`;
    document.getElementById('peer-prev').disabled = currentPage === 1;
    document.getElementById('peer-next').disabled = currentPage === totalPages;
}

export async function renderPeerTable() {
    const body = document.getElementById('peer-table-body');
    if (!body) return;

    const { peerManager } = await import('../network/peerManager.js');
    const { getEntryCount } = await import('../storage/db.js');
    const { getMyPeerId, getRelayCount, getRoomLabel } = await import('../network/roomNetwork.js');
    const profiles = [...peerManager.profiles.entries()];
    const links = await getEntryCount().catch(() => 0);

    const mine = peerManager.peers.size;
    const theirs = profiles.reduce((total, [, profile]) => total + profile.connections, 0);
    document.getElementById('peer-room-name').textContent = getRoomLabel();
    document.getElementById('peer-relay-count').textContent = getRelayCount();
    document.getElementById('peer-online-count').textContent = profiles.length + 1;
    document.getElementById('peer-direct-count').textContent = Math.round((mine + theirs) / 2);

    const people = [
        {
            avatar: getAvatar(),
            username: getUsername(),
            peerId: getMyPeerId().slice(0, 8),
            connections: mine,
            links,
            time: 'Now',
            isSelf: true
        },
        ...profiles.map(([peerId, profile]) => ({
            avatar: profile.avatar,
            username: profile.username,
            peerId: peerId.slice(0, 8),
            connections: profile.connections,
            links: profile.links,
            time: formatConnectedTime(profile.connectedAt)
        }))
    ];

    renderBar(people);
    renderPagination(people.length);

    const start = (currentPage - 1) * ROWS_PER_PAGE;
    const rows = document.createDocumentFragment();
    people.slice(start, start + ROWS_PER_PAGE).forEach((person) => addRow(rows, person));
    body.replaceChildren(rows);
}

function setTableOpen(isOpen) {
    const bar = document.getElementById('peer-bar');
    document.getElementById('peer-modal').hidden = !isOpen;
    bar.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) {
        document.getElementById('peer-close').focus();
    } else {
        bar.focus();
    }
}

function changePage(change) {
    currentPage += change;
    renderPeerTable();
}

export function initPeerTable() {
    const modal = document.getElementById('peer-modal');

    document.getElementById('peer-bar').addEventListener('click', () => setTableOpen(true));
    document.getElementById('peer-close').addEventListener('click', () => setTableOpen(false));
    document.getElementById('peer-prev').addEventListener('click', () => changePage(-1));
    document.getElementById('peer-next').addEventListener('click', () => changePage(1));

    modal.addEventListener('click', (event) => {
        if (event.target === modal) setTableOpen(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !modal.hidden) setTableOpen(false);
    });

    renderPeerTable();
    setInterval(renderPeerTable, 5000);
}
