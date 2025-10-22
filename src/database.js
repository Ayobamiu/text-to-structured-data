import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

const { Pool } = pg;

// Database connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/batch_processor',
    // Force IPv4 to avoid Railway IPv6 issues
    family: 4,
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 10000, // Return an error after 10 seconds if connection could not be established
});

// Test database connection
export async function testConnection() {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        console.log('✅ Database connection successful');
        return { connected: true, timestamp: result.rows[0].now };
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return { connected: false, error: error.message };
    }
}

// Create a new job
export async function createJob(name, schema, schemaName, userId = null, organizationId = null, extractionMode = 'full_extraction', processingConfig = null) {
    const client = await pool.connect();
    try {
        const jobId = uuidv4();

        // Set default processing config if not provided
        const defaultProcessingConfig = {
            extraction: { method: 'mineru', options: {} },
            processing: { method: 'openai', model: 'gpt-4o', options: {} }
        };

        const finalProcessingConfig = processingConfig || defaultProcessingConfig;

        const query = `
            INSERT INTO jobs (id, name, schema_data, status, user_id, organization_id, extraction_mode, processing_config, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
            RETURNING id, name, status, extraction_mode, processing_config, created_at
        `;

        const values = [
            jobId,
            name || `Job ${new Date().toISOString()}`,
            JSON.stringify({ schema, schemaName: schemaName || 'data_extraction' }),
            'queued',
            userId,
            organizationId,
            extractionMode,
            JSON.stringify(finalProcessingConfig)
        ];

        const result = await client.query(query, values);
        console.log(`✅ Job created: ${jobId}`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error creating job:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Add file to job
export async function addFileToJob(jobId, filename, size, s3Key, fileHash, uploadStatus = 'pending', uploadError = null, storageType = 's3') {
    const client = await pool.connect();
    try {
        const fileId = uuidv4();
        const query = `
            INSERT INTO job_files (id, job_id, filename, size, s3_key, file_hash, 
                                 extraction_status, processing_status, upload_status, upload_error, storage_type, retry_count, last_retry_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
            RETURNING id, filename, size, s3_key, file_hash, upload_status, upload_error, storage_type, retry_count, last_retry_at
        `;

        const values = [
            fileId,
            jobId,
            filename,
            size,
            s3Key,
            fileHash,
            'pending',
            'pending',
            uploadStatus,
            uploadError,
            storageType,
            0,
            null
        ];

        const result = await client.query(query, values);
        console.log(`✅ File added to job: ${fileId}`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error adding file to job:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Update file upload status
export async function updateFileUploadStatus(fileId, uploadStatus, uploadError = null, storageType = null, retryCount = null) {
    const client = await pool.connect();
    try {
        const updateFields = ['upload_status = $2'];
        const values = [fileId, uploadStatus];
        let paramCount = 2;

        if (uploadError !== null) {
            paramCount++;
            updateFields.push(`upload_error = $${paramCount}`);
            values.push(uploadError);
        }

        if (storageType !== null) {
            paramCount++;
            updateFields.push(`storage_type = $${paramCount}`);
            values.push(storageType);
        }

        if (retryCount !== null) {
            paramCount++;
            updateFields.push(`retry_count = $${paramCount}`);
            values.push(retryCount);
        }

        // Always update last_retry_at when status changes
        paramCount++;
        updateFields.push(`last_retry_at = NOW()`);

        const query = `
            UPDATE job_files 
            SET ${updateFields.join(', ')}
            WHERE id = $1
            RETURNING id, upload_status, upload_error, storage_type, retry_count, last_retry_at
        `;

        const result = await client.query(query, values);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error updating file upload status:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Update file S3 information
export async function updateFileS3Info(fileId, s3Key, fileHash) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE job_files 
            SET s3_key = $2, file_hash = $3, updated_at = NOW()
            WHERE id = $1
            RETURNING id, s3_key, file_hash, updated_at
        `;

        const values = [fileId, s3Key, fileHash];
        const result = await client.query(query, values);

        if (result.rows.length === 0) {
            throw new Error(`File ${fileId} not found`);
        }

        return result.rows[0];
    } catch (error) {
        console.error('❌ Error updating file S3 info:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get job status with files
export async function getJobStatus(jobId) {
    const client = await pool.connect();
    try {
        // Get job details
        const jobQuery = `
            SELECT id, name, status, schema_data, summary, user_id, created_at, updated_at, extraction_mode
            FROM jobs WHERE id = $1
        `;
        const jobResult = await client.query(jobQuery, [jobId]);

        if (jobResult.rows.length === 0) {
            return null;
        }

        // Get job files
        const filesQuery = `
            SELECT id, filename, size, s3_key, file_hash, extraction_status, 
                   processing_status, extracted_text, extracted_tables, markdown, result, 
                   processing_metadata, extraction_error, processing_error, created_at, processed_at,
                   upload_status, upload_error, storage_type, retry_count, last_retry_at,
                   extraction_time_seconds, ai_processing_time_seconds
            FROM job_files WHERE job_id = $1
            ORDER BY created_at
        `;
        const filesResult = await client.query(filesQuery, [jobId]);

        const job = jobResult.rows[0];
        const files = filesResult.rows;

        // Calculate summary
        const summary = {
            total: files.length,
            extraction_pending: files.filter(f => f.extraction_status === 'pending').length,
            extraction_processing: files.filter(f => f.extraction_status === 'processing').length,
            extraction_completed: files.filter(f => f.extraction_status === 'completed').length,
            extraction_failed: files.filter(f => f.extraction_status === 'failed').length,
            processing_pending: files.filter(f => f.processing_status === 'pending').length,
            processing_processing: files.filter(f => f.processing_status === 'processing').length,
            processing_completed: files.filter(f => f.processing_status === 'completed').length,
            processing_failed: files.filter(f => f.processing_status === 'failed').length
        };

        return {
            ...job,
            files,
            summary
        };
    } catch (error) {
        console.error('❌ Error getting job status:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Update file extraction status
export async function updateFileExtractionStatus(fileId, status, extractedText = null, extractedTables = null, markdown = null, pages = null, error = null, extractionTimeSeconds = null) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE job_files 
            SET extraction_status = $1, extracted_text = $2, extracted_tables = $3, 
                markdown = $4, pages = $5, extraction_error = $6, extraction_time_seconds = $7, updated_at = NOW()
            WHERE id = $8
            RETURNING id, job_id, filename
        `;

        const values = [status, extractedText, extractedTables ? JSON.stringify(extractedTables) : null, markdown, pages ? JSON.stringify(pages) : null, error, extractionTimeSeconds, fileId];
        const result = await client.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('File not found');
        }

        console.log(`✅ File extraction status updated: ${fileId} -> ${status}${extractionTimeSeconds ? ` (${extractionTimeSeconds}s)` : ''}`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error updating file extraction status:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Update file processing status
export async function updateFileProcessingStatus(fileId, status, result = null, error = null, metadata = null, aiProcessingTimeSeconds = null) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE job_files 
            SET processing_status = $1, result = $2, processing_error = $3, 
                processed_at = $4, processing_metadata = $5, ai_processing_time_seconds = $6, updated_at = NOW()
            WHERE id = $7
            RETURNING id, job_id, filename
        `;

        const processedAt = status === 'completed' || status === 'failed' ? new Date() : null;
        const values = [status, result ? JSON.stringify(result) : null, error, processedAt, metadata ? JSON.stringify(metadata) : null, aiProcessingTimeSeconds, fileId];
        const queryResult = await client.query(query, values);

        if (queryResult.rows.length === 0) {
            throw new Error('File not found');
        }

        console.log(`✅ File processing status updated: ${fileId} -> ${status}${aiProcessingTimeSeconds ? ` (${aiProcessingTimeSeconds}s)` : ''}`);
        return queryResult.rows[0];
    } catch (error) {
        console.error('❌ Error updating file processing status:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Update job status
export async function updateJobStatus(jobId, status, summary = null) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE jobs 
            SET status = $1, summary = $2, updated_at = NOW()
            WHERE id = $3
            RETURNING id, name, status
        `;

        const values = [status, summary ? JSON.stringify(summary) : null, jobId];
        const result = await client.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('Job not found');
        }

        console.log(`✅ Job status updated: ${jobId} -> ${status}`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error updating job status:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// List jobs with pagination
export async function listJobsByOrganizations(limit = 10, offset = 0, organizationIds = []) {
    const client = await pool.connect();
    try {
        if (organizationIds.length === 0) {
            return [];
        }

        // Create placeholders for the organization IDs
        const placeholders = organizationIds.map((_, index) => `$${index + 1}`).join(',');

        const query = `
            SELECT j.id, j.name, j.status, j.summary, j.created_at, j.updated_at,
                   COUNT(jf.id) as file_count
            FROM jobs j
            LEFT JOIN job_files jf ON j.id = jf.job_id
            WHERE j.organization_id IN (${placeholders})
            GROUP BY j.id, j.name, j.status, j.summary, j.created_at, j.updated_at
            ORDER BY j.created_at DESC
            LIMIT $${organizationIds.length + 1} OFFSET $${organizationIds.length + 2}
        `;

        const values = [...organizationIds, limit, offset];
        const result = await client.query(query, values);

        return result.rows;
    } catch (error) {
        console.error('❌ Error listing jobs by organizations:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

export async function listJobs(limit = 10, offset = 0, userId = null, organizationId = null) {
    const client = await pool.connect();
    try {
        let query = `
            SELECT j.id, j.name, j.status, j.summary, j.created_at, j.updated_at,
                   COUNT(jf.id) as file_count
            FROM jobs j
            LEFT JOIN job_files jf ON j.id = jf.job_id
        `;

        const values = [];
        const conditions = [];

        if (userId) {
            conditions.push(`j.user_id = $${values.length + 1}`);
            values.push(userId);
        }

        if (organizationId) {
            conditions.push(`j.organization_id = $${values.length + 1}`);
            values.push(organizationId);
        }

        if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += `
            GROUP BY j.id, j.name, j.status, j.summary, j.created_at, j.updated_at
            ORDER BY j.created_at DESC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        `;

        values.push(limit, offset);
        const result = await client.query(query, values);

        return result.rows;
    } catch (error) {
        console.error('❌ Error listing jobs:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get file result
export async function getFileResult(fileId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT jf.id, jf.filename, jf.result, jf.extracted_text, jf.extracted_tables, jf.pages, jf.markdown,
                   jf.extraction_status, jf.processing_status, jf.extraction_error, jf.processing_error, jf.processed_at,
                   jf.job_id, j.name as job_name, j.schema_data, jf.upload_status, jf.upload_error, 
                   jf.storage_type, jf.retry_count, jf.last_retry_at, jf.extraction_time_seconds, jf.ai_processing_time_seconds
            FROM job_files jf
            JOIN jobs j ON jf.job_id = j.id
            WHERE jf.id = $1
        `;

        const result = await client.query(query, [fileId]);

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];
    } catch (error) {
        console.error('❌ Error getting file result:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get system statistics
export async function getSystemStats() {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                COUNT(*) as total_jobs,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_jobs,
                COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_jobs,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_jobs,
                COUNT(CASE WHEN status = 'queued' THEN 1 END) as queued_jobs
            FROM jobs
        `;

        const result = await client.query(query);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error getting system stats:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Close database connection pool
export async function closePool() {
    await pool.end();
    console.log('✅ Database connection pool closed');
}

export default pool;
