#!/usr/bin/env node
/**
 * User management database functions
 * Handles user CRUD operations, authentication, and session management
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { hashPassword, comparePassword, generateSecureToken } from '../auth.js';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'batch_processor',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

/**
 * Create a new user
 * @param {Object} userData - User data
 * @returns {Object} - Created user (without password)
 */
export async function createUser(userData) {
    const client = await pool.connect();
    try {
        const { email, password, name, role = 'user' } = userData;

        // Check if user already exists
        const existingUser = await getUserByEmail(email);
        if (existingUser) {
            throw new Error('User with this email already exists');
        }

        // Hash password
        const hashedPassword = await hashPassword(password);

        // Create user
        const query = `
            INSERT INTO users (email, password_hash, name, role, email_verified, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            RETURNING id, email, name, role, email_verified, created_at, updated_at
        `;

        const values = [email, hashedPassword, name, role, false];
        const result = await client.query(query, values);

        console.log(`✅ User created: ${email}`);
        return result.rows[0];

    } catch (error) {
        console.error('❌ Error creating user:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get user by email
 * @param {string} email - User email
 * @returns {Object|null} - User data or null
 */
export async function getUserByEmail(email) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT id, email, password_hash, name, role, email_verified, 
                   created_at, updated_at, last_login_at, login_count
            FROM users 
            WHERE email = $1
        `;

        const result = await client.query(query, [email]);
        return result.rows[0] || null;

    } catch (error) {
        console.error('❌ Error getting user by email:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get user by ID
 * @param {string} userId - User ID
 * @returns {Object|null} - User data or null
 */
export async function getUserById(userId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT id, email, name, role, email_verified, 
                   created_at, updated_at, last_login_at, login_count
            FROM users 
            WHERE id = $1
        `;

        const result = await client.query(query, [userId]);
        return result.rows[0] || null;

    } catch (error) {
        console.error('❌ Error getting user by ID:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Authenticate user with email and password
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Object|null} - User data or null
 */
export async function authenticateUser(email, password) {
    const client = await pool.connect();
    try {
        const user = await getUserByEmail(email);
        if (!user) {
            return null;
        }

        const isValidPassword = await comparePassword(password, user.password_hash);
        if (!isValidPassword) {
            return null;
        }

        // Update login statistics
        await updateUserLoginStats(user.id);

        // Return user without password hash
        const { password_hash, ...userWithoutPassword } = user;
        return userWithoutPassword;

    } catch (error) {
        console.error('❌ Error authenticating user:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Update user login statistics
 * @param {string} userId - User ID
 */
export async function updateUserLoginStats(userId) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE users 
            SET last_login_at = NOW(), 
                login_count = COALESCE(login_count, 0) + 1,
                updated_at = NOW()
            WHERE id = $1
        `;

        await client.query(query, [userId]);

    } catch (error) {
        console.error('❌ Error updating login stats:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Update user profile
 * @param {string} userId - User ID
 * @param {Object} updateData - Data to update
 * @returns {Object} - Updated user
 */
export async function updateUser(userId, updateData) {
    const client = await pool.connect();
    try {
        const allowedFields = ['name', 'email', 'role'];
        const updates = [];
        const values = [];
        let paramCount = 1;

        for (const [key, value] of Object.entries(updateData)) {
            if (allowedFields.includes(key) && value !== undefined) {
                updates.push(`${key} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }

        if (updates.length === 0) {
            throw new Error('No valid fields to update');
        }

        updates.push(`updated_at = NOW()`);
        values.push(userId);

        const query = `
            UPDATE users 
            SET ${updates.join(', ')}
            WHERE id = $${paramCount}
            RETURNING id, email, name, role, email_verified, created_at, updated_at
        `;

        const result = await client.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('User not found');
        }

        console.log(`✅ User updated: ${userId}`);
        return result.rows[0];

    } catch (error) {
        console.error('❌ Error updating user:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Change user password
 * @param {string} userId - User ID
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 * @returns {boolean} - Success status
 */
export async function changePassword(userId, currentPassword, newPassword) {
    const client = await pool.connect();
    try {
        // Get current user with password hash
        const query = `
            SELECT password_hash FROM users WHERE id = $1
        `;
        const result = await client.query(query, [userId]);

        if (result.rows.length === 0) {
            throw new Error('User not found');
        }

        const { password_hash } = result.rows[0];

        // Verify current password
        const isValidPassword = await comparePassword(currentPassword, password_hash);
        if (!isValidPassword) {
            throw new Error('Current password is incorrect');
        }

        // Hash new password
        const hashedNewPassword = await hashPassword(newPassword);

        // Update password
        const updateQuery = `
            UPDATE users 
            SET password_hash = $1, updated_at = NOW()
            WHERE id = $2
        `;

        await client.query(updateQuery, [hashedNewPassword, userId]);

        console.log(`✅ Password changed for user: ${userId}`);
        return true;

    } catch (error) {
        console.error('❌ Error changing password:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Create user session
 * @param {string} userId - User ID
 * @param {string} token - Session token
 * @param {Object} sessionData - Additional session data
 * @returns {Object} - Created session
 */
export async function createUserSession(userId, token, sessionData = {}) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO user_sessions (user_id, token, ip_address, user_agent, expires_at, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING id, token, expires_at, created_at
        `;

        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        const values = [
            userId,
            token,
            sessionData.ipAddress || null,
            sessionData.userAgent || null,
            expiresAt
        ];

        const result = await client.query(query, values);

        console.log(`✅ Session created for user: ${userId}`);
        return result.rows[0];

    } catch (error) {
        console.error('❌ Error creating session:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Validate user session
 * @param {string} token - Session token
 * @returns {Object|null} - Session data or null
 */
export async function validateUserSession(token) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT s.id, s.user_id, s.token, s.expires_at, s.created_at,
                   u.email, u.name, u.role
            FROM user_sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.token = $1 AND s.expires_at > NOW()
        `;

        const result = await client.query(query, [token]);
        return result.rows[0] || null;

    } catch (error) {
        console.error('❌ Error validating session:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Delete user session
 * @param {string} token - Session token
 * @returns {boolean} - Success status
 */
export async function deleteUserSession(token) {
    const client = await pool.connect();
    try {
        const query = `
            DELETE FROM user_sessions 
            WHERE token = $1
        `;

        const result = await client.query(query, [token]);

        console.log(`✅ Session deleted: ${token}`);
        return result.rowCount > 0;

    } catch (error) {
        console.error('❌ Error deleting session:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Delete all user sessions
 * @param {string} userId - User ID
 * @returns {number} - Number of sessions deleted
 */
export async function deleteAllUserSessions(userId) {
    const client = await pool.connect();
    try {
        const query = `
            DELETE FROM user_sessions 
            WHERE user_id = $1
        `;

        const result = await client.query(query, [userId]);

        console.log(`✅ All sessions deleted for user: ${userId}`);
        return result.rowCount;

    } catch (error) {
        console.error('❌ Error deleting all sessions:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get user statistics
 * @param {string} userId - User ID
 * @returns {Object} - User statistics
 */
export async function getUserStats(userId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                u.id,
                u.email,
                u.name,
                u.role,
                u.created_at,
                u.last_login_at,
                u.login_count,
                COUNT(j.id) as total_jobs,
                COUNT(CASE WHEN j.status = 'completed' THEN 1 END) as completed_jobs,
                COUNT(CASE WHEN j.status = 'processing' THEN 1 END) as processing_jobs,
                COUNT(CASE WHEN j.status = 'failed' THEN 1 END) as failed_jobs,
                COUNT(jf.id) as total_files,
                SUM(jf.size) as total_storage_bytes
            FROM users u
            LEFT JOIN jobs j ON u.id = j.user_id
            LEFT JOIN job_files jf ON j.id = jf.job_id
            WHERE u.id = $1
            GROUP BY u.id, u.email, u.name, u.role, u.created_at, u.last_login_at, u.login_count
        `;

        const result = await client.query(query, [userId]);
        return result.rows[0] || null;

    } catch (error) {
        console.error('❌ Error getting user stats:', error.message);
        throw error;
    } finally {
        client.release();
    }
}
