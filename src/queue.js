import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

class QueueService {
    constructor() {
        this.redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        this.client = null;
        this.queueKey = 'file_processing_queue';
        this.processingKey = 'file_processing_active';
        this.maxRetries = 3;
        this.retryDelay = 5000; // 5 seconds
    }

    async connect() {
        if (!this.client) {
            this.client = createClient({
                url: this.redisUrl,
                socket: {
                    connectTimeout: 10000, // 10 seconds
                    lazyConnect: true
                }
            });

            this.client.on('error', (err) => {
                console.error('❌ Redis Client Error:', err);
            });

            this.client.on('connect', () => {
                console.log('✅ Redis client connected');
            });

            this.client.on('reconnecting', () => {
                console.log('🔄 Redis client reconnecting...');
            });

            this.client.on('end', () => {
                console.log('🛑 Redis client disconnected');
            });

            try {
                await this.client.connect();
                console.log('✅ Redis connection successful');
            } catch (error) {
                console.error('❌ Failed to connect to Redis:', error.message);
                throw error;
            }
        }
        return this.client;
    }

    async disconnect() {
        if (this.client) {
            await this.client.quit();
            this.client = null;
            console.log('🛑 Redis client disconnected');
        }
    }

    async testConnection() {
        try {
            const client = await this.connect();
            const pong = await client.ping();
            return pong === 'PONG';
        } catch (error) {
            console.error('❌ Redis connection test failed:', error.message);
            return false;
        }
    }

    // Add file to processing queue
    async addFileToQueue(fileId, jobId, priority = 0, mode = 'normal') {
        console.log(`🔄 Adding file ${fileId} to queue with priority ${priority} (mode: ${mode})`);
        try {
            const client = await this.connect();

            const queueItem = {
                fileId,
                jobId,
                priority,
                timestamp: Date.now(),
                retries: 0,
                status: 'queued',
                mode: mode // 'normal' or 'reprocess'
            };

            // Add to sorted set (priority queue)
            await client.zAdd(this.queueKey, {
                score: priority,
                value: JSON.stringify(queueItem)
            });

            console.log(`✅ File ${fileId} added to queue with priority ${priority} (mode: ${mode})`);
            return queueItem;
        } catch (error) {
            console.error('❌ Error adding file to queue:', error.message);
            throw error;
        }
    }

    // Get next file from queue
    async getNextFile() {
        try {
            const client = await this.connect();

            // Get the highest priority item (lowest score)
            const result = await client.zPopMin(this.queueKey);

            if (!result || result.length === 0) {
                return null;
            }

            const queueItem = JSON.parse(result.value);
            console.log(`✅ Retrieved file ${queueItem.fileId} from queue`);
            return queueItem;
        } catch (error) {
            console.error('❌ Error getting next file from queue:', error.message);
            throw error;
        }
    }

    // Mark file as processing
    async markFileAsProcessing(fileId) {
        try {
            const client = await this.connect();
            await client.hSet(this.processingKey, fileId, Date.now());
            console.log(`✅ File ${fileId} marked as processing`);
        } catch (error) {
            console.error('❌ Error marking file as processing:', error.message);
            throw error;
        }
    }

    // Remove file from processing
    async removeFileFromProcessing(fileId) {
        try {
            const client = await this.connect();
            await client.hDel(this.processingKey, fileId);
            console.log(`✅ File ${fileId} removed from processing`);
        } catch (error) {
            console.error('❌ Error removing file from processing:', error.message);
            throw error;
        }
    }

    // Clear all stuck processing files
    async clearAllProcessingFiles() {
        try {
            const client = await this.connect();
            const processingFiles = await client.hGetAll(this.processingKey);
            const fileIds = Object.keys(processingFiles);

            if (fileIds.length === 0) {
                console.log('✅ No processing files to clear');
                return 0;
            }

            await client.del(this.processingKey);
            console.log(`✅ Cleared ${fileIds.length} stuck processing files:`, fileIds);
            return fileIds.length;
        } catch (error) {
            console.error('❌ Error clearing processing files:', error.message);
            throw error;
        }
    }

    // Retry failed file
    async retryFile(fileId, jobId, priority = 0) {
        try {
            const client = await this.connect();

            // Get current retry count
            const processingData = await client.hGet(this.processingKey, fileId);
            let retries = 0;

            if (processingData) {
                const data = JSON.parse(processingData);
                retries = data.retries || 0;
            }

            if (retries >= this.maxRetries) {
                console.log(`❌ File ${fileId} exceeded max retries (${this.maxRetries})`);
                return false;
            }

            // Add back to queue with delay
            const delay = this.retryDelay * Math.pow(2, retries); // Exponential backoff
            const queueItem = {
                fileId,
                jobId,
                priority,
                timestamp: Date.now() + delay,
                retries: retries + 1,
                status: 'retry'
            };

            await client.zAdd(this.queueKey, {
                score: priority + delay,
                value: JSON.stringify(queueItem)
            });

            console.log(`🔄 File ${fileId} retried (attempt ${retries + 1}/${this.maxRetries})`);
            return true;
        } catch (error) {
            console.error('❌ Error retrying file:', error.message);
            throw error;
        }
    }

