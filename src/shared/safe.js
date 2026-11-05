// safe.js - Check data from other peers before showing it
const IMAGE_PATTERN = /^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/;

export const MAX_AVATAR_CHARS = 64 * 1024;
export const MAX_THUMB_CHARS = 64 * 1024;
export const MAX_PREVIEW_CHARS = 5 * 1024 * 1024;

export function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

export function safeLink(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
    } catch {
        return '#';
    }
}

export function safeImage(value, maxChars) {
    return typeof value === 'string' && value.length <= maxChars && IMAGE_PATTERN.test(value)
        ? value
        : null;
}

export function shortText(value, maxChars) {
    return typeof value === 'string' ? value.slice(0, maxChars) : '';
}
