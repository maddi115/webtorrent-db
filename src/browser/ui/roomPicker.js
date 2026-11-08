// roomPicker.js - Choose a room: Room 1 to Room 6, up to 50 people each
import { getRoomName, getTopic, TOPICS } from '../../shared/rooms.js';
import { switchTopic } from '../network/roomNetwork.js';
import { getRoomCount, onRoomMove, resetMoves, ROOM_MAX } from '../network/roomPresence.js';
import { updateEntryCount } from '../storage/db.js';
import { refreshResults } from './search.js';

const REFRESH_MS = 2000;

// Your room shows how full it is. Other rooms can only be counted once you are in them.
export function renderRoomPicker() {
    const picker = document.getElementById('room-select');
    if (!picker) return;

    [...picker.options].forEach((option) => {
        const name = getRoomName(option.value);
        option.textContent = option.value === getTopic() ? `${name} (${getRoomCount()}/${ROOM_MAX})` : name;
    });
    picker.value = getTopic();
}

async function goToRoom(topic) {
    switchTopic(topic);
    renderRoomPicker();
    await updateEntryCount();
    refreshResults();
}

function showMessage(text) {
    const toast = document.createElement('div');
    toast.className = 'toast room-toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}

export function initRoomPicker() {
    const picker = document.getElementById('room-select');
    document.getElementById('room-max').textContent = ROOM_MAX;

    TOPICS.forEach((topic) => {
        const option = document.createElement('option');
        option.value = topic;
        picker.append(option);
    });
    renderRoomPicker();
    updateEntryCount();

    picker.addEventListener('change', () => {
        resetMoves();
        goToRoom(picker.value);
    });

    onRoomMove((from, next) => {
        goToRoom(next);
        showMessage(`${from} is full (${ROOM_MAX} people), so you're now in ${getRoomName(next)}.`);
    });

    setInterval(renderRoomPicker, REFRESH_MS);
}
