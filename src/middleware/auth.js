#!/usr/bin/env node
/**
 * Authentication middleware for Core Extract API
 * Handles JWT verification, user authentication, and authorization
 */

import { verifyToken, extractTokenFromHeader } from '../auth.js';

/**
 * Middleware to authenticate JWT tokens
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
export function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        const token = extractTokenFromHeader(authHeader);

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Access token required',
                code: 'MISSING_TOKEN'
            });
        }

        const decoded = verifyToken(token);

        // Add user info to request object
        req.user = {
            id: decoded.userId,
            email: decoded.email,
            role: decoded.role || 'user',
            token: token
        };

        next();
    } catch (error) {
        console.error('Authentication error:', error.message);

        return res.status(401).json({
            success: false,
            error: 'Invalid or expired token',
            code: 'INVALID_TOKEN'
        });
    }
}

/**
 * Middleware to check if user has required role
 * @param {string|Array} requiredRoles - Required role(s)
 * @returns {Function} - Middleware function
 */
export function requireRole(requiredRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }

        const userRole = req.user.role;
        const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];

        if (!roles.includes(userRole)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions',
                code: 'INSUFFICIENT_PERMISSIONS',
                required: roles,
                current: userRole
            });
        }

        next();
    };
}

/**
 * Middleware to check if user owns the resource
 * @param {string} resourceUserIdField - Field name containing user ID in request
 * @returns {Function} - Middleware function
 */
export function requireOwnership(resourceUserIdField = 'user_id') {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }

        // Admin users can access any resource
        if (req.user.role === 'admin') {
            return next();
        }

        const resourceUserId = req.params[resourceUserIdField] || req.body[resourceUserIdField];

        if (!resourceUserId) {
            return res.status(400).json({
                success: false,
                error: 'Resource user ID not specified',
                code: 'MISSING_RESOURCE_USER_ID'
            });
        }

        if (req.user.id !== resourceUserId) {
            return res.status(403).json({
                success: false,
                error: 'Access denied: You can only access your own resources',
                code: 'OWNERSHIP_REQUIRED'
            });
        }

        next();
    };
}

/**
 * Optional authentication middleware
 * Adds user info if token is present, but doesn't require it
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
export function optionalAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        const token = extractTokenFromHeader(authHeader);

        if (token) {
            const decoded = verifyToken(token);
            req.user = {
                id: decoded.userId,
                email: decoded.email,
                role: decoded.role || 'user',
                token: token
            };
        }

        next();
    } catch (error) {
        // Continue without authentication if token is invalid
        next();
    }
}

/**
 * Middleware to validate API key (for programmatic access)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
export function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({
            success: false,
            error: 'API key required',
            code: 'MISSING_API_KEY'
        });
    }

    // TODO: Implement API key validation against database
    // For now, we'll use a simple environment variable check
    const validApiKey = process.env.API_KEY;

    if (!validApiKey || apiKey !== validApiKey) {
        return res.status(401).json({
            success: false,
            error: 'Invalid API key',
            code: 'INVALID_API_KEY'
        });
    }

    // Add API key info to request
    req.apiKey = apiKey;
    req.authType = 'api_key';

    next();
}

/**
 * Middleware to log authentication attempts
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
export function logAuthAttempt(req, res, next) {
    const startTime = Date.now();

    // Log the request
    console.log(`🔐 Auth attempt: ${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
    });

    // Override res.json to log response
    const originalJson = res.json;
    res.json = function (data) {
        const duration = Date.now() - startTime;

        console.log(`🔐 Auth response: ${res.statusCode}`, {
            duration: `${duration}ms`,
            success: data.success,
            error: data.error,
            code: data.code
        });

        return originalJson.call(this, data);
    };

    next();
}

/**
 * Middleware to add security headers
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
export function securityHeaders(req, res, next) {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Enable XSS protection
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Strict Transport Security (HTTPS only)
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // Content Security Policy
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self' ws: wss:;"
    );

    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    next();
}

/**
 * Middleware to validate request origin
 * @param {Array} allowedOrigins - Array of allowed origins
 * @returns {Function} - Middleware function
 */
export function validateOrigin(allowedOrigins = []) {
    return (req, res, next) => {
        const origin = req.get('Origin');

        if (!origin) {
            return next(); // Allow requests without origin (e.g., mobile apps)
        }

        if (allowedOrigins.length === 0) {
            return next(); // No restrictions
        }

        if (!allowedOrigins.includes(origin)) {
            return res.status(403).json({
                success: false,
                error: 'Request origin not allowed',
                code: 'ORIGIN_NOT_ALLOWED',
                origin: origin
            });
        }

        next();
    };
}
