#!/usr/bin/env node
/**
 * Organization helper utilities
 * Provides optimized functions for getting user organizations using JWT enhancement
 */

import { getUserOrganizations } from '../database/userOrganizationMemberships.js';

/**
 * Get user's organization IDs with JWT optimization
 * Uses organization IDs from JWT token if available, otherwise falls back to database query
 * 
 * @param {Object} user - Request user object (from req.user)
 * @returns {Promise<string[]>} Array of organization IDs
 */
export async function getUserOrganizationIds(user) {
    // Use organization IDs from JWT if available (optimization for new tokens)
    if (user.organizationIds && Array.isArray(user.organizationIds) && user.organizationIds.length > 0) {
        return user.organizationIds;
    }

    // Fallback to database query for backward compatibility (old tokens without org IDs)
    const userOrganizations = await getUserOrganizations(user.id);
    return userOrganizations.map(org => org.id);
}

/**
 * Get user's first organization ID with JWT optimization
 * Uses organization IDs from JWT token if available, otherwise falls back to database query
 * 
 * @param {Object} user - Request user object (from req.user)
 * @returns {Promise<string|null>} First organization ID or null if user has no organizations
 */
export async function getUserFirstOrganizationId(user) {
    const organizationIds = await getUserOrganizationIds(user);
    return organizationIds.length > 0 ? organizationIds[0] : null;
}

/**
 * Get user's organizations with error handling
 * Throws error if user has no organizations
 * 
 * @param {Object} user - Request user object (from req.user)
 * @param {Object} res - Express response object (for error responses)
 * @returns {Promise<string[]>} Array of organization IDs
 * @throws {Error} If user has no organizations
 */
export async function requireUserOrganizations(user, res = null) {
    const organizationIds = await getUserOrganizationIds(user);

    if (organizationIds.length === 0) {
        const error = new Error('User must be part of an organization');
        if (res) {
            return res.status(400).json({
                error: 'User must be part of an organization',
                code: 'NO_ORGANIZATION'
            });
        }
        throw error;
    }

    return organizationIds;
}

/**
 * Get user's first organization ID with error handling
 * Throws error if user has no organizations
 * 
 * @param {Object} user - Request user object (from req.user)
 * @param {Object} res - Express response object (for error responses)
 * @returns {Promise<string>} First organization ID
 * @throws {Error} If user has no organizations
 */
export async function requireUserFirstOrganizationId(user, res = null) {
    const organizationId = await getUserFirstOrganizationId(user);

    if (!organizationId) {
        if (res) {
            res.status(400).json({
                error: 'User must be part of an organization',
                code: 'NO_ORGANIZATION'
            });
            return null; // Return null so caller knows error was sent
        }
        throw new Error('User must be part of an organization');
    }

    return organizationId;
}

