#!/usr/bin/env node
/**
 * Authentication utilities for Core Extract
 * Handles JWT tokens, password hashing, and user validation
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { validationResult } from 'express-validator';

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Hashed password
 */
export async function hashPassword(password) {
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
}

/**
 * Compare a password with its hash
 * @param {string} password - Plain text password
 * @param {string} hash - Hashed password
 * @returns {Promise<boolean>} - True if password matches
 */
export async function comparePassword(password, hash) {
    return await bcrypt.compare(password, hash);
}

/**
 * Generate JWT access token
 * @param {Object} payload - Token payload
 * @returns {string} - JWT token
 */
export function generateAccessToken(payload) {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: JWT_EXPIRES_IN,
        issuer: 'core-extract',
        audience: 'core-extract-api'
    });
}

/**
 * Generate JWT refresh token
 * @param {Object} payload - Token payload
 * @returns {string} - JWT refresh token
 */
export function generateRefreshToken(payload) {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRES_IN,
        issuer: 'core-extract',
        audience: 'core-extract-refresh'
    });
}

/**
 * Verify JWT token
 * @param {string} token - JWT token
 * @param {string} audience - Expected audience
 * @returns {Object} - Decoded token payload
 */
export function verifyToken(token, audience = 'core-extract-api') {
    try {
        return jwt.verify(token, JWT_SECRET, {
            issuer: 'core-extract',
            audience: audience
        });
    } catch (error) {
        throw new Error(`Invalid token: ${error.message}`);
    }
}

/**
 * Extract token from Authorization header
 * @param {string} authHeader - Authorization header value
 * @returns {string|null} - Extracted token or null
 */
export function extractTokenFromHeader(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    return authHeader.substring(7); // Remove 'Bearer ' prefix
}

/**
 * Validate request using express-validator
 * @param {Object} req - Express request object
 * @returns {Object} - Validation result
 */
export function validateRequest(req) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return {
            isValid: false,
            errors: errors.array().map(error => ({
                field: error.path,
                message: error.msg,
                value: error.value
            }))
        };
    }
    return { isValid: true, errors: [] };
}

/**
 * Generate secure random string for tokens/sessions
 * @param {number} length - Length of the string
 * @returns {string} - Random string
 */
export function generateSecureToken(length = 32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Password strength validation
 * @param {string} password - Password to validate
 * @returns {Object} - Validation result
 */
export function validatePasswordStrength(password) {
    const minLength = 8;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    const errors = [];
    
    if (password.length < minLength) {
        errors.push(`Password must be at least ${minLength} characters long`);
    }
    if (!hasUpperCase) {
        errors.push('Password must contain at least one uppercase letter');
    }
    if (!hasLowerCase) {
        errors.push('Password must contain at least one lowercase letter');
    }
    if (!hasNumbers) {
        errors.push('Password must contain at least one number');
    }
    if (!hasSpecialChar) {
        errors.push('Password must contain at least one special character');
    }

    return {
        isValid: errors.length === 0,
        errors,
        strength: calculatePasswordStrength(password)
    };
}

/**
 * Calculate password strength score
 * @param {string} password - Password to analyze
 * @returns {string} - Strength level (weak, medium, strong, very-strong)
 */
function calculatePasswordStrength(password) {
    let score = 0;
    
    // Length bonus
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (password.length >= 16) score += 1;
    
    // Character variety bonus
    if (/[a-z]/.test(password)) score += 1;
    if (/[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) score += 1;
    
    // Common patterns penalty
    if (/(.)\1{2,}/.test(password)) score -= 1; // Repeated characters
    if (/123|abc|qwe/i.test(password)) score -= 1; // Sequential patterns
    
    if (score <= 2) return 'weak';
    if (score <= 4) return 'medium';
    if (score <= 6) return 'strong';
    return 'very-strong';
}

/**
 * Sanitize user input to prevent XSS
 * @param {string} input - User input
 * @returns {string} - Sanitized input
 */
export function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    
    return input
        .replace(/[<>]/g, '') // Remove potential HTML tags
        .replace(/javascript:/gi, '') // Remove javascript: protocol
        .replace(/on\w+=/gi, '') // Remove event handlers
        .trim();
}

/**
 * Rate limiting configuration
 */
export const rateLimitConfig = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: 15 * 60 // seconds
    },
    standardHeaders: true,
    legacyHeaders: false,
};

/**
 * Auth-specific rate limiting
 */
export const authRateLimitConfig = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 auth requests per windowMs
    message: {
        error: 'Too many authentication attempts, please try again later.',
        retryAfter: 15 * 60 // seconds
    },
    standardHeaders: true,
    legacyHeaders: false,
};
