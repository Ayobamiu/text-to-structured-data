#!/usr/bin/env node
/**
 * Migration: Add Multi-Tenant Organization Support
 * Creates organizations table and updates existing tables
 */

import pool from '../src/database.js';

async function addMultiTenantSupport() {
    const client = await pool.connect();
    try {
        console.log('🔄 Starting multi-tenant migration...');

        // Step 1: Create organizations table
        console.log('🔄 Creating organizations table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS organizations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(100) UNIQUE NOT NULL,
                domain VARCHAR(255), -- company.com for SSO
                plan VARCHAR(50) DEFAULT 'free',
                settings JSONB DEFAULT '{}',
                billing_email VARCHAR(255),
                stripe_customer_id VARCHAR(255),
                subscription_status VARCHAR(50) DEFAULT 'inactive',
                subscription_plan VARCHAR(50),
                subscription_current_period_end TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        console.log('✅ Created organizations table');

        // Step 2: Create organization invitations table
        console.log('🔄 Creating organization_invitations table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS organization_invitations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                email VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL DEFAULT 'member',
                invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token VARCHAR(255) UNIQUE NOT NULL,
                expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
                accepted_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        console.log('✅ Created organization_invitations table');

        // Step 3: Add organization_id and role to users table
        console.log('🔄 Adding organization_id and role to users table...');

        // Check if organization_id column exists
        const checkOrgId = await client.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'organization_id';
        `);

        if (checkOrgId.rows.length === 0) {
            await client.query(`
                ALTER TABLE users 
                ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
            `);
            console.log('✅ Added organization_id column to users table');
        } else {
            console.log('✅ organization_id column already exists in users table');
        }

        // Check if role column exists
        const checkRole = await client.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'role';
        `);

        if (checkRole.rows.length === 0) {
            await client.query(`
                ALTER TABLE users 
                ADD COLUMN role VARCHAR(50) DEFAULT 'member';
            `);
            console.log('✅ Added role column to users table');
        } else {
            console.log('✅ role column already exists in users table');
        }

        // Add additional user fields for organization management
        console.log('🔄 Adding additional user fields...');

        const additionalFields = [
            { name: 'invited_by', type: 'UUID REFERENCES users(id) ON DELETE SET NULL' },
            { name: 'invitation_token', type: 'VARCHAR(255)' },
            { name: 'invitation_expires_at', type: 'TIMESTAMP WITH TIME ZONE' }
        ];

        for (const field of additionalFields) {
            const checkField = await client.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = 'users' AND column_name = $1;
            `, [field.name]);

            if (checkField.rows.length === 0) {
                await client.query(`
                    ALTER TABLE users 
                    ADD COLUMN ${field.name} ${field.type};
                `);
                console.log(`✅ Added ${field.name} column to users table`);
            } else {
                console.log(`✅ ${field.name} column already exists in users table`);
            }
        }

        // Step 4: Add organization_id to jobs table
        console.log('🔄 Adding organization_id to jobs table...');

        const checkJobsOrgId = await client.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'jobs' AND column_name = 'organization_id';
        `);

        if (checkJobsOrgId.rows.length === 0) {
            await client.query(`
                ALTER TABLE jobs 
                ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
            `);
            console.log('✅ Added organization_id column to jobs table');
        } else {
            console.log('✅ organization_id column already exists in jobs table');
        }

        // Step 5: Create indexes for performance
        console.log('🔄 Creating indexes...');

        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);',
            'CREATE INDEX IF NOT EXISTS idx_organizations_domain ON organizations(domain);',
            'CREATE INDEX IF NOT EXISTS idx_organizations_plan ON organizations(plan);',
            'CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);',
            'CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);',
            'CREATE INDEX IF NOT EXISTS idx_jobs_organization_id ON jobs(organization_id);',
            'CREATE INDEX IF NOT EXISTS idx_org_invitations_organization_id ON organization_invitations(organization_id);',
            'CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON organization_invitations(email);',
            'CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON organization_invitations(token);',
            'CREATE INDEX IF NOT EXISTS idx_org_invitations_expires_at ON organization_invitations(expires_at);'
        ];

        for (const indexQuery of indexes) {
            await client.query(indexQuery);
        }
        console.log('✅ Created all indexes');

        // Step 6: Add triggers for updated_at
        console.log('🔄 Adding updated_at triggers...');

        await client.query(`
            CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('✅ Added updated_at trigger for organizations');

        // Step 7: Create view for organization statistics
        console.log('🔄 Creating organization statistics view...');

        await client.query(`
            CREATE OR REPLACE VIEW organization_statistics AS
            SELECT 
                o.id,
                o.name,
                o.slug,
                o.plan,
                o.created_at,
                o.updated_at,
                COUNT(DISTINCT u.id) AS total_members,
                COUNT(DISTINCT j.id) AS total_jobs,
                COUNT(DISTINCT jf.id) AS total_files,
                COUNT(CASE WHEN u.role = 'owner' THEN 1 END) AS owners_count,
                COUNT(CASE WHEN u.role = 'admin' THEN 1 END) AS admins_count,
                COUNT(CASE WHEN u.role = 'member' THEN 1 END) AS members_count,
                COUNT(CASE WHEN u.role = 'viewer' THEN 1 END) AS viewers_count
            FROM organizations o
            LEFT JOIN users u ON o.id = u.organization_id
            LEFT JOIN jobs j ON o.id = j.organization_id
            LEFT JOIN job_files jf ON j.id = jf.job_id
            GROUP BY o.id, o.name, o.slug, o.plan, o.created_at, o.updated_at
            ORDER BY o.created_at DESC;
        `);
        console.log('✅ Created organization statistics view');

        console.log('🎉 Multi-tenant migration completed successfully!');
        console.log('📝 Next steps:');
        console.log('   1. Update backend API endpoints');
        console.log('   2. Implement access control middleware');
        console.log('   3. Add organization management endpoints');
        console.log('   4. Update frontend organization context');

    } catch (error) {
        console.error('❌ Error during multi-tenant migration:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    addMultiTenantSupport()
        .then(() => {
            console.log('✅ Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Migration failed:', error.message);
            process.exit(1);
        });
}

export default addMultiTenantSupport;
