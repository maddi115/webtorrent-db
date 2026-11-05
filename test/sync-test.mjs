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

async function openPeer(browser, name, setup) {
    const context = await browser.newContext(); // fresh profile = empty database
    if (setup) await setup(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [${name} error] ${e.message}`));
    await page.goto(APP_URL);
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
            const db = await new Promise((res, rej) => {
                const r = indexedDB.open('webtorrent-metadata-db-v2');
                r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
            });
            const all = await new Promise((res) => {
                const r = db.transaction('entries').objectStore('entries').getAll();
                r.onsuccess = () => res(r.result);
            });
            db.close();
            return all.find((e) => e.sourceURL === target) || null;
        }, url);
        if (entry) return entry;
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
}

async function countLink(page, url) {
    return page.evaluate(async (target) => {
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open('webtorrent-metadata-db-v2');
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        const all = await new Promise((res) => {
            const r = db.transaction('entries').objectStore('entries').getAll();
            r.onsuccess = () => res(r.result);
        });
        db.close();
        return all.filter((e) => e.sourceURL === target).length;
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
        report('Late joiner receives existing links', !!(await hasLink(c, u1)));

        await a.reload();
        await waitForPeers(a, 2);
        await new Promise((r) => setTimeout(r, 3000));
        await a.fill('#search-input', `fake-link-a-${ID}`);
        await new Promise((r) => setTimeout(r, 3000));
        const counts = [await countLink(a, u1), await countLink(c, u1)];
        report('No duplicate links', counts.every((n) => n === 1), `copies: ${counts.join(', ')}`);
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
