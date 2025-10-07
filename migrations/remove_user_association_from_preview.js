/**
 * Migration: Remove user association from preview_data_table
 * Removes created_by column and related constraints
 */

import pool from '../src/database.js';

async function removeUserAssociationFromPreviewTable() {
    const client = await pool.connect();

    try {
        console.log('Removing user association from preview_data_table...');

        // Drop the foreign key constraint first
        await client.query(`
            ALTER TABLE preview_data_table 
            DROP CONSTRAINT IF EXISTS preview_data_table_created_by_fkey
        `);

        // Drop the created_by column
        await client.query(`
            ALTER TABLE preview_data_table 
            DROP COLUMN IF EXISTS created_by
        `);

        // Drop the index for created_by
        await client.query(`
            DROP INDEX IF EXISTS idx_preview_data_table_created_by
        `);

        console.log('✅ User association removed from preview_data_table');

    } catch (error) {
        console.error('❌ Error removing user association:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function runMigration() {
    try {
        await removeUserAssociationFromPreviewTable();
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

export { removeUserAssociationFromPreviewTable };
