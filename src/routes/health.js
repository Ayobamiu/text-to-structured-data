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
        logger.info('🔍 Redis Health Check - Environment Variables:');
        logger.info('  REDIS_URL:', process.env.REDIS_URL ? 'SET' : 'NOT SET');
        logger.info('  REDIS_HOST:', process.env.REDIS_HOST ? 'SET' : 'NOT SET');
        logger.info('  REDISHOST:', process.env.REDISHOST ? 'SET' : 'NOT SET');

        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        logger.info('🔗 Using Redis URL for health check:', redisUrl.replace(/:[^:@]*@/, ':***@'));

        const redisClient = createClient({
            url: redisUrl,
            socket: {
                connectTimeout: 5000, // 5 seconds for health check
                lazyConnect: true
            }
        });

        logger.info('🚀 Attempting Redis health check connection...');
        await redisClient.connect();
        logger.info('✅ Redis health check connection successful');

        logger.info('🏓 Testing Redis health check with PING...');
        const pong = await redisClient.ping();
        logger.info('🏓 Redis health check PING response:', pong);

        await redisClient.disconnect();
        logger.info('✅ Redis health check completed successfully');
        healthCheck.services.redis = 'healthy';
    } catch (error) {
        logger.error('❌ Redis health check failed:');
        logger.error('  Error message:', error.message);
        logger.error('  Error code:', error.code);
        logger.error('  Redis URL used:', (process.env.REDIS_URL || 'redis://localhost:6379').replace(/:[^:@]*@/, ':***@'));
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

        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        const redisClient = createClient({
            url: redisUrl,
            socket: {
                connectTimeout: 5000,
                lazyConnect: true
            }
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
