# WebTorrent P2P DB

A shared link database that runs in the browser, with no central database.

People post a link with a magnet link or instant.io link and an optional preview image.
Each browser saves its own copy and shares it directly with other browsers.

## What it does

- Add links with a magnet link, an instant.io link, or both
- Sync links between browsers using direct WebRTC connections
- Save links in each browser with IndexedDB
- Catch up new browsers on links added before they joined
- Search links and group results by URL
- Show which users are online
- Includes in-browser WebTorrent downloads and streaming

## How it works

1. A browser opens the site and connects to the signaling server.
2. The server sends it the list of other online peers.
3. PeerJS helps the browsers connect directly over WebRTC.
4. When someone adds a link, it is saved locally and sent to connected peers.
5. Peers save the link and announce that they have it.
6. A browser that joins later asks for any links it is missing.

The server only helps browsers find each other. Links and files do not go through it.

```
Browser A            Signaling Server            Browser B
    |------ find peers ----|---- find peers ------|
    |                                             |
    |=========== direct WebRTC connection ========|
```

## Quick start

You need Node.js and two terminals.

First time only:

```bash
npm install
cd node
npm install
cd ..
```

Terminal 1:

```bash
cd node
npm start
```

Terminal 2:

```bash
npm run dev
```

Open http://localhost:3000 in two different browsers.
Add a link in one, and it should appear in the other.

## Automated test

The test opens hidden browsers with no saved data, adds fake links, and checks that they sync.

```bash
npx playwright install chromium
npm run test:sync
```

It checks 8 things:

- Browsers connect
- Links sync in both directions
- Synced links appear in search
- instant.io-only links work
- instant.io links are kept
- Late joiners catch up
- Links are not duplicated

## Tech stack

- Vite: build tool and dev server
- PeerJS and WebRTC: direct browser connections
- WebSocket: peer discovery through the signaling server
- IndexedDB: local storage
- C++ and WebAssembly: CRDT and hashing modules
- WebTorrent: in-browser downloads and streaming
- Playwright: automated testing

## Project layout

```
index.html      Main page
node/           Signaling server
src/browser/    Network, storage, UI, and downloads
src/shared/     Shared helpers
src/wasm/       C++ source for the WebAssembly modules
src/wasm-dist/  Built WebAssembly files
test/           Automated sync test
archive/        Older code
```

## Current status

Sync works between two or more browsers on one PC.
It has not been tested across two PCs yet.

## Known issues

- The signaling server address is set to localhost, so other PCs cannot connect yet
- Peer discovery depends on the signaling server and the public PeerJS service
- There is no TURN server, so some networks may block direct connections
- Duplicate handshakes happen when two peers connect to each other at once
- Searching sends a query to peers on every search update
- Large preview images can freeze the page while they sync
- Binary sync is turned off because it corrupted links, so links are sent as JSON
- There is no moderation system yet
- Peers can see each other's IP addresses
- Links only spread while a browser that has them is open

## Next steps

- [ ] Find peers through public WebTorrent trackers
- [ ] Put the site online
- [ ] Test across two PCs
- [ ] Add TURN support
- [ ] Fix duplicate handshakes and query spam
- [ ] Shrink preview images
- [ ] Add moderation tools

## Responsible use

Only share links to content you have the right to share.
