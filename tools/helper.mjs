// helper.mjs - Keeps rooms online from this PC using a hidden browser
// Run with: npm run helper
// Choose rooms with: npm run helper -- music books
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRelay } from './bootstrapRelay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.helper-data');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const PORT = 4173;
const RELAY_PORT = Number(process.env.RELAY_PORT) || 7777;
const ROOMS = ['general', 'movies', 'music', 'software', 'games', 'books'];

// Each helper has a saved browser profile, so its links survive restarts
export async function openHelper({ room, baseURL, dataDir, query = '', setup }) {
    mkdirSync(dataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(dataDir);
    if (setup) await setup(context);

    await context.addInitScript(() => {
        localStorage.setItem('webtorrent-username', 'Room Helper#0000🤖');
    });

    const page = await context.newPage();
    await page.goto(`${baseURL}/?room=${room}&role=helper${query}`);
    await page.waitForFunction(() => document.getElementById('username-display')?.textContent);
    return { page, context };
}

function waitForPort(port) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const check = () => {
            const socket = net.connect(port, 'localhost');
            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.once('error', () => {
                if (Date.now() > deadline) reject(new Error('The helper website did not start'));
                else setTimeout(check, 250);
            });
        };
        check();
    });
}

async function main() {
    const rooms = process.argv.slice(2).length ? process.argv.slice(2) : ['general'];
    const unknown = rooms.find((room) => !ROOMS.includes(room) && !/^[1-6]$/.test(room));
    if (unknown) throw new Error(`Unknown room: ${unknown}. Use a number from 1 to 6.`);

    console.log('Building the app...');
    const relay = startRelay({ port: RELAY_PORT });
    const relayURL = `ws://localhost:${RELAY_PORT}`;
    const env = { ...process.env, VITE_BOOTSTRAP_RELAYS: relayURL };
    const build = spawnSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'ignore', env });
    if (build.status !== 0) throw new Error('The app did not build');

    const website = spawn(
        process.execPath,
        [VITE, 'preview', '--port', String(PORT), '--strictPort'],
        { cwd: ROOT, stdio: 'ignore' }
    );
    await waitForPort(PORT);

    const helpers = await Promise.all(rooms.map(async (room) => ({
        room,
        ...await openHelper({
            room,
            baseURL: `http://localhost:${PORT}`,
            dataDir: path.join(DATA_DIR, room)
        })
    })));

    const report = async () => {
        for (const { room, page } of helpers) {
            const status = await page.evaluate(() => ({
                links: document.getElementById('entry-count').textContent,
                peers: document.getElementById('peer-count').textContent,
                relays: document.getElementById('peer-relay-count').textContent,
                cells: document.getElementById('peer-room-name').textContent
            }));
            console.log(`${room}: ${status.links} links, ${status.peers} peers, ${status.relays} relays, ${status.cells}`);
        }
        console.log(`bootstrap relay: ${relay.stats.clients} browsers connected`);
    };

    const stop = async () => {
        await Promise.all(helpers.map(({ context }) => context.close()));
        await relay.close();
        website.kill();
        process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    console.log(`Bootstrap relay: ${relayURL}`);
    console.log(`Helper is online in: ${rooms.join(', ')}`);
    console.log('Leave this running. Press Ctrl+C to stop.');
    await report();
    setInterval(report, 60000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
