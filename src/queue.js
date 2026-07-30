import dotenv from 'dotenv';
import os from 'os';
import pool from './database.js';

dotenv.config();

class QueueService {
    constructor() {
        this.queueKey = 'file_processing_queue';
        this.processingKey = 'file_processing_active';
        this.maxRetries = 3;
        this.retryDelay = 5000; // 5 seconds
        this.schemaLoaded = false;
        this.availableAtColumn = 'updated_at';
        this.processingStartedAtColumn = 'updated_at';
        this.hasLeaseColumns = false;
        // Identifies THIS process as the owner of the items it claims, so a
        // second worker can tell "someone is actively working on this" from
        // "whoever had this is gone".
        this.workerId = process.env.WORKER_ID
            || `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        // A lease is stale after this long without a heartbeat. Sized off the
        // heartbeat interval (30s), NOT off how long a job takes — that's the
        // whole point of leasing over a timeout.
        this.leaseStaleSeconds = Number(process.env.QUEUE_LEASE_STALE_SECONDS || 120);
        this.hasQueueControl = false;
        // Queue shard: isolates dev/staging/production workers sharing the
        // same database. When QUEUE_SHARD is set (e.g. "dev", "production"),
        // inserts tag items with that shard and getNextFile only claims items
        // with the matching shard. When unset, shard filtering is disabled
        // (backward compatible).
        this.queueShard = process.env.QUEUE_SHARD || null;
        if (this.queueShard) {
            console.log(`🏷️  Queue shard: "${this.queueShard}" — only processing items tagged with this shard`);
        }
    }

    async connect() {
        await this.ensureSchemaInfo();
        return pool;
    }

    async disconnect() {
        await pool.end();
        console.log('🛑 Queue database connection pool closed');
    }

    async testConnection() {
        try {
            const client = await pool.connect();
            await client.query('SELECT 1');
            client.release();
            return true;
        } catch (error) {
            console.error('❌ Queue database connection test failed:', error.message);
            return false;
        }
    }

    async ensureSchemaInfo() {
        if (this.schemaLoaded) {
            return;
        }

        const client = await pool.connect();
        try {
            const columnsResult = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'file_processing_queue'
            `);
            const columns = columnsResult.rows.map(row => row.column_name);

            const availableCandidates = ['available_at', 'next_attempt_at', 'scheduled_at', 'run_at'];
            this.availableAtColumn = availableCandidates.find(col => columns.includes(col)) || 'updated_at';

            const processingCandidates = ['processing_started_at', 'started_at', 'processing_at'];
            this.processingStartedAtColumn = processingCandidates.find(col => columns.includes(col)) || 'updated_at';

            // Lease columns (add_queue_lease migration). Detected rather than
            // assumed so the code is safe to deploy before the migration runs.
            this.hasLeaseColumns = columns.includes('worker_id') && columns.includes('heartbeat_at');

