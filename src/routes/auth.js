#!/usr/bin/env node
/**
 * Authentication routes for Core Extract API
 * Handles user registration, login, logout, and token management
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import {
    generateAccessToken,
    generateRefreshToken,
    verifyToken,
    validatePasswordStrength,
    sanitizeInput,
    authRateLimitConfig
} from '../auth.js';
import {
    createUser,
    authenticateUser,
    getUserById,
    updateUser,
    changePassword,
    createUserSession,
    validateUserSession,
    deleteUserSession,
    deleteAllUserSessions,
    getUserStats
} from '../database/users.js';
import { createDefaultOrganizationForUser, getUserOrganizations } from '../database/userOrganizationMemberships.js';
import { authenticateToken, logAuthAttempt, securityHeaders } from '../middleware/auth.js';

const router = express.Router();

// Apply security headers to all auth routes
router.use(securityHeaders);

// Apply rate limiting to auth routes
// const authLimiter = rateLimit(authRateLimitConfig);
// router.use(authLimiter);

// Apply auth attempt logging
router.use(logAuthAttempt);

/**
 * POST /auth/register
 * Register a new user
 */
router.post('/register', [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email is required'),
    body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters long'),
    body('name')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters'),
], async (req, res) => {
    try {
        // Validate request
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array()
            });
        }

        const { email, password, name } = req.body;

        // Validate password strength
        const passwordValidation = validatePasswordStrength(password);
        if (!passwordValidation.isValid) {
            return res.status(400).json({
                success: false,
                error: 'Password does not meet requirements',
                details: passwordValidation.errors
            });
        }

        // Sanitize inputs
        const sanitizedEmail = sanitizeInput(email);
        const sanitizedName = sanitizeInput(name);

        // Create user
        const user = await createUser({
            email: sanitizedEmail,
            password: password,
            name: sanitizedName,
            role: 'user'
        });

        // Create default organization for the user
        console.log(`🏢 Creating default organization for user: ${user.name}`);
        const { organization } = await createDefaultOrganizationForUser(user.id, user.name, user.email);
        console.log(`✅ Created default organization: ${organization.name} (${organization.slug})`);

        // Get user organizations for JWT
        const userOrganizations = await getUserOrganizations(user.id);
        const organizationIds = userOrganizations.map(org => org.id);

        // Generate tokens with organization IDs
        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            role: user.role,
            organizationIds: organizationIds
        });

        const refreshToken = generateRefreshToken({
            userId: user.id,
            email: user.email,
            role: user.role,
            organizationIds: organizationIds
        });

        // Create session
        await createUserSession(user.id, refreshToken, {
            ipAddress: req.ip,
            userAgent: req.get('User-Agent')
        });

        console.log(`✅ User registered: ${user.email}`);

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    emailVerified: user.email_verified,
                    createdAt: user.created_at
                },
                tokens: {
                    accessToken,
                    refreshToken,
                    expiresIn: '24h'
                }
            }
        });

    } catch (error) {
        console.error('Registration error:', error.message);

        if (error.message.includes('already exists')) {
            return res.status(409).json({
                success: false,
                error: 'User with this email already exists',
                code: 'USER_EXISTS'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Registration failed',
            code: 'REGISTRATION_ERROR'
        });
    }
});

/**
 * POST /auth/login
 * Authenticate user and return tokens
 */
router.post('/login', [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email is required'),
    body('password')
        .notEmpty()
        .withMessage('Password is required'),
], async (req, res) => {
    try {
        // Validate request
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array()
            });
        }

        const { email, password } = req.body;

        // Sanitize email
        const sanitizedEmail = sanitizeInput(email);

        // Authenticate user
        const user = await authenticateUser(sanitizedEmail, password);
        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password',
                code: 'INVALID_CREDENTIALS'
            });
        }

        // Get user organizations for JWT
        const userOrganizations = await getUserOrganizations(user.id);
        const organizationIds = userOrganizations.map(org => org.id);

        // Generate tokens with organization IDs
        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            role: user.role,
            organizationIds: organizationIds
        });

        const refreshToken = generateRefreshToken({
            userId: user.id,
            email: user.email,
            role: user.role,
            organizationIds: organizationIds
        });

        // Create session
        await createUserSession(user.id, refreshToken, {
            ipAddress: req.ip,
            userAgent: req.get('User-Agent')
        });

        console.log(`✅ User logged in: ${user.email}`);

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    emailVerified: user.email_verified,
                    lastLoginAt: user.last_login_at,
                    loginCount: user.login_count
                },
                tokens: {
                    accessToken,
                    refreshToken,
                    expiresIn: '24h'
                }
            }
        });

    } catch (error) {
        console.error('Login error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Login failed',
            code: 'LOGIN_ERROR'
        });
    }
});

