// chatPanel.js - The global chat window: the newest 25 messages from every room
import { getMessages, onChatChange, sendChat, startChat } from '../network/chat.js';
import { getUsername } from '../../shared/username.js';
import { getAvatars } from '../storage/db.js';
import { MAX_AVATAR_CHARS, safeImage } from '../../shared/safe.js';

let unread = 0;
let lastSeenId = null;

function isOpen() {
    return !document.getElementById('chat-panel').hidden;
}

function formatTime(time) {
    return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function makeAvatar(avatar, name) {
    if (avatar) {
        const image = document.createElement('img');
        image.className = 'chat-avatar';
        image.alt = '';
        image.src = avatar;
        return image;
    }
    const letter = document.createElement('span');
    letter.className = 'chat-avatar chat-avatar-empty';
    letter.textContent = name.charAt(0).toUpperCase();
    return letter;
}

// Everything is set as plain text, so a message can never run code
async function render() {
    const messages = getMessages();
    const list = document.getElementById('chat-list');
    const avatars = await getAvatars([...new Set(messages.map((message) => message.name))]).catch(() => ({}));
    const me = getUsername();
    const rows = document.createDocumentFragment();

    messages.forEach((message) => {
        const row = document.createElement('li');
        row.className = message.name === me ? 'chat-message chat-mine' : 'chat-message';
        row.append(makeAvatar(safeImage(avatars[message.name], MAX_AVATAR_CHARS), message.name));

        const body = document.createElement('div');
        body.className = 'chat-body';
        const meta = document.createElement('div');
        meta.className = 'chat-meta';
        const name = document.createElement('span');
        name.className = 'chat-name';
        name.textContent = message.name;
        const time = document.createElement('span');
        time.className = 'chat-time';
        time.textContent = formatTime(message.time);
        meta.append(name, time);
        const text = document.createElement('p');
        text.className = 'chat-text';
        text.textContent = message.text;
        body.append(meta, text);
        row.append(body);
        rows.append(row);
    });

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.replaceChildren(rows);
    if (nearBottom) list.scrollTop = list.scrollHeight;
    document.getElementById('chat-empty').hidden = messages.length > 0;
}

function showUnread() {
    const badge = document.getElementById('chat-unread');
    badge.hidden = unread === 0;
    badge.textContent = unread > 25 ? '25+' : String(unread);
}

function setOpen(open) {
    document.getElementById('chat-panel').hidden = !open;
    document.getElementById('chat-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
        unread = 0;
        lastSeenId = getMessages().at(-1)?.id ?? null;
        showUnread();
        render().then(() => {
            const list = document.getElementById('chat-list');
            list.scrollTop = list.scrollHeight;
        });
        document.getElementById('chat-input').focus();
    }
}

function showError(text) {
    const error = document.getElementById('chat-error');
    error.textContent = text;
    error.hidden = false;
    setTimeout(() => { error.hidden = true; }, 3000);
}

export function initChat() {
    document.getElementById('chat-toggle').addEventListener('click', () => setOpen(!isOpen()));
    document.getElementById('chat-close').addEventListener('click', () => setOpen(false));

    onChatChange((messages) => {
        if (isOpen()) {
            lastSeenId = messages.at(-1)?.id ?? null;
            render();
            return;
        }
        // Count messages that arrived since the chat was last open
        const index = messages.findIndex((message) => message.id === lastSeenId);
        unread = messages.slice(index + 1).filter((message) => message.name !== getUsername()).length;
        showUnread();
    });

    document.getElementById('chat-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('chat-input');
        const result = await sendChat(input.value);
        if (result.ok) {
            input.value = '';
            render().then(() => {
                const list = document.getElementById('chat-list');
                list.scrollTop = list.scrollHeight;
            });
        } else if (result.reason === 'too-fast') {
            showError('Slow down: 10 messages every 30 seconds');
        } else if (result.reason === 'link') {
            showError('Links are not allowed in chat');
        } else if (result.reason === 'name-taken') {
            showError('Someone else already uses this name. Pick a new one.');
        }
    });

    render();
    startChat();
}
