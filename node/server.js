// server.js - Fixed to use actual PeerJS IDs
import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 9000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
        <h1>WebTorrent P2P Signaling Server</h1>
        <p>Status: Running</p>
        <p>Connected peers: ${peers.size}</p>
        <p>Port: ${PORT}</p>
    `);
});

const wss = new WebSocketServer({ server });

const peers = new Map(); // Map<actualPeerId, WebSocket>

wss.on('connection', (ws) => {
    let peerId = null;
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'announce') {
                peerId = message.peerId; // Use ACTUAL PeerJS ID
                peers.set(peerId, ws);
                console.log(`✅ Peer joined: ${peerId.slice(0, 12)}... (Total: ${peers.size})`);
                
                // Send full peer list to everyone
                broadcastPeerList();
            }
        } catch (error) {
            console.error('Invalid message:', error);
        }
    });
    
    ws.on('close', () => {
        if (peerId) {
            peers.delete(peerId);
            console.log(`❌ Peer left: ${peerId.slice(0, 12)}... (Total: ${peers.size})`);
            broadcastPeerList();
        }
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function broadcastPeerList() {
    const peerList = Array.from(peers.keys());
    const message = JSON.stringify({
        type: 'peers',
        peers: peerList
    });
    
    console.log(`📡 Broadcasting peer list: ${peerList.length} peers`);
    
    peers.forEach((ws) => {
        if (ws.readyState === 1) {
            ws.send(message);
        }
    });
}

server.listen(PORT, () => {
    console.log(`🌐 Signaling server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
});
