// profile.js - Pick a profile picture
import { resizeImage } from '../../shared/images.js';
import { getAvatar, setAvatar } from '../../shared/profile.js';
import { saveAvatar } from '../storage/db.js';
import { getUsername } from '../../shared/username.js';
import { renderPeerTable } from './peerTable.js';
import { refreshResults } from './search.js';

// Shows your photo, or the first letter of your name, in the header and the profile window
export function showProfile() {
    const avatar = getAvatar();
    const initial = (getUsername() || '?').charAt(0).toUpperCase();
    const isDefaultName = /^User\d+#/.test(getUsername());

    [['profile-image', 'profile-initial'], ['profile-preview', 'profile-preview-initial']].forEach(([imageId, initialId]) => {
        const image = document.getElementById(imageId);
        const letter = document.getElementById(initialId);
        if (!image || !letter) return;

        letter.textContent = initial;
        if (avatar) image.src = avatar;
        image.hidden = !avatar;
        letter.hidden = Boolean(avatar);
    });

    // A gentle nudge until someone picks their own name or photo
    const card = document.getElementById('profile-card');
    const needsSetup = isDefaultName || !avatar;
    card?.classList.toggle('needs-setup', needsSetup);
    const hint = document.getElementById('profile-card-hint');
    if (hint) hint.textContent = needsSetup ? '✏️ Set your name & photo' : '✏️ Edit profile';
}

export function initProfile() {
    const button = document.getElementById('profile-btn');
    const input = document.getElementById('profile-upload');

    showProfile();
    if (getAvatar()) saveAvatar(getUsername(), getAvatar());
    button.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
        if (!input.files[0]) return;

        const avatar = await resizeImage(input.files[0], 96, 0.8);
        setAvatar(avatar);
        showProfile();
        input.value = '';

        const { peerManager } = await import('../network/peerManager.js');
        await saveAvatar(getUsername(), avatar);
        peerManager.broadcast({ type: 'profile', username: getUsername(), avatar });
        renderPeerTable();
        refreshResults();
    });
}
