// chat.js - One global chat for every room. Only the newest 25 messages are kept.
// Messages are signed like posts, so nobody can fake a name or change what someone said.
// Links are not allowed, and messages are only ever shown as plain text.
import { peerManager } from './peerManager.js';
import { claimName } from '../storage/db.js';
import { getUsername } from '../../shared/username.js';
import { networkSettings } from '../../shared/networkConfig.js';
import { publishChat, startChatRelays } from './chatRelay.js';
import { receiveDeletes, receiveWipe } from './deletes.js';
import { signChat, verifyChat } from '../../shared/signing.js';
import { isPublicKey, isSignature } from '../../shared/entryRules.js';
import { logger } from '../../shared/logger.js';

export const MAX_MESSAGES = 25;
export const MAX_CHAT_CHARS = 300;
const MESSAGES_PER_WINDOW = 10;
const WINDOW_MS = 30 * 1000;
const BLOCK_MS = 10 * 60 * 1000;
const FUTURE_LIMIT_MS = 2 * 60 * 1000;
const OLDEST_MS = 24 * 60 * 60 * 1000;
// A limit for the whole chat, so someone making a new key for every message cannot flood it
const CHAT_BUSY_LIMIT = 40;
const CHAT_BUSY_MS = 10 * 1000;
export const GLOBAL_ROOM = 'global';
const SAVE_KEY = `webtorrent-chat-${networkSettings.roomPrefix}`;

// Web addresses, magnet links, and bare domains like example.com are all blocked
const LINK_PATTERN = new RegExp([
    '[a-z][a-z0-9+.-]*:\\/\\/',
    '\\bwww\\.',
    '\\bmagnet:',
    '\\b\\d{1,3}(\\.\\d{1,3}){3}\\b',
    '\\b[a-z0-9-]+(\\.[a-z0-9-]+)*\\.(com|net|org|io|gg|me|co|xyz|ly|app|dev|tv|ru|to|link|site|info|biz|us|uk|ca|de|fr|jp|cn|in|be|live|online|shop|store|club|top|cc|ai|so|sh|is|fm|tk|ml|ga|cf|gq|onion)\\b'
].join('|'), 'i');

// Removes hidden characters and line breaks, so text cannot hide a link or break the layout
export function cleanChatText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function hasLink(text) {
    return LINK_PATTERN.test(cleanChatText(text));
}

let messages = [];
const seenIds = new Set();
const recentByKey = new Map();
const blockedKeys = new Map();
const listeners = new Set();
let acceptedTimes = [];

function isChatBusy(now) {
    acceptedTimes = acceptedTimes.filter((time) => now - time < CHAT_BUSY_MS);
    return acceptedTimes.length >= CHAT_BUSY_LIMIT;
}

export const chatStats = { received: 0, rejected: {} };

function reject(reason) {
    chatStats.rejected[reason] = (chatStats.rejected[reason] || 0) + 1;
    return false;
}

export function getMessages() {
    return messages;
}

export function onChatChange(listener) {
    listeners.add(listener);
}

function save() {
    try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(messages.map(pack)));
    } catch {
        // The chat still works until this page closes
    }
}

function notify() {
    save();
    listeners.forEach((listener) => listener(messages));
}

function pack(message) {
    const { id, room, name, time, text, key, sig } = message;
    return { id, room, name, time, text, key, sig };
}

function isWellFormed(message, now) {
    return message
        && typeof message.id === 'string' && /^[0-9a-f]{32}$/.test(message.id)
        && message.room === GLOBAL_ROOM
        && typeof message.name === 'string' && message.name.length > 0 && message.name.length <= 100
        && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= MAX_CHAT_CHARS
        && message.text === cleanChatText(message.text)
        && Number.isSafeInteger(message.time) && message.time <= now + FUTURE_LIMIT_MS && message.time >= now - OLDEST_MS
        && isPublicKey(message.key) && isSignature(message.sig);
}

