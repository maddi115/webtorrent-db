// profile.js - Pick a profile picture
import { resizeImage } from '../../shared/images.js';
import { getAvatar, setAvatar } from '../../shared/profile.js';
import { renderPeerTable } from './peerTable.js';

function showAvatar() {
    const image = document.getElementById('profile-image');
    const avatar = getAvatar();

    if (avatar) {
        image.src = avatar;
        image.style.display = 'block';
    }
}

export function initProfile() {
    const button = document.getElementById('profile-btn');
    const input = document.getElementById('profile-upload');

    showAvatar();
    button.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
        if (!input.files[0]) return;

        const avatar = await resizeImage(input.files[0], 96, 0.8);
        setAvatar(avatar);
        showAvatar();
        input.value = '';

        const { peerManager } = await import('../network/peerManager.js');
        const { getUsername } = await import('../../shared/username.js');
        peerManager.broadcast({ type: 'profile', username: getUsername(), avatar });
        renderPeerTable();
    });
}
