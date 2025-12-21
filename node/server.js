// server.js - WebSocket signaling server for WebRTC
import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 9000;

// Create HTTP server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
        <h1>WebTorrent P2P Signaling Server</h1>
        <p>Status: Running</p>
        <p>Connected peers: <span id="count">0</span></p>
        <p>Port: ${PORT}</p>
    `);
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

const peers = new Map();

wss.on('connection', (ws) => {
    const peerId = generatePeerId();
    peers.set(peerId, ws);
    
    console.log(`✅ Peer connected: ${peerId} (Total: ${peers.size})`);
    
    // Send peer their ID
    ws.send(JSON.stringify({ type: 'id', peerId }));
    
    // Broadcast peer list to all peers
    broadcastPeerList();
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(peerId, message);
        } catch (error) {
            console.error('Invalid message:', error);
        }
    });
    
    ws.on('close', () => {
        peers.delete(peerId);
        console.log(`❌ Peer disconnected: ${peerId} (Total: ${peers.size})`);
        broadcastPeerList();
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function handleMessage(fromPeerId, message) {
    switch (message.type) {
        case 'signal':
            // Forward WebRTC signaling to target peer
            const targetPeer = peers.get(message.to);
            if (targetPeer && targetPeer.readyState === 1) {
                targetPeer.send(JSON.stringify({
                    type: 'signal',
                    from: fromPeerId,
                    signal: message.signal
                }));
            }
            break;
            
        case 'broadcast':
            // Broadcast message to all peers except sender
            peers.forEach((peer, peerId) => {
                if (peerId !== fromPeerId && peer.readyState === 1) {
                    peer.send(JSON.stringify({
                        type: 'broadcast',
                        from: fromPeerId,
                        data: message.data
                    }));
                }
            });
            break;
    }
}

function broadcastPeerList() {
    const peerList = Array.from(peers.keys());
    const message = JSON.stringify({ type: 'peers', peers: peerList });
    
    peers.forEach((peer) => {
        if (peer.readyState === 1) {
            peer.send(message);
        }
    });
}

function generatePeerId() {
    return 'peer_' + Math.random().toString(36).substr(2, 9);
}

server.listen(PORT, () => {
    console.log(`🌐 Signaling server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
});
