# WebTorrent P2P DB

A shared link database that runs in the browser, with no central database.

People post links with a title, a magnet or instant.io link, and an optional image.
Each browser keeps its own copy and shares links directly with other browsers.

## What it does

- Topic rooms that split automatically when they fill up
- Direct browser-to-browser sharing over WebRTC
- Local storage and full-text search with WASM SQLite
- Smart sync that sends only the links another peer is missing
- Compressed room snapshots, shared in verified chunks from several peers
- Tiny ThumbHash previews, with images loaded only when needed
- Profile pictures and custom usernames of up to 5 letters
- A live table showing who is online
- Sharing stats and a seeding switch
- An optional helper that keeps rooms online from your PC
- In-browser WebTorrent downloads

## How it works

1. A browser opens the site and picks a room.
2. Trystero uses public Nostr relays to introduce people in that room.
3. WebRTC connects the browsers directly.
4. New users with a big gap download a snapshot from peers.
5. Smart sync compares fingerprints and swaps whatever is still missing.
6. New links go straight to connected peers.
7. Bridge peers pass links between split rooms.

Relays only make introductions. Links and images travel directly between browsers.

```
Browser A  --- introductions ---  Nostr relays  --- introductions ---  Browser B
    |                                                                      |
    |================== direct encrypted WebRTC connection =================|
```

## Run it

You need Node.js.

```bash
npm install
npm run dev
```

Open http://localhost:3000 in two browsers and pick the same room.

## Keep rooms online

The helper runs the app in a hidden browser, so links stay available when nobody else is online.
It also serves the app, so you only need one terminal.

```bash
npm run helper -- books
```

Open http://localhost:4173/?room=books

Rooms: `general`, `movies`, `music`, `software`, `games`, and `books`.

## Test it

```bash
npx playwright install chromium
npm run test:sync
```

## Project layout

```
index.html                  Main page
src/main.js                 App startup
src/browser/network/        Rooms, peers, sync, and snapshots
src/browser/storage/        SQLite database and worker
src/browser/ui/             Search, tables, and forms
src/browser/downloads/      WebTorrent downloads
src/shared/                 Shared helpers and data formats
test/sync-test.mjs          Automated browser tests
tools/helper.mjs            Always-on helper
```

## Limits

- It has only been tested on one PC, using real public relays
- Real torrent downloads are not covered by the automated test
- A link is only available while someone who has it is online
- Peers can see each other's IP addresses
- Some strict networks need a TURN server, which is not set up yet
- Usernames and posts are not signed, so they can be faked
- There is no moderation yet
- Only one tab per browser can save to the database

## Responsible use

Only share links to content you have the right to share.
