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
    children.push(spawn(command, args, { cwd, stdio: 'ignore', shell: process.platform === 'win32' }));
    for (let i = 0; i < 40; i++) {
        if (await portOpen(port)) return;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Server on port ${port} did not start`);
}

async function openPeer(browser, name, setup, options = `testRoom=${TEST_ROOM}`) {
    const context = await browser.newContext(); // fresh profile = empty database
    if (setup) await setup(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [${name} error] ${e.message}`));
    await page.goto(`${APP_URL}/?${options}`);
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
            const { importSigningKey, signEntry, toBase64Url } = await import('/src/shared/signing.js');
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

        const c = await openPeer(browser, 'C', setup);
        await waitForPeers(c, 2);
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
                    username: `Fake User ${i}`, avatar: null, connections: 1, links: 0, connectedAt: Date.now()
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

        const splitOptions = `testRoom=${TEST_ROOM}-split&capacity=2`;
        const d = await openPeer(browser, 'D', setup, splitOptions);
        const e = await openPeer(browser, 'E', setup, splitOptions);
        await Promise.all([waitForPeers(d, 1), waitForPeers(e, 1)]);
        const f = await openPeer(browser, 'F', setup, splitOptions);
        const roomText = (page) => page.evaluate(() => document.getElementById('peer-room-name').textContent);
        const moved = await f.waitForFunction(
            () => document.getElementById('peer-room-name').textContent.startsWith('general 2'),
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
        report('Same topic gets the link', Boolean(await hasLink(h, u9)));

        const syncOptions = `testRoom=${TEST_ROOM}-smart`;
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
        const syncBytes = await Promise.all([syncA.page, syncB.page].map((page) => page.evaluate(async () => {
            const { syncStats } = await import('/src/browser/network/smartSync.js');
            return syncStats.sentBytes;
        })));
        const totalSyncBytes = syncBytes[0] + syncBytes[1];
        report('Sync traffic stays small', totalSyncBytes < 30000, `${totalSyncBytes} bytes for 2005 links`);
        await syncA.context.close();
        await syncB.context.close();

        const shareOptions = `testRoom=${TEST_ROOM}-share&snapshotMin=100&snapshotChunk=8192`;
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

        const meshOptions = `testRoom=${TEST_ROOM}-mesh&capacity=3&visitors=2&linkRetryMs=1500&linkCheckMs=4000`
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
        report('Each browser keeps few connections', maxPeers <= 9 && averagePeers <= 7,
            `average ${averagePeers.toFixed(1)}, max ${maxPeers}, of 11 others`);

        const meshURL = `https://example.com/t/mesh-link-${ID}/1`;
        await addLink(mesh[0], meshURL, { magnet: `magnet:?xt=urn:btih:${hash}` });
        const reached = await Promise.all(mesh.map((page) => hasLink(page, meshURL)));
        const reachedCount = reached.filter(Boolean).length;
        report('Links hop across every cell', reachedCount === mesh.length, `${reachedCount} of ${mesh.length}`);
        await Promise.all(mesh.map((page) => page.close()));
        await relay.close();

        const roomPage = await openPeer(browser, 'RoomLink', setup, `testRoom=${TEST_ROOM}-link&room=music`);
        report('Room links open the right topic', await roomPage.inputValue('#room-select') === 'music');
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
        report('Dead relays are skipped next time', relayChoice.skipsDead && relayChoice.comesBack && relayChoice.keepsEnough,
            JSON.stringify(relayChoice));
        await roomPage.close();

        const helperOptions = `&testRoom=${TEST_ROOM}-helper`;
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
