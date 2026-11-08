// usernameEditor.js - Choose a custom username of up to five letters
import { peerManager } from '../network/peerManager.js';
import { presenceManager } from '../network/presence.js';
import { saveAvatar } from '../storage/db.js';
import { getAvatar } from '../../shared/profile.js';
import { getUsername, isValidName, setUsername } from '../../shared/username.js';
import { renderPeerTable } from './peerTable.js';
import { refreshResults } from './search.js';
import { showProfile } from './profile.js';

async function saveName(name) {
    const username = setUsername(name);
    const avatar = getAvatar();

    document.getElementById('username-display').textContent = username;
    showProfile();
    presenceManager.rename(username);
    peerManager.broadcast({ type: 'profile', username, avatar });
    if (avatar) await saveAvatar(username, avatar);

    renderPeerTable();
    refreshResults();
}

export function initUsernameEditor() {
    const button = document.getElementById('profile-card');
    const modal = document.getElementById('name-modal');
    const form = document.getElementById('name-form');
    const input = document.getElementById('name-input');
    const error = document.getElementById('name-error');

    const close = () => {
        modal.hidden = true;
        button.focus();
    };

    button.addEventListener('click', () => {
        input.value = '';
        error.hidden = true;
        document.getElementById('name-current').textContent = getUsername();
        modal.hidden = false;
        input.focus();
    });

    document.getElementById('name-cancel').addEventListener('click', close);

    modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !modal.hidden) close();
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = input.value.trim();

        // Only the photo changed, so there is no name to save
        if (!name) {
            close();
            return;
        }
        if (!isValidName(name)) {
            error.hidden = false;
            input.focus();
            return;
        }

        await saveName(name);
        close();
    });


}
