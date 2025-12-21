// connect.js - UI for connecting to other peers (just update existing section)
import { connectToPeer, getMyPeerId } from '../network/dht.js';

export function initConnect() {
    // Update my peer ID when ready
    setTimeout(() => {
        const myId = getMyPeerId();
        if (myId) {
            const peerIdEl = document.getElementById('my-peer-id');
            if (peerIdEl) {
                peerIdEl.textContent = myId;
            }
        }
    }, 1000);
    
    // Connect button handler
    const connectBtn = document.getElementById('connect-btn');
    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            const remotePeerId = document.getElementById('remote-peer-id').value.trim();
            if (remotePeerId) {
                connectToPeer(remotePeerId);
            }
        });
    }
}
