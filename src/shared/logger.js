// logger.js - Shared logger
export const logger = {
    info: (msg, ...args) => console.log(`ℹ️  ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`⚠️  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`❌ ${msg}`, ...args),
};
