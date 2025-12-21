// username.js - Username UI (under Add Link section)
import { getUsername, setUsername } from '../../shared/username.js';

export function initUsernameUI() {
    // Add username section to page
    const usernameSection = document.createElement('section');
    usernameSection.id = 'username-section';
    usernameSection.innerHTML = `
        <h2>Your Identity</h2>
        <p>Current: <strong id="current-username">${getUsername()}</strong></p>
        <input type="text" id="username-input" placeholder="Enter nickname (e.g., lalo)" maxlength="20">
        <button id="set-username-btn">Set Username</button>
        <p style="font-size: 0.85rem; color: #888; margin-top: 8px;">
            💡 Random number and emoji will be auto-generated
        </p>
    `;
    
    // Insert after Add Link section
    const addSection = document.getElementById('add-section');
    addSection.after(usernameSection);
    
    // Set username button
    document.getElementById('set-username-btn').addEventListener('click', () => {
        const input = document.getElementById('username-input').value.trim();
        if (input) {
            const newUsername = setUsername(input);
            document.getElementById('current-username').textContent = newUsername;
            document.getElementById('username-input').value = '';
            showToast(`✅ Username set: ${newUsername}`);
        }
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
