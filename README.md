# WebTorrent P2P DB

A shared link database that runs in the browser, with no central database.

People post links with a title, a magnet or instant.io link, and an optional image.
Each browser keeps its own copy and shares links directly with other browsers.

## What it does

- 6 rooms (Room 1 to Room 6), each holding up to 50 people.
  If a room is full, the newest arrivals move to the next room.
- Each room is made of small groups of 4 people, linked into one network
- Direct browser-to-browser sharing over WebRTC
- Local storage and full-text search with WASM SQLite
- Negentropy sync (the method Nostr uses) that finds missing links with very little data
- Signed posts are also saved on Nostr relays, so new visitors get links even when nobody is online
- Each new post solves a small puzzle first (proof of work), so mass spam is expensive
- Compressed room snapshots, shared in verified chunks from several peers
- Tiny ThumbHash previews, with images loaded only when needed
- Profile pictures and custom usernames of up to 5 letters
- Signed posts, so nobody can fake your name or change your links
- One global chat for everyone in every room. It keeps only the newest 25 messages,
  blocks links, and shows messages as plain text only
- A spam limit of 10 links a minute per person
- Each group of 4 links to the next group and adds two shortcuts, so a post reaches
  5,000 people in about 6 hops
- A live table showing who is online
- Sharing stats and a seeding switch
- An optional helper that keeps rooms online and links up to 16 cells
- A bootstrap relay on your PC, used alongside public relays
- In-browser WebTorrent downloads

## How it works

1. A browser opens the site and picks a room.
2. Trystero uses public Nostr relays to introduce people in that room.
3. WebRTC connects the browsers directly.
4. New users with a big gap download a snapshot from peers.
5. Smart sync compares fingerprints and swaps whatever is still missing.
6. New links go straight to connected peers.
   Each link is signed with a key made in your browser.
   Peers check the signature and drop links that are unsigned, changed,
   posted under someone else's name, or sent faster than 10 a minute.
7. In each cell, the first person links to the next cell in a ring,
   and the second adds a random shortcut, so every cell stays connected.
   Each browser keeps about 5 to 10 connections, however big the room gets.

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
It also serves the app and starts a bootstrap relay at ws://localhost:7777,
so browsers on that address always find each other, even if public relays fail.
You only need one terminal.

```bash
npm run helper -- books
```

Open http://localhost:4173/?room=books

Rooms: `general`, `movies`, `music`, `software`, `games`, and `books`.

## Admin

The admin can remove anyone's post and clear every post in all 6 rooms.
Everyone can see and delete their own posts under Profile, then My posts.

To become the admin:
1. Open the site, click your profile, and copy "Your key".
2. On GitHub, go to Settings, then Secrets and variables, then Actions, then Variables.
3. Add a variable named `ADMIN_KEYS` with your key. Separate several keys with commas.
4. Run the Deploy to GitHub Pages workflow again.

Only that browser has your key, so use the same browser for admin work.

## Network settings

Copy `.env.example` to `.env.local` to add your own bootstrap relays or switch on TURN.

### TURN

Some networks, like many phones on mobile data, block direct connections.
TURN passes the traffic through a relay server for those people only.
It uses Cloudflare's TURN service, which is free for the first 1,000 GB a month.

`tools/turn-worker` is a tiny Cloudflare Worker that keeps your secret TURN key
and hands out logins that expire after a day. To switch TURN on for the live site,
deploy the worker and save its address as the `TURN_ENDPOINT` repository variable.
Open the site with `?turnOnly=1` to force every connection through TURN and check it works.

To let other PCs use your bootstrap relay, run `npm run relay -- --public`.
Add `--store` to also keep saved posts, so new visitors can load them from your relay.
behind a secure address. Browsers on https pages need `wss://` relays.

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
- Your signing key lives in one browser, so a second device gets a different key
- Someone can still make many new keys to get around the spam limit
- There is no moderation yet
- Only one tab per browser can save to the database

## Responsible use

Only share links to content you have the right to share.
