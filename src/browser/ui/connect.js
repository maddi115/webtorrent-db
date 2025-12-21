// connect.js - UI for connecting to other peers
import { connectToPeer, getMyPeerId } from '../network/dht.js';

export function initConnect() {
    // Add connect UI to page
    const connectSection = document.createElement('section');
    connectSection.id = 'connect-section';
    connectSection.innerHTML = `
        <h2>Connect to Peer</h2>
        <p>Your Peer ID: <strong id="my-peer-id">Loading...</strong></p>
        <input type="text" id="remote-peer-id" placeholder="Enter peer ID to connect">
        <button id="connect-btn">Connect</button>
    `;
    
    document.querySelector('#app').insertBefore(
        connectSection,
        document.querySelector('#add-section')
    );
    
    // Update my peer ID when ready
    setTimeout(() => {
        const myId = getMyPeerId();
        if (myId) {
            document.getElementById('my-peer-id').textContent = myId;
        }
    }, 1000);
    
    // Connect button handler
    document.getElementById('connect-btn').addEventListener('click', () => {
        const remotePeerId = document.getElementById('remote-peer-id').value.trim();
        if (remotePeerId) {
            connectToPeer(remotePeerId);
        }
    });
}
