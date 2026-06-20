/**
 * Post-processing framework entry point.
 *
 * Registers the built-in services once and re-exports the registry accessors.
 * Import this (not registry.ts directly) from routes/workers so services are
 * guaranteed registered.
 */

import { registerService, getService, listServices } from './registry.ts';
import mgsEnrich from './services/mgsEnrich.ts';

let registered = false;

/** Idempotently register the built-in services. Safe to call many times. */
export function registerBuiltInServices(): void {
    if (registered) return;
    registerService(mgsEnrich);
    // D2 will add: registerService(geocodeLocations);
    registered = true;
}

// Register on import so consumers don't have to remember to.
registerBuiltInServices();

export { getService, listServices };
