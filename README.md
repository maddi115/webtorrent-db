# WebTorrent P2P Metadata DB

**Decentralized browser-based metadata DB where users post external links with WebTorrent/magnet + optional previews; metadata syncs P2P via DHT and delta gossip; WASM ensures fast CRDT merging and efficient storage.**

## 🎯 Phase 1 Complete: Basic P2P Working!

### What's Working Now:
- ✅ WebRTC peer-to-peer connections
- ✅ WebSocket signaling server
- ✅ Real-time metadata sync between peers
- ✅ Local IndexedDB storage
- ✅ Delta gossip protocol
- ✅ Multi-tab testing ready

## Quick Start

### 1. Start Signaling Server
```bash
cd node
npm start
# Server runs on ws://localhost:9000
```

### 2. Start Web App (separate terminal)
```bash
npm run dev -- --host 0.0.0.0 --port 8080
```

### 3. Test P2P Sync
1. Open http://localhost:8080 in TWO browser tabs
2. In Tab 1: Add a link + magnet + preview
3. Watch Tab 2: Entry appears automatically!
4. Check console: See peer connections + gossip logs

## Architecture
```
Tab 1 (Browser)              Signaling Server           Tab 2 (Browser)
     │                              │                          │
     ├──WebSocket──────────────────┤──────────────WebSocket───┤
     │         (peer discovery)     │                          │
     │                              │                          │
     ├──────────WebRTC (direct)────────────────────────────────┤
                 (metadata sync)
```

## How It Works

1. **Join Network**: Browser connects to signaling server via WebSocket
2. **Discover Peers**: Server sends list of other connected peers
3. **WebRTC Setup**: Browsers establish direct peer-to-peer connections
4. **Add Entry**: User posts link → Stored in IndexedDB → Gossip to all peers
5. **Sync**: All connected peers receive and store the entry

## Tech Stack

- **Vite** - Build tool
- **IndexedDB** - Local storage
- **SimplePeer** - WebRTC connections
- **WebSocket** - Signaling for WebRTC setup
- **Gossip Protocol** - Efficient metadata propagation

## Next Steps

- [ ] DHT for decentralized peer discovery
- [ ] CRDT conflict resolution
- [ ] WASM performance optimization
- [ ] Persistent bootstrap nodes
- [ ] Preview fetching from peers

