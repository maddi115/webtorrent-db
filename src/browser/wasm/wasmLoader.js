// wasmLoader.js - Load all WASM modules
import createCRDTModule from '../../wasm-dist/crdt.mjs';
import createHashModule from '../../wasm-dist/hash.mjs';
import createSerializerModule from '../../wasm-dist/serializer.mjs';
import { logger } from '../../shared/logger.js';

let crdtModule = null;
let hashModule = null;
let serializerModule = null;

export async function initWASM() {
    try {
        logger.info('🔧 Initializing WASM modules...');
        
        // Load CRDT module
        crdtModule = await createCRDTModule();
        logger.info('✅ CRDT WASM loaded');
        
        // Load Hash module  
        hashModule = await createHashModule();
        logger.info('✅ Hash WASM loaded');
        
        // Load Serializer module
        serializerModule = await createSerializerModule();
        logger.info('✅ Binary Serializer WASM loaded');
        
        return { crdtModule, hashModule, serializerModule };
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

export function getSerializerModule() {
    return serializerModule;
}
