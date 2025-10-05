import express from 'express';
import pool from '../database.js';
import { createClient } from 'redis';
import logger from '../utils/logger.js';

const router = express.Router();

// Health check endpoint
router.get('/health', async (req, res) => {
    const healthCheck = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        services: {
            database: 'unknown',
            redis: 'unknown',
            flask: 'unknown'
        }
    };

    try {
        // Check database connection
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        healthCheck.services.database = 'healthy';
    } catch (error) {
        logger.error('Database health check failed:', error);
        healthCheck.services.database = 'unhealthy';
        healthCheck.status = 'unhealthy';
    }

    try {
        // Check Redis connection
        const redisClient = createClient({
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT || 6379,
        });

        await redisClient.connect();
        await redisClient.ping();
        await redisClient.disconnect();
        healthCheck.services.redis = 'healthy';
    } catch (error) {
        logger.error('Redis health check failed:', error);
        healthCheck.services.redis = 'unhealthy';
        healthCheck.status = 'unhealthy';
    }

    try {
        // Check Flask service
        const axios = (await import('axios')).default;
        const response = await axios.get(`${process.env.FLASK_URL}/health`, {
            timeout: 5000
        });

        if (response.status === 200) {
            healthCheck.services.flask = 'healthy';
        } else {
            healthCheck.services.flask = 'unhealthy';
            healthCheck.status = 'unhealthy';
        }
    } catch (error) {
        logger.error('Flask service health check failed:', error);
        healthCheck.services.flask = 'unhealthy';
        healthCheck.status = 'unhealthy';
    }

    const statusCode = healthCheck.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(healthCheck);
});

// Readiness probe
router.get('/ready', async (req, res) => {
    try {
        // Check if all critical services are available
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();

        const redisClient = createClient({
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT || 6379,
        });

        await redisClient.connect();
        await redisClient.ping();
        await redisClient.disconnect();

        res.status(200).json({ status: 'ready' });
    } catch (error) {
        logger.error('Readiness check failed:', error);
        res.status(503).json({ status: 'not ready', error: error.message });
    }
});

// Liveness probe
router.get('/live', (req, res) => {
    res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

export default router;
