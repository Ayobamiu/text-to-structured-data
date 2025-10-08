/**
 * Migration: Add preview_data_table
 * Creates table for storing preview configurations and file references
 */

import pool from '../src/database.js';

async function createPreviewDataTable() {
    const client = await pool.connect();

    try {
        console.log('Creating preview_data_table...');

        // Create the preview_data_table
        await client.query(`
            CREATE TABLE IF NOT EXISTS preview_data_table (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(255) NOT NULL,
                schema JSONB NOT NULL,
                items_ids UUID[] DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                created_by UUID REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Create indexes for better performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_preview_data_table_created_by 
            ON preview_data_table(created_by)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_preview_data_table_created_at 
            ON preview_data_table(created_at)
        `);

        // Create trigger for updated_at
        await client.query(`
            CREATE OR REPLACE FUNCTION update_preview_data_table_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);

        await client.query(`
            DROP TRIGGER IF EXISTS trigger_update_preview_data_table_updated_at ON preview_data_table;
            CREATE TRIGGER trigger_update_preview_data_table_updated_at
                BEFORE UPDATE ON preview_data_table
                FOR EACH ROW
                EXECUTE FUNCTION update_preview_data_table_updated_at()
        `);

        console.log('✅ preview_data_table created successfully');

    } catch (error) {
        console.error('❌ Error creating preview_data_table:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function runMigration() {
    try {
        await createPreviewDataTable();
        console.log('🎉 Migration completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('💥 Migration failed:', error);
        process.exit(1);
    }
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runMigration();
}

export { createPreviewDataTable };
