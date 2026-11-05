// profile.js - Pick a profile picture
import { resizeImage } from '../../shared/images.js';
import { getAvatar, setAvatar } from '../../shared/profile.js';
import { saveAvatar } from '../storage/db.js';
import { getUsername } from '../../shared/username.js';
import { renderPeerTable } from './peerTable.js';
import { refreshResults } from './search.js';

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
    if (getAvatar()) saveAvatar(getUsername(), getAvatar());
    button.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
        if (!input.files[0]) return;

        const avatar = await resizeImage(input.files[0], 96, 0.8);
        setAvatar(avatar);
        showAvatar();
        input.value = '';

        const { peerManager } = await import('../network/peerManager.js');
        await saveAvatar(getUsername(), avatar);
        peerManager.broadcast({ type: 'profile', username: getUsername(), avatar });
        renderPeerTable();
        refreshResults();
    });
}
