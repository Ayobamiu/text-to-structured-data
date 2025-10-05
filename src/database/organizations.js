import pool from '../database.js';
import { v4 as uuidv4 } from 'uuid';

// --- Organization Management ---

export async function createOrganization(name, slug, domain = null, createdByUserId = null) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO organizations (name, slug, domain)
            VALUES ($1, $2, $3)
            RETURNING id, name, slug, domain, plan, created_at
        `;
        const values = [name, slug, domain];
        const result = await client.query(query, values);

        // If a user created the organization, make them the owner
        if (createdByUserId) {
            await client.query(`
                UPDATE users 
                SET organization_id = $1, role = 'owner'
                WHERE id = $2
            `, [result.rows[0].id, createdByUserId]);
        }

        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function findOrganizationById(id) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT id, name, slug, domain, plan, settings, billing_email, 
                   stripe_customer_id, subscription_status, subscription_plan,
                   subscription_current_period_end, created_at, updated_at
            FROM organizations
            WHERE id = $1
        `;
        const result = await client.query(query, [id]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function findOrganizationBySlug(slug) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT id, name, slug, domain, plan, settings, billing_email, 
                   stripe_customer_id, subscription_status, subscription_plan,
                   subscription_current_period_end, created_at, updated_at
            FROM organizations
            WHERE slug = $1
        `;
        const result = await client.query(query, [slug]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function updateOrganization(id, updates) {
    const client = await pool.connect();
    try {
        const allowedFields = ['name', 'slug', 'domain', 'plan', 'settings', 'billing_email'];
        const setClause = [];
        const values = [];
        let paramCount = 1;

        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                setClause.push(`${key} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }

        if (setClause.length === 0) {
            throw new Error('No valid fields to update');
        }

        values.push(id);
        const query = `
            UPDATE organizations 
            SET ${setClause.join(', ')}, updated_at = NOW()
            WHERE id = $${paramCount}
            RETURNING id, name, slug, domain, plan, settings, billing_email, updated_at
        `;

        const result = await client.query(query, values);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function deleteOrganization(id) {
    const client = await pool.connect();
    try {
        // First, remove all users from the organization
        await client.query(`
            UPDATE users 
            SET organization_id = NULL, role = 'member'
            WHERE organization_id = $1
        `, [id]);

        // Then delete the organization (this will cascade delete jobs and invitations)
        const result = await client.query(`
            DELETE FROM organizations 
            WHERE id = $1
            RETURNING id, name
        `, [id]);

        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function listOrganizationsForUser(userId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT DISTINCT o.id, o.name, o.slug, o.domain, o.plan, o.created_at, o.updated_at,
                   u.role as user_role
            FROM organizations o
            JOIN users u ON o.id = u.organization_id
            WHERE u.id = $1
            ORDER BY o.created_at DESC
        `;
        const result = await client.query(query, [userId]);
        return result.rows;
    } finally {
        client.release();
    }
}

// --- Organization Members Management ---

export async function getOrganizationMembers(organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT u.id, u.email, u.name, u.role, u.email_verified, 
                   u.created_at, u.last_login_at, u.login_count,
                   inviter.name as invited_by_name
            FROM users u
            LEFT JOIN users inviter ON u.invited_by = inviter.id
            WHERE u.organization_id = $1
            ORDER BY u.created_at ASC
        `;
        const result = await client.query(query, [organizationId]);
        return result.rows;
    } finally {
        client.release();
    }
}

export async function updateUserRole(userId, role, updatedByUserId) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE users 
            SET role = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, name, role, organization_id
        `;
        const result = await client.query(query, [role, userId]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function removeUserFromOrganization(userId) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE users 
            SET organization_id = NULL, role = 'member', updated_at = NOW()
            WHERE id = $1
            RETURNING id, email, name
        `;
        const result = await client.query(query, [userId]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

// --- Organization Invitations ---

export async function createOrganizationInvitation(organizationId, email, role, invitedByUserId) {
    const client = await pool.connect();
    try {
        const token = uuidv4();
        const expiresAt = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)); // 7 days

        const query = `
            INSERT INTO organization_invitations (organization_id, email, role, invited_by, token, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, email, role, token, expires_at, created_at
        `;
        const values = [organizationId, email, role, invitedByUserId, token, expiresAt];
        const result = await client.query(query, values);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function findInvitationByToken(token) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT oi.id, oi.organization_id, oi.email, oi.role, oi.token, oi.expires_at, oi.created_at,
                   o.name as organization_name, o.slug as organization_slug,
                   inviter.name as invited_by_name
            FROM organization_invitations oi
            JOIN organizations o ON oi.organization_id = o.id
            LEFT JOIN users inviter ON oi.invited_by = inviter.id
            WHERE oi.token = $1 AND oi.expires_at > NOW() AND oi.accepted_at IS NULL
        `;
        const result = await client.query(query, [token]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function acceptInvitation(token, userId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get invitation details
        const invitation = await findInvitationByToken(token);
        if (!invitation) {
            throw new Error('Invalid or expired invitation');
        }

        // Update user to join organization
        await client.query(`
            UPDATE users 
            SET organization_id = $1, role = $2, updated_at = NOW()
            WHERE id = $3
        `, [invitation.organization_id, invitation.role, userId]);

        // Mark invitation as accepted
        await client.query(`
            UPDATE organization_invitations 
            SET accepted_at = NOW()
            WHERE token = $1
        `, [token]);

        await client.query('COMMIT');

        return {
            organizationId: invitation.organization_id,
            organizationName: invitation.organization_name,
            role: invitation.role
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function getOrganizationInvitations(organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT oi.id, oi.email, oi.role, oi.token, oi.expires_at, oi.accepted_at, oi.created_at,
                   inviter.name as invited_by_name
            FROM organization_invitations oi
            LEFT JOIN users inviter ON oi.invited_by = inviter.id
            WHERE oi.organization_id = $1
            ORDER BY oi.created_at DESC
        `;
        const result = await client.query(query, [organizationId]);
        return result.rows;
    } finally {
        client.release();
    }
}

