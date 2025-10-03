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
                url: this.redisUrl
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
    async addFileToQueue(fileId, jobId, priority = 0) {
        try {
            const client = await this.connect();

            const queueItem = {
                fileId,
                jobId,
                priority,
                timestamp: Date.now(),
                retries: 0,
                status: 'queued'
            };

            // Add to sorted set (priority queue)
            await client.zAdd(this.queueKey, {
                score: priority,
                value: JSON.stringify(queueItem)
            });

            console.log(`✅ File ${fileId} added to queue with priority ${priority}`);
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

            return {
                queueSize,
                processingCount,
                nextFiles,
                maxRetries: this.maxRetries,
                retryDelay: this.retryDelay
            };
        } catch (error) {
            console.error('❌ Error getting queue stats:', error.message);
            throw error;
        }
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
