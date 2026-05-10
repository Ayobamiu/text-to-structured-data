#!/usr/bin/env node
/**
 * Database Migration: Schema Registry + Field Corrections (Phase 0)
 *
 * Adds three tables that form the foundation of the registry-based schema
 * architecture (see plan in conversation transcript for full context):
 *
 *   1. document_types   — registry of supported document types (boring_log,
 *                         aquifer_test, lab_qc, ...). One row per type.
 *
 *   2. schemas          — versioned OpenAI-strict JSON Schemas + prompt_hints
 *                         per document_type. Each document_type points at one
 *                         active schema version; older versions remain for
 *                         historical extractions.
 *
 *   3. field_corrections — append-only audit log of every field value
 *                         change made by a reviewer in FileResultsEditor.
 *                         Foundation for future few-shot/fine-tune pools and
 *                         per-doc-type accuracy metrics.
 *
 * This migration is non-breaking: it only adds tables. No existing column,
 * row, or code path is touched. Today's pipeline keeps reading
 * jobs.schema_data exactly as before.
 *
 * Idempotent — safe to run multiple times.
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

const pool = new Pool({
    connectionString:
        process.env.DATABASE_URL ||
        `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function addSchemaRegistry() {
    const client = await pool.connect();
    try {
        console.log('🔄 Creating schema registry + corrections tables...');

        // -------------------------------------------------------------------
        // 1. document_types
        // -------------------------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS document_types (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                slug VARCHAR(100) UNIQUE NOT NULL,
                display_name VARCHAR(255) NOT NULL,
                description TEXT,
                default_extractor VARCHAR(50) NOT NULL DEFAULT 'extendai',
                routing_confidence_threshold REAL NOT NULL DEFAULT 0.75,
                current_schema_version_id UUID,
                status VARCHAR(50) NOT NULL DEFAULT 'active',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);
        await client.query(`
            COMMENT ON TABLE document_types IS
                'Registry of supported document types. Each type has one active schema version (current_schema_version_id) and a default extractor.'
        `);
        await client.query(`
            COMMENT ON COLUMN document_types.slug IS
                'Stable machine identifier used by the classifier and per-section result envelope (e.g. boring_log, aquifer_test).'
        `);
        await client.query(`
            COMMENT ON COLUMN document_types.routing_confidence_threshold IS
                'Per-type confidence threshold below which the visual classifier flags a section for pre-extraction routing review.'
        `);
        await client.query(`
            ALTER TABLE document_types
            ADD CONSTRAINT IF NOT EXISTS check_document_types_status
            CHECK (status IN ('active', 'deprecated'))
        `).catch((e) => {
            if (!e.message.includes('already exists') && !e.message.includes('syntax error')) throw e;
            // Older Postgres versions don't support ADD CONSTRAINT IF NOT EXISTS;
            // try the equivalent guarded form.
            return client.query(`
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint WHERE conname = 'check_document_types_status'
                    ) THEN
                        ALTER TABLE document_types
                        ADD CONSTRAINT check_document_types_status
                        CHECK (status IN ('active', 'deprecated'));
                    END IF;
                END $$
            `);
        });
        console.log('✅ document_types table ready');

        // -------------------------------------------------------------------
        // 2. schemas
        // -------------------------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS schemas (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                document_type_id UUID NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                json_schema JSONB NOT NULL,
                prompt_hints JSONB NOT NULL DEFAULT '{}'::jsonb,
                schema_name VARCHAR(255),
                status VARCHAR(50) NOT NULL DEFAULT 'active',
                created_by UUID REFERENCES users(id) ON DELETE SET NULL,
                notes TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE (document_type_id, version)
            )
        `);
        await client.query(`
            COMMENT ON TABLE schemas IS
                'Versioned OpenAI-strict JSON Schemas per document_type. Each schema row carries a json_schema (fed to OpenAI) and prompt_hints (system prompt + per-field hints, materialised from the legacy x-* extension keywords).'
        `);
        await client.query(`
            COMMENT ON COLUMN schemas.prompt_hints IS
                $c$Shape: { system_role?: string, guidelines?: string[], validators?: string[], field_hints?: { [json_path: string]: { locators?: string[], rules?: string[], instructions?: string[], date_formats?: string[] } } }. Materialised at prompt build time; never sent to OpenAI as part of response_format.json_schema.$c$
        `);
        await client.query(`
            COMMENT ON COLUMN schemas.json_schema IS
                'OpenAI structured-outputs strict-mode JSON Schema. Must satisfy OpenAI strict-mode rules (additionalProperties:false, required for every property, anyOf for nullables).'
        `);
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'check_schemas_status'
                ) THEN
                    ALTER TABLE schemas
                    ADD CONSTRAINT check_schemas_status
                    CHECK (status IN ('active', 'draft', 'deprecated'));
                END IF;
            END $$
        `);
        console.log('✅ schemas table ready');

        // Add the FK from document_types.current_schema_version_id back into
        // schemas now that schemas exists. Done as a separate ALTER so we can
        // create both tables in either order on a fresh DB.
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_types_current_schema_version'
                ) THEN
                    ALTER TABLE document_types
                    ADD CONSTRAINT fk_document_types_current_schema_version
                    FOREIGN KEY (current_schema_version_id)
                    REFERENCES schemas(id)
                    ON DELETE SET NULL;
                END IF;
            END $$
        `);
        console.log('✅ document_types.current_schema_version_id FK ready');

        // -------------------------------------------------------------------
        // 3. field_corrections
        // -------------------------------------------------------------------
        // Append-only log. Each row = one field-level edit a reviewer made.
        // We diff old result vs new result on the server when /files/:id/results
        // is PUT, and emit one row per leaf-value change.
        //
        // json_path uses dot/bracket notation matching the v1 (today's flat
        // result) and the future v2 (typed-section envelope) shapes:
        //   - v1 single-section: 'well_construction.casing_diameter'
        //   - v2 multi-section : 'sections.boring_log[0].lithology_intervals[3].primary_material'
        await client.query(`
            CREATE TABLE IF NOT EXISTS field_corrections (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                file_id UUID NOT NULL REFERENCES job_files(id) ON DELETE CASCADE,
                job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
                document_type_slug VARCHAR(100),
                schema_version INTEGER,
                section_type VARCHAR(100),
                section_index INTEGER,
                json_path TEXT NOT NULL,
                change_kind VARCHAR(20) NOT NULL,
                original_value JSONB,
                corrected_value JSONB,
                corrected_by UUID REFERENCES users(id) ON DELETE SET NULL,
                organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);
        await client.query(`
            COMMENT ON TABLE field_corrections IS
                'Append-only log of reviewer field edits. One row per leaf-value change. Foundation for future few-shot example pools, fine-tuning datasets, per-doc-type accuracy metrics, and schema-version regression tests.'
        `);
        await client.query(`
            COMMENT ON COLUMN field_corrections.change_kind IS
                'One of: modified (value changed), added (key did not exist before), removed (key existed before, gone now).'
        `);
        await client.query(`
            COMMENT ON COLUMN field_corrections.json_path IS
                'Dot/bracket path within the result blob. Compatible with v1 flat results and v2 sectioned envelope.'
        `);
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'check_field_corrections_change_kind'
                ) THEN
                    ALTER TABLE field_corrections
                    ADD CONSTRAINT check_field_corrections_change_kind
                    CHECK (change_kind IN ('modified', 'added', 'removed'));
                END IF;
            END $$
        `);
        console.log('✅ field_corrections table ready');

        // -------------------------------------------------------------------
        // Indexes
        // -------------------------------------------------------------------
        await client.query(`CREATE INDEX IF NOT EXISTS idx_document_types_slug ON document_types(slug)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_document_types_status ON document_types(status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_schemas_document_type_id ON schemas(document_type_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_schemas_status ON schemas(status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_field_corrections_file_id ON field_corrections(file_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_field_corrections_job_id ON field_corrections(job_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_field_corrections_document_type_slug ON field_corrections(document_type_slug)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_field_corrections_corrected_by ON field_corrections(corrected_by)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_field_corrections_organization_id ON field_corrections(organization_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_field_corrections_created_at ON field_corrections(created_at)`);
        console.log('✅ Indexes created');

        // -------------------------------------------------------------------
        // updated_at triggers (reuse the existing update_updated_at_column fn
        // declared in src/database/init.js)
        // -------------------------------------------------------------------
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_trigger WHERE tgname = 'update_document_types_updated_at'
                ) THEN
                    CREATE TRIGGER update_document_types_updated_at
                    BEFORE UPDATE ON document_types
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
                END IF;
            END $$
        `);
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_trigger WHERE tgname = 'update_schemas_updated_at'
                ) THEN
                    CREATE TRIGGER update_schemas_updated_at
                    BEFORE UPDATE ON schemas
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
                END IF;
            END $$
        `);
        console.log('✅ updated_at triggers ready');

        console.log('🎉 Schema registry migration complete');
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addSchemaRegistry()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addSchemaRegistry };
