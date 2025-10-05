import pool from '../src/database.js';

async function addUserOrganizationMemberships() {
    const client = await pool.connect();
    try {
        console.log('🔄 Starting user-organization memberships migration...');

        // Create user_organization_memberships table for many-to-many relationship
        console.log('🔄 Creating user_organization_memberships table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_organization_memberships (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                role VARCHAR(50) NOT NULL DEFAULT 'member',
                joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
                invitation_accepted_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(user_id, organization_id)
            );
        `);
        console.log('✅ Created user_organization_memberships table');

        // Create indexes for performance
        console.log('🔄 Creating indexes...');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_user_org_memberships_user_id ON user_organization_memberships(user_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_user_org_memberships_organization_id ON user_organization_memberships(organization_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_user_org_memberships_role ON user_organization_memberships(role);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_user_org_memberships_joined_at ON user_organization_memberships(joined_at);`);
        console.log('✅ Created indexes');

        // Add updated_at trigger
        console.log('🔄 Adding updated_at trigger...');
        await client.query(`
            CREATE TRIGGER update_user_organization_memberships_updated_at 
            BEFORE UPDATE ON user_organization_memberships
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('✅ Added updated_at trigger');

        // Migrate existing data: Move users from organizations table to memberships table
        console.log('🔄 Migrating existing user-organization relationships...');

        // First, get all users who have an organization_id
        const existingUsers = await client.query(`
            SELECT id, organization_id, role 
            FROM users 
            WHERE organization_id IS NOT NULL
        `);

        console.log(`Found ${existingUsers.rows.length} users with existing organization relationships`);

        // Create memberships for existing users
        for (const user of existingUsers.rows) {
            try {
                await client.query(`
                    INSERT INTO user_organization_memberships (user_id, organization_id, role, joined_at)
                    VALUES ($1, $2, $3, NOW())
                    ON CONFLICT (user_id, organization_id) DO NOTHING
                `, [user.id, user.organization_id, user.role]);
                console.log(`✅ Migrated user ${user.id} to organization ${user.organization_id} as ${user.role}`);
            } catch (error) {
                console.log(`⚠️  User ${user.id} might already be a member of organization ${user.organization_id}`);
            }
        }

        // Create default organizations for users who don't have any organization
        console.log('🔄 Creating default organizations for users without organizations...');
        const usersWithoutOrgs = await client.query(`
            SELECT id, name, email 
            FROM users 
            WHERE id NOT IN (SELECT DISTINCT user_id FROM user_organization_memberships)
        `);

        console.log(`Found ${usersWithoutOrgs.rows.length} users without organizations`);

        for (const user of usersWithoutOrgs.rows) {
            try {
                // Create a default organization for the user
                const orgName = `${user.name}'s Organization`;
                const orgSlug = `${user.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-org-${Date.now()}`;

                const orgResult = await client.query(`
                    INSERT INTO organizations (name, slug, plan)
                    VALUES ($1, $2, 'free')
                    RETURNING id
                `, [orgName, orgSlug]);

                const orgId = orgResult.rows[0].id;

                // Add user as owner of their default organization
                await client.query(`
                    INSERT INTO user_organization_memberships (user_id, organization_id, role, joined_at)
                    VALUES ($1, $2, 'owner', NOW())
                `, [user.id, orgId]);

                console.log(`✅ Created default organization "${orgName}" for user ${user.name}`);
            } catch (error) {
                console.error(`❌ Error creating default organization for user ${user.id}:`, error.message);
            }
        }

        // Remove organization_id column from users table (we'll keep it for now for backward compatibility)
        // But we'll update the application to use the memberships table instead
        console.log('🔄 Migration completed successfully!');
        console.log('📝 Next steps:');
        console.log('   1. Update backend API to use memberships table');
        console.log('   2. Update frontend to handle multiple organizations');
        console.log('   3. Test multi-organization functionality');

    } catch (error) {
        console.error('❌ Error during user-organization memberships migration:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Execute the migration
if (process.argv[2] === 'run') {
    addUserOrganizationMemberships().catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
}

export default addUserOrganizationMemberships;
