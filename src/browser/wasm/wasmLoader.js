// wasmLoader.js - Proper WASM loading for Vite
import createCRDTModule from '../../wasm-dist/crdt.mjs';
import createHashModule from '../../wasm-dist/hash.mjs';
import { logger } from '../../shared/logger.js';

let crdtModule = null;
let hashModule = null;

export async function initWASM() {
    try {
        logger.info('🔧 Initializing WASM modules...');
        
        // Load CRDT module
        crdtModule = await createCRDTModule();
        logger.info('✅ CRDT WASM loaded');
        
        // Load Hash module  
        hashModule = await createHashModule();
        logger.info('✅ Hash WASM loaded');
        
        return { crdtModule, hashModule };
    } catch (error) {
        logger.error('❌ Failed to load WASM:', error);
        logger.warn('⚠️  Falling back to JS');
        return null;
    }
}

export function getCRDTModule() {
    return crdtModule;
}

export function getHashModule() {
    return hashModule;
}
