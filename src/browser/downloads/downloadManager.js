// downloadManager.js - With completion callback
import { logger } from '../../shared/logger.js';
import { trackDownload } from '../storage/db.js';
import { extractSlug } from '../../shared/urlParser.js';

class DownloadManager {
    constructor() {
        this.client = null;
        this.activeDownloads = new Map();
        this.downloadUI = null;
        this.isLoading = false;
    }
    
    async init() {
        if (!window.WebTorrent) {
            this.isLoading = true;
            await this.loadWebTorrent();
        }
        
        this.client = new window.WebTorrent();
        logger.info('✅ WebTorrent client initialized');
        
        this.client.on('error', (err) => {
            logger.error('WebTorrent error:', err);
            this.showToast('❌ Download error: ' + err.message);
        });
        
        this.createDownloadUI();
    }
    
    loadWebTorrent() {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js';
            script.onload = () => {
                logger.info('✅ WebTorrent loaded from CDN');
                resolve();
            };
            script.onerror = () => {
                logger.error('❌ Failed to load WebTorrent');
                reject(new Error('Failed to load WebTorrent'));
            };
            document.head.appendChild(script);
        });
    }
    
    createDownloadUI() {
        this.downloadUI = document.createElement('div');
        this.downloadUI.id = 'download-ui';
        this.downloadUI.className = 'download-ui';
        document.body.appendChild(this.downloadUI);
    }
    
    startDownload(magnetURI, sourceURL, title, onComplete) {
        if (!this.client) {
            this.showToast('⚠️ WebTorrent not ready yet...');
            return;
        }
        
        logger.info('🌊 Starting WebTorrent download:', magnetURI);
        
        const torrent = this.client.add(magnetURI, {
            announce: [
                'wss://tracker.openwebtorrent.com',
                'wss://tracker.btorrent.xyz',
                'wss://tracker.fastcast.nz'
            ]
        });
        
        const downloadId = Date.now().toString();
        
        this.activeDownloads.set(downloadId, {
            torrent,
            magnetURI,
            sourceURL,
            title,
            startTime: Date.now(),
            onComplete
        });
        
        this.addDownloadCard(downloadId, title);
        
        torrent.on('metadata', () => {
            logger.info('📦 Metadata received:', torrent.name);
            this.updateDownloadCard(downloadId);
        });
        
        torrent.on('download', () => {
            this.updateDownloadCard(downloadId);
        });
        
        torrent.on('done', () => {
            logger.info('✅ Download complete!');
            this.handleDownloadComplete(downloadId, sourceURL);
        });
        
        torrent.on('error', (err) => {
            logger.error('Download error:', err);
            this.removeDownloadCard(downloadId);
            this.showToast('❌ Download failed: ' + err.message);
        });
        
        this.showToast('🌊 Starting download via WebTorrent...');
    }
    
    addDownloadCard(downloadId, title) {
        const card = document.createElement('div');
        card.className = 'download-card';
        card.id = `download-${downloadId}`;
        
        card.innerHTML = `
            <div class="download-header">
                <span class="download-title">${title || 'Downloading...'}</span>
                <button class="download-close" data-id="${downloadId}">✕</button>
            </div>
            <div class="download-progress">
                <div class="progress-bar">
                    <div class="progress-fill" id="progress-${downloadId}" style="width: 0%"></div>
                </div>
                <div class="download-stats" id="stats-${downloadId}">
                    <span>Connecting to peers...</span>
                </div>
            </div>
        `;
        
        this.downloadUI.appendChild(card);
        
        card.querySelector('.download-close').addEventListener('click', () => {
            this.cancelDownload(downloadId);
        });
    }
    
    updateDownloadCard(downloadId) {
        const download = this.activeDownloads.get(downloadId);
        if (!download) return;
        
        const { torrent } = download;
        const progressFill = document.getElementById(`progress-${downloadId}`);
        const stats = document.getElementById(`stats-${downloadId}`);
        
        if (!progressFill || !stats) return;
        
        const progress = (torrent.progress * 100).toFixed(1);
        const downloadSpeed = (torrent.downloadSpeed / 1024 / 1024).toFixed(2);
        const uploadSpeed = (torrent.uploadSpeed / 1024 / 1024).toFixed(2);
        const numPeers = torrent.numPeers;
        
        progressFill.style.width = `${progress}%`;
        
        stats.innerHTML = `
            <span>${progress}% • ↓ ${downloadSpeed} MB/s • ↑ ${uploadSpeed} MB/s • ${numPeers} peer${numPeers !== 1 ? 's' : ''}</span>
        `;
    }
    
    async handleDownloadComplete(downloadId, sourceURL) {
        const download = this.activeDownloads.get(downloadId);
        if (!download) return;
        
        const { torrent, onComplete } = download;
        
        const slug = extractSlug(sourceURL);
        await trackDownload(slug);
        
        const card = document.getElementById(`download-${downloadId}`);
        if (card) {
            card.querySelector('.download-stats').innerHTML = `
                <span style="color: #51cf66;">✅ Complete! Auto-downloading files...</span>
            `;
        }
        
        this.showToast('✅ Download complete! Saving files...');
        
        // Auto-download all files
        torrent.files.forEach(file => {
            file.getBlobURL((err, url) => {
                if (err) {
                    logger.error('Error creating download link:', err);
                    return;
                }
                
                const link = document.createElement('a');
                link.href = url;
                link.download = file.name;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                logger.info('💾 Auto-downloaded:', file.name);
            });
        });
        
        // Call completion callback
        if (onComplete) {
            onComplete();
        }
        
        setTimeout(() => {
            this.removeDownloadCard(downloadId);
        }, 5000);
    }
    
    cancelDownload(downloadId) {
        const download = this.activeDownloads.get(downloadId);
        if (!download) return;
        
        download.torrent.destroy();
        this.activeDownloads.delete(downloadId);
        this.removeDownloadCard(downloadId);
        
        this.showToast('🛑 Download cancelled');
    }
    
    removeDownloadCard(downloadId) {
        const card = document.getElementById(`download-${downloadId}`);
        if (card) {
            card.style.opacity = '0';
            setTimeout(() => card.remove(), 300);
        }
        this.activeDownloads.delete(downloadId);
    }
    
    showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => toast.classList.add('show'), 100);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

export const downloadManager = new DownloadManager();
