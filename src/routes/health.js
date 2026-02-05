import express from 'express';
import pool from '../database.js';
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
            queue: 'unknown',
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
        // Check queue table availability
        const client = await pool.connect();
        await client.query('SELECT 1 FROM file_processing_queue LIMIT 1');
        client.release();
        healthCheck.services.queue = 'healthy';
    } catch (error) {
        logger.error('Queue health check failed:', error);
        healthCheck.services.queue = 'unhealthy';
        healthCheck.status = 'unhealthy';
    }

    try {
        // Check Flask service (optional - only if FLASK_URL is set)
        if (process.env.FLASK_URL) {
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
        } else {
            healthCheck.services.flask = 'not configured';
            logger.info('Flask service not configured (FLASK_URL not set)');
        }
    } catch (error) {
        logger.error('Flask service health check failed:', error);
        healthCheck.services.flask = 'unhealthy';
        // Don't fail the overall health check for Flask service
        logger.warn('Flask service unavailable, but continuing with other health checks');
    }

    const statusCode = healthCheck.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(healthCheck);
});

// Readiness probe
router.get('/ready', async (req, res) => {
    try {
        // Check if all critical services are available
        const client = await pool.connect();
        try {
            await client.query('SELECT 1');
            await client.query('SELECT 1 FROM file_processing_queue LIMIT 1');
        } finally {
            client.release();
        }

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
