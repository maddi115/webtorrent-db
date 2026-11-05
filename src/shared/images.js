// images.js - Shrink pictures in the browser before saving or sharing them
import { rgbaToThumbHash, thumbHashToDataURL } from 'thumbhash';

const THUMB_HASH_SIZE = 100;

async function loadImage(source) {
    const image = new Image();
    const url = source instanceof Blob ? URL.createObjectURL(source) : source;

    try {
        image.src = url;
        await image.decode();
        return image;
    } finally {
        if (source instanceof Blob) URL.revokeObjectURL(url);
    }
}

function drawImage(image, maxSize) {
    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, context };
}

export async function resizeImage(source, maxSize, quality = 0.75) {
    const { canvas } = drawImage(await loadImage(source), maxSize);
    const webp = canvas.toDataURL('image/webp', quality);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality);
}

// About 30 bytes that decode into a soft blurred preview
export async function makeThumbHash(source) {
    const { canvas, context } = drawImage(await loadImage(source), THUMB_HASH_SIZE);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const hash = rgbaToThumbHash(canvas.width, canvas.height, pixels);
    return btoa(String.fromCharCode(...hash));
}

export function thumbHashToImage(thumbHash) {
    try {
        const bytes = Uint8Array.from(atob(thumbHash), (char) => char.charCodeAt(0));
        return thumbHashToDataURL(bytes);
    } catch {
        return null;
    }
}
