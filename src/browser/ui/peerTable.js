// peerTable.js - Live black table of the people connected right now
import { getUsername } from '../../shared/username.js';
import { getAvatar } from '../../shared/profile.js';

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

export async function renderPeerTable() {
    const body = document.getElementById('peer-table-body');
    if (!body) return;

    const { peerManager } = await import('../network/peerManager.js');
    const { getEntryCount } = await import('../storage/db.js');
    const { getMyPeerId } = await import('../network/dht.js');
    const profiles = [...peerManager.profiles.entries()];
    const links = await getEntryCount().catch(() => 0);

    const mine = peerManager.peers.size;
    const theirs = profiles.reduce((total, [, profile]) => total + profile.connections, 0);
    document.getElementById('peer-online-count').textContent = mine + 1;
    document.getElementById('peer-direct-count').textContent = Math.round((mine + theirs) / 2);

    const rows = document.createDocumentFragment();
    addRow(rows, {
        avatar: getAvatar(),
        username: getUsername(),
        peerId: getMyPeerId().slice(0, 8),
        connections: mine,
        links,
        time: 'Now',
        isSelf: true
    });

    profiles.forEach(([peerId, profile]) => addRow(rows, {
        avatar: profile.avatar,
        username: profile.username,
        peerId: peerId.slice(0, 8),
        connections: profile.connections,
        links: profile.links,
        time: formatConnectedTime(profile.connectedAt)
    }));

    body.replaceChildren(rows);
}

export function initPeerTable() {
    renderPeerTable();
    setInterval(renderPeerTable, 5000);
}
