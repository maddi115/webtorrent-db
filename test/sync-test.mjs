// sync-test.mjs - Automatic P2P sync test.
// Starts the servers if needed, opens fresh browsers (no old entries),
// adds fake links, and checks that they reach the other browser.
// Run with: npm run test:sync
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const APP_URL = 'http://localhost:3000';
const WAIT_MS = 45000;
const ID = Date.now();
const TEST_ROOM = `test-${ID}`;
const results = [];
const children = [];

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
    await ensureServer(3000, process.execPath, ['node_modules/vite/bin/vite.js', '--port', '3000'], '.');
    const browser = await chromium.launch();
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
        report('Thumbnail syncs without full image', Boolean(previewEntry?.thumb && !previewEntry.preview));

        await b.fill('#search-input', `fake-link-e-${ID}`);
        await b.click('.preview-thumb');
        await b.waitForSelector('#preview-overlay img', { timeout: WAIT_MS });
        report('Full image loads on demand', Boolean((await hasLink(b, u5))?.preview));
        await b.click('#preview-overlay');

        const avatarShown = await b.waitForFunction(
            () => document.querySelectorAll('#peer-table-body img').length > 0,
            null, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        report('Profile picture appears in peer table', avatarShown);

        const unsafeTitle = '<img src=x onerror="window.unsafeRan=true">';
        const u6 = `https://example.com/t/fake-link-f-${ID}/6`;
        await addLink(a, u6, { magnet: `magnet:?xt=urn:btih:${hash}`, title: unsafeTitle });
        await hasLink(b, u6);
        await b.fill('#search-input', `fake-link-f-${ID}`);
        await b.waitForSelector('.url-title', { timeout: WAIT_MS });
        await new Promise((r) => setTimeout(r, 1000));
        const unsafeRan = await b.evaluate(() => window.unsafeRan === true);
        report('Unsafe title stays plain text', !unsafeRan);

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
            () => document.getElementById('peer-room-name').textContent === 'general 2',
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
