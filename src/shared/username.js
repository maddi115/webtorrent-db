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

export function parseUsername(fullUsername) {
    const match = fullUsername.match(/^(.+?)#(\d{4})(.+)$/);
    if (match) {
        return {
            name: match[1],
            discriminator: match[2],
            emoji: match[3]
        };
    }
    return { name: fullUsername, discriminator: '', emoji: '' };
}
