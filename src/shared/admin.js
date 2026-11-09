// admin.js - Admin keys can remove any post and clear every room.
// The list comes from the ADMIN_KEYS setting, so every copy of the site agrees on who the admin is.
import { isPublicKey } from './entryRules.js';
import { getMyKeys } from './signing.js';

const devOptions = new URLSearchParams(import.meta.env.DEV ? location.search : '');

export const ADMIN_KEYS = [...new Set([
    ...(import.meta.env.VITE_ADMIN_KEYS || '').split(','),
    ...devOptions.getAll('adminKey')
].map((key) => key.trim()).filter(isPublicKey))];

export function isAdminKey(key) {
    return ADMIN_KEYS.includes(key);
}

export async function amIAdmin() {
    return isAdminKey((await getMyKeys()).publicKey);
}