// Too many messages from one key in a short time blocks that key for a while
function isTooFast(key, now) {
    const blockedAt = blockedKeys.get(key);
    if (blockedAt && now - blockedAt < BLOCK_MS) return true;
    blockedKeys.delete(key);

    const recent = (recentByKey.get(key) || []).filter((time) => now - time < WINDOW_MS);
    if (recent.length >= MESSAGES_PER_WINDOW) {
        blockedKeys.set(key, now);
        recentByKey.delete(key);
        return true;
    }
    recent.push(now);
    recentByKey.set(key, recent);
    return false;
}

// Keeps the newest 25 and deletes anything older
function store(message) {
    const list = [...messages, message].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    messages = list.slice(-MAX_MESSAGES);
    if (seenIds.size > 2000) {
        seenIds.clear();
        messages.forEach((item) => seenIds.add(item.id));
    }
    return messages.includes(message);
}

// Checks one message. Returns true if it was new, valid, and kept.
async function accept(raw, { countRate = true } = {}) {
    const now = Date.now();
    if (!isWellFormed(raw, now)) return reject('invalid');
    const message = pack(raw);
    if (seenIds.has(message.id)) return reject('known');
    if (countRate && isChatBusy(now)) return reject('busy');
    if (hasLink(message.text)) return reject('link');
    if (!await verifyChat(message)) return reject('bad-signature');
    if (!await claimName(message.name, message.key).catch(() => false)) return reject('name-taken');
    if (countRate && isTooFast(message.key, now)) return reject('too-fast');

    seenIds.add(message.id);
    acceptedTimes.push(now);
    if (!store(message)) return reject('too-old');
    chatStats.received += 1;
    return true;
}

export async function sendChat(text) {
    const clean = cleanChatText(text).slice(0, MAX_CHAT_CHARS);
    if (!clean) return { ok: false, reason: 'empty' };
    if (hasLink(clean)) return { ok: false, reason: 'link' };

    const message = await signChat({ room: GLOBAL_ROOM, name: getUsername(), time: Date.now(), text: clean });
    if (!await claimName(message.name, message.key).catch(() => false)) return { ok: false, reason: 'name-taken' };
    if (isTooFast(message.key, Date.now())) return { ok: false, reason: 'too-fast' };

    seenIds.add(message.id);
    store(message);
    peerManager.broadcast({ type: 'chat', message: pack(message) });
    publishChat(pack(message)).catch(() => {});
    notify();
    return { ok: true, message };
}

export async function receiveChat(raw, sourcePeerId) {
    if (!await accept(raw)) {
        if (chatStats.rejected['bad-signature'] || chatStats.rejected['name-taken']) {
            logger.warn('🚫 Chat message rejected');
        }
        return;
    }
    peerManager.forwardMessage({ type: 'chat', message: pack(raw) }, sourcePeerId);
    notify();
}

// Messages from the relays come from every room, so they are not passed on again.
// The relays also carry deletes and "clear all posts" notes, so every room hears about them.
async function receiveFromRelay(raw) {
    if (raw?.kind === 'delete') return receiveDeletes(raw.deletes, null);
    if (raw?.kind === 'wipe') return receiveWipe(raw.wipe, null);
    if (await accept(raw)) notify();
}

// New peers get the last 25 messages, so the chat is not empty when they join
export function sendHistory(connection) {
    const messages = getMessages().map(pack);
    if (messages.length) connection.send({ type: 'chat_history', messages });
}

export async function receiveHistory(messages) {
    if (!Array.isArray(messages)) return;
    let changed = false;
    for (const raw of messages.slice(-MAX_MESSAGES)) {
        if (await accept(raw, { countRate: false })) changed = true;
    }
    if (changed) notify();
}

// Loads the last 25 messages saved in this browser, then listens on the relays
export async function startChat() {
    try {
        await receiveHistory(JSON.parse(localStorage.getItem(SAVE_KEY)) || []);
    } catch {
        // Nothing saved yet
    }
    startChatRelays(receiveFromRelay);
}
