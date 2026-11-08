// rooms.js - Topic rooms that people can join
export const TOPICS = ['general', 'movies', 'music', 'software', 'games', 'books'];
export const DEFAULT_TOPIC = 'general';

const TOPIC_KEY = 'webtorrent-room';
let currentTopic = null;

export function isTopic(value) {
    return TOPICS.includes(value);
}

// People see Room 1 to Room 6. The old names stay inside, so old links and posts still work.
export function getRoomName(topic = getTopic()) {
    const index = TOPICS.indexOf(topic);
    return index >= 0 ? `Room ${index + 1}` : 'Room 1';
}

export function getNextTopic(topic = getTopic()) {
    return TOPICS[(TOPICS.indexOf(topic) + 1) % TOPICS.length];
}

// Accepts ?room=3 as well as the old ?room=music
function topicFromLink(value) {
    if (isTopic(value)) return value;
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= TOPICS.length ? TOPICS[number - 1] : null;
}

export function getTopic() {
    if (currentTopic) return currentTopic;

    const linkedRoom = topicFromLink(new URLSearchParams(location.search).get('room'));
    if (linkedRoom) {
        currentTopic = linkedRoom;
        return currentTopic;
    }

    try {
        const saved = localStorage.getItem(TOPIC_KEY);
        currentTopic = isTopic(saved) ? saved : DEFAULT_TOPIC;
    } catch {
        currentTopic = DEFAULT_TOPIC;
    }
    return currentTopic;
}

export function setTopic(topic) {
    currentTopic = topic;
    try {
        localStorage.setItem(TOPIC_KEY, topic);
    } catch {
        // The room still works until this page is closed
    }
}

export function getEntryTopic(entry) {
    return entry.room || DEFAULT_TOPIC;
}
