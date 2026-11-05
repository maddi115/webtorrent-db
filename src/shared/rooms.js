// rooms.js - Topic rooms that people can join
export const TOPICS = ['general', 'movies', 'music', 'software', 'games', 'books'];
export const DEFAULT_TOPIC = 'general';

const TOPIC_KEY = 'webtorrent-room';
let currentTopic = null;

export function isTopic(value) {
    return TOPICS.includes(value);
}

export function getTopic() {
    if (currentTopic) return currentTopic;

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
