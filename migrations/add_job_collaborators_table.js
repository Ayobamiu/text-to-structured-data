#!/usr/bin/env node
/**
 * Database Migration: Create job_collaborators junction table
 * This replaces the JSONB collaborators column with a proper relational table
 * Much simpler queries: just JOIN job_collaborators instead of complex JSONB queries
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
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function addJobCollaboratorsTable() {
    const client = await pool.connect();
    try {
        console.log('🔄 Creating job_collaborators table...');

        // Step 1: Create job_collaborators table
        await client.query(`
            CREATE TABLE IF NOT EXISTS job_collaborators (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                user_email VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL DEFAULT 'reviewer',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(job_id, user_email)
            )
        `);
        console.log('✅ Created job_collaborators table');

        // Step 2: Create indexes for better performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_job_collaborators_job_id 
            ON job_collaborators(job_id)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_job_collaborators_user_email 
            ON job_collaborators(user_email)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_job_collaborators_user_id 
            ON job_collaborators(user_id)
        `);
        console.log('✅ Created indexes on job_collaborators');

        // Step 3: Migrate existing data from JSONB collaborators column
        console.log('🔄 Migrating existing collaborators data...');
        const jobsWithCollaborators = await client.query(`
            SELECT id, collaborators
            FROM jobs
            WHERE collaborators IS NOT NULL
              AND jsonb_typeof(collaborators) = 'array'
              AND jsonb_array_length(collaborators) > 0
        `);

        let migratedCount = 0;
        for (const job of jobsWithCollaborators.rows) {
            try {
                const collaborators = Array.isArray(job.collaborators) 
                    ? job.collaborators 
                    : JSON.parse(job.collaborators);
                
                for (const collab of collaborators) {
                    if (collab.email) {
                        // Try to find user_id by email
                        const userResult = await client.query(
                            'SELECT id FROM users WHERE email = $1',
                            [collab.email]
                        );
                        const userId = userResult.rows.length > 0 ? userResult.rows[0].id : null;

                        await client.query(`
                            INSERT INTO job_collaborators (job_id, user_id, user_email, role)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (job_id, user_email) DO UPDATE
                            SET role = EXCLUDED.role, updated_at = NOW()
                        `, [
                            job.id,
                            userId,
                            collab.email,
                            collab.role || 'reviewer'
                        ]);
                        migratedCount++;
                    }
                }
            } catch (error) {
                console.warn(`⚠️ Failed to migrate collaborators for job ${job.id}:`, error.message);
            }
        }
        console.log(`✅ Migrated ${migratedCount} collaborator records`);

        // Step 4: Add trigger to update updated_at
        await client.query(`
            CREATE TRIGGER update_job_collaborators_updated_at 
            BEFORE UPDATE ON job_collaborators
            FOR EACH ROW 
            EXECUTE FUNCTION update_updated_at_column()
        `);
        console.log('✅ Created trigger for updated_at');

        console.log('🎉 Migration completed successfully!');
        console.log('');
        console.log('📝 Next steps:');
        console.log('   1. Update listJobsByOrganizations() to use job_collaborators table');
        console.log('   2. Update access checks to use job_collaborators table');
        console.log('   3. (Optional) Remove collaborators JSONB column after verifying everything works');

    } catch (error) {
        console.error('❌ Error creating job_collaborators table:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addJobCollaboratorsTable()
        .then(() => {
            console.log('✅ Migration script completed!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addJobCollaboratorsTable };

