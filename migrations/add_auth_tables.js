#!/usr/bin/env node
/**
 * Database Migration: Add authentication tables
 * Run this script to add authentication support to existing databases
 */

import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'batch_processor',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function addAuthTables() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding authentication tables...');

        // Check if users table exists and has password_hash column
        const checkUsersQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'password_hash'
        `;
        const checkUsersResult = await client.query(checkUsersQuery);

        if (checkUsersResult.rows.length === 0) {
            console.log('🔄 Adding password_hash column to users table...');

            // Add password_hash column
            await client.query(`
                ALTER TABLE users 
                ADD COLUMN password_hash VARCHAR(255)
            `);

            // Add other auth columns
            await client.query(`
                ALTER TABLE users 
                ADD COLUMN role VARCHAR(50) DEFAULT 'user',
                ADD COLUMN email_verified BOOLEAN DEFAULT FALSE,
                ADD COLUMN last_login_at TIMESTAMP WITH TIME ZONE,
                ADD COLUMN login_count INTEGER DEFAULT 0
            `);

            console.log('✅ Added authentication columns to users table');
        } else {
            console.log('✅ Authentication columns already exist in users table');
        }

        // Check if user_sessions table exists
        const checkSessionsQuery = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_name = 'user_sessions'
        `;
        const checkSessionsResult = await client.query(checkSessionsQuery);

        if (checkSessionsResult.rows.length === 0) {
            console.log('🔄 Creating user_sessions table...');

            await client.query(`
                CREATE TABLE user_sessions (
                    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token VARCHAR(255) UNIQUE NOT NULL,
                    ip_address INET,
                    user_agent TEXT,
                    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                )
            `);

            console.log('✅ Created user_sessions table');
        } else {
            console.log('✅ user_sessions table already exists');
        }

        // Check if audit_logs table exists
        const checkAuditQuery = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_name = 'audit_logs'
        `;
        const checkAuditResult = await client.query(checkAuditQuery);

        if (checkAuditResult.rows.length === 0) {
            console.log('🔄 Creating audit_logs table...');

            await client.query(`
                CREATE TABLE audit_logs (
                    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
                    action VARCHAR(100) NOT NULL,
                    resource_type VARCHAR(100),
                    resource_id VARCHAR(255),
                    details JSONB,
                    ip_address INET,
                    user_agent TEXT,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                )
            `);

            console.log('✅ Created audit_logs table');
        } else {
            console.log('✅ audit_logs table already exists');
        }

        // Create indexes
        console.log('🔄 Creating authentication indexes...');

        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
            'CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)',
            'CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token)',
            'CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at)',
            'CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)',
            'CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type)',
            'CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)'
        ];

        for (const indexQuery of indexes) {
            await client.query(indexQuery);
        }

        console.log('✅ Created authentication indexes');

        // Update default admin user with proper password hash
        console.log('🔄 Updating default admin user...');

        const adminPasswordHash = bcrypt.hashSync('admin123', 12);

        await client.query(`
            UPDATE users 
            SET password_hash = $1, role = 'admin', email_verified = true
            WHERE id = '00000000-0000-0000-0000-000000000000'
        `, [adminPasswordHash]);

        console.log('✅ Updated default admin user with password hash');

        console.log('🎉 Authentication migration completed successfully!');
        console.log('📝 Default admin credentials:');
        console.log('   Email: admin@coreextract.com');
        console.log('   Password: admin123');
        console.log('   ⚠️  Change these credentials in production!');

    } catch (error) {
        console.error('❌ Error adding authentication tables:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the migration
if (import.meta.url === `file://${process.argv[1]}`) {
    addAuthTables()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addAuthTables };
