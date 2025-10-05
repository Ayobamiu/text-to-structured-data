import pool from '../src/database.js';

async function addProcessingMetadataColumn() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding processing_metadata column to job_files table...');

        // Add the processing_metadata column
        await client.query(`
            ALTER TABLE job_files 
            ADD COLUMN IF NOT EXISTS processing_metadata JSONB
        `);

        console.log('✅ Successfully added processing_metadata column');

    } catch (error) {
        console.error('❌ Error adding processing_metadata column:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Run the migration
addProcessingMetadataColumn()
    .then(() => {
        console.log('✅ Migration completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    });
