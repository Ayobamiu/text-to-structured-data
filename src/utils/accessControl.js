#!/usr/bin/env node
/**
 * Centralized access control helpers
 * Provides consistent access checking for jobs and files
 */

import { userHasJobAccess, getJobOrganizationId } from '../database.js';
import { getUserOrganizationIds } from './organizationHelpers.js';
import { getFileResult } from '../database.js';

/**
 * Check if user has access to a job
 * Returns true if user is a member of the job's organization (any role: owner, admin, member, viewer)
 * 
 * @param {string} jobId - Job ID to check access for
 * @param {Object} user - Request user object (from req.user)
 * @param {Object} res - Express response object (optional, for automatic error responses)
 * @returns {Promise<boolean>} True if user has access, false otherwise
 */
export async function checkJobAccess(jobId, user, res = null) {
    try {
        // Get user's organization IDs
        const userOrganizationIds = await getUserOrganizationIds(user);

        // Check access using centralized function
        const hasAccess = await userHasJobAccess(
            jobId,
            user.email,
            user.role,
            userOrganizationIds
        );

        if (!hasAccess && res) {
            res.status(403).json({
                status: "error",
                message: "Access denied to this job"
            });
        }

        return hasAccess;
    } catch (error) {
        console.error('❌ Error checking job access:', error.message);
        if (res) {
            res.status(500).json({
                status: "error",
                message: "Failed to check access"
            });
        }
        return false;
    }
}

/**
 * Check if user has access to a file
 * Files inherit access from their parent job
 * 
 * @param {string} fileId - File ID to check access for
 * @param {Object} user - Request user object (from req.user)
 * @param {Object} res - Express response object (optional, for automatic error responses)
 * @returns {Promise<boolean>} True if user has access, false otherwise
 */
export async function checkFileAccess(fileId, user, res = null) {
    try {
        // Get file to find its job_id
        const file = await getFileResult(fileId);

        if (!file) {
            if (res) {
                res.status(404).json({
                    status: "error",
                    message: "File not found"
                });
            }
            return false;
        }

        // Check access via job
        return await checkJobAccess(file.job_id, user, res);
    } catch (error) {
        console.error('❌ Error checking file access:', error.message);
        if (res) {
            res.status(500).json({
                status: "error",
                message: "Failed to check access"
            });
        }
        return false;
    }
}

