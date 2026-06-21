/**
 * Pipeline stage: run config-enabled post-processing services automatically
 * during file processing (the auto-run half of the activation model).
 *
 * Reads per-job overrides + per-document-type defaults off the pipeline context
 * (assembled in database.js:updateFileProcessingStatus), resolves which services
 * are enabled for each slug present in the file, runs them over the freshly
 * extracted envelope, persists side effects (e.g. record_geocodes), and returns
 * the enriched envelope so the caller writes it back to job_files.
 *
 * This is the go-forward path for ALL services (geocode_locations, mgs_enrich,
 * future ones). The legacy MGSPermitFixStage stays wired but dormant (self-gated
 * to one legacy job whose county flag depends on it) — see FileProcessingPipeline.
 */

import { PipelineStage } from '../PipelineStage.js';
import pool from '../../database.js';
import { listServices } from '../../services/postProcessing/index.ts';
import { runConfiguredServicesOverResult } from '../../services/postProcessing/runOverResult.ts';
import { persistSideEffects } from '../../services/postProcessing/sideEffects.ts';
import type { ServiceConfigEntry } from '../../services/postProcessing/resolvePostProcessing.ts';

interface PostProcessingContextConfig {
    jobOverrides?: ServiceConfigEntry[];
    slugDefaultsBySlug?: Record<string, ServiceConfigEntry[]>;
}

interface PipelineContext {
    fileId?: string;
    status?: string;
    result?: unknown;
    postProcessing?: PostProcessingContextConfig;
    metadata?: Record<string, unknown>;
    [k: string]: unknown;
}

export class PostProcessingServicesStage extends PipelineStage {
    constructor(options: Record<string, unknown> = {}) {
        super('post_processing_services', {
            enabled: options.enabled !== false,
            required: false,
            retryable: true,
            ...options,
        });
    }

    shouldRun(context: PipelineContext): boolean {
        if (!super.shouldRun(context)) return false;
        if (context.status !== 'completed' || !context.result) return false;
        const cfg = context.postProcessing;
        if (!cfg) return false;
        const hasJob = Array.isArray(cfg.jobOverrides) && cfg.jobOverrides.length > 0;
        const hasSlug = cfg.slugDefaultsBySlug && Object.keys(cfg.slugDefaultsBySlug).length > 0;
        return Boolean(hasJob || hasSlug);
    }

    async execute(context: PipelineContext): Promise<PipelineContext> {
        const cfg = context.postProcessing || {};
        const out = await runConfiguredServicesOverResult({
            result: context.result,
            fileId: context.fileId ?? null,
            jobOverrides: cfg.jobOverrides || [],
            slugDefaultsBySlug: cfg.slugDefaultsBySlug || {},
            registry: listServices(),
            // geocode_locations reads GOOGLE_PLACES_API_KEY from env by default.
            deps: {},
        });

        if (out.slugsRun.length === 0) {
            return context; // nothing enabled for this file's slugs
        }

        if (out.sideEffects.length > 0) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await persistSideEffects(client, out.sideEffects);
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        }

        console.log(
            `🧩 post_processing_services: slugs=[${out.slugsRun.join(', ')}] ` +
            `records=${out.recordsProcessed} sideEffects=${out.sideEffects.length} ` +
            `summary=${JSON.stringify(out.summary)}`,
        );

        const priorMeta = context.metadata && typeof context.metadata === 'object' ? context.metadata : {};
        return {
            ...context,
            result: out.result,
            metadata: {
                ...priorMeta,
                post_processing_summary: out.summary,
            },
        };
    }
}

export default PostProcessingServicesStage;