/**
 * POST /auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', [
    body('refreshToken')
        .notEmpty()
        .withMessage('Refresh token is required'),
], async (req, res) => {
    try {
        const { refreshToken } = req.body;

        // Validate refresh token
        const session = await validateUserSession(refreshToken);
        if (!session) {
            return res.status(401).json({
                success: false,
                error: 'Invalid or expired refresh token',
                code: 'INVALID_REFRESH_TOKEN'
            });
        }

        // Get user organizations for JWT (organizations may have changed since token was issued)
        const userOrganizations = await getUserOrganizations(session.user_id);
        const organizationIds = userOrganizations.map(org => org.id);

        // Generate new access token with organization IDs
        const accessToken = generateAccessToken({
            userId: session.user_id,
            email: session.email,
            role: session.role,
            organizationIds: organizationIds
        });

        console.log(`✅ Token refreshed for user: ${session.email}`);

        res.json({
            success: true,
            message: 'Token refreshed successfully',
            data: {
                accessToken,
                expiresIn: '24h'
            }
        });

    } catch (error) {
        console.error('Token refresh error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Token refresh failed',
            code: 'REFRESH_ERROR'
        });
    }
});

/**
 * POST /auth/logout
 * Logout user and invalidate session
 */
router.post('/logout', authenticateToken, async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (refreshToken) {
            // Delete specific session
            await deleteUserSession(refreshToken);
        } else {
            // Delete all user sessions
            await deleteAllUserSessions(req.user.id);
        }

        console.log(`✅ User logged out: ${req.user.email}`);

        res.json({
            success: true,
            message: 'Logout successful'
        });

    } catch (error) {
        console.error('Logout error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Logout failed',
            code: 'LOGOUT_ERROR'
        });
    }
});

/**
 * GET /auth/me
 * Get current user information
 */
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const user = await getUserById(req.user.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found',
                code: 'USER_NOT_FOUND'
            });
        }

        res.json({
            success: true,
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    emailVerified: user.email_verified,
                    createdAt: user.created_at,
                    lastLoginAt: user.last_login_at,
                    loginCount: user.login_count
                }
            }
        });

    } catch (error) {
        console.error('Get user error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Failed to get user information',
            code: 'GET_USER_ERROR'
        });
    }
});

/**
 * GET /auth/stats
 * Get user statistics
 */
router.get('/stats', authenticateToken, async (req, res) => {
    try {
        const stats = await getUserStats(req.user.id);
        if (!stats) {
            return res.status(404).json({
                success: false,
                error: 'User not found',
                code: 'USER_NOT_FOUND'
            });
        }

        res.json({
            success: true,
            data: {
                stats: {
                    user: {
                        id: stats.id,
                        email: stats.email,
                        name: stats.name,
                        role: stats.role,
                        createdAt: stats.created_at,
                        lastLoginAt: stats.last_login_at,
                        loginCount: stats.login_count
                    },
                    jobs: {
                        total: parseInt(stats.total_jobs) || 0,
                        completed: parseInt(stats.completed_jobs) || 0,
                        processing: parseInt(stats.processing_jobs) || 0,
                        failed: parseInt(stats.failed_jobs) || 0
                    },
                    files: {
                        total: parseInt(stats.total_files) || 0,
                        totalSizeBytes: parseInt(stats.total_storage_bytes) || 0
                    }
                }
            }
        });

    } catch (error) {
        console.error('Get user stats error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Failed to get user statistics',
            code: 'GET_STATS_ERROR'
        });
    }
});

/**
 * PUT /auth/profile
 * Update user profile
 */
router.put('/profile', authenticateToken, [
    body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters'),
    body('email')
        .optional()
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email is required'),
], async (req, res) => {
    try {
        // Validate request
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array()
            });
        }

        const { name, email } = req.body;
        const updateData = {};

        if (name) updateData.name = sanitizeInput(name);
        if (email) updateData.email = sanitizeInput(email);

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No valid fields to update'
            });
        }

        const updatedUser = await updateUser(req.user.id, updateData);

        console.log(`✅ User profile updated: ${updatedUser.email}`);

        res.json({
            success: true,
            message: 'Profile updated successfully',
            data: {
                user: {
                    id: updatedUser.id,
                    email: updatedUser.email,
                    name: updatedUser.name,
                    role: updatedUser.role,
                    emailVerified: updatedUser.email_verified,
                    updatedAt: updatedUser.updated_at
                }
            }
        });

    } catch (error) {
        console.error('Profile update error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Profile update failed',
            code: 'PROFILE_UPDATE_ERROR'
        });
    }
});

/**
 * PUT /auth/change-password
 * Change user password
 */
router.put('/change-password', authenticateToken, [
    body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required'),
    body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters long'),
], async (req, res) => {
    try {
        // Validate request
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array()
            });
        }

        const { currentPassword, newPassword } = req.body;

        // Validate new password strength
        const passwordValidation = validatePasswordStrength(newPassword);
        if (!passwordValidation.isValid) {
            return res.status(400).json({
                success: false,
                error: 'New password does not meet requirements',
                details: passwordValidation.errors
            });
        }

        // Change password
        await changePassword(req.user.id, currentPassword, newPassword);

        console.log(`✅ Password changed for user: ${req.user.email}`);

        res.json({
            success: true,
            message: 'Password changed successfully'
        });

    } catch (error) {
        console.error('Password change error:', error.message);

        if (error.message.includes('incorrect')) {
            return res.status(400).json({
                success: false,
                error: 'Current password is incorrect',
                code: 'INVALID_CURRENT_PASSWORD'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Password change failed',
            code: 'PASSWORD_CHANGE_ERROR'
        });
    }
});

export default router;
