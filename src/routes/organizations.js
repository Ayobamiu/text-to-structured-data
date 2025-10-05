import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticateToken } from '../middleware/auth.js';
import {
    createOrganization,
    findOrganizationById,
    findOrganizationBySlug,
    updateOrganization,
    deleteOrganization,
    generateUniqueSlug
} from '../database/organizations.js';
import {
    getUserOrganizations,
    getUserRoleInOrganization,
    createUserOrganizationMembership,
    removeUserFromOrganization,
    getOrganizationMembers,
    updateUserOrganizationRole,
    getOrganizationStats
} from '../database/userOrganizationMemberships.js';
import { createAuditLog } from '../database/users.js';

const router = express.Router();

// Helper to get IP address
const getIpAddress = (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress;

// --- Organization CRUD Routes ---

// Create organization
router.post('/', authenticateToken, [
    body('name').trim().notEmpty().withMessage('Organization name is required'),
    body('domain').optional().isEmail().withMessage('Domain must be a valid email format')
], async (req, res) => {
    const { name, domain } = req.body;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`🏢 Creating organization: ${name} by user ${req.user.userId}`);

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array()
            });
        }

        // Generate unique slug
        const slug = await generateUniqueSlug(name);

        // Create organization
        const organization = await createOrganization(name, slug, domain);

        // Add user as owner of the organization
        await createUserOrganizationMembership(req.user.id, organization.id, 'owner');

        await createAuditLog(req.user.id, 'ORGANIZATION_CREATED', 'organization', organization.id,
            { organizationName: name, slug }, ipAddress, userAgent);

        console.log(`✅ Organization created: ${organization.name} (${organization.slug})`);

        res.status(201).json({
            success: true,
            message: 'Organization created successfully',
            data: { organization }
        });
    } catch (error) {
        console.error('❌ Error creating organization:', error.message);
        await createAuditLog(req.user.userId, 'ORGANIZATION_CREATE_FAILED', 'organization', null,
            { error: error.message, organizationName: name }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to create organization',
            code: 'ORGANIZATION_CREATE_ERROR'
        });
    }
});

// Get user's organizations
router.get('/', authenticateToken, async (req, res) => {
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    try {
        const organizations = await getUserOrganizations(req.user.id);

        await createAuditLog(req.user.id, 'ORGANIZATIONS_LISTED', 'organization', null,
            { count: organizations.length }, ipAddress, userAgent);

        res.json({
            success: true,
            data: { organizations }
        });
    } catch (error) {
        console.error('❌ Error getting organizations:', error.message);
        await createAuditLog(req.user.id, 'ORGANIZATIONS_LIST_FAILED', 'organization', null,
            { error: error.message }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to get organizations',
            code: 'ORGANIZATIONS_LIST_ERROR'
        });
    }
});

// Get organization by ID
router.get('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`🏢 Getting organization ${id} by user ${req.user.userId}`);

    try {
        // Check if user has access to this organization
        const access = await checkUserOrganizationAccess(req.user.userId, id);
        if (!access) {
            await createAuditLog(req.user.userId, 'ORGANIZATION_ACCESS_DENIED', 'organization', id,
                null, ipAddress, userAgent);
            return res.status(403).json({
                success: false,
                error: 'Access denied to organization',
                code: 'ORGANIZATION_ACCESS_DENIED'
            });
        }

        const organization = await findOrganizationById(id);
        if (!organization) {
            return res.status(404).json({
                success: false,
                error: 'Organization not found',
                code: 'ORGANIZATION_NOT_FOUND'
            });
        }

        await createAuditLog(req.user.userId, 'ORGANIZATION_VIEWED', 'organization', id,
            null, ipAddress, userAgent);

        res.json({
            success: true,
            data: { organization }
        });
    } catch (error) {
        console.error('❌ Error getting organization:', error.message);
        await createAuditLog(req.user.userId, 'ORGANIZATION_VIEW_FAILED', 'organization', id,
            { error: error.message }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to get organization',
            code: 'ORGANIZATION_VIEW_ERROR'
        });
    }
});

