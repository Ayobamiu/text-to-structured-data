import pool from '../database.js';
import { v4 as uuidv4 } from 'uuid';

// --- User-Organization Membership Management ---

export async function createUserOrganizationMembership(userId, organizationId, role = 'member', invitedBy = null) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO user_organization_memberships (user_id, organization_id, role, invited_by, joined_at)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING id, user_id, organization_id, role, joined_at
        `;
        const values = [userId, organizationId, role, invitedBy];
        const result = await client.query(query, values);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function getUserOrganizationMemberships(userId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                uom.id,
                uom.user_id,
                uom.organization_id,
                uom.role,
                uom.joined_at,
                uom.invited_by,
                uom.invitation_accepted_at,
                o.name as organization_name,
                o.slug as organization_slug,
                o.plan as organization_plan,
                o.created_at as organization_created_at,
                inviter.name as invited_by_name
            FROM user_organization_memberships uom
            JOIN organizations o ON uom.organization_id = o.id
            LEFT JOIN users inviter ON uom.invited_by = inviter.id
            WHERE uom.user_id = $1
            ORDER BY uom.joined_at DESC
        `;
        const result = await client.query(query, [userId]);
        return result.rows;
    } finally {
        client.release();
    }
}

export async function getUserOrganizations(userId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                o.id,
                o.name,
                o.slug,
                o.domain,
                o.plan,
                o.settings,
                o.billing_email,
                o.stripe_customer_id,
                o.subscription_status,
                o.subscription_plan,
                o.subscription_current_period_end,
                o.created_at,
                o.updated_at,
                uom.role as user_role,
                uom.joined_at,
                uom.invited_by
            FROM organizations o
            JOIN user_organization_memberships uom ON o.id = uom.organization_id
            WHERE uom.user_id = $1
            ORDER BY uom.joined_at DESC
        `;
        const result = await client.query(query, [userId]);
        return result.rows;
    } finally {
        client.release();
    }
}

export async function getUserRoleInOrganization(userId, organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT role, joined_at, invited_by
            FROM user_organization_memberships
            WHERE user_id = $1 AND organization_id = $2
        `;
        const result = await client.query(query, [userId, organizationId]);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

export async function updateUserOrganizationRole(userId, organizationId, newRole) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE user_organization_memberships
            SET role = $3, updated_at = NOW()
            WHERE user_id = $1 AND organization_id = $2
            RETURNING id, role, updated_at
        `;
        const result = await client.query(query, [userId, organizationId, newRole]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function removeUserFromOrganization(userId, organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            DELETE FROM user_organization_memberships
            WHERE user_id = $1 AND organization_id = $2
            RETURNING id
        `;
        const result = await client.query(query, [userId, organizationId]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function getOrganizationMembers(organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                uom.id,
                uom.user_id,
                uom.role,
                uom.joined_at,
                uom.invited_by,
                uom.invitation_accepted_at,
                u.name as user_name,
                u.email as user_email,
                u.email_verified,
                u.created_at as user_created_at,
                u.last_login_at,
                u.login_count,
                inviter.name as invited_by_name
            FROM user_organization_memberships uom
            JOIN users u ON uom.user_id = u.id
            LEFT JOIN users inviter ON uom.invited_by = inviter.id
            WHERE uom.organization_id = $1
            ORDER BY uom.joined_at DESC
        `;
        const result = await client.query(query, [organizationId]);
        return result.rows;
    } finally {
        client.release();
    }
}

export async function checkUserOrganizationAccess(userId, organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT role
            FROM user_organization_memberships
            WHERE user_id = $1 AND organization_id = $2
        `;
        const result = await client.query(query, [userId, organizationId]);
        return result.rows.length > 0 ? result.rows[0].role : null;
    } finally {
        client.release();
    }
}

export async function createDefaultOrganizationForUser(userId, userName, userEmail) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start transaction

        // Create a default organization for the user
        const orgName = `${userName}'s Organization`;
        const orgSlug = `${userName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-org-${Date.now()}`;

        const orgQuery = `
            INSERT INTO organizations (name, slug, plan)
            VALUES ($1, $2, 'free')
            RETURNING id, name, slug, plan, created_at
        `;
        const orgResult = await client.query(orgQuery, [orgName, orgSlug]);
        const organization = orgResult.rows[0];

        // Add user as owner of their default organization
        const membershipQuery = `
            INSERT INTO user_organization_memberships (user_id, organization_id, role, joined_at)
            VALUES ($1, $2, 'owner', NOW())
            RETURNING id, role, joined_at
        `;
        const membershipResult = await client.query(membershipQuery, [userId, organization.id]);

        await client.query('COMMIT'); // Commit transaction

        return {
            organization,
            membership: membershipResult.rows[0]
        };
    } catch (error) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error('❌ Error creating default organization for user:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

export async function getOrganizationStats(organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                COUNT(DISTINCT uom.user_id) AS total_members,
                COUNT(DISTINCT j.id) AS total_jobs,
                COUNT(DISTINCT jf.id) AS total_files,
                COUNT(CASE WHEN uom.role = 'owner' THEN 1 END) AS owners_count,
                COUNT(CASE WHEN uom.role = 'admin' THEN 1 END) AS admins_count,
                COUNT(CASE WHEN uom.role = 'member' THEN 1 END) AS members_count,
                COUNT(CASE WHEN uom.role = 'viewer' THEN 1 END) AS viewers_count
            FROM user_organization_memberships uom
            LEFT JOIN jobs j ON uom.organization_id = j.organization_id
            LEFT JOIN job_files jf ON j.id = jf.job_id
            WHERE uom.organization_id = $1
        `;
        const result = await client.query(query, [organizationId]);
        return result.rows[0];
    } finally {
        client.release();
    }
}
