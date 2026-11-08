// signing.js - Each browser signs its own links, so nobody can fake or change them
import { fromPublicEntry, getEntryId, getSignedText, toPublicEntry } from './entryId.js';
import { cleanRemoteEntry, isPublicKey, isSignature } from './entryRules.js';

const KEY_STORAGE = 'webtorrent-signing-key';
const MAX_CACHED_KEYS = 5000;
const SIGNED_FIELDS = [
    'sourceURL', 'magnet', 'instantIOLink', 'title', 'addedBy',
    'timestamp', 'room', 'thumbHash', 'hasPreview'
];

const encoder = new TextEncoder();
const verifyKeys = new Map();
let myKeys = null;

export function toBase64Url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(value) {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export async function importSigningKey(privateKey, publicKey) {
    return {
        publicKey,
        privateKey: await crypto.subtle.importKey(
            'pkcs8', fromBase64Url(privateKey), 'Ed25519', false, ['sign']
        )
    };
}

// The key is made once and kept in this browser
async function loadOrCreateKeys() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY_STORAGE));
        if (saved?.privateKey && isPublicKey(saved.publicKey)) {
            return await importSigningKey(saved.privateKey, saved.publicKey);
        }
    } catch {
        // A broken saved key is replaced with a new one
    }

    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const saved = {
        privateKey: toBase64Url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
        publicKey: toBase64Url(await crypto.subtle.exportKey('raw', pair.publicKey))
    };
    try {
        localStorage.setItem(KEY_STORAGE, JSON.stringify(saved));
    } catch {
        // The key still works until this page closes
    }
    return importSigningKey(saved.privateKey, saved.publicKey);
}

export function getMyKeys() {
    if (!myKeys) myKeys = loadOrCreateKeys();
    return myKeys;
}

// Makes the link look exactly like peers will rebuild it, so its ID and signature match
export function normalizeEntry(entry) {
    const room = entry.room || 'general';
    const clean = cleanRemoteEntry(fromPublicEntry(toPublicEntry({
        ...entry, authorKey: null, signature: null
    })), room);
    if (!clean) throw new Error('This link is not valid');

    SIGNED_FIELDS.forEach((field) => { entry[field] = clean[field]; });
    return entry;
}

export async function signEntry(entry, keys) {
    const signer = keys || await getMyKeys();
    normalizeEntry(entry);
    entry.authorKey = signer.publicKey;

    const signature = await crypto.subtle.sign(
        'Ed25519', signer.privateKey, encoder.encode(getSignedText(entry))
    );
    entry.signature = toBase64Url(signature);
    entry.entryId = await getEntryId(entry);
    return entry;
}

// The exact text a delete note's signature covers
export function getDeleteText(entryId) {
    return `wtdb-delete-1\n${entryId}`;
}

export async function signDelete(entryId, keys) {
    const signer = keys || await getMyKeys();
    const signature = await crypto.subtle.sign(
        'Ed25519', signer.privateKey, encoder.encode(getDeleteText(entryId))
    );
    return { entryId, authorKey: signer.publicKey, signature: toBase64Url(signature) };
}

async function getVerifyKey(publicKey) {
    if (verifyKeys.has(publicKey)) return verifyKeys.get(publicKey);

    const key = await crypto.subtle.importKey(
        'raw', fromBase64Url(publicKey), 'Ed25519', false, ['verify']
    );
    if (verifyKeys.size >= MAX_CACHED_KEYS) verifyKeys.clear();
    verifyKeys.set(publicKey, key);
    return key;
}

async function verifyText(publicKey, signature, text) {
    if (!isPublicKey(publicKey) || !isSignature(signature)) return false;

    try {
        return await crypto.subtle.verify(
            'Ed25519', await getVerifyKey(publicKey), fromBase64Url(signature), encoder.encode(text)
        );
    } catch {
        return false;
    }
}

export function verifyEntry(entry) {
    return verifyText(entry.authorKey, entry.signature, getSignedText(entry));
}

export function isEntryId(value) {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

export function verifyDelete(note) {
    if (!isEntryId(note?.entryId)) return Promise.resolve(false);
    return verifyText(note.authorKey, note.signature, getDeleteText(note.entryId));
}
