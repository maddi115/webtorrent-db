// username.js - Display username in corner
import { getUsername } from '../../shared/username.js';

export function initUsernameUI() {
    const display = document.getElementById('username-display');
    
    if (display) {
        const username = getUsername();
        display.textContent = username;
    }
}