    // Get queue statistics
    async getQueueStats() {
        try {
            const client = await this.connect();

            const queueSize = await client.zCard(this.queueKey);
            const processingCount = await client.hLen(this.processingKey);

            // Get next items in queue
            const nextItems = await client.zRange(this.queueKey, 0, 4, { REV: false });
            const nextFiles = nextItems.map(item => {
                try {
                    return JSON.parse(item);
                } catch {
                    return null;
                }
            }).filter(Boolean);

            // Get processing files details
            const processingFiles = await this.getProcessingFiles();

            // Get queue health metrics
            const oldestItem = await client.zRange(this.queueKey, 0, 0, { REV: false, WITHSCORES: true });
            const newestItem = await client.zRange(this.queueKey, -1, -1, { REV: false, WITHSCORES: true });

            const oldestTimestamp = oldestItem.length > 0 ? oldestItem[0].score : null;
            const newestTimestamp = newestItem.length > 0 ? newestItem[0].score : null;

            const avgWaitTime = oldestTimestamp ? Date.now() - oldestTimestamp : 0;

            return {
                queueSize,
                processingCount,
                nextFiles,
                processingFiles,
                maxRetries: this.maxRetries,
                retryDelay: this.retryDelay,
                metrics: {
                    avgWaitTimeMs: avgWaitTime,
                    oldestItemAge: oldestTimestamp ? Date.now() - oldestTimestamp : 0,
                    queueHealth: this.calculateQueueHealth(queueSize, processingCount, avgWaitTime)
                }
            };
        } catch (error) {
            console.error('❌ Error getting queue stats:', error.message);
            throw error;
        }
    }

    // Calculate queue health score
    calculateQueueHealth(queueSize, processingCount, avgWaitTime) {
        let healthScore = 100;

        // Penalize high queue size
        if (queueSize > 100) healthScore -= 20;
        else if (queueSize > 50) healthScore -= 10;

        // Penalize high processing count (potential bottleneck)
        if (processingCount > 10) healthScore -= 15;
        else if (processingCount > 5) healthScore -= 5;

        // Penalize long wait times
        if (avgWaitTime > 300000) healthScore -= 25; // 5 minutes
        else if (avgWaitTime > 60000) healthScore -= 10; // 1 minute

        const health = Math.max(0, healthScore);
        let status = 'healthy';
        if (health < 50) status = 'critical';
        else if (health < 75) status = 'warning';

        return { score: health, status };
    }

    // Clear queue (for testing)
    async clearQueue() {
        try {
            const client = await this.connect();
            await client.del(this.queueKey);
            await client.del(this.processingKey);
            console.log('🗑️ Queue cleared');
        } catch (error) {
            console.error('❌ Error clearing queue:', error.message);
            throw error;
        }
    }

    // Pause queue processing
    async pauseQueue() {
        try {
            const client = await this.connect();
            await client.set('queue_paused', 'true');
            console.log('⏸️ Queue paused');
        } catch (error) {
            console.error('❌ Error pausing queue:', error.message);
            throw error;
        }
    }

    // Resume queue processing
    async resumeQueue() {
        try {
            const client = await this.connect();
            await client.del('queue_paused');
            console.log('▶️ Queue resumed');
        } catch (error) {
            console.error('❌ Error resuming queue:', error.message);
            throw error;
        }
    }

    // Check if queue is paused
    async isQueuePaused() {
        try {
            const client = await this.connect();
            const paused = await client.get('queue_paused');
            return paused === 'true';
        } catch (error) {
            console.error('❌ Error checking queue status:', error.message);
            return false;
        }
    }

    // Remove specific file from queue
    async removeFileFromQueue(fileId) {
        try {
            const client = await this.connect();

            // Remove from main queue
            const queueItems = await client.zRange(this.queueKey, 0, -1);
            for (const item of queueItems) {
                try {
                    const data = JSON.parse(item);
                    if (data.fileId === fileId) {
                        await client.zRem(this.queueKey, item);
                        break;
                    }
                } catch (e) {
                    // Skip invalid items
                }
            }

            // Remove from processing set
            await client.hDel(this.processingKey, fileId);

            console.log(`🗑️ File ${fileId} removed from queue`);
        } catch (error) {
            console.error('❌ Error removing file from queue:', error.message);
            throw error;
        }
    }

    // Get detailed queue analytics
    async getQueueAnalytics() {
        try {
            const client = await this.connect();

            // Get queue size over time (simplified)
            const queueSize = await client.zCard(this.queueKey);
            const processingCount = await client.hLen(this.processingKey);

            // Get processing files with timestamps
            const processingFiles = await this.getProcessingFiles();

            // Calculate processing times
            const now = Date.now();
            const processingTimes = processingFiles.map(file => {
                if (file.timestamp) {
                    return now - file.timestamp;
                }
                return 0;
            });

            const avgProcessingTime = processingTimes.length > 0
                ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
                : 0;

            return {
                queueSize,
                processingCount,
                avgProcessingTimeMs: avgProcessingTime,
                processingFiles: processingFiles.length,
                queueUtilization: processingCount > 0 ? (processingCount / (processingCount + queueSize)) * 100 : 0,
                timestamp: now
            };
        } catch (error) {
            console.error('❌ Error getting queue analytics:', error.message);
            throw error;
        }
    }

    // Get processing files
    async getProcessingFiles() {
        try {
            const client = await this.connect();
            const processing = await client.hGetAll(this.processingKey);

            return Object.entries(processing).map(([fileId, data]) => {
                try {
                    return {
                        fileId,
                        ...JSON.parse(data)
                    };
                } catch {
                    return {
                        fileId,
                        timestamp: data
                    };
                }
            });
        } catch (error) {
            console.error('❌ Error getting processing files:', error.message);
            throw error;
        }
    }
}

// Create singleton instance
const queueService = new QueueService();

export default queueService;
