/**
 * Backfill selected_pages for files processed by the visual classifier.
 *
 * Before this fix, only manually-selected pages were written to the
 * selected_pages column.  Files processed via the visual classifier had their
 * extraction_pages stored inside detected_sections→sections[]→extraction_pages
 * but the flat selected_pages column was left NULL.  This caused the "3 of 10"
 * display in the Pages column to fall back to just showing the total.
 *
 * This migration flattens all extraction_pages from detected_sections into the
 * selected_pages column for every file that has detected_sections but no
 * selected_pages.
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function backfill() {
    const client = await pool.connect();
    try {
        // Find all files with detected_sections but no selected_pages
        const result = await client.query(`
            SELECT id, detected_sections
            FROM job_files
            WHERE detected_sections IS NOT NULL
              AND selected_pages IS NULL
        `);

        console.log(`Found ${result.rows.length} files to backfill`);

        let updated = 0;
        let skipped = 0;

        for (const row of result.rows) {
            const ds = typeof row.detected_sections === 'string'
                ? JSON.parse(row.detected_sections)
                : row.detected_sections;

            const sections = ds?.sections || [];

            // Collect all extraction_pages from all sections, deduplicate & sort
            const allPages = new Set();
            for (const section of sections) {
                if (Array.isArray(section.extraction_pages)) {
                    for (const p of section.extraction_pages) {
                        allPages.add(p);
                    }
                }
            }

            if (allPages.size === 0) {
                skipped++;
                continue;
            }

            const sorted = [...allPages].sort((a, b) => a - b);

            await client.query(
                `UPDATE job_files SET selected_pages = $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify(sorted), row.id]
            );
            updated++;
        }

        console.log(`✅ Backfill complete: ${updated} files updated, ${skipped} skipped (no extraction_pages)`);
    } catch (error) {
        console.error('❌ Backfill failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

backfill();