            const queueControlResult = await client.query(`SELECT to_regclass('public.queue_control') AS name`);
            this.hasQueueControl = Boolean(queueControlResult.rows[0]?.name);
        } finally {
            client.release();
        }

        this.schemaLoaded = true;
    }

    buildQueueItem(row) {
        return {
            fileId: row.file_id,
            jobId: row.job_id,
            priority: row.priority ?? 0,
            retries: row.retries ?? 0,
            status: row.status,
            mode: row.mode || 'normal',
            timestamp: row.created_at ? new Date(row.created_at).getTime() : Date.now()
        };
    }

    async insertQueueItem({ fileId, jobId, priority, mode, retries, delayMs = 0 }) {
        await this.ensureSchemaInfo();

        const availableAtColumn = this.availableAtColumn;
        const hasDelay = delayMs > 0;

        // When QUEUE_SHARD is set, we set available_at to far-future so that
        // OLD workers (without shard awareness) whose query includes
        // "available_at <= NOW()" will never see these items. The local
        // shard-aware worker skips the available_at check and uses
        // queue_shard filtering instead.
        let delayExpr;
        if (this.queueShard) {
            // Far-future: invisible to old workers' "available_at <= NOW()" filter
            delayExpr = `'2099-12-31T00:00:00Z'::timestamptz`;
        } else if (hasDelay) {
            delayExpr = `NOW() + ($6 * INTERVAL '1 millisecond')`;
        } else {
            delayExpr = 'NOW()';
        }

        const availableAtInsert = availableAtColumn !== 'updated_at'
            ? `, ${availableAtColumn}`
            : '';
        const availableAtValues = availableAtColumn !== 'updated_at'
            ? `, ${delayExpr}`
            : '';
        const updatedAtValue = availableAtColumn === 'updated_at' ? delayExpr : 'NOW()';

        // Tag with queue_shard when QUEUE_SHARD env var is set.
        const shardInsert = this.queueShard ? ', queue_shard' : '';
        // Shard param index depends on whether we still need delayMs param
        const shardParamIdx = hasDelay && !this.queueShard ? 7 : 6;
        const shardValue = this.queueShard ? `, $${shardParamIdx}` : '';

        const query = `
            INSERT INTO file_processing_queue (file_id, job_id, priority, status, mode, retries, created_at, updated_at${availableAtInsert}${shardInsert})
            VALUES ($1, $2, $3, 'queued', $4, $5, NOW(), ${updatedAtValue}${availableAtValues}${shardValue})
            RETURNING id, file_id, job_id, priority, status, mode, retries, created_at, updated_at
        `;

        // When shard is set, delayMs is irrelevant (available_at is always far-future)
        const baseParams = [fileId, jobId, priority, mode, retries];
        let params;
        if (this.queueShard) {
            params = [...baseParams, this.queueShard];
        } else if (hasDelay) {
            params = [...baseParams, delayMs];
        } else {
            params = baseParams;
        }

        const client = await pool.connect();
        try {
            const result = await client.query(query, params);
            return result.rows[0];
        } finally {
            client.release();
        }
    }

    // Add file to processing queue
    async addFileToQueue(fileId, jobId, priority = 0, mode = 'normal') {
        console.log(`🔄 Adding file ${fileId} to queue with priority ${priority} (mode: ${mode})`);
        try {
            const row = await this.insertQueueItem({
                fileId,
                jobId,
                priority,
                mode,
                retries: 0
            });

            console.log(`✅ File ${fileId} added to queue with priority ${priority} (mode: ${mode})`);
            return this.buildQueueItem(row);
        } catch (error) {
            console.error('❌ Error adding file to queue:', error.message);
            throw error;
        }
    }

    // Get next file from queue
    async getNextFile() {
        try {
            await this.ensureSchemaInfo();
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // When QUEUE_SHARD is set, filter by shard instead of
                // available_at (items are inserted with far-future available_at
                // to hide them from old unsharded workers).
                let whereExtra, queryParams;
                if (this.queueShard) {
                    whereExtra = `AND queue_shard = $1`;
                    queryParams = [this.queueShard];
                } else {
                    whereExtra = `AND ${this.availableAtColumn} <= NOW()`;
                    queryParams = [];
                }

                const nextQuery = `
                    SELECT id, file_id, job_id, priority, status, mode, retries, created_at, updated_at
                    FROM file_processing_queue
                    WHERE status = 'queued'
                      ${whereExtra}
                    ORDER BY priority ASC, created_at ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                `;

                const nextResult = await client.query(nextQuery, queryParams);
                if (nextResult.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return null;
                }

                const nextRow = nextResult.rows[0];

                const updateFields = [
                    `status = 'processing'`,
                    `updated_at = NOW()`
                ];
                if (this.processingStartedAtColumn !== 'updated_at') {
                    updateFields.push(`${this.processingStartedAtColumn} = NOW()`);
                }
                // Take the lease: this row is mine, and it is alive as of now.
                if (this.hasLeaseColumns) {
                    updateFields.push(`worker_id = '${this.workerId.replace(/'/g, "")}'`);
                    updateFields.push(`heartbeat_at = NOW()`);
                }

                const updateQuery = `
                    UPDATE file_processing_queue
                    SET ${updateFields.join(', ')}
                    WHERE id = $1
                    RETURNING id, file_id, job_id, priority, status, mode, retries, created_at, updated_at
                `;

                const updatedResult = await client.query(updateQuery, [nextRow.id]);
                await client.query('COMMIT');

                const queueItem = this.buildQueueItem(updatedResult.rows[0]);
                console.log(`✅ Retrieved file ${queueItem.fileId} from queue`);
                return queueItem;
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error getting next file from queue:', error.message);
            throw error;
        }
    }

    // Mark file as processing
    async markFileAsProcessing(fileId) {
        try {
            await this.ensureSchemaInfo();
            const client = await pool.connect();
            try {
                const updateFields = [
                    `status = 'processing'`,
                    `updated_at = NOW()`
                ];
                if (this.processingStartedAtColumn !== 'updated_at') {
                    updateFields.push(`${this.processingStartedAtColumn} = NOW()`);
                }

                const query = `
                    UPDATE file_processing_queue
                    SET ${updateFields.join(', ')}
                    WHERE file_id = $1
                      AND status = 'processing'
                `;
                await client.query(query, [fileId]);
            } finally {
                client.release();
            }
            console.log(`✅ File ${fileId} marked as processing`);
        } catch (error) {
            console.error('❌ Error marking file as processing:', error.message);
            throw error;
        }
    }

    // Remove file from processing
    async removeFileFromProcessing(fileId) {
        try {
            const client = await pool.connect();
            try {
                await client.query(
                    `DELETE FROM file_processing_queue WHERE file_id = $1 AND status = 'processing'`,
                    [fileId]
                );
            } finally {
                client.release();
            }
            console.log(`✅ File ${fileId} removed from processing`);
        } catch (error) {
            console.error('❌ Error removing file from processing:', error.message);
            throw error;
        }
    }

    // Clear all stuck processing files
    async clearAllProcessingFiles() {
        try {
            const client = await pool.connect();
            try {
                const result = await client.query(
                    `DELETE FROM file_processing_queue WHERE status = 'processing' RETURNING file_id`
                );
                if (result.rows.length === 0) {
                    console.log('✅ No processing files to clear');
                    return 0;
                }
                const fileIds = result.rows.map(row => row.file_id);
                console.log(`✅ Cleared ${fileIds.length} stuck processing files:`, fileIds);
                return fileIds.length;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error clearing processing files:', error.message);
            throw error;
        }
    }

    /**
     * Renew the lease on an item this worker is actively processing. Called on
     * a timer by the worker; failure is non-fatal (the next tick retries).
     */
    async heartbeat(fileId) {
        if (!this.hasLeaseColumns) return false;
        try {
            const res = await pool.query(
                `UPDATE file_processing_queue
                 SET heartbeat_at = NOW()
                 WHERE file_id = $1 AND status = 'processing' AND worker_id = $2`,
                [fileId, this.workerId],
            );
            return (res.rowCount || 0) > 0;
        } catch (error) {
            console.warn(`⚠️ queue heartbeat failed for ${fileId}: ${error.message}`);
            return false;
        }
    }

    // Requeue files stuck in 'processing' by a worker that is genuinely GONE.
    //
    // This used to reset EVERY row in 'processing' on boot, on the assumption
    // that a booting worker means the previous one died. That is false during
    // a rolling deploy: the new container starts while the old one is still
    // mid-file, so the item got handed to a second worker and both ran it.
    // On 2026-07-30 that cost file 924215a5 its 12-section v2 envelope — the
    // duplicate run finished last and overwrote it with a single flat record
    // (and at 01:07 the same thing re-ran a directed re-extraction, re-billing
    // the vision call).
    //
    // Liveness is now proven by a heartbeat rather than assumed from uptime.
    // A timeout on processing_started_at was the obvious alternative and is
    // not good enough: real files legitimately run ~30 min of extraction+AI
    // (plus ~14 min of classification on a 640-page document), so any
    // threshold safe against false steals would leave genuine crashes
    // unrecovered for an hour. The heartbeat is sized off the heartbeat
    // interval instead, so recovery stays ~2 minutes no matter how long the
    // job itself takes.
    async requeueStaleProcessingFiles() {
        try {
            const client = await pool.connect();
            try {
                await this.ensureSchemaInfo();
                // When QUEUE_SHARD is set, only requeue items from this shard.
                const params = [];
                let shardFilter = '';
                if (this.queueShard) {
                    params.push(this.queueShard);
                    shardFilter = `AND queue_shard = $${params.length}`;
                }

                let livenessFilter = '';
                if (this.hasLeaseColumns) {
                    params.push(this.leaseStaleSeconds);
                    // Stale = no heartbeat for longer than the lease window.
                    // Rows predating the migration have a null heartbeat; fall
                    // back to when they were claimed so they can still recover.
                    livenessFilter = `AND COALESCE(heartbeat_at, ${this.processingStartedAtColumn}, updated_at)
                                        < NOW() - ($${params.length} * INTERVAL '1 second')`;
                } else {
                    console.warn(
                        '⚠️ queue lease columns missing (run migrations/add_queue_lease.js) — ' +
                        'skipping stale requeue rather than risk stealing a live job'
                    );
                    return [];
                }

                const result = await client.query(
                    `UPDATE file_processing_queue
                     SET status = 'queued', updated_at = NOW(), worker_id = NULL, heartbeat_at = NULL
                     WHERE status = 'processing'
                     ${shardFilter}
                     ${livenessFilter}
                     RETURNING file_id, job_id`,
                    params
                );
                if (result.rows.length === 0) {
                    console.log('✅ No stale processing files to requeue');
                    return [];
                }
                const requeued = result.rows;
                console.log(
                    `🔄 Requeued ${requeued.length} stale processing file(s): ` +
                    requeued.map(r => r.file_id).join(', ')
                );

                // Also reset the job_files extraction_status so the file
                // doesn't appear "stuck in processing" in the UI / API.
                const fileIds = requeued.map(r => r.file_id);
                await client.query(
                    `UPDATE job_files
                     SET extraction_status = 'pending', updated_at = NOW()
                     WHERE id = ANY($1::uuid[])
                       AND extraction_status = 'processing'`,
                    [fileIds]
                );

                return requeued;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error requeuing stale processing files:', error.message);
            // Non-fatal — worker can still process new files
            return [];
        }
    }

    // Retry failed file
    async retryFile(fileId, jobId, priority = 0, mode = 'normal') {
        try {
            await this.ensureSchemaInfo();
            const client = await pool.connect();
            let retries = 0;
            try {
                const retryResult = await client.query(
                    `SELECT retries FROM file_processing_queue WHERE file_id = $1 AND status = 'processing' ORDER BY updated_at DESC LIMIT 1`,
                    [fileId]
                );
                if (retryResult.rows.length > 0) {
                    retries = retryResult.rows[0].retries || 0;
                }
            } finally {
                client.release();
            }

            if (retries >= this.maxRetries) {
                console.log(`❌ File ${fileId} exceeded max retries (${this.maxRetries})`);
                return false;
            }

            // Add back to queue with delay
            const delay = this.retryDelay * Math.pow(2, retries); // Exponential backoff
            await this.insertQueueItem({
                fileId,
                jobId,
                priority,
                mode,
                retries: retries + 1,
                delayMs: delay
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
            await this.ensureSchemaInfo();
            const client = await pool.connect();
            try {
                const queueSizeResult = await client.query(
                    `SELECT COUNT(*)::int AS count FROM file_processing_queue WHERE status = 'queued'`
                );
                const processingCountResult = await client.query(
                    `SELECT COUNT(*)::int AS count FROM file_processing_queue WHERE status = 'processing'`
                );

                const queueSize = queueSizeResult.rows[0]?.count || 0;
                const processingCount = processingCountResult.rows[0]?.count || 0;

                const nextItemsResult = await client.query(`
                    SELECT file_id, job_id, priority, status, mode, retries, created_at
                    FROM file_processing_queue
                    WHERE status = 'queued'
                      AND ${this.availableAtColumn} <= NOW()
                    ORDER BY priority ASC, created_at ASC
                    LIMIT 5
                `);
                const nextFiles = nextItemsResult.rows.map(row => this.buildQueueItem(row));

                const processingFiles = await this.getProcessingFiles();

                const oldestItemResult = await client.query(`
                    SELECT created_at
                    FROM file_processing_queue
                    WHERE status = 'queued'
                    ORDER BY created_at ASC
                    LIMIT 1
                `);
                const newestItemResult = await client.query(`
                    SELECT created_at
                    FROM file_processing_queue
                    WHERE status = 'queued'
                    ORDER BY created_at DESC
                    LIMIT 1
                `);

                const oldestTimestamp = oldestItemResult.rows[0]?.created_at
                    ? new Date(oldestItemResult.rows[0].created_at).getTime()
                    : null;
                const newestTimestamp = newestItemResult.rows[0]?.created_at
                    ? new Date(newestItemResult.rows[0].created_at).getTime()
                    : null;

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
            } finally {
                client.release();
            }
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
            const client = await pool.connect();
            try {
                await client.query('DELETE FROM file_processing_queue');
            } finally {
                client.release();
            }
            console.log('🗑️ Queue cleared');
        } catch (error) {
            console.error('❌ Error clearing queue:', error.message);
            throw error;
        }
    }

    // Pause queue processing
    async pauseQueue() {
        try {
            await this.ensureSchemaInfo();
            if (!this.hasQueueControl) {
                throw new Error('queue_control table not found. Please add it to enable pause/resume.');
            }

            const client = await pool.connect();
            try {
                const columnsResult = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'queue_control'
                `);
                const columns = columnsResult.rows.map(row => row.column_name);

                if (columns.includes('key')) {
                    await client.query(`
                        INSERT INTO queue_control (key, paused, updated_at)
                        VALUES ('queue', true, NOW())
                        ON CONFLICT (key)
                        DO UPDATE SET paused = EXCLUDED.paused, updated_at = NOW()
                    `);
                } else {
                    await client.query(`
                        INSERT INTO queue_control (id, paused, updated_at)
                        VALUES (1, true, NOW())
                        ON CONFLICT (id)
                        DO UPDATE SET paused = EXCLUDED.paused, updated_at = NOW()
                    `);
                }
            } finally {
                client.release();
            }
            console.log('⏸️ Queue paused');
        } catch (error) {
            console.error('❌ Error pausing queue:', error.message);
            throw error;
        }
    }

    // Resume queue processing
    async resumeQueue() {
        try {
            await this.ensureSchemaInfo();
            if (!this.hasQueueControl) {
                throw new Error('queue_control table not found. Please add it to enable pause/resume.');
            }

            const client = await pool.connect();
            try {
                const columnsResult = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'queue_control'
                `);
                const columns = columnsResult.rows.map(row => row.column_name);

                if (columns.includes('key')) {
                    await client.query(`
                        INSERT INTO queue_control (key, paused, updated_at)
                        VALUES ('queue', false, NOW())
                        ON CONFLICT (key)
                        DO UPDATE SET paused = EXCLUDED.paused, updated_at = NOW()
                    `);
                } else {
                    await client.query(`
                        INSERT INTO queue_control (id, paused, updated_at)
                        VALUES (1, false, NOW())
                        ON CONFLICT (id)
                        DO UPDATE SET paused = EXCLUDED.paused, updated_at = NOW()
                    `);
                }
            } finally {
                client.release();
            }
            console.log('▶️ Queue resumed');
        } catch (error) {
            console.error('❌ Error resuming queue:', error.message);
            throw error;
        }
    }

    // Check if queue is paused
    async isQueuePaused() {
        try {
            await this.ensureSchemaInfo();
            if (!this.hasQueueControl) {
                return false;
            }

            const client = await pool.connect();
            try {
                const columnsResult = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'queue_control'
                `);
                const columns = columnsResult.rows.map(row => row.column_name);

                if (columns.includes('key')) {
                    const result = await client.query(`SELECT paused FROM queue_control WHERE key = 'queue'`);
                    return result.rows.length > 0 ? result.rows[0].paused === true : false;
                }

                const result = await client.query(`SELECT paused FROM queue_control WHERE id = 1`);
                return result.rows.length > 0 ? result.rows[0].paused === true : false;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error checking queue status:', error.message);
            return false;
        }
    }

    // Remove specific file from queue
    async removeFileFromQueue(fileId) {
        try {
            const client = await pool.connect();
            try {
                await client.query(`DELETE FROM file_processing_queue WHERE file_id = $1`, [fileId]);
            } finally {
                client.release();
            }

            console.log(`🗑️ File ${fileId} removed from queue`);
        } catch (error) {
            console.error('❌ Error removing file from queue:', error.message);
            throw error;
        }
    }

    // Get detailed queue analytics
    async getQueueAnalytics() {
        try {
            const client = await pool.connect();
            try {
                const queueSizeResult = await client.query(
                    `SELECT COUNT(*)::int AS count FROM file_processing_queue WHERE status = 'queued'`
                );
                const processingCountResult = await client.query(
                    `SELECT COUNT(*)::int AS count FROM file_processing_queue WHERE status = 'processing'`
                );

                const queueSize = queueSizeResult.rows[0]?.count || 0;
                const processingCount = processingCountResult.rows[0]?.count || 0;

                const processingFiles = await this.getProcessingFiles();

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
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error getting queue analytics:', error.message);
            throw error;
        }
    }

    // Get processing files
    async getProcessingFiles() {
        try {
            await this.ensureSchemaInfo();
            const client = await pool.connect();
            try {
                const result = await client.query(`
                    SELECT file_id, job_id, priority, status, mode, retries,
                           ${this.processingStartedAtColumn} AS processing_started_at,
                           created_at, updated_at
                    FROM file_processing_queue
                    WHERE status = 'processing'
                    ORDER BY updated_at DESC
                `);

                return result.rows.map(row => {
                    const startedAt = row.processing_started_at || row.updated_at || row.created_at;
                    return {
                        fileId: row.file_id,
                        jobId: row.job_id,
                        priority: row.priority ?? 0,
                        status: row.status,
                        mode: row.mode || 'normal',
                        retries: row.retries ?? 0,
                        timestamp: startedAt ? new Date(startedAt).getTime() : Date.now()
                    };
                });
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error getting processing files:', error.message);
            throw error;
        }
    }

    async isFileInQueue(fileId) {
        try {
            const client = await pool.connect();
            try {
                const result = await client.query(
                    `SELECT 1 FROM file_processing_queue WHERE file_id = $1 AND status = 'queued' LIMIT 1`,
                    [fileId]
                );
                return result.rows.length > 0;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error checking queue for file:', error.message);
            throw error;
        }
    }

    async isFileProcessing(fileId) {
        try {
            const client = await pool.connect();
            try {
                const result = await client.query(
                    `SELECT 1 FROM file_processing_queue WHERE file_id = $1 AND status = 'processing' LIMIT 1`,
                    [fileId]
                );
                return result.rows.length > 0;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error checking processing for file:', error.message);
            throw error;
        }
    }
}

// Create singleton instance
const queueService = new QueueService();

export default queueService;
