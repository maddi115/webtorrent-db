// seedingMode.js - Helps keep this PC awake while it shares with the room
const SEEDING_KEY = 'webtorrent-seeding';
let wakeLock = null;
let seeding = false;

async function holdWakeLock() {
    try {
        wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
        wakeLock = null;
    }
}

function render(button) {
    button.textContent = seeding ? 'Seeding: on' : 'Seeding: off';
    button.setAttribute('aria-pressed', String(seeding));
}

async function setSeeding(isOn, button) {
    seeding = isOn;
    render(button);

    try {
        localStorage.setItem(SEEDING_KEY, String(isOn));
    } catch {
        // The switch still works until this page is closed
    }

    if (isOn) {
        await holdWakeLock();
    } else {
        await wakeLock?.release();
        wakeLock = null;
    }
}

export function initSeedingMode() {
    const button = document.getElementById('seed-toggle');
    let saved = false;
    try {
        saved = localStorage.getItem(SEEDING_KEY) === 'true';
    } catch {
        saved = false;
    }

    button.addEventListener('click', () => setSeeding(!seeding, button));
    document.addEventListener('visibilitychange', () => {
        if (seeding && document.visibilityState === 'visible') holdWakeLock();
    });

    navigator.storage?.persist?.().catch(() => {});
    setSeeding(saved, button);
}
