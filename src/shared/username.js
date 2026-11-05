// username.js - Username system with discriminator & emoji

const EMOJIS = ['🎅', '🎄', '⭐', '🎁', '❄️', '🔥', '💎', '🚀', '🌙', '⚡', '🎮', '🎯', '🎨', '🎭', '🎪', '🎬', '🎵', '🎸', '🎺', '🎹'];

export function getUsername() {
    let username = localStorage.getItem('webtorrent-username');
    
    if (!username) {
        username = generateUsername();
        localStorage.setItem('webtorrent-username', username);
    }
    
    return username;
}

export function isValidName(name) {
    return /^[A-Za-z]{1,5}$/.test(name);
}

export function setUsername(name) {
    const discriminator = generateDiscriminator();
    const emoji = getRandomEmoji();
    const fullUsername = `${name}#${discriminator}${emoji}`;
    localStorage.setItem('webtorrent-username', fullUsername);
    return fullUsername;
}

function generateUsername() {
    const randomName = `User${Math.floor(Math.random() * 1000)}`;
    const discriminator = generateDiscriminator();
    const emoji = getRandomEmoji();
    return `${randomName}#${discriminator}${emoji}`;
}

function generateDiscriminator() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function getRandomEmoji() {
    return EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
}
