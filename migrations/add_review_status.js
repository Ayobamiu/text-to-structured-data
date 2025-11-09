#!/usr/bin/env node
/**
 * Database Migration: Add review status fields to job_files
 * Adds:
 *   - review_status VARCHAR(50) DEFAULT 'pending' (pending, in_review, reviewed, approved, rejected)
 *   - reviewed_by UUID REFERENCES users(id)
 *   - reviewed_at TIMESTAMP WITH TIME ZONE
 *   - review_notes TEXT
 * 
 * Also migrates existing admin_verified files to reviewed status
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

async function addReviewStatus() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding review status columns...');

        // Step 1: Add review_status column
        const checkReviewStatusQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'job_files'
              AND column_name = 'review_status'
        `;
        const checkReviewStatusResult = await client.query(checkReviewStatusQuery);

        if (checkReviewStatusResult.rows.length === 0) {
            await client.query(`
                ALTER TABLE job_files
                ADD COLUMN review_status VARCHAR(50) DEFAULT 'pending'
            `);
            await client.query(`
                COMMENT ON COLUMN job_files.review_status IS 'Review status: pending, in_review, reviewed, approved, rejected'
            `);
            console.log('✅ Added review_status column to job_files table');
        } else {
            console.log('✅ review_status column already exists in job_files table');
        }

        // Step 2: Add reviewed_by column
        const checkReviewedByQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'job_files'
              AND column_name = 'reviewed_by'
        `;
        const checkReviewedByResult = await client.query(checkReviewedByQuery);

        if (checkReviewedByResult.rows.length === 0) {
            await client.query(`
                ALTER TABLE job_files
                ADD COLUMN reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL
            `);
            await client.query(`
                COMMENT ON COLUMN job_files.reviewed_by IS 'User ID of the reviewer'
            `);
            console.log('✅ Added reviewed_by column to job_files table');
        } else {
            console.log('✅ reviewed_by column already exists in job_files table');
        }

        // Step 3: Add reviewed_at column
        const checkReviewedAtQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'job_files'
              AND column_name = 'reviewed_at'
        `;
        const checkReviewedAtResult = await client.query(checkReviewedAtQuery);

        if (checkReviewedAtResult.rows.length === 0) {
            await client.query(`
                ALTER TABLE job_files
                ADD COLUMN reviewed_at TIMESTAMP WITH TIME ZONE
            `);
            await client.query(`
                COMMENT ON COLUMN job_files.reviewed_at IS 'Timestamp when the file was reviewed'
            `);
            console.log('✅ Added reviewed_at column to job_files table');
        } else {
            console.log('✅ reviewed_at column already exists in job_files table');
        }

        // Step 4: Add review_notes column
        const checkReviewNotesQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'job_files'
              AND column_name = 'review_notes'
        `;
        const checkReviewNotesResult = await client.query(checkReviewNotesQuery);

        if (checkReviewNotesResult.rows.length === 0) {
            await client.query(`
                ALTER TABLE job_files
                ADD COLUMN review_notes TEXT
            `);
            await client.query(`
                COMMENT ON COLUMN job_files.review_notes IS 'Optional notes from the reviewer'
            `);
            console.log('✅ Added review_notes column to job_files table');
        } else {
            console.log('✅ review_notes column already exists in job_files table');
        }

        // Step 5: Create index on review_status for better query performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_job_files_review_status 
            ON job_files(review_status)
        `);
        console.log('✅ Created index on job_files.review_status');

        // Step 6: Migrate existing admin_verified files
        const adminUserId = 'e384d193-cd24-4ab6-bea8-7c820fd46ab9';

        // Check if user exists
        const userCheckQuery = `SELECT id FROM users WHERE id = $1`;
        const userCheckResult = await client.query(userCheckQuery, [adminUserId]);

        if (userCheckResult.rows.length === 0) {
            console.log(`⚠️ User ${adminUserId} not found. Skipping migration of admin_verified files.`);
        } else {
            // Get files that are admin_verified but don't have review_status set to 'reviewed'
            const getVerifiedFilesQuery = `
                SELECT id, admin_verified, updated_at
                FROM job_files
                WHERE admin_verified = true
                  AND (review_status IS NULL OR review_status != 'reviewed')
            `;
            const verifiedFilesResult = await client.query(getVerifiedFilesQuery);

            if (verifiedFilesResult.rows.length > 0) {
                console.log(`📋 Found ${verifiedFilesResult.rows.length} admin_verified files to migrate...`);

                let migratedCount = 0;
                for (const file of verifiedFilesResult.rows) {
                    // Use updated_at as reviewed_at if available, otherwise use current time
                    const reviewedAt = file.updated_at || new Date().toISOString();

                    const updateQuery = `
                        UPDATE job_files
                        SET review_status = 'reviewed',
                            reviewed_by = $1,
                            reviewed_at = $2
                        WHERE id = $3
                    `;
                    await client.query(updateQuery, [adminUserId, reviewedAt, file.id]);
                    migratedCount++;
                }

                console.log(`✅ Migrated ${migratedCount} admin_verified files to reviewed status`);
            } else {
                console.log('✅ No admin_verified files found to migrate');
            }
        }

        // Step 7: Add constraint to ensure valid review_status values
        await client.query(`
            ALTER TABLE job_files
            ADD CONSTRAINT check_review_status 
            CHECK (review_status IN ('pending', 'in_review', 'reviewed', 'approved', 'rejected'))
        `).catch((error) => {
            // Constraint might already exist
            if (error.message.includes('already exists')) {
                console.log('✅ review_status constraint already exists');
            } else {
                throw error;
            }
        });

    } catch (error) {
        console.error('❌ Error adding review status columns:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addReviewStatus()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addReviewStatus };

