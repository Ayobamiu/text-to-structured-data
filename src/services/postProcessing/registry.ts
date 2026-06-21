/**
 * Post-processing service registry.
 *
 * See ./types.ts for the service contract. Services register here at startup and
 * the runner executes the enabled ones in order.
 */

import type { PostProcessingService } from './types.ts';

const _registry = new Map<string, PostProcessingService>();

/** Register a service. Throws on a duplicate name to catch wiring mistakes early. */
export function registerService(service: PostProcessingService): PostProcessingService {
    if (!service || typeof service.name !== 'string' || !service.name) {
        throw new Error('registerService: service.name is required');
    }
    if (typeof service.run !== 'function') {
        throw new Error(`registerService: service "${service.name}" must implement run()`);
    }
    if (typeof service.version !== 'string' || !service.version) {
        throw new Error(`registerService: service "${service.name}" must declare a version`);
    }
    if (_registry.has(service.name)) {
        throw new Error(`registerService: duplicate service name "${service.name}"`);
    }
    // Default appliesTo = all slugs.
    if (typeof service.appliesTo !== 'function') {
        service.appliesTo = () => true;
    }
    _registry.set(service.name, service);
    return service;
}

/** Get a registered service by name, or null. */
export function getService(name: string): PostProcessingService | null {
    return _registry.get(name) || null;
}

/** List all registered services. */
export function listServices(): PostProcessingService[] {
    return [..._registry.values()];
}

/** Test helper: clear the registry. */
export function _resetRegistry(): void {
    _registry.clear();
}

export default { registerService, getService, listServices, _resetRegistry };
