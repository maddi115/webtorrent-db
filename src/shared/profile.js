// profile.js - The profile picture this browser shows to other peers
const AVATAR_KEY = 'webtorrent-avatar';

export function getAvatar() {
    try {
        return localStorage.getItem(AVATAR_KEY);
    } catch {
        return null;
    }
}

export function setAvatar(avatar) {
    try {
        localStorage.setItem(AVATAR_KEY, avatar);
    } catch {
        // The picture still works until this page is closed
    }
}
