// usernameEditor.js - Choose a custom five-letter username
import { peerManager } from '../network/peerManager.js';
import { presenceManager } from '../network/presence.js';
import { saveAvatar } from '../storage/db.js';
import { getAvatar } from '../../shared/profile.js';
import { getUsername, isValidName, setUsername } from '../../shared/username.js';
import { renderPeerTable } from './peerTable.js';
import { refreshResults } from './search.js';

async function saveName(name) {
    const username = setUsername(name);
    const avatar = getAvatar();

    document.getElementById('username-display').textContent = username;
    presenceManager.rename(username);
    peerManager.broadcast({ type: 'profile', username, avatar });
    if (avatar) await saveAvatar(username, avatar);

    renderPeerTable();
    refreshResults();
}

export function initUsernameEditor() {
    const button = document.getElementById('username-display');
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

        if (!isValidName(name)) {
            error.hidden = false;
            input.focus();
            return;
        }

        await saveName(name);
        close();
    });

    button.title = `Change username: ${getUsername()}`;
}
