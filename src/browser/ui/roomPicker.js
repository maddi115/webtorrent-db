// roomPicker.js - Choose which topic room to join
import { getTopic, TOPICS } from '../../shared/rooms.js';
import { switchTopic } from '../network/roomNetwork.js';
import { updateEntryCount } from '../storage/db.js';
import { refreshResults } from './search.js';

export function initRoomPicker() {
    const picker = document.getElementById('room-select');

    TOPICS.forEach((topic) => {
        const option = document.createElement('option');
        option.value = topic;
        option.textContent = topic.charAt(0).toUpperCase() + topic.slice(1);
        picker.append(option);
    });

    picker.value = getTopic();
    updateEntryCount();
    picker.addEventListener('change', async () => {
        switchTopic(picker.value);

        await updateEntryCount();
        refreshResults();
    });
}