// Update organization
router.put('/:id', authenticateToken, [
    body('name').optional().trim().notEmpty().withMessage('Organization name cannot be empty'),
    body('domain').optional().isEmail().withMessage('Domain must be a valid email format')
], async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`🏢 Updating organization ${id} by user ${req.user.userId}`);

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array()
            });
        }

        // Check if user has admin/owner access to this organization
        const hasAccess = await checkUserRole(req.user.userId, id, 'admin');
        if (!hasAccess) {
            await createAuditLog(req.user.userId, 'ORGANIZATION_UPDATE_DENIED', 'organization', id,
                null, ipAddress, userAgent);
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to update organization',
                code: 'ORGANIZATION_UPDATE_DENIED'
            });
        }

        // Generate new slug if name is being updated
        if (updates.name) {
            updates.slug = await generateUniqueSlug(updates.name);
        }

        const organization = await updateOrganization(id, updates);

        await createAuditLog(req.user.userId, 'ORGANIZATION_UPDATED', 'organization', id,
            { updates }, ipAddress, userAgent);

        console.log(`✅ Organization updated: ${organization.name}`);

        res.json({
            success: true,
            message: 'Organization updated successfully',
            data: { organization }
        });
    } catch (error) {
        console.error('❌ Error updating organization:', error.message);
        await createAuditLog(req.user.userId, 'ORGANIZATION_UPDATE_FAILED', 'organization', id,
            { error: error.message, updates }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to update organization',
            code: 'ORGANIZATION_UPDATE_ERROR'
        });
    }
});

// Delete organization
router.delete('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`🏢 Deleting organization ${id} by user ${req.user.userId}`);

    try {
        // Check if user has owner access to this organization
        const hasAccess = await checkUserRole(req.user.userId, id, 'owner');
        if (!hasAccess) {
            await createAuditLog(req.user.userId, 'ORGANIZATION_DELETE_DENIED', 'organization', id,
                null, ipAddress, userAgent);
            return res.status(403).json({
                success: false,
                error: 'Only organization owners can delete organizations',
                code: 'ORGANIZATION_DELETE_DENIED'
            });
        }

        const organization = await deleteOrganization(id);

        await createAuditLog(req.user.userId, 'ORGANIZATION_DELETED', 'organization', id,
            { organizationName: organization.name }, ipAddress, userAgent);

        console.log(`✅ Organization deleted: ${organization.name}`);

        res.json({
            success: true,
            message: 'Organization deleted successfully',
            data: { organization }
        });
    } catch (error) {
        console.error('❌ Error deleting organization:', error.message);
        await createAuditLog(req.user.userId, 'ORGANIZATION_DELETE_FAILED', 'organization', id,
            { error: error.message }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to delete organization',
            code: 'ORGANIZATION_DELETE_ERROR'
        });
    }
});

// --- Organization Members Management ---

// Get organization members
router.get('/:id/members', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`👥 Getting members for organization ${id} by user ${req.user.userId}`);

    try {
        // Check if user has access to this organization
        const userRole = await getUserRoleInOrganization(req.user.id, id);
        if (!userRole) {
            return res.status(403).json({
                success: false,
                error: 'Access denied to organization',
                code: 'ORGANIZATION_ACCESS_DENIED'
            });
        }

        const members = await getOrganizationMembers(id);

        await createAuditLog(req.user.userId, 'ORGANIZATION_MEMBERS_LISTED', 'organization', id,
            { memberCount: members.length }, ipAddress, userAgent);

        res.json({
            success: true,
            data: { members }
        });
    } catch (error) {
        console.error('❌ Error getting organization members:', error.message);
        await createAuditLog(req.user.userId, 'ORGANIZATION_MEMBERS_LIST_FAILED', 'organization', id,
            { error: error.message }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to get organization members',
            code: 'ORGANIZATION_MEMBERS_LIST_ERROR'
        });
    }
});

// Update member role
router.put('/:id/members/:userId', authenticateToken, [
    body('role').isIn(['owner', 'admin', 'member', 'viewer']).withMessage('Invalid role')
], async (req, res) => {
    const { id, userId } = req.params;
    const { role } = req.body;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`👥 Updating member ${userId} role to ${role} in organization ${id}`);

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array()
            });
        }

        // Check if user has admin/owner access to this organization
        const hasAccess = await checkUserRole(req.user.userId, id, 'admin');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to update member roles',
                code: 'MEMBER_UPDATE_DENIED'
            });
        }

        // Prevent non-owners from making someone an owner
        if (role === 'owner') {
            const isOwner = await checkUserRole(req.user.userId, id, 'owner');
            if (!isOwner) {
                return res.status(403).json({
                    success: false,
                    error: 'Only owners can assign owner role',
                    code: 'OWNER_ROLE_DENIED'
                });
            }
        }

        const member = await updateUserRole(userId, role, req.user.userId);

        await createAuditLog(req.user.userId, 'MEMBER_ROLE_UPDATED', 'user', userId,
            { organizationId: id, newRole: role }, ipAddress, userAgent);

        console.log(`✅ Member role updated: ${member.email} -> ${role}`);

        res.json({
            success: true,
            message: 'Member role updated successfully',
            data: { member }
        });
    } catch (error) {
        console.error('❌ Error updating member role:', error.message);
        await createAuditLog(req.user.userId, 'MEMBER_ROLE_UPDATE_FAILED', 'user', userId,
            { error: error.message, organizationId: id, role }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to update member role',
            code: 'MEMBER_ROLE_UPDATE_ERROR'
        });
    }
});