export async function cancelInvitation(invitationId) {
    const client = await pool.connect();
    try {
        const query = `
            DELETE FROM organization_invitations 
            WHERE id = $1 AND accepted_at IS NULL
            RETURNING id, email
        `;
        const result = await client.query(query, [invitationId]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

// --- Organization Statistics ---

export async function getOrganizationStats(organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                COUNT(DISTINCT u.id) AS total_members,
                COUNT(DISTINCT j.id) AS total_jobs,
                COUNT(DISTINCT jf.id) AS total_files,
                COUNT(CASE WHEN u.role = 'owner' THEN 1 END) AS owners_count,
                COUNT(CASE WHEN u.role = 'admin' THEN 1 END) AS admins_count,
                COUNT(CASE WHEN u.role = 'member' THEN 1 END) AS members_count,
                COUNT(CASE WHEN u.role = 'viewer' THEN 1 END) AS viewers_count,
                COUNT(CASE WHEN j.status = 'completed' THEN 1 END) AS completed_jobs,
                COUNT(CASE WHEN j.status = 'processing' THEN 1 END) AS processing_jobs,
                COUNT(CASE WHEN j.status = 'failed' THEN 1 END) AS failed_jobs,
                SUM(jf.size) AS total_storage_bytes
            FROM organizations o
            LEFT JOIN users u ON o.id = u.organization_id
            LEFT JOIN jobs j ON o.id = j.organization_id
            LEFT JOIN job_files jf ON j.id = jf.job_id
            WHERE o.id = $1
            GROUP BY o.id
        `;
        const result = await client.query(query, [organizationId]);
        return result.rows[0] || {
            total_members: 0,
            total_jobs: 0,
            total_files: 0,
            owners_count: 0,
            admins_count: 0,
            members_count: 0,
            viewers_count: 0,
            completed_jobs: 0,
            processing_jobs: 0,
            failed_jobs: 0,
            total_storage_bytes: 0
        };
    } finally {
        client.release();
    }
}

// --- Helper Functions ---

export async function generateUniqueSlug(name) {
    const client = await pool.connect();
    try {
        let baseSlug = name.toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
            .replace(/\s+/g, '-') // Replace spaces with hyphens
            .replace(/-+/g, '-') // Replace multiple hyphens with single
            .trim();

        let slug = baseSlug;
        let counter = 1;

        while (true) {
            const result = await client.query(`
                SELECT id FROM organizations WHERE slug = $1
            `, [slug]);

            if (result.rows.length === 0) {
                return slug;
            }

            slug = `${baseSlug}-${counter}`;
            counter++;
        }
    } finally {
        client.release();
    }
}

export async function checkUserOrganizationAccess(userId, organizationId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT u.id, u.role, u.organization_id
            FROM users u
            WHERE u.id = $1 AND u.organization_id = $2
        `;
        const result = await client.query(query, [userId, organizationId]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function checkUserRole(userId, organizationId, requiredRole) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT u.role
            FROM users u
            WHERE u.id = $1 AND u.organization_id = $2
        `;
        const result = await client.query(query, [userId, organizationId]);

        if (result.rows.length === 0) {
            return false;
        }

        const userRole = result.rows[0].role;
        const roleHierarchy = ['viewer', 'member', 'admin', 'owner'];

        return roleHierarchy.indexOf(userRole) >= roleHierarchy.indexOf(requiredRole);
    } finally {
        client.release();
    }
}
