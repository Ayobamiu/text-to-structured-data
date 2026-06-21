/**
 * Resolve which post-processing services run for a given document-type slug.
 *
 * Activation model (locked 2026-06-21): BOTH per-document-type defaults AND
 * per-job config, with the job entry overriding the slug default.
 *
 *   enabled = jobOverride.enabled ?? slugDefault.enabled ?? false
 *   options = { ...slugDefault.options, ...jobOverride.options }
 *   AND the service must be registered AND service.appliesTo(slug) must be true.
 *
 * Pure + DB-free so it's unit-testable. The caller supplies the registry lookup
 * (so tests can inject services) and the two config sources. Order follows
 * registry order so behavior is deterministic.
 */

import type { PostProcessingService } from './types.ts';

/** One entry in either the slug-default list or the per-job override list. */
export interface ServiceConfigEntry {
    name: string;
    enabled?: boolean;
    options?: Record<string, unknown>;
}

export interface ResolveArgs {
    slug: string | null;
    /** Per-document-type defaults for THIS slug (document_types.post_processing_defaults). */
    slugDefaults?: ServiceConfigEntry[];
    /** Per-job overrides (jobs.processing_config.postProcessing). */
    jobOverrides?: ServiceConfigEntry[];
    /** All registered services, in the order they should run. */
    registry: PostProcessingService[];
}

export interface ResolvedServices {
    /** Enabled + applicable services, in registry order. */
    services: PostProcessingService[];
    /** Per-service options (merged slug default <- job override), keyed by name. */
    optionsByService: Record<string, Record<string, unknown>>;
}

function entryByName(list: ServiceConfigEntry[] | undefined, name: string): ServiceConfigEntry | undefined {
    if (!Array.isArray(list)) return undefined;
    return list.find((e) => e && e.name === name);
}

export function resolvePostProcessing({
    slug,
    slugDefaults = [],
    jobOverrides = [],
    registry,
}: ResolveArgs): ResolvedServices {
    const services: PostProcessingService[] = [];
    const optionsByService: Record<string, Record<string, unknown>> = {};

    for (const service of registry) {
        // Slug applicability is the service's own concern (e.g. geocode only on
        // borehole_log/mgs_well_log). Default appliesTo = all slugs.
        const applies = service.appliesTo ? service.appliesTo(slug) : true;
        if (!applies) continue;

        const slugDefault = entryByName(slugDefaults, service.name);
        const jobOverride = entryByName(jobOverrides, service.name);

        const enabled = jobOverride?.enabled ?? slugDefault?.enabled ?? false;
        if (!enabled) continue;

        services.push(service);
        optionsByService[service.name] = {
            ...(slugDefault?.options || {}),
            ...(jobOverride?.options || {}),
        };
    }

    return { services, optionsByService };
}

export default { resolvePostProcessing };