// Remove member from organization
router.delete('/:id/members/:userId', authenticateToken, async (req, res) => {
    const { id, userId } = req.params;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`👥 Removing member ${userId} from organization ${id}`);

    try {
        // Check if user has admin/owner access to this organization
        const hasAccess = await checkUserRole(req.user.userId, id, 'admin');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to remove members',
                code: 'MEMBER_REMOVE_DENIED'
            });
        }

        // Prevent removing the last owner
        if (userId === req.user.userId) {
            const members = await getOrganizationMembers(id);
            const ownerCount = members.filter(m => m.role === 'owner').length;
            if (ownerCount <= 1) {
                return res.status(400).json({
                    success: false,
                    error: 'Cannot remove the last owner from organization',
                    code: 'LAST_OWNER_REMOVE_DENIED'
                });
            }
        }

        const member = await removeUserFromOrganization(userId);

        await createAuditLog(req.user.userId, 'MEMBER_REMOVED', 'user', userId,
            { organizationId: id, memberEmail: member.email }, ipAddress, userAgent);

        console.log(`✅ Member removed: ${member.email}`);

        res.json({
            success: true,
            message: 'Member removed successfully',
            data: { member }
        });
    } catch (error) {
        console.error('❌ Error removing member:', error.message);
        await createAuditLog(req.user.userId, 'MEMBER_REMOVE_FAILED', 'user', userId,
            { error: error.message, organizationId: id }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to remove member',
            code: 'MEMBER_REMOVE_ERROR'
        });
    }
});

// --- Organization Invitations ---

// Invite user to organization
router.post('/:id/invite', authenticateToken, [
    body('email').isEmail().withMessage('Valid email is required'),
    body('role').isIn(['admin', 'member', 'viewer']).withMessage('Invalid role')
], async (req, res) => {
    const { id } = req.params;
    const { email, role } = req.body;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`📧 Inviting ${email} to organization ${id} with role ${role}`);

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array()
            });
        }

        // Check if user has admin/owner access to this organization
        const hasAccess = await checkUserRole(req.user.userId, id, 'admin');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to invite members',
                code: 'INVITE_DENIED'
            });
        }

        const invitation = await createOrganizationInvitation(id, email, role, req.user.userId);

        await createAuditLog(req.user.userId, 'INVITATION_SENT', 'organization_invitation', invitation.id,
            { organizationId: id, email, role }, ipAddress, userAgent);

        console.log(`✅ Invitation sent to ${email}`);

        res.status(201).json({
            success: true,
            message: 'Invitation sent successfully',
            data: { invitation }
        });
    } catch (error) {
        console.error('❌ Error sending invitation:', error.message);
        await createAuditLog(req.user.userId, 'INVITATION_SEND_FAILED', 'organization_invitation', null,
            { error: error.message, organizationId: id, email, role }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to send invitation',
            code: 'INVITATION_SEND_ERROR'
        });
    }
});

// Get organization invitations
router.get('/:id/invitations', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`📧 Getting invitations for organization ${id}`);

    try {
        // Check if user has admin/owner access to this organization
        const hasAccess = await checkUserRole(req.user.userId, id, 'admin');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to view invitations',
                code: 'INVITATIONS_VIEW_DENIED'
            });
        }

        const invitations = await getOrganizationInvitations(id);

        await createAuditLog(req.user.userId, 'INVITATIONS_LISTED', 'organization', id,
            { invitationCount: invitations.length }, ipAddress, userAgent);

        res.json({
            success: true,
            data: { invitations }
        });
    } catch (error) {
        console.error('❌ Error getting invitations:', error.message);
        await createAuditLog(req.user.userId, 'INVITATIONS_LIST_FAILED', 'organization', id,
            { error: error.message }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to get invitations',
            code: 'INVITATIONS_LIST_ERROR'
        });
    }
});

