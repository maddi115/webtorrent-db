// chatRelay.js - Carries global chat messages through the public relays.
// Relays are shared by every room, so a message reaches everyone, whatever room they are in.
// Relays only pass messages along. They do not keep them.
import { createEvent, subscribe } from 'trystero';
import { getRelayUrls, networkSettings } from '../../shared/networkConfig.js';

const TOPIC = `${networkSettings.roomPrefix}global-chat`;
const MAX_RELAYS = 4;
const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;
const MAX_EVENT_CHARS = 4000;

const sockets = new Map();
let onMessage = () => {};

function connect(url, retryMs = FIRST_RETRY_MS) {
    let socket;
    try {
        socket = new WebSocket(url);
    } catch {
        return;
    }
    const subId = `chat-${Math.random().toString(36).slice(2, 10)}`;
    sockets.set(url, socket);

    socket.onopen = () => socket.send(subscribe(subId, TOPIC));
    socket.onmessage = ({ data }) => {
        if (typeof data !== 'string' || data.length > MAX_EVENT_CHARS) return;
        try {
            const [type, id, event] = JSON.parse(data);
            if (type !== 'EVENT' || id !== subId || typeof event?.content !== 'string') return;
            onMessage(JSON.parse(event.content));
        } catch {
            // Broken messages from a relay are ignored
        }
    };
    socket.onclose = () => {
        sockets.delete(url);
        setTimeout(() => connect(url, Math.min(retryMs * 2, MAX_RETRY_MS)), retryMs);
    };
    socket.onerror = () => {};
}

export function startChatRelays(handler) {
    onMessage = handler;
    getRelayUrls().slice(0, MAX_RELAYS).forEach((url) => connect(url));
}

export async function publishChat(message) {
    const event = await createEvent(TOPIC, JSON.stringify(message));
    let sent = 0;
    sockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(event);
            sent += 1;
        }
    });
    return sent;
}
