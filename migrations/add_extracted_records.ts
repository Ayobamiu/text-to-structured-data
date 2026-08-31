/**
 * Migration: extracted_records — the queryable projection layer.
 *
 * extracted_records is a DERIVED, section-grain projection of job_files.result,
 * kept SEPARATE from the extracted envelope (which stays ground truth). It exists
 * so the NL-query layer and BI/views query stable, typed, indexed rows instead of
 * heterogeneous JSONB. It is rebuildable per record — never authoritative.
 *
 * Grain: one row per section-record.
 *   - section_key = '_root'  → the object/scalar header of a record (one row)
 *   - section_key = '<name>' → one row per element of an array section
 *                              (lithology_intervals, samples, analyte_results, …)
 *
 * Keying: record_uid = section_result_id (V2) OR file_id (V1, which never carries
 * a section_result_id — see resultEnvelope.js). Unique per (slug, record_uid,
 * section_key, row_index) so re-runs replace rather than duplicate.
 *
 * Partitioned BY LIST (slug): the 8 known slugs each get an isolated partition;
 * everything else (and future slugs) lands in the DEFAULT partition with zero DDL.
 * Promote a slug out of DEFAULT into its own partition when its row count earns it.
 *
 * `data` holds the full typed payload for the row; the promoted columns
 * (lat/lon/county/state/event_date/depth/record_label) are the cross-cutting
 * dimensions chosen from real fill rates (97–100% on the dominant slug) so the
 * common filters are fast and correctly typed.
 *
 * Idempotent (CREATE ... IF NOT EXISTS). Run: `npx tsx migrations/add_extracted_records.ts`.
 */

import pool from '../src/database.js';

/** Known document-type slugs that get a dedicated partition. New slugs fall into DEFAULT. */
const KNOWN_SLUGS = [
    'mgs_well_log',
    'borehole_log',
    'aecom_field_borehole_log',
    'analytical_results',
    'aquifer_test',
    'aquifer_test_data',
    'well_coordinate_table',
    'field_sampling_forms',
];

/** A slug → safe partition suffix (lowercase, non-word → _). */
const partName = (slug: string) => `extracted_records_${slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;

export default async function addExtractedRecords(): Promise<void> {
    const client = await pool.connect();
    try {
        console.log('Creating extracted_records (partitioned by slug)...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS extracted_records (
                id                 UUID NOT NULL DEFAULT gen_random_uuid(),
                -- lineage + tenancy (the query layer scopes on these)
                file_id            UUID,
                job_id             UUID,
                org_id             UUID,
                slug               TEXT NOT NULL,
                schema_version     INTEGER,
                section_result_id  TEXT,        -- joins to record_geocodes / section_verifications (V2 only)
                record_uid         TEXT NOT NULL, -- section_result_id ?? file_id (stable per-record key)
                -- section grain
                section_key        TEXT NOT NULL, -- '_root' = header; else array section name
                row_index          INTEGER NOT NULL DEFAULT 0,
                -- the typed payload for this row
                data               JSONB NOT NULL,
                -- promoted, cross-cutting filter columns (typed; chosen from real fill rates)
                latitude           DOUBLE PRECISION,
                longitude          DOUBLE PRECISION,
                county             TEXT,
                state              TEXT,
                event_date         DATE,
                depth_top          NUMERIC,
                depth_bottom       NUMERIC,
                record_label       TEXT,        -- api_number / permit_number / well_number
                -- housekeeping
                projector_version  TEXT,
                created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
                -- partition key must be part of PK / UNIQUE on partitioned tables
                PRIMARY KEY (slug, id),
                UNIQUE (slug, record_uid, section_key, row_index)
            ) PARTITION BY LIST (slug)
        `);

        // DEFAULT partition: future/unknown slugs land here with zero DDL.
        await client.query(`
            CREATE TABLE IF NOT EXISTS extracted_records_default
            PARTITION OF extracted_records DEFAULT
        `);

        // Dedicated partition per known slug (physical isolation for the big ones).
        for (const slug of KNOWN_SLUGS) {
            await client.query(
                `CREATE TABLE IF NOT EXISTS ${partName(slug)}
                 PARTITION OF extracted_records FOR VALUES IN ($1)`.replace('$1', `'${slug}'`),
            );
        }

        // Indexes on the parent propagate to every partition.
        await client.query(`CREATE INDEX IF NOT EXISTS idx_extracted_records_file ON extracted_records (file_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_extracted_records_job ON extracted_records (job_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_extracted_records_org ON extracted_records (org_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_extracted_records_slug_section ON extracted_records (slug, section_key)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_extracted_records_county ON extracted_records (county)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_extracted_records_event_date ON extracted_records (event_date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_extracted_records_data_gin ON extracted_records USING GIN (data)`);

        console.log('✅ extracted_records ready (DEFAULT + ' + KNOWN_SLUGS.length + ' slug partitions)');
    } finally {
        client.release();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addExtractedRecords()
        .then(() => { console.log('🎉 Migration completed'); process.exit(0); })
        .catch((e) => { console.error('💥 Migration failed:', e); process.exit(1); });
}
