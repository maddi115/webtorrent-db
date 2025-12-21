// urlParser.js - Smart URL parsing with title extraction

export function extractTitle(url) {
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        const parts = path.split('/').filter(Boolean);
        
        if (parts.length === 0) return urlObj.hostname;
        
        // Common forum patterns: /t/{slug}/{id} or /posts/{slug}/{id}
        if (parts.length >= 2) {
            const secondLast = parts[parts.length - 2];
            const last = parts[parts.length - 1];
            
            // If last part is numeric (ID), use second-to-last (slug)
            if (/^\d+$/.test(last)) {
                return slugToTitle(secondLast);
            }
        }
        
        // Use last part if not numeric
        const slug = parts[parts.length - 1];
        return slugToTitle(slug);
        
    } catch (error) {
        return 'Untitled';
    }
}

export function extractSlug(url) {
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        const parts = path.split('/').filter(Boolean);
        
        if (parts.length === 0) return urlObj.hostname;
        
        // Common forum patterns: /t/{slug}/{id}
        if (parts.length >= 2) {
            const secondLast = parts[parts.length - 2];
            const last = parts[parts.length - 1];
            
            // If last part is numeric (ID), use second-to-last (slug)
            if (/^\d+$/.test(last)) {
                return cleanSlug(secondLast);
            }
        }
        
        // Use last part
        let slug = parts[parts.length - 1];
        return cleanSlug(slug);
        
    } catch (error) {
        return url.toLowerCase().trim();
    }
}

function cleanSlug(slug) {
    return slug
        .replace(/\?.*$/, '')     
        .replace(/#.*$/, '')       
        .replace(/\.(html|htm|php)$/, '')
        .toLowerCase();
}

function slugToTitle(slug) {
    return slug
        .replace(/-/g, ' ')
        .replace(/_/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export function normalizeSearchQuery(query) {
    return query
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-');
}

export function isURL(str) {
    try {
        new URL(str);
        return true;
    } catch {
        return false;
    }
}

export function generateContentId(entry) {
    const slug = extractSlug(entry.sourceURL);
    return `${slug}_${entry.timestamp}`;
}
