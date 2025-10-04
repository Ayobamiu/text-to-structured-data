#!/usr/bin/env node
/**
 * Database Migration: Fix token field length
 * Run this script to fix the token field length issue
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'batch_processor',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function fixTokenFieldLength() {
    const client = await pool.connect();
    try {
        console.log('🔄 Fixing token field length...');

        // Change token field from VARCHAR(255) to TEXT
        await client.query(`
            ALTER TABLE user_sessions 
            ALTER COLUMN token TYPE TEXT
        `);

        console.log('✅ Token field length fixed');

    } catch (error) {
        console.error('❌ Error fixing token field length:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the migration
if (import.meta.url === `file://${process.argv[1]}`) {
    fixTokenFieldLength()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { fixTokenFieldLength };
