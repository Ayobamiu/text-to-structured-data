import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import mgsDataService from './services/mgsDataService.js';
import { addItemsToPreview } from './database/previewDataTable.js';

// Auto-fix missing permit numbers by extracting from filename
function autoFixPermitNumber(result, filename) {
    if (!result || !filename) return result;

    const { permitNumber, correct } = mgsDataService.getPermitNumberFromData(result, filename);

    if (!correct) {
        return {
            ...result,
            permit_number: permitNumber
        };
    }

    return result;
}

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
    // Note: statement_timeout and query_timeout are not valid Pool options
    // These need to be set per-connection or via SQL SET command
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

        // Create initial schema data object
        const initialSchemaData = { schema, schemaName: schemaName || 'data_extraction' };

        const query = `
            INSERT INTO jobs (id, name, schema_data, schema_data_array, status, user_id, organization_id, extraction_mode, processing_config, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
            RETURNING id, name, status, extraction_mode, processing_config, created_at
        `;

        const values = [
            jobId,
            name || `Job ${new Date().toISOString()}`,
            JSON.stringify(initialSchemaData),
            JSON.stringify([initialSchemaData]), // Initialize schema_data_array with first version
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
export async function addFileToJob(jobId, filename, size, s3Key, fileHash, uploadStatus = 'pending', uploadError = null, storageType = 's3', pageCount = null) {
    const client = await pool.connect();
    try {
        const fileId = uuidv4();
        const query = `
            INSERT INTO job_files (id, job_id, filename, size, page_count, s3_key, file_hash, 
                                 extraction_status, processing_status, upload_status, upload_error, storage_type, retry_count, last_retry_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
            RETURNING id, filename, size, page_count, s3_key, file_hash, upload_status, upload_error, storage_type, retry_count, last_retry_at
        `;

        const values = [
            fileId,
            jobId,
            filename,
            size,
            pageCount,
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

// Get job details with summary (combined - single connection, parallel queries)
export async function getJobDetailsWithSummary(jobId) {
    const client = await pool.connect();
    try {
        // Set statement timeout for this connection (30 seconds)
        await client.query('SET statement_timeout = 30000');

        // Run both queries in parallel on the same connection
        const [jobResult, summaryResult] = await Promise.all([
            client.query(`
                SELECT id, name, status, schema_data, schema_data_array, user_id, organization_id, 
                       created_at, updated_at, extraction_mode, processing_config
                FROM jobs WHERE id = $1
            `, [jobId]),
            client.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE extraction_status = 'pending') as extraction_pending,
                    COUNT(*) FILTER (WHERE extraction_status = 'processing') as extraction_processing,
                    COUNT(*) FILTER (WHERE extraction_status = 'completed') as extraction_completed,
                    COUNT(*) FILTER (WHERE extraction_status = 'failed') as extraction_failed,
                    COUNT(*) FILTER (WHERE processing_status = 'pending') as processing_pending,
                    COUNT(*) FILTER (WHERE processing_status = 'processing') as processing_processing,
                    COUNT(*) FILTER (WHERE processing_status = 'completed') as processing_completed,
                    COUNT(*) FILTER (WHERE processing_status = 'failed') as processing_failed,
                    -- Combined counts for summary display
                    COUNT(*) FILTER (WHERE extraction_status = 'processing' OR processing_status = 'processing') as processing,
                    COUNT(*) FILTER (WHERE extraction_status = 'pending' AND processing_status = 'pending') as pending
                FROM job_files
                WHERE job_id = $1
            `, [jobId])
        ]);

        if (jobResult.rows.length === 0) {
            return { job: null, summary: null };
        }

        const job = jobResult.rows[0];

        // Parse processing_config if it's a string (JSONB columns can return as strings)
        let processingConfig = job.processing_config;
        if (processingConfig && typeof processingConfig === 'string') {
            try {
                processingConfig = JSON.parse(processingConfig);
            } catch (parseError) {
                console.warn('⚠️ Failed to parse processing_config, using default:', parseError.message);
                processingConfig = null;
            }
        }

        const parsedJob = {
            ...job,
            processing_config: processingConfig
        };

        // Parse summary
        let summary;
        if (summaryResult.rows.length === 0) {
            summary = {
                total: 0,
                extraction_pending: 0,
                extraction_processing: 0,
                extraction_completed: 0,
                extraction_failed: 0,
                processing_pending: 0,
                processing_processing: 0,
                processing_completed: 0,
                processing_failed: 0,
                processing: 0,
                pending: 0
            };
        } else {
            const row = summaryResult.rows[0];
            summary = {
                total: parseInt(row.total, 10),
                extraction_pending: parseInt(row.extraction_pending, 10),
                extraction_processing: parseInt(row.extraction_processing, 10),
                extraction_completed: parseInt(row.extraction_completed, 10),
                extraction_failed: parseInt(row.extraction_failed, 10),
                processing_pending: parseInt(row.processing_pending, 10),
                processing_processing: parseInt(row.processing_processing, 10),
                processing_completed: parseInt(row.processing_completed, 10),
                processing_failed: parseInt(row.processing_failed, 10),
                // Combined counts for summary display
                processing: parseInt(row.processing || 0, 10),
                pending: parseInt(row.pending || 0, 10)
            };
        }

        return {
            job: parsedJob,
            summary
        };
    } catch (error) {
        console.error('❌ Error getting job details with summary:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get job status with files (lightweight - excludes large columns by default)
export async function getJobStatus(jobId, includeLargeColumns = false) {
    const client = await pool.connect();
    try {
        // Set statement timeout for this connection (30 seconds)
        await client.query('SET statement_timeout = 30000');

        // Get job details
        const jobQuery = `
            SELECT id, name, status, schema_data, schema_data_array, summary, user_id, organization_id, created_at, updated_at, extraction_mode, processing_config
            FROM jobs WHERE id = $1
        `;
        const jobResult = await client.query(jobQuery, [jobId]);

        if (jobResult.rows.length === 0) {
            return null;
        }

        // Get job files - exclude large columns unless explicitly requested
        // Large columns: extracted_text, markdown, result, actual_result, raw_data
        const largeColumns = includeLargeColumns
            ? 'extracted_text, extracted_tables, markdown, result, actual_result, raw_data,'
            : '';

        const filesQuery = `
            SELECT id, filename, size, s3_key, file_hash, extraction_status, 
                   processing_status, ${largeColumns}
                   processing_metadata, extraction_error, processing_error, created_at, processed_at,
                   upload_status, upload_error, storage_type, retry_count, last_retry_at,
                   extraction_time_seconds, ai_processing_time_seconds, admin_verified, customer_verified,
                   pages, page_count, openai_feed_blocked, openai_feed_unblocked, extraction_metadata, source_locations
            FROM job_files WHERE job_id = $1
            ORDER BY created_at
        `;
        const filesResult = await client.query(filesQuery, [jobId]);

        const job = jobResult.rows[0];

        // Parse processing_config if it's a string (JSONB columns can return as strings)
        let processingConfig = job.processing_config;
        if (processingConfig && typeof processingConfig === 'string') {
            try {
                processingConfig = JSON.parse(processingConfig);
            } catch (parseError) {
                console.warn('⚠️ Failed to parse processing_config, using default:', parseError.message);
                processingConfig = null;
            }
        }

        // Extract pages from raw_data for each file (only if raw_data was fetched)
        const files = filesResult.rows.map(file => {
            if (includeLargeColumns && file.raw_data) {
                let pages = null;
                if (typeof file.raw_data === 'object' && file.raw_data.pages) {
                    pages = file.raw_data.pages;
                } else if (typeof file.raw_data === 'string') {
                    try {
                        const parsed = JSON.parse(file.raw_data);
                        pages = parsed.pages || null;
                    } catch (e) {
                        // Ignore parsing errors
                    }
                }
                return {
                    ...file,
                    pages: pages || file.pages || null
                };
            }
            // If raw_data not fetched, just return file
            return file;
        });

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
            processing_config: processingConfig,
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
export async function updateFileExtractionStatus(
    fileId,
    status,
    extractedText = null,
    extractedTables = null,
    markdown = null,
    pages = null,
    error = null,
    extractionTimeSeconds = null,
    openaiFeedBlocked = null,
    openaiFeedUnblocked = null,
    extractionMetadata = null,
    rawData = null,
    pageCount = null // Optional: preserve or update page_count
) {
    const client = await pool.connect();
    try {
        // Build query conditionally - only update page_count if provided
        let updatePageCount = pageCount !== null && pageCount !== undefined;

        // Ensure pageCount is an integer if provided
        let pageCountValue = null;
        if (updatePageCount) {
            pageCountValue = typeof pageCount === 'number' ? Math.floor(pageCount) : parseInt(pageCount, 10);
            if (isNaN(pageCountValue) || pageCountValue < 0) {
                console.warn(`⚠️ Invalid pageCount value: ${pageCount}, skipping page_count update`);
                // Fall back to not updating page_count
                updatePageCount = false;
                pageCountValue = null;
            }
        }

        // When updatePageCount is true: $1-$11 are regular params, $12 is fileId, $13 is pageCount
        // When updatePageCount is false: $1-$11 are regular params, $12 is fileId
        const query = `
            UPDATE job_files 
            SET extraction_status = $1, extracted_text = $2, extracted_tables = $3, 
                markdown = $4, pages = $5, extraction_error = $6, extraction_time_seconds = $7,
                openai_feed_blocked = $8, openai_feed_unblocked = $9, extraction_metadata = $10,
                raw_data = $11${updatePageCount ? ', page_count = $13' : ''}, updated_at = NOW()
            WHERE id = $12
            RETURNING id, job_id, filename
        `;

        // Handle empty strings - convert to null for consistency
        const openaiFeedBlockedValue = (openaiFeedBlocked && openaiFeedBlocked.trim().length > 0) ? openaiFeedBlocked : null;
        const openaiFeedUnblockedValue = (openaiFeedUnblocked && openaiFeedUnblocked.trim().length > 0) ? openaiFeedUnblocked : null;

        const values = updatePageCount
            ? [
                status,
                extractedText,
                extractedTables ? JSON.stringify(extractedTables) : null,
                markdown,
                pages ? JSON.stringify(pages) : null,
                error,
                extractionTimeSeconds,
                openaiFeedBlockedValue,
                openaiFeedUnblockedValue,
                extractionMetadata ? JSON.stringify(extractionMetadata) : null,
                rawData ? JSON.stringify(rawData) : null,
                fileId,
                pageCountValue
            ]
            : [
                status,
                extractedText,
                extractedTables ? JSON.stringify(extractedTables) : null,
                markdown,
                pages ? JSON.stringify(pages) : null,
                error,
                extractionTimeSeconds,
                openaiFeedBlockedValue,
                openaiFeedUnblockedValue,
                extractionMetadata ? JSON.stringify(extractionMetadata) : null,
                rawData ? JSON.stringify(rawData) : null,
                fileId
            ];

        // Debug logging
        console.log('🔍 updateFileExtractionStatus debug:', {
            fileId,
            status,
            extractionTimeSeconds,
            updatePageCount,
            pageCount,
            pageCountType: typeof pageCount,
            openaiFeedBlocked: openaiFeedBlockedValue ? `${openaiFeedBlockedValue.length} chars` : 'null',
            openaiFeedUnblocked: openaiFeedUnblockedValue ? `${openaiFeedUnblockedValue.length} chars` : 'null',
            hasExtractionMetadata: !!extractionMetadata,
            extractionMetadataKeys: extractionMetadata ? Object.keys(extractionMetadata) : null,
            hasRawData: !!rawData,
            rawDataType: rawData ? typeof rawData : 'null',
            rawDataKeys: rawData && typeof rawData === 'object' ? Object.keys(rawData).slice(0, 5) : null,
            valuesLength: values.length,
            lastValue: values[values.length - 1],
            lastValueType: typeof values[values.length - 1],
        });

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
        // Extract source_locations from result if present, and remove it from result
        let sourceLocations = null;
        let resultWithoutSourceLocations = result;

        if (result && typeof result === 'object' && result.source_locations !== undefined) {
            sourceLocations = result.source_locations;
            // Create a copy without source_locations
            const { source_locations, ...rest } = result;
            resultWithoutSourceLocations = rest;
            console.log(`📍 Extracted source_locations from result for file ${fileId}`);
        }

        // Check if we need to save actual_result (original AI result before modifications)
        let actualResultToSave = null;
        if (status === 'completed' && result) {
            // Check if actual_result is NULL - if so, this is the first time saving, store original
            const checkActualQuery = `SELECT actual_result FROM job_files WHERE id = $1`;
            const checkActualResult = await client.query(checkActualQuery, [fileId]);

            if (checkActualResult.rows.length > 0 && checkActualResult.rows[0].actual_result === null) {
                // First time saving - store original AI result before any modifications
                // Store the result with source_locations removed for actual_result too
                actualResultToSave = resultWithoutSourceLocations;
            }
        }

        // Auto-fix permit number if result is being saved and status is completed
        let finalResult = resultWithoutSourceLocations;
        if (status === 'completed' && result) {
            // Get filename and job_id for permit extraction
            const fileQuery = `SELECT filename, job_id FROM job_files WHERE id = $1`;
            const fileResult = await client.query(fileQuery, [fileId]);

            if (fileResult.rows.length > 0) {
                const { filename, job_id } = fileResult.rows[0];
                console.log({ filename, job_id });

                // Only run auto-fix for MGS job
                if (job_id === '5667fe82-63e1-47fa-a640-b182b5c5d034') {
                    console.log(`🔧 Starting MGS processing for file ${fileId}`);

                    // Step 1: Fix permit number
                    finalResult = autoFixPermitNumber(result, filename);
                    console.log(`✅ Step 1: Permit number fixed for ${filename}`);

                    const permitNumber = mgsDataService.extractPermitFromData(finalResult);
                    if (permitNumber) {
                        console.log(`🔍 Step 2: Looking up MGS data for permit ${permitNumber}`);
                        try {
                            const mgsData = await mgsDataService.getMGSDataByPermitNumber(permitNumber);
                            if (mgsData) {
                                // Step 2: Populate MGS data
                                finalResult = mgsDataService.mergeMGSData(finalResult, mgsData);
                                console.log(`✅ Step 2: MGS data populated for permit ${permitNumber}`);

                                // Step 3: Add to preview (only if MGS data was found)
                                console.log(`📋 Step 3: Adding file ${fileId} to preview`);
                                await addItemsToPreview('550bff46-db7d-4691-8503-e819273977ee', [fileId]);
                                console.log(`✅ Step 3: File ${fileId} added to preview successfully`);
                            } else {
                                console.log(`⚠️ Step 2: No MGS data found for permit ${permitNumber}`);
                            }
                        } catch (error) {
                            console.error(`❌ Step 2: Error looking up MGS data for permit ${permitNumber}:`, error.message);
                        }
                    } else {
                        console.log(`⚠️ Step 2: No permit number found in result, skipping MGS data lookup`);
                    }

                    console.log(`🎉 MGS processing completed for file ${fileId}`);
                }
            }
        }

        // Build update query - include actual_result if we need to set it
        let query;
        let values;

        if (actualResultToSave !== null) {
            // First time saving - set both actual_result and result, plus source_locations
            query = `
                UPDATE job_files 
                SET processing_status = $1, result = $2, actual_result = $3, processing_error = $4, 
                    processed_at = $5, processing_metadata = $6, ai_processing_time_seconds = $7, 
                    source_locations = $8, updated_at = NOW()
                WHERE id = $9
                RETURNING id, job_id, filename
            `;
            const processedAt = status === 'completed' || status === 'failed' ? new Date() : null;
            values = [
                status,
                finalResult ? JSON.stringify(finalResult) : null,
                JSON.stringify(actualResultToSave),
                error,
                processedAt,
                metadata ? JSON.stringify(metadata) : null,
                aiProcessingTimeSeconds,
                sourceLocations ? JSON.stringify(sourceLocations) : null,
                fileId
            ];
        } else {
            // Not first time - only update result and source_locations (actual_result stays unchanged)
            query = `
                UPDATE job_files 
                SET processing_status = $1, result = $2, processing_error = $3, 
                    processed_at = $4, processing_metadata = $5, ai_processing_time_seconds = $6, 
                    source_locations = $7, updated_at = NOW()
                WHERE id = $8
                RETURNING id, job_id, filename
            `;
            const processedAt = status === 'completed' || status === 'failed' ? new Date() : null;
            values = [
                status,
                finalResult ? JSON.stringify(finalResult) : null,
                error,
                processedAt,
                metadata ? JSON.stringify(metadata) : null,
                aiProcessingTimeSeconds,
                sourceLocations ? JSON.stringify(sourceLocations) : null,
                fileId
            ];
        }
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

// Update job configuration
export async function updateJobConfig(jobId, updates) {
    const client = await pool.connect();
    try {
        // Build dynamic update query based on provided updates
        const updatesList = [];
        const values = [];
        let paramIndex = 1;

        if (updates.name !== undefined) {
            updatesList.push(`name = $${paramIndex++}`);
            values.push(updates.name);
        }

        if (updates.extraction_mode !== undefined) {
            updatesList.push(`extraction_mode = $${paramIndex++}`);
            values.push(updates.extraction_mode);
        }

        if (updates.processing_config !== undefined) {
            updatesList.push(`processing_config = $${paramIndex++}`);
            values.push(JSON.stringify(updates.processing_config));
        }

        if (updatesList.length === 0) {
            throw new Error('No updates provided');
        }

        // Always update updated_at timestamp
        updatesList.push(`updated_at = NOW()`);
        values.push(jobId);

        const query = `
            UPDATE jobs 
            SET ${updatesList.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING id, name, extraction_mode, processing_config, updated_at
        `;

        const result = await client.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('Job not found');
        }

        const updatedJob = result.rows[0];

        // Parse processing_config if it's a string (JSONB columns can return as strings)
        if (updatedJob.processing_config && typeof updatedJob.processing_config === 'string') {
            try {
                updatedJob.processing_config = JSON.parse(updatedJob.processing_config);
            } catch (parseError) {
                console.warn('⚠️ Failed to parse processing_config in update result:', parseError.message);
            }
        }

        console.log(`✅ Job configuration updated: ${jobId}`);
        return updatedJob;
    } catch (error) {
        console.error('❌ Error updating job configuration:', error.message);
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
// Returns jobs from organizations the user is a member of (any role: owner, admin, member, viewer)
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

// Get job organization ID (ultra-lightweight - for access checks)
export async function getJobOrganizationId(jobId) {
    const client = await pool.connect();
    try {
        await client.query('SET statement_timeout = 30000');
        const query = `SELECT organization_id FROM jobs WHERE id = $1`;
        const result = await client.query(query, [jobId]);
        return result.rows.length > 0 ? result.rows[0].organization_id : null;
    } catch (error) {
        console.error('❌ Error getting job organization ID:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get file by ID (lightweight - for worker use)
export async function getFileById(fileId, includeLargeColumns = false) {
    const client = await pool.connect();
    try {
        // Set statement timeout for this connection (30 seconds)
        await client.query('SET statement_timeout = 30000');
        const largeColumns = includeLargeColumns
            ? 'extracted_text, extracted_tables, markdown, result, actual_result, raw_data,'
            : '';

        const query = `
            SELECT jf.id, jf.filename, jf.size, jf.s3_key, jf.file_hash, jf.extraction_status, 
                   jf.processing_status, ${largeColumns}
                   jf.processing_metadata, jf.extraction_error, jf.processing_error, 
                   jf.created_at, jf.processed_at, jf.upload_status, jf.upload_error, 
                   jf.storage_type, jf.retry_count, jf.last_retry_at,
                   jf.extraction_time_seconds, jf.ai_processing_time_seconds, 
                   jf.admin_verified, jf.customer_verified, jf.pages, jf.page_count,
                   jf.openai_feed_blocked, jf.openai_feed_unblocked, jf.extraction_metadata, 
                   jf.source_locations, jf.job_id,
                   j.id as job_id, j.name as job_name, j.schema_data, j.schema_data_array, j.processing_config
            FROM job_files jf
            JOIN jobs j ON jf.job_id = j.id
            WHERE jf.id = $1
        `;

        const result = await client.query(query, [fileId]);

        if (result.rows.length === 0) {
            return null;
        }

        const file = result.rows[0];

        // Parse processing_config if it's a string
        if (file.processing_config && typeof file.processing_config === 'string') {
            try {
                file.processing_config = JSON.parse(file.processing_config);
            } catch (parseError) {
                console.warn('⚠️ Failed to parse processing_config in getFileById:', parseError.message);
            }
        }

        // Extract pages from raw_data if included
        if (includeLargeColumns && file.raw_data) {
            let pages = null;
            if (typeof file.raw_data === 'object' && file.raw_data.pages) {
                pages = file.raw_data.pages;
            } else if (typeof file.raw_data === 'string') {
                try {
                    const parsed = JSON.parse(file.raw_data);
                    pages = parsed.pages || null;
                } catch (e) {
                    // Ignore parsing errors
                }
            }
            file.pages = pages || file.pages || null;
        }

        return file;
    } catch (error) {
        console.error('❌ Error getting file by ID:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get file result (includes all large columns)
export async function getFileResult(fileId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT jf.id, jf.filename, jf.result, jf.actual_result, jf.extracted_text, jf.extracted_tables, jf.pages, jf.page_count, jf.markdown,
                   jf.extraction_status, jf.processing_status, jf.extraction_error, jf.processing_error, jf.processed_at,
                   jf.job_id, j.name as job_name, j.schema_data, j.schema_data_array, jf.upload_status, jf.upload_error, 
                   jf.storage_type, jf.retry_count, jf.last_retry_at, jf.extraction_time_seconds, jf.ai_processing_time_seconds,
                   jf.admin_verified, jf.customer_verified, jf.openai_feed_blocked, jf.openai_feed_unblocked, jf.extraction_metadata,
                   jf.source_locations, jf.raw_data
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

// Update file verification status
export async function updateFileVerification(fileId, adminVerified = null, customerVerified = null) {
    const client = await pool.connect();
    try {
        const updates = [];
        const values = [];
        let paramCount = 0;

        if (adminVerified !== null) {
            paramCount++;
            updates.push(`admin_verified = $${paramCount}`);
            values.push(adminVerified);
        }

        if (customerVerified !== null) {
            paramCount++;
            updates.push(`customer_verified = $${paramCount}`);
            values.push(customerVerified);
        }

        if (updates.length === 0) {
            throw new Error('At least one verification field must be provided');
        }

        paramCount++;
        values.push(fileId);

        const query = `
            UPDATE job_files 
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $${paramCount}
            RETURNING id, filename, admin_verified, customer_verified
        `;

        const result = await client.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('File not found');
        }

        console.log(`✅ File verification updated: ${fileId} - admin: ${adminVerified}, customer: ${customerVerified}`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error updating file verification:', error.message);
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

// Get all files across all jobs with pagination
// Returns files from jobs in organizations the user is a member of (any role)
export async function getAllFiles(limit = 50, offset = 0, status = null, jobId = null, organizationIds = null) {
    const client = await pool.connect();
    try {
        // Build base query conditions
        let whereConditions = 'WHERE 1=1';
        const params = [];
        let paramCount = 0;

        if (status) {
            paramCount++;
            whereConditions += ` AND (jf.extraction_status = $${paramCount} OR jf.processing_status = $${paramCount})`;
            params.push(status);
        }

        if (jobId) {
            paramCount++;
            whereConditions += ` AND jf.job_id = $${paramCount}`;
            params.push(jobId);
        }

        // Filter by organization membership (any role: owner, admin, member, viewer)
        if (organizationIds && Array.isArray(organizationIds) && organizationIds.length > 0) {
            const placeholders = organizationIds.map(() => `$${++paramCount}`).join(',');
            whereConditions += ` AND j.organization_id IN (${placeholders})`;
            params.push(...organizationIds);
        } else {
            // User with no organizations - return empty
            return {
                files: [],
                total: 0,
                stats: {
                    total: 0,
                    completed: 0,
                    processing: 0,
                    failed: 0,
                    pending: 0
                }
            };
        }

        // Get total count and file statistics
        const countQuery = `
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN jf.processing_status = 'completed' THEN 1 END) as completed,
                COUNT(CASE WHEN jf.processing_status = 'processing' THEN 1 END) as processing,
                COUNT(CASE WHEN jf.processing_status = 'failed' THEN 1 END) as failed,
                COUNT(CASE WHEN jf.processing_status = 'pending' THEN 1 END) as pending
            FROM job_files jf
            LEFT JOIN jobs j ON jf.job_id = j.id
            ${whereConditions}
        `;

        const countResult = await client.query(countQuery, params);
        const stats = {
            total: parseInt(countResult.rows[0].total),
            completed: parseInt(countResult.rows[0].completed),
            processing: parseInt(countResult.rows[0].processing),
            failed: parseInt(countResult.rows[0].failed),
            pending: parseInt(countResult.rows[0].pending)
        };

        // Get paginated files with preview data
        const filesQuery = `
            SELECT 
                jf.id,
                jf.filename,
                jf.size,
                jf.extraction_status,
                jf.processing_status,
                jf.extraction_time_seconds,
                jf.ai_processing_time_seconds,
                jf.created_at,
                jf.processed_at,
                jf.job_id,
                j.name as job_name,
                jf.result,
                jf.actual_result,
                jf.extraction_error,
                jf.processing_error,
                jf.extracted_text, 
                jf.extracted_tables, 
                jf.pages, 
                jf.page_count,
                jf.markdown,
                jf.admin_verified,
                jf.customer_verified,
                jf.openai_feed_blocked,
                jf.openai_feed_unblocked,
                jf.extraction_metadata,
                jf.source_locations,
                COALESCE(
                    JSON_AGG(
                        CASE 
                            WHEN pdt.id IS NOT NULL 
                            THEN JSON_BUILD_OBJECT(
                                'id', pdt.id,
                                'name', pdt.name,
                                'created_at', pdt.created_at
                            )
                            ELSE NULL
                        END
                    ) FILTER (WHERE pdt.id IS NOT NULL),
                    '[]'::json
                ) as previews
            FROM job_files jf
            LEFT JOIN jobs j ON jf.job_id = j.id
            LEFT JOIN preview_data_table pdt ON jf.id = ANY(pdt.items_ids)
            ${whereConditions}
            GROUP BY jf.id, jf.filename, jf.size, jf.extraction_status, jf.processing_status,
                     jf.extraction_time_seconds, jf.ai_processing_time_seconds, jf.created_at,
                     jf.processed_at, jf.job_id, j.name, jf.result, jf.actual_result,
                     jf.extraction_error, jf.processing_error, jf.markdown, jf.admin_verified,
                     jf.customer_verified, jf.page_count
            ORDER BY jf.created_at DESC 
            LIMIT $${++paramCount} OFFSET $${++paramCount}
        `;

        params.push(parseInt(limit), parseInt(offset));
        const filesResult = await client.query(filesQuery, params);

        return {
            files: filesResult.rows,
            total: stats.total,
            stats: stats
        };
    } catch (error) {
        console.error('Error fetching all files:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get job file statistics
export async function getJobFileStats(jobId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN jf.processing_status = 'completed' AND jf.extraction_status = 'completed' THEN 1 END) as processed,
                COUNT(CASE WHEN jf.processing_status = 'processing' OR jf.extraction_status = 'processing' THEN 1 END) as processing,
                COUNT(CASE WHEN jf.processing_status = 'pending' AND jf.extraction_status = 'pending' THEN 1 END) as pending
            FROM job_files jf
            WHERE jf.job_id = $1
        `;

        const result = await client.query(query, [jobId]);

        if (result.rows.length === 0) {
            return {
                total: 0,
                processed: 0,
                processing: 0,
                pending: 0
            };
        }

        return {
            total: parseInt(result.rows[0].total),
            processed: parseInt(result.rows[0].processed),
            processing: parseInt(result.rows[0].processing),
            pending: parseInt(result.rows[0].pending)
        };
    } catch (error) {
        console.error('Error getting job file statistics:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get job files by status with pagination
export async function getJobFilesByStatus(jobId, status, limit = 50, offset = 0) {
    const client = await pool.connect();
    try {
        // Build status condition
        let statusCondition = '';
        if (status === 'processed') {
            statusCondition = "jf.processing_status = 'completed' AND jf.extraction_status = 'completed'";
        } else if (status === 'processing') {
            statusCondition = "jf.processing_status = 'processing' OR jf.extraction_status = 'processing'";
        } else if (status === 'pending') {
            statusCondition = "jf.processing_status = 'pending' AND jf.extraction_status = 'pending'";
        } else {
            throw new Error('Invalid status. Must be: processed, processing, or pending');
        }

        // Get total count for this status
        const countQuery = `
            SELECT COUNT(*) as total
            FROM job_files jf
            WHERE jf.job_id = $1 AND ${statusCondition}
        `;

        const countResult = await client.query(countQuery, [jobId]);
        const total = parseInt(countResult.rows[0].total);

        // Get paginated files with preview data
        const filesQuery = `
            SELECT 
                jf.id,
                jf.filename,
                jf.size,
                jf.extraction_status,
                jf.processing_status,
                jf.extraction_time_seconds,
                jf.ai_processing_time_seconds,
                jf.created_at,
                jf.processed_at,
                jf.job_id,
                jf.result,
                jf.extraction_error,
                jf.processing_error,
                COALESCE(
                    JSON_AGG(
                        CASE 
                            WHEN pdt.id IS NOT NULL 
                            THEN JSON_BUILD_OBJECT(
                                'id', pdt.id,
                                'name', pdt.name,
                                'created_at', pdt.created_at
                            )
                            ELSE NULL
                        END
                    ) FILTER (WHERE pdt.id IS NOT NULL),
                    '[]'::json
                ) as previews
            FROM job_files jf
            LEFT JOIN preview_data_table pdt ON jf.id = ANY(pdt.items_ids)
            WHERE jf.job_id = $1 AND ${statusCondition}
            GROUP BY jf.id, jf.filename, jf.size, jf.extraction_status, jf.processing_status,
                     jf.extraction_time_seconds, jf.ai_processing_time_seconds, jf.created_at,
                     jf.processed_at, jf.job_id, jf.result, jf.extraction_error, jf.processing_error
            ORDER BY jf.created_at DESC 
            LIMIT $2 OFFSET $3
        `;

        const filesResult = await client.query(filesQuery, [jobId, parseInt(limit), parseInt(offset)]);

        return {
            files: filesResult.rows,
            total: total,
            status: status
        };
    } catch (error) {
        console.error('Error getting job files by status:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Check if user has access to a job
// Returns true if user is a member of the job's organization (any role: owner, admin, member, viewer)
export async function userHasJobAccess(jobId, userEmail, userRole, userOrganizationIds = []) {
    const client = await pool.connect();
    try {
        // Get job's organization_id
        const jobQuery = `SELECT organization_id FROM jobs WHERE id = $1`;
        const jobResult = await client.query(jobQuery, [jobId]);

        if (jobResult.rows.length === 0) {
            return false; // Job doesn't exist
        }

        const jobOrgId = jobResult.rows[0].organization_id;

        // User has access if they're a member of the job's organization (any role)
        return jobOrgId && userOrganizationIds.includes(jobOrgId);
    } catch (error) {
        console.error('❌ Error checking job access:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

export default pool;
