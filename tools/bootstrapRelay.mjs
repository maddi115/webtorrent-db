// bootstrapRelay.mjs - A small Nostr relay that passes introductions along.
// With store on, it also keeps saved posts so new visitors can load them.
// Browsers use it alongside the public relays.
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_SUBSCRIPTIONS = 64;
const MAX_CLIENTS = 2000;
const EVENTS_PER_SECOND = 40;

const MAX_STORED = 20000;
const MAX_RESULTS = 1000;

function matches(filter, event) {
    if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
    const tags = Array.isArray(event.tags) ? event.tags : [];
    for (const [key, values] of Object.entries(filter)) {
        if (!key.startsWith('#') || !Array.isArray(values)) continue;
        const name = key.slice(1);
        if (!tags.some((tag) => tag[0] === name && values.includes(tag[1]))) return false;
    }
    return true;
}

// Ephemeral events (kinds 20000 to 29999) are passed along but never kept
function isStorable(event) {
    return Number.isInteger(event.kind) && !(event.kind >= 20000 && event.kind < 30000);
}

function replaceKey(event) {
    if (event.kind < 30000 || event.kind >= 40000) return null;
    const d = (event.tags || []).find((tag) => tag[0] === 'd')?.[1] ?? '';
    return `${event.pubkey}:${event.kind}:${d}`;
}

export function startRelay({ port = 7777, host = '127.0.0.1', store = false } = {}) {
    const stored = [];
    const server = new WebSocketServer({ port, host, maxPayload: MAX_MESSAGE_BYTES });
    const clients = new Set();
    const stats = { clients: 0, events: 0 };

    server.on('connection', (socket) => {
        if (clients.size >= MAX_CLIENTS) {
            socket.close(1013, 'Relay is full');
            return;
        }

        const client = { socket, subscriptions: new Map(), windowStart: Date.now(), windowCount: 0 };
        clients.add(client);
        stats.clients = clients.size;

        socket.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (!Array.isArray(message)) return;

            const [type] = message;
            if (type === 'REQ' && typeof message[1] === 'string') {
                if (client.subscriptions.size >= MAX_SUBSCRIPTIONS && !client.subscriptions.has(message[1])) {
                    socket.send(JSON.stringify(['CLOSED', message[1], 'too many subscriptions']));
                    return;
                }
                const filters = message.slice(2).filter((f) => f && typeof f === 'object');
                client.subscriptions.set(message[1], filters);
                if (store) {
                    filters.forEach((filter) => {
                        const limit = Math.min(Number(filter.limit) || MAX_RESULTS, MAX_RESULTS);
                        stored.filter((event) => matches(filter, event)).slice(-limit).forEach((event) => {
                            socket.send(JSON.stringify(['EVENT', message[1], event]));
                        });
                    });
                }
                socket.send(JSON.stringify(['EOSE', message[1]]));
            } else if (type === 'CLOSE') {
                client.subscriptions.delete(message[1]);
            } else if (type === 'EVENT' && message[1] && typeof message[1] === 'object') {
                const now = Date.now();
                if (now - client.windowStart > 1000) {
                    client.windowStart = now;
                    client.windowCount = 0;
                }
                if (++client.windowCount > EVENTS_PER_SECOND) {
                    socket.send(JSON.stringify(['OK', message[1].id, false, 'rate-limited: slow down']));
                    return;
                }

                const event = message[1];
                stats.events += 1;
                if (store && isStorable(event)) {
                    const key = replaceKey(event);
                    if (key) {
                        const old = stored.findIndex((item) => replaceKey(item) === key);
                        if (old >= 0) stored.splice(old, 1);
                    }
                    stored.push(event);
                    if (stored.length > MAX_STORED) stored.shift();
                }
                socket.send(JSON.stringify(['OK', event.id, true, '']));
                for (const other of clients) {
                    for (const [id, filters] of other.subscriptions) {
                        if (filters.some((filter) => matches(filter, event))) {
                            other.socket.send(JSON.stringify(['EVENT', id, event]));
                        }
                    }
                }
            }
        });

        socket.on('close', () => {
            clients.delete(client);
            stats.clients = clients.size;
        });
        socket.on('error', () => {});
    });

    return {
        stats,
        close: () => new Promise((resolve) => {
            clients.forEach((client) => client.socket.terminate());
            server.close(() => resolve());
        })
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.RELAY_PORT) || 7777;
    const host = process.argv.includes('--public') ? '0.0.0.0' : '127.0.0.1';
    const relay = startRelay({ port, host, store: process.argv.includes('--store') });
    console.log(`Bootstrap relay running on ws://${host}:${port}`);
    setInterval(() => console.log(`relay: ${relay.stats.clients} browsers, ${relay.stats.events} introductions`), 60000);
}
