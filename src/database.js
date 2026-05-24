import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { FileProcessingPipeline } from './pipeline/FileProcessingPipeline.js';
import { resolvePgPoolConfig } from './utils/pgConnection.js';

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

const { Pool } = pg;

const defaultDbUrl = 'postgresql://postgres:password@localhost:5432/batch_processor';

// Database connection pool (IPv4 + TLS SNI when needed — see resolvePgPoolConfig)
const pool = new Pool(
    await resolvePgPoolConfig(process.env.DATABASE_URL || defaultDbUrl, {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    })
);

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
//
// `documentTypeSlug` is optional and points at document_types.slug in the
// schema registry (Phase 0). It's used as the fallback document_type label on
// field_corrections rows when an editor saves changes against a v1 (flat)
// result blob whose json_path doesn't encode a section type. Defaulting to
// `schemaName` makes existing call-sites correctly tag corrections without
// requiring any caller change, since today's `schemaName` already matches the
// intended type slug (e.g. 'mgs_well_log').
export async function createJob(name, schema, schemaName, userId = null, organizationId = null, extractionMode = 'full_extraction', processingConfig = null, documentTypeSlug = null) {
    const client = await pool.connect();
    try {
        const jobId = uuidv4();

        // Set default processing config if not provided
        const defaultProcessingConfig = {
            extraction: { method: 'paddleocr', options: {} },
            processing: { method: 'openai', model: 'gpt-4o', options: {} }
        };

        const finalProcessingConfig = processingConfig || defaultProcessingConfig;

        // Create initial schema data object
        const initialSchemaData = { schema, schemaName: schemaName || 'data_extraction' };

        const finalDocumentTypeSlug = documentTypeSlug || schemaName || null;

        const query = `
            INSERT INTO jobs (id, name, schema_data, schema_data_array, status, user_id, organization_id, extraction_mode, processing_config, document_type_slug, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
            RETURNING id, name, status, extraction_mode, processing_config, document_type_slug, created_at
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
            JSON.stringify(finalProcessingConfig),
            finalDocumentTypeSlug
        ];

        const result = await client.query(query, values);
        console.log(`✅ Job created: ${jobId} (document_type_slug=${finalDocumentTypeSlug})`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error creating job:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Add file to job
export async function addFileToJob(jobId, filename, size, s3Key, fileHash, uploadStatus = 'pending', uploadError = null, storageType = 's3', pageCount = null, selectedPages = null) {
    console.log('🔍 addFileToJob debug:', {
        jobId,
        filename,
        size,
        s3Key,
        fileHash,
        uploadStatus,
        uploadError,
        storageType,
        pageCount,
        selectedPages
    });
    const client = await pool.connect();
    try {
        const fileId = uuidv4();
        const query = `
            INSERT INTO job_files (id, job_id, filename, size, page_count, s3_key, file_hash, 
                                 extraction_status, processing_status, upload_status, upload_error, storage_type, retry_count, last_retry_at, selected_pages, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
            RETURNING id, filename, size, page_count, s3_key, file_hash, upload_status, upload_error, storage_type, retry_count, last_retry_at, selected_pages
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
            null,
            selectedPages ? JSON.stringify(selectedPages) : null
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
                SELECT id, name, status, schema_data, user_id, organization_id, 
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
            SELECT id, name, status, schema_data, summary, user_id, organization_id, created_at, updated_at, extraction_mode, processing_config
            FROM jobs WHERE id = $1
        `;
        const jobResult = await client.query(jobQuery, [jobId]);

        if (jobResult.rows.length === 0) {
            return null;
        }

        // Get job files - exclude large columns unless explicitly requested
        // Large columns: actual_result, extracted_text, extracted_tables, pages, openai_feed_blocked, openai_feed_unblocked, source_locations, raw_data
        const largeColumns = includeLargeColumns
            ? 'actual_result, extracted_text, extracted_tables, pages, openai_feed_blocked, openai_feed_unblocked, source_locations, raw_data,'
            : '';

        const filesQuery = `
            SELECT id, filename, size, s3_key, file_hash, extraction_status, 
                   processing_status, ${largeColumns}
                   processing_metadata, extraction_error, processing_error, created_at, processed_at,
                   upload_status, upload_error, storage_type, retry_count, last_retry_at,
                   extraction_time_seconds, ai_processing_time_seconds, admin_verified, customer_verified,
                   page_count, extraction_metadata,
                   review_status, reviewed_by, reviewed_at, review_notes
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
// NOTE: This function does NOT update page_count to preserve the original PDF page count
// (especially when selected_pages are used, we want to keep the original total, not the selected pages count)
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
    pageCount = null // Parameter kept for backward compatibility, but page_count is NEVER updated
) {
    const client = await pool.connect();
    try {
        // Query does NOT include page_count - we preserve the original value
        const query = `
            UPDATE job_files 
            SET extraction_status = $1, extracted_text = $2, extracted_tables = $3, 
                markdown = $4, pages = $5, extraction_error = $6, extraction_time_seconds = $7,
                openai_feed_blocked = $8, openai_feed_unblocked = $9, extraction_metadata = $10,
                raw_data = $11, updated_at = NOW()
            WHERE id = $12
            RETURNING id, job_id, filename
        `;

        // Handle empty strings - convert to null for consistency
        const openaiFeedBlockedValue = (openaiFeedBlocked && openaiFeedBlocked.trim().length > 0) ? openaiFeedBlocked : null;
        const openaiFeedUnblockedValue = (openaiFeedUnblocked && openaiFeedUnblocked.trim().length > 0) ? openaiFeedUnblocked : null;

        const values = [
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
            openaiFeedBlocked: openaiFeedBlockedValue ? `${openaiFeedBlockedValue.length} chars` : 'null',
            openaiFeedUnblocked: openaiFeedUnblockedValue ? `${openaiFeedUnblockedValue.length} chars` : 'null',
            hasExtractionMetadata: !!extractionMetadata,
            extractionMetadataKeys: extractionMetadata ? Object.keys(extractionMetadata) : null,
            hasRawData: !!rawData,
            rawDataType: rawData ? typeof rawData : 'null',
            rawDataKeys: rawData && typeof rawData === 'object' ? Object.keys(rawData).slice(0, 5) : null,
            valuesLength: values.length,
            note: 'page_count is NOT updated by this function'
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

        // Run post-processing pipeline (MGS permit fix, formation page detection, etc.)
        let finalResult = resultWithoutSourceLocations;
        let finalMetadata = metadata;

        if (status === 'completed' && result) {
            try {
                // Get file info for pipeline context
                const fileInfoQuery = `SELECT id, filename, job_id, s3_key, storage_type, pages FROM job_files WHERE id = $1`;
                const fileInfoResult = await client.query(fileInfoQuery, [fileId]);

                if (fileInfoResult.rows.length > 0) {
                    const fileInfo = fileInfoResult.rows[0];

                    // Parse pages if needed
                    let pages = null;
                    if (fileInfo.pages) {
                        if (typeof fileInfo.pages === 'string') {
                            try {
                                pages = JSON.parse(fileInfo.pages);
                            } catch (parseError) {
                                console.warn(`⚠️ Failed to parse pages JSON: ${parseError.message}`);
                            }
                        } else if (Array.isArray(fileInfo.pages)) {
                            pages = fileInfo.pages;
                        }
                    }

                    // Create pipeline context
                    const pipelineContext = {
                        fileId: fileId,
                        jobId: fileInfo.job_id,
                        filename: fileInfo.filename,
                        result: resultWithoutSourceLocations,
                        status: status,
                        fileInfo: fileInfo,
                        pages: pages,
                        metadata: metadata ? (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) : {}
                    };

                    // Execute pipeline
                    const pipeline = new FileProcessingPipeline({
                        stopOnError: false, // Don't fail entire update if pipeline stage fails
                        logProgress: true
                    });

                    const pipelineResult = await pipeline.execute(pipelineContext);

                    // Update final result and metadata from pipeline
                    finalResult = pipelineResult.result || finalResult;
                    finalMetadata = pipelineResult.metadata || finalMetadata;

                    // Log pipeline summary
                    const summary = pipeline.getSummary();
                    if (summary.failed > 0) {
                        console.warn(`⚠️ Pipeline completed with ${summary.failed} failed stage(s) for file ${fileId}`);
                    } else {
                        console.log(`✅ Pipeline completed successfully for file ${fileId}`);
                    }
                }
            } catch (pipelineError) {
                // Don't fail the entire update if pipeline fails
                console.error(`❌ Pipeline execution failed for file ${fileId}:`, pipelineError.message);
                // Continue with original result and metadata
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
                finalMetadata ? JSON.stringify(finalMetadata) : null,
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
                finalMetadata ? JSON.stringify(finalMetadata) : null,
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
        // Large columns: actual_result, extracted_text, extracted_tables, pages, openai_feed_blocked, openai_feed_unblocked, source_locations, raw_data
        const largeColumns = includeLargeColumns
            ? 'jf.actual_result, jf.extracted_text, jf.extracted_tables, jf.pages, jf.openai_feed_blocked, jf.openai_feed_unblocked, jf.source_locations, jf.raw_data,'
            : '';

        const query = `
            SELECT jf.id, jf.filename, jf.size, jf.s3_key, jf.file_hash, jf.extraction_status, 
                   jf.processing_status, ${largeColumns}
                   jf.processing_metadata, jf.extraction_error, jf.processing_error, 
                   jf.created_at, jf.processed_at, jf.upload_status, jf.upload_error, 
                   jf.storage_type, jf.retry_count, jf.last_retry_at,
                   jf.extraction_time_seconds, jf.ai_processing_time_seconds, 
                   jf.admin_verified, jf.customer_verified, jf.page_count,
                   jf.extraction_metadata, jf.job_id, jf.selected_pages,
                   jf.detected_sections,
                   jf.review_status, jf.reviewed_by, jf.reviewed_at, jf.review_notes,
                   j.id as job_id, j.name as job_name, j.schema_data, j.processing_config
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

        // Parse selected_pages if it's a string (JSONB can return as string)
        if (file.selected_pages && typeof file.selected_pages === 'string') {
            try {
                file.selected_pages = JSON.parse(file.selected_pages);
            } catch (e) {
                console.warn('⚠️ Failed to parse selected_pages in getFileById:', e.message);
                file.selected_pages = null;
            }
        }

        // detected_sections is small JSON — always selected so reprocess / worker
        // can restore per-section routing without re-running the classifier.
        if (file.detected_sections && typeof file.detected_sections === 'string') {
            try {
                file.detected_sections = JSON.parse(file.detected_sections);
            } catch (e) {
                console.warn('⚠️ Failed to parse detected_sections in getFileById:', e.message);
                file.detected_sections = null;
            }
        }

        // Defensive: large JSONB columns (pages, extracted_tables) usually
        // come back as parsed objects/arrays from node-postgres, but in some
        // pgbouncer / Supabase configurations they arrive as strings.
        // Reprocess feeds these straight to the per-section extractor, which
        // requires Array.isArray(pages) === true. Without this parse,
        // reprocess silently falls through to the v1 single-schema path and
        // returns a flat result keyed by the legacy job.schema_data.
        if (includeLargeColumns) {
            if (file.pages && typeof file.pages === 'string') {
                try {
                    file.pages = JSON.parse(file.pages);
                } catch (e) {
                    console.warn('⚠️ Failed to parse pages in getFileById:', e.message);
                    file.pages = null;
                }
            }
            if (file.extracted_tables && typeof file.extracted_tables === 'string') {
                try {
                    file.extracted_tables = JSON.parse(file.extracted_tables);
                } catch (e) {
                    console.warn('⚠️ Failed to parse extracted_tables in getFileById:', e.message);
                    file.extracted_tables = null;
                }
            }
        }

        return file;
    } catch (error) {
        console.error('❌ Error getting file by ID:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Get file result (optimized - excludes large columns: actual_result, extracted_text, extracted_tables, pages, raw_data, source_locations)
export async function getFileResult(fileId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT jf.id, jf.filename, jf.result, jf.page_count, jf.markdown,
                   jf.extraction_status, jf.processing_status, jf.extraction_error, jf.processing_error, jf.processed_at,
                   jf.job_id, j.name as job_name, j.schema_data, j.document_type_slug, jf.upload_status, jf.upload_error, 
                   jf.storage_type, jf.retry_count, jf.last_retry_at, jf.extraction_time_seconds, jf.ai_processing_time_seconds,
                   jf.admin_verified, jf.customer_verified, jf.extraction_metadata,
                   jf.review_status, jf.reviewed_by, jf.reviewed_at, jf.review_notes,
                   jf.detected_sections, jf.s3_key, jf.selected_pages
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

/**
 * Replace the `detected_sections` JSONB blob on a job_files row.
 *
 * Used by the routing-review endpoints (Phase 1, item #4). Caller is
 * responsible for any validation; this is a dumb writer.
 *
 * @param {string} fileId
 * @param {Object} detectedSections   Full new blob (not a patch).
 * @returns {Promise<{id, job_id, filename, detected_sections}>}
 */
export async function updateFileDetectedSections(fileId, detectedSections) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `UPDATE job_files
             SET detected_sections = $1::jsonb, updated_at = NOW()
             WHERE id = $2
             RETURNING id, job_id, filename, detected_sections`,
            [JSON.stringify(detectedSections), fileId]
        );
        if (rows.length === 0) {
            throw new Error('File not found');
        }
        return rows[0];
    } catch (error) {
        console.error('❌ Error updating file detected_sections:', error.message);
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

// Bulk update file review status
export async function bulkUpdateFileReviewStatus(fileIds, reviewStatus, reviewedBy = null, reviewNotes = null) {
    const client = await pool.connect();
    try {
        // Validate review status
        const validStatuses = ['pending', 'in_review', 'reviewed', 'approved', 'rejected'];
        if (!validStatuses.includes(reviewStatus)) {
            throw new Error(`Invalid review status. Must be one of: ${validStatuses.join(', ')}`);
        }

        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            throw new Error('File IDs array is required');
        }

        const updates = [];
        const values = [];
        let paramCount = 0;

        paramCount++;
        updates.push(`review_status = $${paramCount}`);
        values.push(reviewStatus);

        if (reviewedBy !== null) {
            paramCount++;
            updates.push(`reviewed_by = $${paramCount}`);
            values.push(reviewedBy);
        }

        // Set reviewed_at when status changes to reviewed, approved, or rejected
        if (['reviewed', 'approved', 'rejected'].includes(reviewStatus)) {
            updates.push(`reviewed_at = NOW()`);
        } else if (reviewStatus === 'pending') {
            updates.push(`reviewed_at = NULL`);
        }

        if (reviewNotes !== null && reviewNotes !== undefined) {
            paramCount++;
            updates.push(`review_notes = $${paramCount}`);
            values.push(reviewNotes);
        }

        // Create placeholders for file IDs
        const fileIdPlaceholders = fileIds.map((_, index) => `$${++paramCount}`).join(',');
        values.push(...fileIds);

        const query = `
            UPDATE job_files 
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id IN (${fileIdPlaceholders})
            RETURNING id, filename, review_status, reviewed_by, reviewed_at, review_notes, job_id
        `;

        const result = await client.query(query, values);

        console.log(`✅ Bulk review status updated: ${result.rows.length} files -> ${reviewStatus}${reviewedBy ? ` by ${reviewedBy}` : ''}`);
        return result.rows;
    } catch (error) {
        console.error('❌ Error bulk updating file review status:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Bulk update file verification status
export async function bulkUpdateFileVerification(fileIds, adminVerified = null, customerVerified = null) {
    const client = await pool.connect();
    try {
        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            throw new Error('File IDs array is required');
        }

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

        // Create placeholders for file IDs
        const fileIdPlaceholders = fileIds.map((_, index) => `$${++paramCount}`).join(',');
        values.push(...fileIds);

        const query = `
            UPDATE job_files 
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id IN (${fileIdPlaceholders})
            RETURNING id, filename, admin_verified, customer_verified, job_id
        `;

        const result = await client.query(query, values);

        console.log(`✅ Bulk verification updated: ${result.rows.length} files - admin: ${adminVerified}, customer: ${customerVerified}`);
        return result.rows;
    } catch (error) {
        console.error('❌ Error bulk updating file verification:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Update file review status
export async function updateFileReviewStatus(fileId, reviewStatus, reviewedBy = null, reviewNotes = null) {
    const client = await pool.connect();
    try {
        // Validate review status
        const validStatuses = ['pending', 'in_review', 'reviewed', 'approved', 'rejected'];
        if (!validStatuses.includes(reviewStatus)) {
            throw new Error(`Invalid review status. Must be one of: ${validStatuses.join(', ')}`);
        }

        const updates = [];
        const values = [];
        let paramCount = 0;

        paramCount++;
        updates.push(`review_status = $${paramCount}`);
        values.push(reviewStatus);

        if (reviewedBy !== null) {
            paramCount++;
            updates.push(`reviewed_by = $${paramCount}`);
            values.push(reviewedBy);
        }

        // Set reviewed_at when status changes to reviewed, approved, or rejected
        // Note: Don't increment paramCount for SQL literals (NOW(), NULL)
        if (['reviewed', 'approved', 'rejected'].includes(reviewStatus)) {
            updates.push(`reviewed_at = NOW()`);
        } else if (reviewStatus === 'pending') {
            // Reset reviewed_at when going back to pending
            updates.push(`reviewed_at = NULL`);
        }

        if (reviewNotes !== null && reviewNotes !== undefined) {
            paramCount++;
            updates.push(`review_notes = $${paramCount}`);
            values.push(reviewNotes);
        }

        paramCount++;
        values.push(fileId);

        const query = `
            UPDATE job_files 
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $${paramCount}
            RETURNING id, filename, review_status, reviewed_by, reviewed_at, review_notes
        `;

        const result = await client.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('File not found');
        }

        console.log(`✅ File review status updated: ${fileId} -> ${reviewStatus}${reviewedBy ? ` by ${reviewedBy}` : ''}`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error updating file review status:', error.message);
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
// OPTIMIZED: Excludes large columns (extracted_text, markdown, result, etc.) by default to reduce egress
export async function getAllFiles(limit = 50, offset = 0, status = null, jobId = null, organizationIds = null, includeLargeColumns = false) {
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

        // Phase 1: Skinny list — only columns needed to render a table row.
        // Heavy columns (result, markdown, extraction_metadata, processing_metadata)
        // are fetched on-demand in the detail/fullscreen view.
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
                j.extraction_mode as job_extraction_mode,
                jf.extraction_error,
                jf.processing_error,
                jf.page_count,
                jf.selected_pages,
                jf.admin_verified,
                jf.customer_verified,
                jf.review_status,
                jf.reviewed_by,
                jf.reviewed_at,
                jf.review_notes,
                (jf.result IS NOT NULL) as has_result,
                (jf.extraction_metadata->>'extraction_method') as extraction_method,
                '[]'::jsonb as flags,
                (SELECT COUNT(*)::int FROM preview_data_table pdt WHERE jf.id = ANY(pdt.items_ids)) as previews_count
            FROM job_files jf
            LEFT JOIN jobs j ON jf.job_id = j.id
            ${whereConditions}
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
