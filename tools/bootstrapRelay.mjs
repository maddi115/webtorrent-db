// bootstrapRelay.mjs - A small Nostr relay that only passes introductions along.
// It stores nothing. Browsers use it alongside the public relays.
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_SUBSCRIPTIONS = 64;
const MAX_CLIENTS = 2000;
const EVENTS_PER_SECOND = 40;

function matches(filter, event) {
    if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
    if (Array.isArray(filter['#x'])) {
        const tags = Array.isArray(event.tags) ? event.tags : [];
        return tags.some((tag) => tag[0] === 'x' && filter['#x'].includes(tag[1]));
    }
    return true;
}

export function startRelay({ port = 7777, host = '127.0.0.1' } = {}) {
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
                client.subscriptions.set(message[1], message.slice(2).filter((f) => f && typeof f === 'object'));
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
    const relay = startRelay({ port, host });
    console.log(`Bootstrap relay running on ws://${host}:${port}`);
    setInterval(() => console.log(`relay: ${relay.stats.clients} browsers, ${relay.stats.events} introductions`), 60000);
}
