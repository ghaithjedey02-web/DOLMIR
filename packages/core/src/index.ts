/**
 * Public surface of the DOLMIR core. Delivery adapters (apps/*) import only
 * from here; internal modules import each other through their own index files
 * (see .dependency-cruiser.cjs).
 */
export * from './kernel/index.js';
export * from './infrastructure/index.js';
export * from './modules/audit/index.js';
export * from './modules/ledger/index.js';
export * from './modules/tenancy/index.js';
export * from './modules/identity/index.js';
export * from './modules/access/index.js';