// Cancel invitation
router.delete('/:id/invitations/:invitationId', authenticateToken, async (req, res) => {
    const { id, invitationId } = req.params;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`📧 Cancelling invitation ${invitationId} for organization ${id}`);

    try {
        // Check if user has admin/owner access to this organization
        const hasAccess = await checkUserRole(req.user.userId, id, 'admin');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions to cancel invitations',
                code: 'INVITATION_CANCEL_DENIED'
            });
        }

        const invitation = await cancelInvitation(invitationId);
        if (!invitation) {
            return res.status(404).json({
                success: false,
                error: 'Invitation not found or already accepted',
                code: 'INVITATION_NOT_FOUND'
            });
        }

        await createAuditLog(req.user.userId, 'INVITATION_CANCELLED', 'organization_invitation', invitationId,
            { organizationId: id, email: invitation.email }, ipAddress, userAgent);

        console.log(`✅ Invitation cancelled: ${invitation.email}`);

        res.json({
            success: true,
            message: 'Invitation cancelled successfully',
            data: { invitation }
        });
    } catch (error) {
        console.error('❌ Error cancelling invitation:', error.message);
        await createAuditLog(req.user.userId, 'INVITATION_CANCEL_FAILED', 'organization_invitation', invitationId,
            { error: error.message, organizationId: id }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to cancel invitation',
            code: 'INVITATION_CANCEL_ERROR'
        });
    }
});

// Accept invitation (public endpoint)
router.post('/invitations/:token/accept', authenticateToken, async (req, res) => {
    const { token } = req.params;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`📧 Accepting invitation ${token} by user ${req.user.userId}`);

    try {
        const result = await acceptInvitation(token, req.user.userId);

        await createAuditLog(req.user.userId, 'INVITATION_ACCEPTED', 'organization_invitation', null,
            { organizationId: result.organizationId, organizationName: result.organizationName, role: result.role }, ipAddress, userAgent);

        console.log(`✅ Invitation accepted: User ${req.user.userId} joined organization ${result.organizationName}`);

        res.json({
            success: true,
            message: 'Invitation accepted successfully',
            data: {
                organizationId: result.organizationId,
                organizationName: result.organizationName,
                role: result.role
            }
        });
    } catch (error) {
        console.error('❌ Error accepting invitation:', error.message);
        await createAuditLog(req.user.userId, 'INVITATION_ACCEPT_FAILED', 'organization_invitation', null,
            { error: error.message, token }, ipAddress, userAgent);
        res.status(400).json({
            success: false,
            error: error.message,
            code: 'INVITATION_ACCEPT_ERROR'
        });
    }
});

// Get invitation details (public endpoint)
router.get('/invitations/:token', async (req, res) => {
    const { token } = req.params;

    console.log(`📧 Getting invitation details for token ${token}`);

    try {
        const invitation = await findInvitationByToken(token);
        if (!invitation) {
            return res.status(404).json({
                success: false,
                error: 'Invalid or expired invitation',
                code: 'INVITATION_NOT_FOUND'
            });
        }

        res.json({
            success: true,
            data: { invitation }
        });
    } catch (error) {
        console.error('❌ Error getting invitation:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to get invitation',
            code: 'INVITATION_GET_ERROR'
        });
    }
});

// Get organization statistics
router.get('/:id/stats', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const ipAddress = getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    console.log(`📊 Getting stats for organization ${id}`);

    try {
        // Check if user has access to this organization
        const access = await checkUserOrganizationAccess(req.user.userId, id);
        if (!access) {
            return res.status(403).json({
                success: false,
                error: 'Access denied to organization',
                code: 'ORGANIZATION_ACCESS_DENIED'
            });
        }

        const stats = await getOrganizationStats(id);

        await createAuditLog(req.user.userId, 'ORGANIZATION_STATS_VIEWED', 'organization', id,
            null, ipAddress, userAgent);

        res.json({
            success: true,
            data: { stats }
        });
    } catch (error) {
        console.error('❌ Error getting organization stats:', error.message);
        await createAuditLog(req.user.userId, 'ORGANIZATION_STATS_FAILED', 'organization', id,
            { error: error.message }, ipAddress, userAgent);
        res.status(500).json({
            success: false,
            error: 'Failed to get organization statistics',
            code: 'ORGANIZATION_STATS_ERROR'
        });
    }
});

export default router;
