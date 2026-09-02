/**
 * Public surface of the DOLMIR core. Delivery adapters (apps/*) import only
 * from here; internal modules import each other through their own index files
 * (see .dependency-cruiser.cjs).
 */
export * from './kernel/index.js';
