// sync-test.mjs - Automatic P2P sync test.
// Starts the servers if needed, opens fresh browsers (no old entries),
// adds fake links, and checks that they reach the other browser.
// Run with: npm run test:sync
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openHelper } from '../tools/helper.mjs';
import { startRelay } from '../tools/bootstrapRelay.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';

// Test pages always ask for proof of work, at an easier level so the test stays quick
const TEST_WORK = '&powAfter=0&powBits=12';

const APP_PORT = 3107;
const APP_URL = `http://localhost:${APP_PORT}`;
const WAIT_MS = 45000;
const ID = Date.now();
const TEST_ROOM = `test-${ID}`;
const results = [];
const children = [];

// One shared test key, so seeded links match in every browser
async function makeTestKey() {
    const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const text = (buffer) => Buffer.from(buffer).toString('base64url');
    return {
        privateKey: text(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)),
        publicKey: text(await webcrypto.subtle.exportKey('raw', pair.publicKey))
    };
}

function report(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

function portOpen(port) {
    return new Promise((resolve) => {
        const s = net.connect(port, 'localhost');
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error', () => resolve(false));
    });
}

async function ensureServer(port, command, args, cwd) {
    if (await portOpen(port)) return;
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (data) => { output = (output + data).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    children.push(child);
    for (let i = 0; i < 120; i++) {
        if (await portOpen(port)) return;
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    child.kill();
    throw new Error(`Server on port ${port} did not start. Its output was:\n${output || '(nothing)'}`);
}

async function openPeer(browser, name, setup, options = `testRoom=${TEST_ROOM}`) {
    const context = await browser.newContext(); // fresh profile = empty database
    if (setup) await setup(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [${name} error] ${e.message}`));
    await page.goto(`${APP_URL}/?${options}${TEST_WORK}`);
    await page.waitForFunction(() => document.getElementById('username-display')?.textContent);
    return page;
}

const waitForPeers = (page, count) => page.waitForFunction(
    (n) => Number(document.getElementById('peer-count').textContent) >= n, count, { timeout: WAIT_MS });

async function addLink(page, url, { magnet = '', instantIO = '', title = '' }) {
    await page.click('#add-entry-btn');
    await page.fill('#entry-title', title);
    await page.fill('#source-url', url);
    await page.fill('#magnet-link', magnet);
    await page.fill('#instantio-link', instantIO);
    await page.click('#add-btn');
}

async function hasLink(page, url) {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        const entry = await page.evaluate(async (target) => {
            const { getEntryByURL } = await import('/src/browser/storage/db.js');
            return getEntryByURL(target);
        }, url);
        if (entry) return entry;
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
}

async function countLink(page, url) {
    return page.evaluate(async (target) => {
        const { getAllEntries } = await import('/src/browser/storage/db.js');
        const entries = await getAllEntries();
        return entries.filter((entry) => entry.sourceURL === target).length;
    }, url);
}

export async function run({ setup } = {}) {
    await ensureServer(APP_PORT, process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(APP_PORT), '--strictPort'], '.');
    const browser = await chromium.launch();
    const testKey = await makeTestKey();
    try {
        const a = await openPeer(browser, 'A', setup);
        const b = await openPeer(browser, 'B', setup);
        await Promise.all([waitForPeers(a, 1), waitForPeers(b, 1)]);
        report('Two fresh browsers connect', true);

        const hash = '0123456789abcdef0123456789abcdef01234567';
        const u1 = `https://example.com/t/fake-link-a-${ID}/1`;
        await addLink(a, u1, { magnet: `magnet:?xt=urn:btih:${hash}` });
        report('A to B: magnet link', !!(await hasLink(b, u1)));

        const u2 = `https://example.com/t/fake-link-b-${ID}/2`;
        await addLink(b, u2, { magnet: `magnet:?xt=urn:btih:${hash}` });
        report('B to A: magnet link', !!(await hasLink(a, u2)));

        await b.fill('#search-input', `fake-link-a-${ID}`);
        const shown = await b.waitForFunction(
            (t) => document.getElementById('results-container').textContent.toLowerCase().includes(t),
            `fake link a ${ID}`, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Synced link appears in search results', shown);

        const u3 = `https://example.com/t/fake-link-c-${ID}/3`;
        const io = 'https://instant.io/#fake';
        await addLink(a, u3, { instantIO: io });
        const got = await hasLink(b, u3);
        report('A to B: instant.io-only link', !!got);
        report('instant.io link survives sync', got?.instantIOLink === io, `got ${got?.instantIOLink}`);

        const u4 = `https://example.com/t/fake-link-d-${ID}/4`;
        const customTitle = `My Custom Title ${ID}`;
        await addLink(a, u4, { magnet: `magnet:?xt=urn:btih:${hash}`, title: customTitle });
        report('Custom title survives sync', (await hasLink(b, u4))?.title === customTitle);

        await b.fill('#search-input', customTitle);
        const titleShown = await b.waitForFunction(
            (t) => document.getElementById('results-container').textContent.includes(t),
            customTitle, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Search finds and shows custom title', titleShown);

        const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        const image = { name: 'test.png', mimeType: 'image/png', buffer: pixel };
        const u5 = `https://example.com/t/fake-link-e-${ID}/5`;
        await a.setInputFiles('#profile-upload', image);
        await a.click('#add-entry-btn');
        await a.setInputFiles('#preview-upload', image);
        await a.fill('#source-url', u5);
        await a.fill('#magnet-link', `magnet:?xt=urn:btih:${hash}`);
        await a.click('#add-btn');
        const previewEntry = await hasLink(b, u5);
        report('ThumbHash syncs without images', Boolean(previewEntry?.thumbHash && !previewEntry.thumb && !previewEntry.preview));

        await b.fill('#search-input', `fake-link-e-${ID}`);
        const thumbLoaded = await b.waitForFunction(() => {
            const image = document.querySelector('.preview-thumb');
            return image?.src.startsWith('data:image/') && !image.hasAttribute('data-needs-thumb');
        }, null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Thumbnail loads when on screen', thumbLoaded);

        await b.click('.preview-thumb');
        await b.waitForSelector('#preview-overlay img', { timeout: WAIT_MS });
        report('Full image loads on demand', Boolean((await hasLink(b, u5))?.preview));
        await b.click('#preview-overlay');

        const avatarShown = await b.waitForFunction(
            () => document.querySelectorAll('#peer-table-body img').length > 0,
            null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Profile picture appears in peer table', avatarShown);

        const dirtyURL = `https://example.com/t/fake-link-clean-${ID}/10?utm_source=x&fbclid=y&keep=1`;
        const cleanURL = `https://example.com/t/fake-link-clean-${ID}/10?keep=1`;
        await addLink(a, dirtyURL, { magnet: `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=File&tr=wss%3A%2F%2Ftracker.example` });
        const cleanEntry = await hasLink(b, cleanURL);
        report('Tracking junk is removed from URLs', Boolean(cleanEntry));
        report('Magnet rebuilds from its raw hash', cleanEntry?.magnet === `magnet:?xt=urn:btih:${hash}`);

        const messageSize = await a.evaluate(async (url) => {
            const { getEntryByURL } = await import('/src/browser/storage/db.js');
            const { toPublicEntry } = await import('/src/shared/entryId.js');
            return JSON.stringify(toPublicEntry(await getEntryByURL(url))).length;
        }, cleanURL);
        report('Link messages stay small', messageSize < 340, `${messageSize} bytes with signature`);

        const unsafeTitle = '<img src=x onerror="window.unsafeRan=true">';
        const u6 = `https://example.com/t/fake-link-f-${ID}/6`;
        await addLink(a, u6, { magnet: `magnet:?xt=urn:btih:${hash}`, title: unsafeTitle });
        await hasLink(b, u6);
        await b.fill('#search-input', `fake-link-f-${ID}`);
        await b.waitForSelector('.url-title', { timeout: WAIT_MS });
        await new Promise((r) => setTimeout(r, 1000));
        const unsafeRan = await b.evaluate(() => window.unsafeRan === true);
        report('Unsafe title stays plain text', !unsafeRan);

        const signedOnB = await hasLink(b, u1);
        const signatureValid = await b.evaluate(async (entry) => {
            const { verifyEntry } = await import('/src/shared/signing.js');
            return verifyEntry(entry);
        }, signedOnB);
        report('Links are signed by their author', Boolean(signedOnB?.signature) && signatureValid);

        const trust = await b.evaluate(async ({ url, takenName, stamp }) => {
            const { getEntryByURL } = await import('/src/browser/storage/db.js');
            const { toPublicEntry } = await import('/src/shared/entryId.js');
            const { gossip } = await import('/src/browser/network/gossip.js');
            const { importSigningKey, signEntry: signOnly, toBase64Url } = await import('/src/shared/signing.js');
            const { addWork } = await import('/src/shared/work.js');
            const signEntry = async (entry, keys) => addWork(await signOnly(entry, keys));
            const makeKeys = async () => {
                const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
                return importSigningKey(
                    toBase64Url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
                    toBase64Url(await crypto.subtle.exportKey('raw', pair.publicKey))
                );
            };
            const makeLink = (name, addedBy, timestamp) => ({
                sourceURL: `https://example.com/t/${name}-${stamp}/1`, magnet: null, instantIOLink: null,
                title: name, addedBy, timestamp, room: 'general', hasPreview: false
            });
            const arrives = async (packed) => {
                await gossip.receiveEntry(packed, 'test-peer');
                return Boolean(await getEntryByURL(packed.u));
            };

            const original = toPublicEntry(await getEntryByURL(url));
            const changed = await arrives({ ...original, u: `https://example.com/t/changed-${stamp}/1` });
            const unsigned = { ...original, u: `https://example.com/t/unsigned-${stamp}/1` };
            delete unsigned.k;
            delete unsigned.g;
            const unsignedSaved = await arrives(unsigned);

            const thief = await makeKeys();
            const stolen = await signEntry(makeLink('stolen-name', takenName, Date.now()), thief);
            const stolenSaved = await arrives(toPublicEntry(stolen));

            const spammer = await makeKeys();
            const now = Date.now();
            let spamSaved = 0;
            for (let index = 0; index < 15; index++) {
                const spam = await signEntry(makeLink(`spam-${index}`, `Spam${stamp}`, now + index * 1000), spammer);
                if (await arrives(toPublicEntry(spam))) spamSaved += 1;
            }
            const later = await signEntry(makeLink('spam-later', `Spam${stamp}`, now - 30 * 60 * 1000), spammer);
            const laterSaved = await arrives(toPublicEntry(later));

            return { changed, unsignedSaved, stolenSaved, spamSaved, laterSaved };
        }, { url: u1, takenName: await a.textContent('#username-display'), stamp: ID });
        report('Changed links are rejected', !trust.changed);
        report('Unsigned links are rejected', !trust.unsignedSaved);
        report('Nobody can post under a taken name', !trust.stolenSaved);
        report('Spam is capped at 10 links a minute', trust.spamSaved === 10, `${trust.spamSaved} of 15 saved`);
        report('Spammers stay blocked', !trust.laterSaved);

        const ownLimit = await b.evaluate(async (stamp) => {
            const { saveOwnEntry } = await import('/src/browser/storage/db.js');
            const { signEntry } = await import('/src/shared/signing.js');
            const { getUsername } = await import('/src/shared/username.js');
            const time = Date.now() - 20 * 60 * 1000;
            const statuses = [];
            for (let index = 0; index < 11; index++) {
                const entry = await signEntry({
                    sourceURL: `https://example.com/t/own-limit-${stamp}-${index}/1`, magnet: null,
                    instantIOLink: null, title: `Own ${index}`, addedBy: getUsername(),
                    timestamp: time + index * 1000, room: 'general', hasPreview: false
                });
                statuses.push(await saveOwnEntry(entry));
            }
            return statuses;
        }, ID);
        report('You can post 10 links a minute, not more',
            ownLimit.filter((status) => status === 'saved').length === 10 && ownLimit[10] === 'too-fast');

        const oldLinks = await b.evaluate(async (stamp) => {
            const { getEntryByURL, importEntries, signOldLinks } = await import('/src/browser/storage/db.js');
            const { getEntryId } = await import('/src/shared/entryId.js');
            const { getUsername } = await import('/src/shared/username.js');
            const makeOld = async (name, addedBy) => {
                const entry = {
                    sourceURL: `https://example.com/t/${name}-${stamp}/1`, magnet: null, title: name,
                    addedBy, timestamp: 1700000000000, room: 'general', hasPreview: false
                };
                entry.entryId = await getEntryId(entry);
                return entry;
            };
            const staleCopy = { ...await makeOld('my-old-link', getUsername()), entryId: 'f'.repeat(32) };
            await importEntries([
                await makeOld('my-old-link', getUsername()), staleCopy, await makeOld('their-old-link', 'Someone')
            ]);
            await signOldLinks();
            const { getAllEntries } = await import('/src/browser/storage/db.js');
            const copies = (await getAllEntries())
                .filter((entry) => entry.sourceURL === `https://example.com/t/my-old-link-${stamp}/1`).length;
            return {
                copies,
                mine: Boolean((await getEntryByURL(`https://example.com/t/my-old-link-${stamp}/1`))?.signature),
                theirs: Boolean((await getEntryByURL(`https://example.com/t/their-old-link-${stamp}/1`))?.signature)
            };
        }, ID);
        report('Your old links get signed', oldLinks.mine && !oldLinks.theirs);
        report('Old duplicate copies merge into one', oldLinks.copies === 1, `${oldLinks.copies} copies`);

        const deleteURL = `https://example.com/t/delete-me-${ID}/1`;
        await addLink(a, deleteURL, { magnet: `magnet:?xt=urn:btih:${hash}`, instantIO: `https://instant.io/#${hash}` });
        const copyOnB = await hasLink(b, deleteURL);
        const deleteButton = (page) => page.$(`.results-table tr:has(a[href="${deleteURL}"]) [data-action="delete"]`);
        await a.fill('#search-input', `delete-me-${ID}`);
        await b.fill('#search-input', `delete-me-${ID}`);
        await a.waitForSelector(`.results-table a[href="${deleteURL}"]`, { timeout: WAIT_MS });
        await b.waitForSelector(`.results-table a[href="${deleteURL}"]`, { timeout: WAIT_MS });
        await new Promise((r) => setTimeout(r, 500));
        report('Your posts have a delete button', Boolean(await deleteButton(a)) && !(await deleteButton(b)));
        report('Delete buttons fit in the table', await a.evaluate(() => {
            const scroll = document.querySelector('.results-scroll');
            return scroll.scrollWidth <= scroll.clientWidth;
        }));

        await (await deleteButton(a)).click();
        const asksFirst = Boolean(await countLink(a, deleteURL)) && (await (await deleteButton(a)).textContent()) === 'Sure?';
        await (await deleteButton(a)).click();
        const goneFrom = async (page, url) => {
            const deadline = Date.now() + WAIT_MS;
            while (Date.now() < deadline) {
                if (await countLink(page, url) === 0) return true;
                await new Promise((r) => setTimeout(r, 200));
            }
            return false;
        };
        report('Delete asks "Sure?" first', asksFirst);
        report('Deleting removes the post everywhere', await goneFrom(a, deleteURL) && await goneFrom(b, deleteURL));

        const deleteChecks = await b.evaluate(async ({ old, stamp }) => {
            const { getEntryByURL, importEntries, applyDeletes } = await import('/src/browser/storage/db.js');
            const { toPublicEntry } = await import('/src/shared/entryId.js');
            const { gossip } = await import('/src/browser/network/gossip.js');
            const { signDelete } = await import('/src/shared/signing.js');
            await gossip.receiveEntry(toPublicEntry(old), 'test-peer');
            const cameBack = Boolean(await getEntryByURL(old.sourceURL));

            const theirs = await getEntryByURL(`https://example.com/t/fake-link-a-${stamp}/1`);
            const fakeDelete = await signDelete(theirs.entryId);
            await applyDeletes([fakeDelete]);
            const othersSafe = Boolean(await getEntryByURL(theirs.sourceURL));

            const junk = await signDelete('ab'.repeat(16));
            const junkKept = (await applyDeletes([junk])).length > 0;
            return { cameBack, othersSafe, junkKept };
        }, { old: copyOnB, stamp: ID });
        report('Deleted posts do not come back', !deleteChecks.cameBack);
        report('Only the author can delete a post', deleteChecks.othersSafe);
        report('Junk delete notes are ignored', !deleteChecks.junkKept);

        const lateContext = await browser.newContext();
        if (setup) await setup(lateContext);
        const late = await lateContext.newPage();
        await late.goto(`${APP_URL}/?testRoom=${TEST_ROOM}-solo-late`);
        await late.waitForFunction(() => document.getElementById('username-display')?.textContent);
        await late.evaluate(async (old) => {
            const { importEntries } = await import('/src/browser/storage/db.js');
            await importEntries([old]);
        }, copyOnB);
        await late.goto(`${APP_URL}/?testRoom=${TEST_ROOM}`);
        await late.waitForFunction(() => document.getElementById('username-display')?.textContent);
        await waitForPeers(late, 1);
        report('Browsers that missed a delete catch up', await goneFrom(late, deleteURL));
        await lateContext.close();
        await a.fill('#search-input', '');
        await b.fill('#search-input', '');

        const chatText = `hello <b>bold?</b> ${ID}`;
        await a.click('#chat-toggle');
        await a.fill('#chat-input', chatText);
        await a.click('#chat-form button[type="submit"]');
        await b.click('#chat-toggle');
        const chatShown = await b.waitForFunction((text) => [...document.querySelectorAll('#chat-list .chat-text')]
            .some((item) => item.textContent === text), chatText, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Chat messages reach the other browser', chatShown);
        report('Chat messages stay plain text', await b.evaluate(() => !document.querySelector('#chat-list b')));

        const chatChecks = await b.evaluate(async ({ takenName, stamp }) => {
            const { getMessages, receiveChat, receiveHistory } = await import('/src/browser/network/chat.js');
            const { importSigningKey, signChat, toBase64Url } = await import('/src/shared/signing.js');
            const makeKeys = async () => {
                const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
                return importSigningKey(
                    toBase64Url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
                    toBase64Url(await crypto.subtle.exportKey('raw', pair.publicKey))
                );
            };
            const has = (text) => getMessages().some((message) => message.text === text);
            const base = Date.now() - 60000;

            const honest = await signChat({ room: 'global', name: `Tester${stamp}`, time: Date.now(), text: `real ${stamp}` }, await makeKeys());
            await receiveChat({ ...honest, text: `changed ${stamp}` }, 'test-peer');
            const changedKept = has(`changed ${stamp}`);

            const stolen = await signChat({ room: 'global', name: takenName, time: Date.now(), text: `stolen ${stamp}` }, await makeKeys());
            await receiveChat(stolen, 'test-peer');
            const stolenKept = has(`stolen ${stamp}`);

            const linked = await signChat({ room: 'global', name: `Link${stamp}`, time: Date.now(), text: `see example.com ${stamp}` }, await makeKeys());
            await receiveChat(linked, 'test-peer');
            const linkKept = has(`see example.com ${stamp}`);

            const spammer = await makeKeys();
            let spamKept = 0;
            for (let index = 0; index < 15; index++) {
                const spam = await signChat({ room: 'global', name: `ChatSpam${stamp}`, time: Date.now(), text: `spam ${index} ${stamp}` }, spammer);
                await receiveChat(spam, 'test-peer');
                if (has(`spam ${index} ${stamp}`)) spamKept += 1;
            }

            const many = [];
            for (let index = 0; index < 30; index++) {
                many.push(await signChat({ room: 'global', name: `Many${index}x${stamp}`, time: base + 10000 + index * 1000, text: `many ${index} ${stamp}` }, await makeKeys()));
            }
            await receiveHistory(many);
            await new Promise((r) => setTimeout(r, 300));
            const kept = getMessages();
            return {
                changedKept, stolenKept, linkKept, spamKept,
                count: kept.length,
                newestKept: has(`many 29 ${stamp}`),
                oldestGone: !has(`many 0 ${stamp}`),
                shown: document.querySelectorAll('#chat-list .chat-message').length
            };
        }, { takenName: await a.textContent('#username-display'), stamp: ID });
        report('Changed chat messages are rejected', !chatChecks.changedKept);
        report('Nobody can chat under a taken name', !chatChecks.stolenKept);
        report('Links from other people are dropped', !chatChecks.linkKept);
        report('Chat spam is capped', chatChecks.spamKept === 10, `${chatChecks.spamKept} of 15 kept`);
        report('Only the newest 25 messages are kept', chatChecks.count === 25 && chatChecks.newestKept && chatChecks.oldestGone
            && chatChecks.shown <= 25, JSON.stringify(chatChecks));
        const linkBlocked = await a.evaluate(async () => {
            const { sendChat, hasLink } = await import('/src/browser/network/chat.js');
            const tries = ['go to https://x.test', 'www.example', 'example.com/page', 'magnet:?xt=urn:btih:abc',
                'visit 192.168.1.1', 'site\u200B.com', 'ｅｘａｍｐｌｅ．ｃｏｍ'];
            const results = await Promise.all(tries.map((text) => sendChat(text)));
            return {
                allBlocked: results.every((result) => result.reason === 'link'),
                normalTextOk: !hasLink('see you at 5.30, the coliseum was great!')
            };
        });
        const floodChecks = await b.evaluate(async (stamp) => {
            const { receiveChat, chatStats } = await import('/src/browser/network/chat.js');
            const { importSigningKey, signChat, toBase64Url } = await import('/src/shared/signing.js');
            await new Promise((r) => setTimeout(r, 10500));
            const before = chatStats.rejected.busy || 0;
            for (let index = 0; index < 50; index++) {
                const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
                const keys = await importSigningKey(
                    toBase64Url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
                    toBase64Url(await crypto.subtle.exportKey('raw', pair.publicKey))
                );
                await receiveChat(await signChat({ room: 'global', name: `Flood${index}x${stamp}`, time: Date.now(), text: `flood ${index}` }, keys), 'test-peer');
            }
            return (chatStats.rejected.busy || 0) - before;
        }, ID);
        report('A flood of new keys is capped too', floodChecks >= 10, `${floodChecks} of 50 dropped`);
        report('Links cannot be sent in chat', linkBlocked.allBlocked && linkBlocked.normalTextOk, JSON.stringify(linkBlocked));

        const otherRoomPage = await openPeer(browser, 'ChatMusic', setup, `testRoom=${TEST_ROOM}&room=music`);
        const globalText = `global hello ${ID}`;
        await a.evaluate(async (text) => {
            const { sendChat } = await import('/src/browser/network/chat.js');
            await new Promise((r) => setTimeout(r, 2000));
            await sendChat(text);
        }, globalText);
        const reachedOtherRoom = await otherRoomPage.waitForFunction(async (text) => {
            const { getMessages } = await import('/src/browser/network/chat.js');
            return getMessages().some((message) => message.text === text);
        }, globalText, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Chat reaches people in other rooms', reachedOtherRoom);
        report('The chat uses no innerHTML', await otherRoomPage.evaluate(async () => {
            const code = await (await fetch('/src/browser/ui/chatPanel.js')).text()
                + await (await fetch('/src/browser/network/chat.js')).text();
            return !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code);
        }));
        await otherRoomPage.close();

        await a.click('#chat-close');
        await b.click('#chat-close');

        const workChecks = await b.evaluate(async (stamp) => {
            const { getEntryByURL } = await import('/src/browser/storage/db.js');
            const { toPublicEntry } = await import('/src/shared/entryId.js');
            const { gossip } = await import('/src/browser/network/gossip.js');
            const { signEntry } = await import('/src/shared/signing.js');
            const { hasWork } = await import('/src/shared/work.js');
            const lazy = await signEntry({
                sourceURL: `https://example.com/t/no-work-${stamp}/1`, magnet: null, instantIOLink: null,
                title: 'no work', addedBy: `Lazy${stamp}`, timestamp: Date.now(), room: 'general', hasPreview: false
            });
            await gossip.receiveEntry(toPublicEntry(lazy), 'test-peer');
            const real = await getEntryByURL(`https://example.com/t/fake-link-a-${stamp}/1`);
            return {
                lazyKept: Boolean(await getEntryByURL(lazy.sourceURL)),
                realHasWork: Number.isSafeInteger(real?.work) && await hasWork(real, 12)
            };
        }, ID);
        report('Posts without proof of work are rejected', !workChecks.lazyKept);
        report('Real posts carry proof of work', workChecks.realHasWork);
        report('The live site asks for 18 bits of work', await b.evaluate(async () => {
            const code = await (await fetch('/src/shared/work.js')).text();
            return /: 18;/.test(code) && /Date\.UTC\(2026, 10, 10\)/.test(code);
        }));

        const storeRelay = startRelay({ port: 7792, store: true });
        const storeOptions = `testRoom=${TEST_ROOM}-store&storeRelay=ws://localhost:7792`;
        const storePoster = await openPeer(browser, 'StorePoster', setup, storeOptions);
        const keptURL = `https://example.com/t/kept-on-relay-${ID}/1`;
        const goneURL = `https://example.com/t/deleted-on-relay-${ID}/1`;
        await addLink(storePoster, keptURL, { magnet: `magnet:?xt=urn:btih:${hash}`, title: 'Kept on relay' });
        await addLink(storePoster, goneURL, { magnet: `magnet:?xt=urn:btih:${hash}` });
        const goneEntry = await hasLink(storePoster, goneURL);
        await hasLink(storePoster, keptURL);
        await storePoster.evaluate(async (id) => {
            const { deleteOwnPost } = await import('/src/browser/network/deletes.js');
            await deleteOwnPost(id);
        }, goneEntry.entryId);
        await new Promise((r) => setTimeout(r, 1500));
        const keptEntry = await storePoster.evaluate(async (url) => {
            const { getEntryByURL } = await import('/src/browser/storage/db.js');
            return getEntryByURL(url);
        }, keptURL);
        await storePoster.close();

        // Someone puts a changed copy straight onto the relay
        await new Promise((resolve) => {
            const socket = new WebSocket('ws://localhost:7792');
            socket.on('open', () => {
                const forged = { u: `https://example.com/t/forged-${ID}/1`, a: keptEntry.addedBy, s: keptEntry.timestamp,
                    t: 'Forged', k: keptEntry.authorKey, g: keptEntry.signature, w: keptEntry.work };
                socket.send(JSON.stringify(['EVENT', { id: 'f'.repeat(64), pubkey: 'e'.repeat(64), created_at: 1, kind: 30078,
                    tags: [['d', 'forged'], ['t', `${TEST_ROOM}-store-general`]], content: JSON.stringify(forged), sig: '0'.repeat(128) }]));
                setTimeout(() => { socket.close(); resolve(); }, 300);
            });
        });

        const visitorPage = await openPeer(browser, 'StoreVisitor', setup, storeOptions);
        const loadedFromRelay = await hasLink(visitorPage, keptURL);
        const visitorState = await visitorPage.evaluate(async ({ gone, forged }) => {
            const { getEntryByURL } = await import('/src/browser/storage/db.js');
            const { storeStats } = await import('/src/browser/network/nostrStore.js');
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            await new Promise((r) => setTimeout(r, 1000));
            return {
                loaded: storeStats.loaded,
                peers: peerManager.peers.size,
                goneBack: Boolean(await getEntryByURL(gone)),
                forgedKept: Boolean(await getEntryByURL(forged))
            };
        }, { gone: goneURL, forged: `https://example.com/t/forged-${ID}/1` });
        report('New visitors get links from relays when nobody is online', Boolean(loadedFromRelay)
            && visitorState.loaded > 0 && visitorState.peers === 0, JSON.stringify(visitorState));
        report('Deleted posts stay deleted for new visitors', !visitorState.goneBack);
        report('Changed copies on relays are rejected', !visitorState.forgedKept);
        await visitorPage.close();
        await storeRelay.close();

        const adminKey = await makeTestKey();
        const adminOptions = `testRoom=${TEST_ROOM}-admin&adminKey=${adminKey.publicKey}`;
        const adminContext = await browser.newContext();
        if (setup) await setup(adminContext);
        await adminContext.addInitScript((key) => {
            localStorage.setItem('webtorrent-signing-key', JSON.stringify(key));
        }, adminKey);
        const admin = await adminContext.newPage();
        admin.on('pageerror', (e) => console.log(`  [Admin error] ${e.message}`));
        await admin.goto(`${APP_URL}/?${adminOptions}${TEST_WORK}`);
        await admin.waitForFunction(() => document.getElementById('username-display')?.textContent);
        const member = await openPeer(browser, 'Member', setup, adminOptions);
        await Promise.all([waitForPeers(admin, 1), waitForPeers(member, 1)]);

        const memberURL = (name) => `https://example.com/t/${name}-${ID}/1`;
        await addLink(member, memberURL('member-room-one'), { magnet: `magnet:?xt=urn:btih:${hash}` });
        await hasLink(admin, memberURL('member-room-one'));
        await member.selectOption('#room-select', 'movies');
        await new Promise((r) => setTimeout(r, 1000));
        await addLink(member, memberURL('member-room-two'), { magnet: `magnet:?xt=urn:btih:${hash}` });
        await new Promise((r) => setTimeout(r, 500));
        await member.selectOption('#room-select', 'general');
        await waitForPeers(member, 1);

        await member.click('#profile-card');
        report('Only the admin sees admin tools', await member.isHidden('#admin-tools')
            && await admin.evaluate(() => !document.getElementById('admin-tools').hidden));
        await member.click('#my-posts-btn');
        await member.waitForSelector('#my-posts-list .my-post', { timeout: WAIT_MS });
        const myPosts = await member.evaluate(() => [...document.querySelectorAll('#my-posts-list .my-post')]
            .map((row) => row.textContent));
        report('My posts lists your posts from every room', myPosts.length === 2
            && myPosts.some((text) => text.includes('Room 1')) && myPosts.some((text) => text.includes('Room 2')),
            myPosts.map((text) => text.replace(/\s+/g, ' ').slice(0, 60)).join(' | '));
        const roomTwoRow = '#my-posts-list .my-post:has(.my-post-meta:text-matches("Room 2")) .my-post-delete';
        await member.click(roomTwoRow);
        const asksFirstHere = await member.textContent(roomTwoRow) === 'Sure?';
        await member.click(roomTwoRow);
        await member.waitForFunction(() => document.querySelectorAll('#my-posts-list .my-post').length === 1,
            null, { timeout: WAIT_MS }).catch(() => {});
        report('You can delete your posts from My posts', asksFirstHere
            && await countLink(member, memberURL('member-room-two')) === 0
            && await member.evaluate(() => document.querySelectorAll('#my-posts-list .my-post').length) === 1);
        report('My posts uses no innerHTML', await member.evaluate(async () => {
            const code = await (await fetch('/src/browser/ui/myPosts.js')).text();
            return !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code);
        }));
        await member.click('#my-posts-close');

        await admin.fill('#search-input', `member-room-one-${ID}`);
        const removeButton = `.results-table tr:has(a[href="${memberURL('member-room-one')}"]) [data-action="delete"]`;
        await admin.waitForSelector(removeButton, { timeout: WAIT_MS });
        const removeLabel = await admin.textContent(removeButton);
        await admin.click(removeButton);
        await admin.click(removeButton);
        const removedEverywhere = async (url) => {
            const deadline = Date.now() + WAIT_MS;
            while (Date.now() < deadline) {
                if (await countLink(admin, url) === 0 && await countLink(member, url) === 0) return true;
                await new Promise((r) => setTimeout(r, 200));
            }
            return false;
        };
        report('The admin can remove anyone\'s post', removeLabel === 'Remove'
            && await removedEverywhere(memberURL('member-room-one')));
        await admin.fill('#search-input', '');

        await addLink(member, memberURL('before-clear'), { magnet: `magnet:?xt=urn:btih:${hash}` });
        const beforeClear = await hasLink(admin, memberURL('before-clear'));
        await new Promise((r) => setTimeout(r, 50));
        await admin.click('#profile-card');
        await admin.click('#clear-all-btn');
        await admin.click('#clear-all-btn');
        const stillThere = await countLink(admin, memberURL('before-clear')) === 1;
        const lastWarning = await admin.textContent('#clear-all-btn');
        await admin.click('#clear-all-btn');
        report('Clear all needs 3 clicks', stillThere && lastWarning.includes('1 more'), lastWarning);
        report('Clear all removes every post for everyone', await removedEverywhere(memberURL('before-clear')));
        await admin.click('#name-cancel');

        const afterClear = await member.evaluate(async (old) => {
            const { getEntryByURL } = await import('/src/browser/storage/db.js');
            const { toPublicEntry } = await import('/src/shared/entryId.js');
            const { gossip } = await import('/src/browser/network/gossip.js');
            await gossip.receiveEntry(toPublicEntry(old), 'test-peer');
            const cameBack = Boolean(await getEntryByURL(old.sourceURL));
            const { applyWipe } = await import('/src/browser/storage/db.js');
            const { signWipe } = await import('/src/shared/signing.js');
            const fakeWipe = await applyWipe(await signWipe(Date.now()));
            return { cameBack, fakeWipe };
        }, beforeClear);
        report('Cleared posts do not come back', !afterClear.cameBack);
        report('Only the admin can clear posts', !afterClear.fakeWipe);
        await addLink(member, memberURL('after-clear'), { magnet: `magnet:?xt=urn:btih:${hash}` });
        report('New posts work after a clear', Boolean(await hasLink(admin, memberURL('after-clear'))));
        await adminContext.close();
        await member.close();

        const c = await openPeer(browser, 'C', setup);
        await waitForPeers(c, 2);
        const historyArrived = await c.waitForFunction(async () => {
            const { getMessages } = await import('/src/browser/network/chat.js');
            return getMessages().length === 25;
        }, null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('New people get the last 25 messages', historyArrived);
        const tableShown = await c.waitForFunction(() => {
            const rows = document.querySelectorAll('#peer-table-body tr').length;
            const online = document.getElementById('peer-online-count').textContent;
            const direct = document.getElementById('peer-direct-count').textContent;
            return rows === 3 && online === '3' && direct === '3';
        }, null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Peer table shows live counts', tableShown);

        await c.evaluate(async () => {
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            const { renderPeerTable } = await import('/src/browser/ui/peerTable.js');
            for (let i = 0; i < 20; i++) {
                peerManager.profiles.set(`fake-peer-${i}`, {
                    username: `Fake User ${i}`, avatar: null, connections: 1, links: 0, connectedAt: Date.now(),
                    lastSeen: Date.now(), ready: true
                });
            }
            await renderPeerTable();
        });
        report('Bar shows 4 profiles and the total', await c.evaluate(() =>
            document.querySelectorAll('#peer-bar-avatars .peer-avatar').length === 4
            && document.getElementById('peer-bar-count').textContent.endsWith(' online')));
        report('Table stays closed until clicked', await c.isHidden('#peer-modal'));

        await c.click('#peer-bar');
        const size = await c.evaluate(() => {
            const box = document.querySelector('.peer-panel').getBoundingClientRect();
            const scroll = document.querySelector('.peer-panel-scroll');
            return {
                width: box.width,
                height: box.height,
                centered: Math.abs(box.left + box.width / 2 - innerWidth / 2) <= 1,
                rows: document.querySelectorAll('#peer-table-body tr').length,
                fits: scroll.scrollHeight <= scroll.clientHeight
            };
        });
        report('Table is 600 by 400 and centered',
            size.width === 600 && size.height === 400 && size.centered, JSON.stringify(size));
        report('Table shows 13 users without scrolling', size.rows === 13 && size.fits);

        await c.click('#peer-next');
        const pageTwo = await c.waitForFunction(() =>
            document.getElementById('peer-page-info').textContent.startsWith('Page 2')
            && document.querySelectorAll('#peer-table-body tr').length === 10,
            null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Pagination shows the next users', pageTwo);
        await c.click('#peer-close');
        report('Late joiner receives existing links', !!(await hasLink(c, u1)));
        await c.evaluate(async () => {
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            for (let i = 0; i < 20; i++) peerManager.profiles.delete(`fake-peer-${i}`);
        });

        const presenceOptions = `testRoom=${TEST_ROOM}-presence`;
        const stay = await openPeer(browser, 'Stay', setup, presenceOptions);
        const visit = await openPeer(browser, 'Visit', setup, presenceOptions);
        await Promise.all([waitForPeers(stay, 1), waitForPeers(visit, 1)]);
        const visitName = await visit.textContent('#username-display');
        const rowsFor = (name) => stay.evaluate((target) => [...document.querySelectorAll('#peer-table-body tr')]
            .filter((row) => row.children[1]?.textContent === target).length, name);
        const onlineCount = () => stay.evaluate(() => document.getElementById('peer-online-count').textContent);
        const shownOnce = await stay.waitForFunction(async (target) => (
            [...document.querySelectorAll('#peer-table-body tr')]
                .filter((row) => row.children[1]?.textContent === target).length === 1
        ), visitName, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('New people show in the bar', shownOnce);

        await visit.reload();
        await visit.waitForFunction(() => document.getElementById('username-display')?.textContent);
        const reloadStart = Date.now();
        let doubled = false;
        while (Date.now() - reloadStart < 8000) {
            if (await rowsFor(visitName) > 1) doubled = true;
            await new Promise((r) => setTimeout(r, 250));
        }
        await stay.waitForFunction(async (target) => {
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            return [...peerManager.profiles.values()].some((profile) => profile.username === target && profile.ready);
        }, visitName, { timeout: WAIT_MS });
        const quietCheck = await stay.evaluate(async (target) => {
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            const { renderPeerTable } = await import('/src/browser/ui/peerTable.js');
            const entry = [...peerManager.profiles.values()].find((profile) => profile.username === target);
            entry.lastSeen = Date.now() - 5 * 60 * 1000;
            await renderPeerTable();
            const row = () => [...document.querySelectorAll('#peer-table-body tr')]
                .find((item) => item.children[1]?.textContent === target);
            const stillShown = Boolean(row());
            const markedIdle = row()?.children[5]?.textContent.includes('idle');
            peerManager.checkAlive();
            await new Promise((r) => setTimeout(r, 1500));
            await renderPeerTable();
            return { stillShown, markedIdle, answered: Date.now() - entry.lastSeen < 5000 && !row()?.children[5]?.textContent.includes('idle') };
        }, visitName);
        report('Quiet tabs stay in the bar', quietCheck.stillShown && quietCheck.markedIdle, JSON.stringify(quietCheck));
        report('Tabs answer "are you there" right away', quietCheck.answered);

        report('A reload does not show someone twice', !doubled && await rowsFor(visitName) === 1,
            `online ${await onlineCount()}`);

        // What a phone's browser does when the screen turns off, then on again
        await visit.evaluate(() => document.dispatchEvent(new Event('freeze')));
        const droppedWhenAsleep = await stay.waitForFunction(
            () => document.getElementById('peer-online-count').textContent === '1',
            null, { timeout: 10000 }).then(() => true).catch(() => false);
        await new Promise((r) => setTimeout(r, 1000));
        await visit.evaluate(() => document.dispatchEvent(new Event('resume')));
        const backAfterWaking = await stay.waitForFunction(
            () => document.getElementById('peer-online-count').textContent === '2',
            null, { timeout: 20000 }).then(() => true).catch(() => false);
        report('A phone that goes to sleep is dropped right away', droppedWhenAsleep);
        report('A phone that wakes up shows again without a refresh', backAfterWaking);

        const silentDrop = await stay.evaluate(async (target) => {
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            const entry = [...peerManager.profiles.values()].find((profile) => profile.username === target);
            entry.pingedAt = Date.now() - 60000;
            peerManager.checkAlive();
            await new Promise((r) => setTimeout(r, 300));
            return ![...peerManager.profiles.values()].some((profile) => profile.username === target);
        }, visitName);
        const reconnects = await stay.waitForFunction(
            () => document.getElementById('peer-online-count').textContent === '2',
            null, { timeout: 30000 }).then(() => true).catch(() => false);
        report('Dead connections are closed and replaced', silentDrop && reconnects);

        await visit.close();
        const leftQuickly = await stay.waitForFunction(
            () => document.getElementById('peer-online-count').textContent === '1',
            null, { timeout: 5000 }).then(() => true).catch(() => false);
        report('People who leave disappear right away', leftQuickly);
        await stay.close();

        const splitOptions = `testRoom=${TEST_ROOM}-split&capacity=2`;
        const d = await openPeer(browser, 'D', setup, splitOptions);
        const e = await openPeer(browser, 'E', setup, splitOptions);
        await Promise.all([waitForPeers(d, 1), waitForPeers(e, 1)]);
        const f = await openPeer(browser, 'F', setup, splitOptions);
        const roomText = (page) => page.evaluate(() => document.getElementById('peer-room-name').textContent);
        const moved = await f.waitForFunction(
            () => document.getElementById('peer-room-name').textContent.startsWith('Room 1 · group 2'),
            null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Full room splits automatically', moved, await roomText(f));

        await waitForPeers(f, 1);
        const u7 = `https://example.com/t/fake-link-g-${ID}/7`;
        const u8 = `https://example.com/t/fake-link-h-${ID}/8`;
        await addLink(e, u7, { magnet: `magnet:?xt=urn:btih:${hash}` });
        await addLink(f, u8, { magnet: `magnet:?xt=urn:btih:${hash}` });
        report('Links cross into the split room', Boolean(await hasLink(f, u7)));
        report('Links cross back from the split room', Boolean(await hasLink(e, u8)));

        const musicOptions = `testRoom=${TEST_ROOM}-topics`;
        const g = await openPeer(browser, 'G', setup, musicOptions);
        const h = await openPeer(browser, 'H', setup, musicOptions);
        await Promise.all([waitForPeers(g, 1), waitForPeers(h, 1)]);
        const u9 = `https://example.com/t/fake-link-i-${ID}/9`;
        await g.selectOption('#room-select', 'music');
        await new Promise((r) => setTimeout(r, 1000));
        await addLink(g, u9, { magnet: `magnet:?xt=urn:btih:${hash}` });
        await new Promise((r) => setTimeout(r, 3000));
        report('Other topics do not get the link', await countLink(h, u9) === 0);
        await h.selectOption('#room-select', 'music');
        const sameTopic = Boolean(await hasLink(h, u9));
        const topicState = async (page) => page.evaluate(async (url) => {
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            const { getEntryByURL } = await import('/src/browser/storage/db.js');
            const { syncStats } = await import('/src/browser/network/smartSync.js');
            return `${document.getElementById('room-select').value} peers=${peerManager.peers.size} `
                + `has=${Boolean(await getEntryByURL(url))} neg=${syncStats.negentropy} fp=${syncStats.fingerprints}`;
        }, u9);
        report('Same topic gets the link', sameTopic, sameTopic ? '' : `G: ${await topicState(g)} | H: ${await topicState(h)}`);

        const syncOptions = `testRoom=${TEST_ROOM}-smart&powBits=0`;
        const seedSyncLinks = async (page, onlyHere, offset) => page.evaluate(async ({ only, time, key, extraTime }) => {
            const { importEntries, updateEntryCount } = await import('/src/browser/storage/db.js');
            const { importSigningKey, signEntry } = await import('/src/shared/signing.js');
            const keys = await importSigningKey(key.privateKey, key.publicKey);
            const makeEntry = (name, timestamp) => signEntry({
                sourceURL: `https://example.com/t/${name}/1`, title: name, addedBy: 'Sync Test',
                timestamp, room: 'general', magnet: null, hasPreview: false
            }, keys);
            const shared = Array.from({ length: 2000 }, (_, i) => makeEntry(`shared-link-${i}`, time - i * 15000));
            const extras = Array.from({ length: 5 }, (_, i) => makeEntry(`${only}-${i}`, extraTime - i * 300000));
            await importEntries(await Promise.all([...shared, ...extras]));
            await updateEntryCount();
        }, { only: onlyHere, time: ID, key: testKey, extraTime: ID - offset });

        const seedPeer = async (name, onlyHere, offset) => {
            const context = await browser.newContext();
            if (setup) await setup(context);
            const page = await context.newPage();
            page.on('pageerror', (error) => console.log(`  [${name} error] ${error.message}`));
            await page.goto(`${APP_URL}/?testRoom=${TEST_ROOM}-solo-${name}`);
            await page.waitForFunction(() => document.getElementById('username-display')?.textContent);
            await seedSyncLinks(page, onlyHere, offset);
            await page.goto(`${APP_URL}/?${syncOptions}`);
            await page.waitForFunction(() => document.getElementById('username-display')?.textContent);
            return { page, context };
        };
        const [syncA, syncB] = await Promise.all([seedPeer('SyncA', 'only-a', 40000000), seedPeer('SyncB', 'only-b', 50000000)]);
        await Promise.all([waitForPeers(syncA.page, 1), waitForPeers(syncB.page, 1)]);
        const aGot = await hasLink(syncA.page, 'https://example.com/t/only-b-3/1');
        const bGot = await hasLink(syncB.page, 'https://example.com/t/only-a-3/1');
        report('Smart sync swaps only what is missing', Boolean(aGot && bGot));
        const negentropyUsed = await Promise.all([syncA.page, syncB.page].map((page) => page.evaluate(async () => {
            const { syncStats } = await import('/src/browser/network/smartSync.js');
            return syncStats.negentropy;
        })));
        report('Sync uses Negentropy', negentropyUsed[0] + negentropyUsed[1] > 0, JSON.stringify(negentropyUsed));
        const oldMethod = await syncA.page.evaluate(async ({ key, time }) => {
            const { importEntries, getEntryByURL } = await import('/src/browser/storage/db.js');
            const { importSigningKey, signEntry } = await import('/src/shared/signing.js');
            const { startSync, forgetSyncCache } = await import('/src/browser/network/smartSync.js');
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            const keys = await importSigningKey(key.privateKey, key.publicKey);
            const entry = await signEntry({
                sourceURL: 'https://example.com/t/old-method-link/1', title: 'old method', addedBy: 'Sync Test',
                timestamp: time, room: 'general', magnet: null, hasPreview: false
            }, keys);
            await importEntries([entry]);
            forgetSyncCache();
            const [connection] = [...peerManager.peers.values()];
            await startSync(connection, true, 1);
            return Boolean(await getEntryByURL(entry.sourceURL));
        }, { key: testKey, time: ID - 60 * 60 * 1000 });
        report('Older browsers still sync the old way', oldMethod
            && Boolean(await hasLink(syncB.page, 'https://example.com/t/old-method-link/1')));
        const syncBytes = await Promise.all([syncA.page, syncB.page].map((page) => page.evaluate(async () => {
            const { syncStats } = await import('/src/browser/network/smartSync.js');
            return syncStats.sentBytes;
        })));
        const totalSyncBytes = syncBytes[0] + syncBytes[1];
        report('Sync traffic stays small', totalSyncBytes < 30000, `${totalSyncBytes} bytes for 2005 links`);
        await syncA.context.close();
        await syncB.context.close();

        const shareOptions = `testRoom=${TEST_ROOM}-share&snapshotMin=100&snapshotChunk=8192&powBits=0`;
        const seedOldLinks = async (name) => {
            const context = await browser.newContext();
            if (setup) await setup(context);
            const page = await context.newPage();
            await page.goto(`${APP_URL}/?testRoom=${TEST_ROOM}-solo-${name}`);
            await page.waitForFunction(() => document.getElementById('username-display')?.textContent);
            await page.evaluate(async ({ time, key }) => {
                const { importEntries, updateEntryCount } = await import('/src/browser/storage/db.js');
                const { importSigningKey, signEntry } = await import('/src/shared/signing.js');
                const keys = await importSigningKey(key.privateKey, key.publicKey);
                const entries = await Promise.all(Array.from({ length: 3000 }, (_, index) => signEntry({
                    sourceURL: `https://example.com/t/shared-archive-${index}-${(index * 7919).toString(36)}/${index}`,
                    title: `Archive ${(index * 104729).toString(36)}`, addedBy: 'Archive', timestamp: time + index * 15000,
                    room: 'general', magnet: null, hasPreview: false
                }, keys)));
                await importEntries(entries);
                await updateEntryCount();
            }, { time: ID - 30 * 24 * 60 * 60 * 1000, key: testKey });
            await page.goto(`${APP_URL}/?${shareOptions}`);
            await page.waitForFunction(() => document.getElementById('username-display')?.textContent);
            return { page, context };
        };
        const [shareA, shareB] = await Promise.all([seedOldLinks('ShareA'), seedOldLinks('ShareB')]);
        await waitForPeers(shareA.page, 1);
        const shareC = await openPeer(browser, 'ShareC', setup, shareOptions);
        const readShareStats = () => shareC.evaluate(async () => {
            const { getEntryCount } = await import('/src/browser/storage/db.js');
            const { snapshotStats } = await import('/src/browser/network/snapshotManager.js');
            const { syncStats } = await import('/src/browser/network/smartSync.js');
            return {
                links: await getEntryCount(),
                restored: snapshotStats.restored,
                chunks: snapshotStats.chunks,
                peers: snapshotStats.peers.size,
                syncBytes: syncStats.sentBytes
            };
        });
        let shareStats = await readShareStats();
        const shareDeadline = Date.now() + WAIT_MS;
        while (shareStats.links < 3000 && Date.now() < shareDeadline) {
            await new Promise((r) => setTimeout(r, 200));
            shareStats = await readShareStats();
        }
        report('New user gets a snapshot', shareStats.restored === 3000, JSON.stringify(shareStats));
        report('Snapshot comes from several peers', shareStats.peers === 2);

        const badSnapshotRejected = await shareC.evaluate(async () => {
            const { importSnapshot } = await import('/src/browser/storage/db.js');
            const junk = new TextEncoder().encode('fake snapshot');
            return importSnapshot('general', junk, '00000000000000000000000000000000').then(() => false, () => true);
        });
        report('Fake snapshots are rejected', badSnapshotRejected);
        await shareA.context.close();
        await shareB.context.close();

        const sharedText = await a.textContent('#shared-links');
        report('Sharing stats count sent links', Number(sharedText) > 0, `${sharedText} links`);

        await a.click('#seed-toggle');
        report('Seeding mode switches on', await a.getAttribute('#seed-toggle', 'aria-pressed') === 'true');
        await a.click('#seed-toggle');

        const magnetFixPage = await openPeer(browser, 'MagnetFix', setup, `testRoom=${TEST_ROOM}-magnet`);
        const instantInMagnet = `https://example.com/t/instant-in-magnet-${ID}/1`;
        await addLink(magnetFixPage, instantInMagnet, { magnet: `https://instant.io/#${hash}` });
        const fixedEntry = await hasLink(magnetFixPage, instantInMagnet);
        report('instant.io links in the magnet box are fixed',
            fixedEntry?.magnet === `magnet:?xt=urn:btih:${hash}` && fixedEntry?.instantIOLink === `https://instant.io/#${hash}`);
        await magnetFixPage.close();

        const rejoinOptions = `testRoom=${TEST_ROOM}-rejoin&rejoinMs=1000`;
        const aloneA = await openPeer(browser, 'AloneA', setup, rejoinOptions);
        await new Promise((r) => setTimeout(r, 3500));
        const attempts = await aloneA.evaluate(async () => {
            const { rejoinStats } = await import('/src/browser/network/roomNetwork.js');
            return rejoinStats.attempts;
        });
        report('Empty rooms rejoin automatically', attempts >= 2, `${attempts} rejoins`);
        const aloneB = await openPeer(browser, 'AloneB', setup, rejoinOptions);
        const rejoined = await Promise.all([waitForPeers(aloneA, 1), waitForPeers(aloneB, 1)])
            .then(() => true).catch(() => false);
        report('Peers connect after rejoining', rejoined);
        await aloneA.close();
        await aloneB.close();

        const relay = startRelay({ port: 7791 });
        const relayPages = [];
        for (const name of ['RelayA', 'RelayB']) {
            const context = await browser.newContext();
            await context.routeWebSocket(/^wss:/, (socket) => socket.close());
            await context.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
            const page = await context.newPage();
            await page.goto(`${APP_URL}/?testRoom=${TEST_ROOM}-bootstrap&relay=ws://localhost:7791`);
            await page.waitForFunction(() => document.getElementById('username-display')?.textContent);
            relayPages.push({ page, context });
        }
        const viaBootstrap = await Promise.all(relayPages.map(({ page }) => waitForPeers(page, 1)))
            .then(() => true).catch(() => false);
        report('Peers meet through the bootstrap relay alone', viaBootstrap, `${relay.stats.events} introductions`);
        await Promise.all(relayPages.map(({ context }) => context.close()));

        const meshOptions = `testRoom=${TEST_ROOM}-mesh&capacity=3&visitors=3&linkRetryMs=1500&linkCheckMs=4000`
            + '&relay=ws://localhost:7791&publicRelays=off';
        const mesh = [];
        for (let index = 0; index < 12; index++) {
            mesh.push(await openPeer(browser, `Mesh${index}`, setup, meshOptions));
            await new Promise((r) => setTimeout(r, 400));
        }
        const meshState = () => Promise.all(mesh.map((page) => page.evaluate(async () => {
            const { getCellStats } = await import('/src/browser/network/roomNetwork.js');
            const { peerManager } = await import('/src/browser/network/peerManager.js');
            return { ...getCellStats(), peers: peerManager.peers.size };
        })));
        const settleDeadline = Date.now() + WAIT_MS;
        let states = await meshState();
        while (Date.now() < settleDeadline) {
            const homes = new Set(states.map((state) => state.home));
            if (homes.size >= 4 && states.every((state) => state.peers > 0)) break;
            await new Promise((r) => setTimeout(r, 1000));
            states = await meshState();
        }
        await new Promise((r) => setTimeout(r, 6000));
        states = await meshState();
        const cellCount = new Set(states.map((state) => state.home)).size;
        const maxPeers = Math.max(...states.map((state) => state.peers));
        const averagePeers = states.reduce((total, state) => total + state.peers, 0) / states.length;
        report('Peers spread out into small cells', cellCount >= 4, `${cellCount} cells`);
        report('Each browser keeps few connections', maxPeers <= 10 && averagePeers <= 8,
            `average ${averagePeers.toFixed(1)}, max ${maxPeers}, of 11 others`);

        const meshURL = `https://example.com/t/mesh-link-${ID}/1`;
        await addLink(mesh[0], meshURL, { magnet: `magnet:?xt=urn:btih:${hash}` });
        const reached = await Promise.all(mesh.map((page) => hasLink(page, meshURL)));
        const reachedCount = reached.filter(Boolean).length;
        report('Links hop across every cell', reachedCount === mesh.length, `${reachedCount} of ${mesh.length}`);
        const meshChat = `mesh chat ${ID}`;
        await mesh[0].evaluate(async (text) => {
            const { sendChat } = await import('/src/browser/network/chat.js');
            await sendChat(text);
        }, meshChat);
        const chatReached = await Promise.all(mesh.map((page) => page.waitForFunction(async (text) => {
            const { getMessages } = await import('/src/browser/network/chat.js');
            return getMessages().some((message) => message.text === text);
        }, meshChat, { timeout: WAIT_MS }).then(() => true).catch(() => false)));
        const chatCount = chatReached.filter(Boolean).length;
        report('Chat hops across every cell', chatCount === mesh.length, `${chatCount} of ${mesh.length}`);
        await Promise.all(mesh.map((page) => page.close()));
        await relay.close();

        const roomPage = await openPeer(browser, 'RoomLink', setup, `testRoom=${TEST_ROOM}-link&room=music`);
        report('Room links open the right topic', await roomPage.inputValue('#room-select') === 'music');
        const roomNames = await roomPage.evaluate(() => [...document.querySelectorAll('#room-select option')]
            .map((option) => option.textContent));
        report('Rooms are named Room 1 to Room 6', roomNames.length === 6
            && roomNames.every((name, index) => name.startsWith(`Room ${index + 1}`))
            && roomNames[2].endsWith('(1/50)'), roomNames.join(', '));
        report('The page explains rooms', (await roomPage.textContent('.room-note')).includes('up to 50 people'));
        const numberLink = await openPeer(browser, 'NumberLink', setup, `testRoom=${TEST_ROOM}-link&room=5`);
        report('Room number links work', await numberLink.inputValue('#room-select') === 'games');
        await numberLink.close();

        const fullOptions = `testRoom=${TEST_ROOM}-full&roomMax=2&roomSettleMs=3000&hereMs=1500`;
        const first = await openPeer(browser, 'Full1', setup, fullOptions);
        const second = await openPeer(browser, 'Full2', setup, fullOptions);
        await Promise.all([waitForPeers(first, 1), waitForPeers(second, 1)]);
        await new Promise((r) => setTimeout(r, 1500));
        const third = await openPeer(browser, 'Full3', setup, fullOptions);
        const roomCount = (page) => page.evaluate(async () => {
            const { getRoomCount } = await import('/src/browser/network/roomPresence.js');
            return getRoomCount();
        });
        const countedFull = await first.waitForFunction(async () => {
            const { getRoomCount } = await import('/src/browser/network/roomPresence.js');
            return getRoomCount() === 3;
        }, null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Everyone in a room is counted', countedFull);
        const thirdMoved = await third.waitForFunction(
            () => document.getElementById('room-select').value === 'movies',
            null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        const toldWhy = thirdMoved && await third.evaluate(() => [...document.querySelectorAll('.room-toast')]
            .some((toast) => toast.textContent.includes('Room 1 is full')));
        report('The newest person moves when a room is full', thirdMoved
            && await first.inputValue('#room-select') === 'general'
            && await second.inputValue('#room-select') === 'general');
        report('They are told why they moved', toldWhy);
        const settledCounts = await first.waitForFunction(async () => {
            const { getRoomCount } = await import('/src/browser/network/roomPresence.js');
            return getRoomCount() === 2;
        }, null, { timeout: 3000 }).then(() => true).catch(() => false);
        await new Promise((r) => setTimeout(r, 3000));
        const stillTwo = await roomCount(first) === 2 && await roomCount(second) === 2;
        report('Room counts go down right away when people leave', settledCounts && stillTwo,
            `${await roomCount(first)} in Room 1`);
        await Promise.all([first.close(), second.close(), third.close()]);
        const relayChoice = await roomPage.evaluate(async () => {
            const { PUBLIC_RELAYS, getPublicRelays, saveRelayHealth } = await import('/src/shared/networkConfig.js');
            saveRelayHealth([], ['wss://relay.damus.io']);
            const skipsDead = !getPublicRelays().includes('wss://relay.damus.io');
            saveRelayHealth(['wss://relay.damus.io'], []);
            const comesBack = getPublicRelays().includes('wss://relay.damus.io');
            saveRelayHealth([], PUBLIC_RELAYS);
            const keepsEnough = getPublicRelays().length === PUBLIC_RELAYS.length;
            localStorage.removeItem('webtorrent-dead-relays');
            return { skipsDead, comesBack, keepsEnough };
        });
        const turnContext = await browser.newContext();
        if (setup) await setup(turnContext);
        await turnContext.route('https://turn.test/**', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478'] },
                { urls: ['turn:turn.test:3478?transport=udp', 'turn:turn.test:53?transport=udp', 'turns:turn.test:443?transport=tcp'],
                    username: 'test-user', credential: 'test-pass' }
            ] })
        }));
        await turnContext.route('https://turn-down.test/**', (route) => route.fulfill({ status: 502, body: 'down' }));
        const turnPage = await turnContext.newPage();
        await turnPage.goto(`${APP_URL}/?testRoom=${TEST_ROOM}-turn&turnEndpoint=https://turn.test/ice&turnOnly=1`);
        await turnPage.waitForFunction(() => document.getElementById('username-display')?.textContent);
        const turnState = await turnPage.evaluate(async () => {
            const { getRtcConfig, getTurnConfig, loadTurnConfig } = await import('/src/shared/networkConfig.js');
            await new Promise((r) => setTimeout(r, 2500));
            const servers = getTurnConfig();
            const status = document.getElementById('peer-turn-status').textContent;
            const relayOnly = getRtcConfig()?.iceTransportPolicy === 'relay';
            const downStillWorks = await loadTurnConfig('https://turn-down.test/ice') === false && !getTurnConfig();
            return { servers, status, relayOnly, downStillWorks };
        });
        const turnURLs = turnState.servers?.[0]?.urls || [];
        report('TURN logins load from the worker', turnState.status === 'on' && turnState.servers?.length === 1
            && turnURLs.length === 2 && !turnURLs.some((url) => url.includes(':53')), JSON.stringify(turnURLs));
        report('TURN-only test mode works', turnState.relayOnly);
        report('The app still works if TURN is down', turnState.downStillWorks);
        await turnContext.close();

        report('Dead relays are skipped next time', relayChoice.skipsDead && relayChoice.comesBack && relayChoice.keepsEnough,
            JSON.stringify(relayChoice));
        await roomPage.close();

        const helperOptions = `&testRoom=${TEST_ROOM}-helper${TEST_WORK}`;
        const helperData = mkdtempSync(path.join(tmpdir(), 'webtorrent-helper-'));
        const helperSettings = {
            room: 'general', baseURL: APP_URL, dataDir: helperData, query: helperOptions, setup
        };
        const helperURL = `https://example.com/t/helper-link-${ID}/1`;
        let helper = await openHelper(helperSettings);
        const poster = await openPeer(browser, 'Poster', setup, `testRoom=${TEST_ROOM}-helper`);
        await waitForPeers(poster, 1);
        await addLink(poster, helperURL, { magnet: `magnet:?xt=urn:btih:${hash}` });
        report('Helper saves new links', Boolean(await hasLink(helper.page, helperURL)));
        await poster.close();

        await helper.context.close();
        helper = await openHelper(helperSettings);
        report('Helper keeps links after restarting', Boolean(await hasLink(helper.page, helperURL)));

        const visitor = await openPeer(browser, 'Visitor', setup, `testRoom=${TEST_ROOM}-helper`);
        await waitForPeers(visitor, 1);
        report('Helper serves links when nobody else is online', Boolean(await hasLink(visitor, helperURL)));
        await visitor.close();
        await helper.context.close();
        rmSync(helperData, { recursive: true, force: true });

        const tablePage = await openPeer(browser, 'Table', setup, `testRoom=${TEST_ROOM}-table`);
        await tablePage.evaluate(async (time) => {
            const { importEntries } = await import('/src/browser/storage/db.js');
            const { getEntryId } = await import('/src/shared/entryId.js');
            const entries = await Promise.all(Array.from({ length: 25 }, async (_, index) => {
                const entry = {
                    sourceURL: `https://example.com/t/table-row-${index}/${index}`, title: `Table Row ${index}`,
                    addedBy: 'Table Test', timestamp: time + index, room: 'general',
                    magnet: `magnet:?xt=urn:btih:${index.toString(16).padStart(40, '0')}`, hasPreview: false,
                    instantIOLink: `https://instant.io/#${index}`
                };
                entry.entryId = await getEntryId(entry);
                return entry;
            }));
            await importEntries(entries);
        }, ID);
        await tablePage.fill('#search-input', 'table row');
        await tablePage.waitForSelector('.results-table tbody tr', { timeout: WAIT_MS });
        report('Results show in a black table', await tablePage.evaluate(() => (
            document.querySelectorAll('.results-table tbody tr').length === 20
            && getComputedStyle(document.querySelector('.results-panel')).backgroundColor === 'rgb(0, 0, 0)'
        )));
        await tablePage.click('[data-action="next-page"]');
        const nextResults = await tablePage.waitForFunction(() => (
            document.querySelectorAll('.results-table tbody tr').length === 5
        ), null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Results table has pages', nextResults);
        report('Results table is 720 wide', await tablePage.evaluate(() => {
            const panel = document.querySelector('.results-panel');
            const scroll = document.querySelector('.results-scroll');
            return panel.getBoundingClientRect().width === 720 && scroll.scrollWidth <= scroll.clientWidth;
        }));

        const cardText = await tablePage.textContent('#profile-card');
        report('Profile button says how to edit it', cardText.includes('Set your name') || cardText.includes('Edit profile'), cardText.trim().replace(/\s+/g, ' '));
        await tablePage.click('#profile-card');
        report('Profile window shows your name and photo button', await tablePage.isVisible('#name-modal')
            && await tablePage.textContent('#name-current') === await tablePage.textContent('#username-display')
            && await tablePage.isVisible('#profile-btn'));
        await tablePage.click('#name-cancel');
        await tablePage.click('#username-display');
        await tablePage.fill('#name-input', 'Ab1');
        await tablePage.click('#name-form button[type="submit"]');
        report('Bad usernames are rejected', await tablePage.isVisible('#name-error'));

        await tablePage.fill('#name-input', 'Nova');
        await tablePage.click('#name-form button[type="submit"]');
        await tablePage.waitForFunction(() => (
            document.getElementById('username-display').textContent.startsWith('Nova#')
        ), null, { timeout: WAIT_MS });
        report('Short usernames can be saved', await tablePage.isHidden('#name-modal'));

        await tablePage.setInputFiles('#profile-upload', {
            name: 'avatar.png',
            mimeType: 'image/png',
            buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
        });
        const avatarURL = `https://example.com/t/avatar-row-${ID}/1`;
        await addLink(tablePage, avatarURL, { magnet: `magnet:?xt=urn:btih:${hash}` });
        await tablePage.fill('#search-input', `avatar-row-${ID}`);
        const avatarInResults = await tablePage.waitForSelector('img.result-avatar', { timeout: WAIT_MS })
            .then(() => true).catch(() => false);
        report('Profile pictures show in results', avatarInResults);
        await tablePage.close();

        const snapshot = await a.evaluate(async (key) => {
            const { getEntryId, toPublicEntry } = await import('/src/shared/entryId.js');
            const { importSigningKey, signEntry, verifyEntry } = await import('/src/shared/signing.js');
            const keys = await importSigningKey(key.privateKey, key.publicKey);
            const {
                compressSnapshot, decompressSnapshot, packSnapshot, unpackSnapshot
            } = await import('/src/shared/snapshot.js');

            const entries = await Promise.all(Array.from({ length: 5000 }, async (_, index) => {
                const hash = index.toString(16).padStart(40, '0');
                const entry = {
                    sourceURL: `https://example.com/t/snapshot-link-${index}/${index}`,
                    title: index % 3 === 0 ? `Custom Title ${index}` : `Snapshot Link ${index}`,
                    addedBy: `User${index % 40}`,
                    timestamp: 1760000000000 + index * 1000,
                    room: 'music',
                    magnet: index % 10 === 0 ? 'magnet:?xt=urn:btih:custom' : `magnet:?xt=urn:btih:${hash}`,
                    instantIOLink: index % 7 === 0 ? `https://instant.io/#${index}` : null,
                    thumbHash: index % 2 === 0 ? 'AAAAAAAAAAAAAAAAAAAAAA==' : null,
                    hasPreview: index % 2 === 0
                };
                return signEntry(entry, keys);
            }));

            const packed = packSnapshot('music', entries);
            const compressed = await compressSnapshot(packed);
            const restored = unpackSnapshot(await decompressSnapshot(compressed));
            const originalIds = entries.map((entry) => entry.entryId).sort();
            const restoredIds = (await Promise.all(restored.entries.map(getEntryId))).sort();

            const damaged = compressed.slice();
            damaged[Math.floor(damaged.length / 2)] ^= 255;
            const damagedRejected = await decompressSnapshot(damaged)
                .then(unpackSnapshot)
                .then(() => false, () => true);

            const junkRejected = await Promise.resolve()
                .then(() => unpackSnapshot(new TextEncoder().encode('not a snapshot')))
                .then(() => false, () => true);

            const checks = await Promise.all(restored.entries.slice(0, 500).map(verifyEntry));
            return {
                signaturesKept: checks.every(Boolean),
                exact: originalIds.join() === restoredIds.join() && restored.room === 'music',
                jsonBytes: JSON.stringify(entries.map(toPublicEntry)).length,
                compressedBytes: compressed.length,
                damagedRejected,
                junkRejected
            };
        }, testKey);
        report('Snapshot restores every link exactly', snapshot.exact);
        report('Snapshots keep signatures valid', snapshot.signaturesKept);
        report('Snapshot is much smaller than JSON', snapshot.compressedBytes < snapshot.jsonBytes / 3,
            `${snapshot.compressedBytes} vs ${snapshot.jsonBytes} bytes`);
        report('Damaged snapshots are rejected', snapshot.damagedRejected && snapshot.junkRejected);

        await a.reload();
        await a.waitForFunction(() => document.getElementById('username-display')?.textContent);
        report('Links survive a page reload', Boolean(await hasLink(a, u1)));
        await waitForPeers(a, 2);
        await new Promise((r) => setTimeout(r, 3000));
        await a.fill('#search-input', `fake-link-a-${ID}`);
        await new Promise((r) => setTimeout(r, 3000));
        const counts = [await countLink(a, u1), await countLink(c, u1)];
        report('No duplicate links', counts.every((n) => n === 1), `copies: ${counts.join(', ')}`);

        const migrationContext = await browser.newContext();
        if (setup) await setup(migrationContext);
        await migrationContext.route('**/seed.html', (route) => route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>Seed</title>'
        }));
        const seed = await migrationContext.newPage();
        const oldURL = `https://example.com/t/old-saved-link-${ID}/1`;
        await seed.goto(`${APP_URL}/seed.html`);
        await seed.evaluate((sourceURL) => new Promise((resolve, reject) => {
            const request = indexedDB.open('webtorrent-metadata-db-v2', 5);
            request.onupgradeneeded = () => {
                const entries = request.result.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
                entries.createIndex('entryId', 'entryId');
                request.result.createObjectStore('stats', { keyPath: 'contentId' });
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const transaction = request.result.transaction('entries', 'readwrite');
                transaction.objectStore('entries').add({
                    sourceURL, magnet: 'magnet:?xt=urn:btih:abc', title: 'Old Saved Link', addedBy: 'Old User', timestamp: 123
                });
                transaction.oncomplete = () => { request.result.close(); resolve(); };
            };
        }), oldURL);
        await seed.goto(`${APP_URL}/?testRoom=${TEST_ROOM}-migration`);
        await seed.waitForFunction(() => document.getElementById('username-display')?.textContent);
        report('Old saved links move to SQLite', Boolean(await hasLink(seed, oldURL)));

        await seed.fill('#search-input', 'saved link');
        const searched = await seed.waitForSelector('.url-title', { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Search finds words inside titles', searched);

        const secondTab = await migrationContext.newPage();
        await secondTab.goto(`${APP_URL}/?testRoom=${TEST_ROOM}-migration`);
        await secondTab.waitForSelector('#storage-warning', { timeout: WAIT_MS });
        report('A second tab shows a safe warning', true);
        await migrationContext.close();
    } catch (e) {
        report('Test run finished', false, e.message.split('\n')[0]);
    } finally {
        await browser.close();
        children.forEach((c) => c.kill());
    }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed} of ${results.length} checks passed`);
    return passed === results.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit((await run()) ? 0 : 1);
}
