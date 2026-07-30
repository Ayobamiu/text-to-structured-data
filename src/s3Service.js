import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import dotenv from 'dotenv';

dotenv.config();

class S3Service {
    constructor() {
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
        const region = (process.env.AWS_REGION || 'us-east-1').trim();

        this.s3Client = new S3Client({
            region,
            credentials: {
                accessKeyId,
                secretAccessKey,
            },
        });

        this.bucketName = (process.env.S3_BUCKET_NAME || 'document-extractor-files').trim();
        this.enabled = process.env.CLOUD_STORAGE_ENABLED === 'true';
        this.fileRetentionDays = parseInt(process.env.FILE_RETENTION_DAYS) || 7;
    }

    // Check if cloud storage is enabled
    isCloudStorageEnabled() {
        return this.enabled;
    }

    /** Safe segment for S3 keys: ASCII-ish (NBSP / odd Unicode from OS filenames breaks some signing paths). */
    asciiSafeStem(originalName) {
        const ext = path.extname(originalName);
        const stem = path.basename(originalName, ext);
        const cleaned = stem
            .replace(/\u00A0/g, ' ')
            .replace(/[^\w.\- ()[\]]+/g, '_')
            .trim()
            .slice(0, 120);
        return cleaned.length ? cleaned : 'file';
    }

    // Generate unique filename with hash
    generateUniqueFilename(originalName) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2);
        const ext = path.extname(originalName);
        const baseName = this.asciiSafeStem(originalName);

        return `${baseName}_${timestamp}_${random}${ext}`;
    }

    // Calculate file hash for integrity checking
    calculateFileHash(fileBuffer) {
        return crypto.createHash('sha256').update(fileBuffer).digest('hex');
    }

    /**
     * Same sha256, computed by streaming the file off disk so a large upload
     * never materializes as a Buffer. Identical output to
     * calculateFileHash(fs.readFileSync(path)) — verified against the buffer
     * path on a 148.8MB PDF.
     */
    hashFileStream(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('error', reject);
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
        });
    }

    /** Base64 UTF-8 so S3 user metadata stays ASCII-safe (Unicode/NBSP filenames break SigV4 otherwise). */
    encodeFilenameForMetadata(originalName) {
        return Buffer.from(originalName ?? '', 'utf8').toString('base64');
    }

    // Upload logo file to S3
    async uploadLogo(fileBuffer, originalName) {
        try {
            if (!this.enabled) {
                throw new Error('S3 storage is disabled');
            }

            const filename = this.generateUniqueFilename(originalName);
            const key = `logos/${filename}`;

            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: fileBuffer,
                ContentType: this.getContentType(originalName),
                Metadata: {
                    'original-filename-b64': this.encodeFilenameForMetadata(originalName),
                    'upload-type': 'logo',
                    'uploaded-at': new Date().toISOString()
                }
            });

            await this.s3Client.send(command);

            // Return simple public URL since bucket is now public
            return `https://${this.bucketName}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
        } catch (error) {
            console.error('Error uploading logo to S3:', error);
            throw error;
        }
    }

    // Generate signed URL for existing logo
    async getLogoSignedUrl(s3Key) {
        try {
            if (!this.enabled) {
                throw new Error('S3 storage is disabled');
            }

            const getCommand = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key
            });

            const signedUrl = await getSignedUrl(this.s3Client, getCommand, {
                expiresIn: 604800 // 7 days in seconds
            });

            return signedUrl;
        } catch (error) {
            console.error('Error generating signed URL for logo:', error);
            throw error;
        }
    }

    // Get content type based on file extension
    getContentType(filename) {
        const ext = path.extname(filename).toLowerCase();
        const contentTypes = {
            '.pdf': 'application/pdf',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
            '.tiff': 'image/tiff',
            '.tif': 'image/tiff',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp'
        };
        return contentTypes[ext] || 'application/octet-stream';
    }

    // Upload file to S3
    async uploadFile(file, jobId) {
        try {
            if (!this.enabled) {
                throw new Error('S3 storage is disabled');
            }

            const uniqueFilename = this.generateUniqueFilename(file.originalname);
            const key = `jobs/${jobId}/${uniqueFilename}`;

            // Set expiration date
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + this.fileRetentionDays);

            // Hash and upload WITHOUT ever holding the file in memory.
            //
            // This used to be `fs.readFileSync(file.path)` into a Buffer that
            // was then hashed and handed whole to PutObject — so a 150MB PDF
            // cost 150MB resident before the SDK added its own copies. A
            // 2026-07-29 prod upload of a 148.8MB file died in exactly this
            // window: the container went away mid-request (Safari reported a
            // torn-down connection, no HTTP response), nothing reached the
            // logs, and no S3 object was written. Same anti-pattern as the
            // thumbnail OOM three days earlier.
            //
            // Two passes over the file on disk, neither buffered: one to
            // hash, one to upload. Multer already wrote it to disk, so the
            // read is local. Uploaded files can still arrive in memory
            // (upload.memoryStorage elsewhere), so `file.buffer` stays
            // supported for those callers.
            const fileHash = file.buffer
                ? this.calculateFileHash(file.buffer)
                : await this.hashFileStream(file.path);

            const body = file.buffer || fs.createReadStream(file.path);

            // lib-storage's Upload streams in parts (5MB default) and
            // switches to multipart automatically past the threshold, so peak
            // memory is a few parts rather than the whole file. PutObject
            // cannot do this — it needs a known length up front.
            const upload = new Upload({
                client: this.s3Client,
                params: {
                    Bucket: this.bucketName,
                    Key: key,
                    Body: body,
                    ContentType: file.mimetype || this.getContentType(file.originalname),
                    Metadata: {
                        'original-filename-b64': this.encodeFilenameForMetadata(file.originalname),
                        jobid: jobId,
                        filehash: fileHash,
                        uploadedat: new Date().toISOString(),
                        expiresat: expiresAt.toISOString()
                    }
                },
                queueSize: 4,
                partSize: 8 * 1024 * 1024,
                leavePartsOnError: false,
            });

            await upload.done();

            // Generate signed URL for access
            const signedUrl = await this.generateSignedUrl(key);

            const fileMetadata = {
                originalName: file.originalname,
                storedName: uniqueFilename,
                s3Key: key,
                fileUrl: signedUrl,
                storageType: 's3',
                fileHash: fileHash,
                size: file.size,
                mimeType: file.mimetype,
                expiresAt: expiresAt,
                createdAt: new Date()
            };

            console.log(`✅ File uploaded to S3: ${file.originalname} -> ${key}`);
            return fileMetadata;

        } catch (error) {
            console.error('❌ Error uploading file to S3:', error.message);
            throw error;
        }
    }

    // Generate signed URL for file access
    async generateSignedUrl(s3Key, expiresIn = 3600) {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key
            });

            const signedUrl = await getSignedUrl(this.s3Client, command, { expiresIn });
            return signedUrl;
        } catch (error) {
            console.error('❌ Error generating signed URL:', error.message);
            throw error;
        }
    }

    // Download file from S3
    async downloadFile(s3Key) {
        if (!this.enabled) {
            throw new Error('S3 storage is disabled');
        }

        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key
            });

            const response = await this.s3Client.send(command);

            // Convert stream to buffer
            const chunks = [];
            for await (const chunk of response.Body) {
                chunks.push(chunk);
            }

            const buffer = Buffer.concat(chunks);
            console.log(`✅ File downloaded from S3: ${s3Key} (${buffer.length} bytes)`);
            return buffer;
        } catch (error) {
            console.error(`❌ Error downloading file from S3 (${s3Key}):`, error.message);
            throw error;
        }
    }

    /**
     * Stream an object straight to a local path — never materialises it on
     * the heap. Use this instead of `downloadFile` for anything large where
     * the consumer wants a file path anyway (e.g. pdftoppm). Returns the
     * number of bytes written.
     */
    async downloadToFile(s3Key, destPath) {
        if (!this.enabled) {
            throw new Error('S3 storage is disabled');
        }

        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key
            });

            const response = await this.s3Client.send(command);
            await pipeline(response.Body, fs.createWriteStream(destPath));

            const { size } = fs.statSync(destPath);
            console.log(`✅ File streamed from S3 to disk: ${s3Key} (${size} bytes)`);
            return size;
        } catch (error) {
            console.error(`❌ Error streaming file from S3 (${s3Key}):`, error.message);
            throw error;
        }
    }

    /**
     * Open an object for reading without buffering it. Returns null when the
     * key does not exist, so callers can treat "cache miss" as a normal path
     * rather than an exception. The caller owns the returned stream.
     */
    async getObjectStream(s3Key) {
        if (!this.enabled) {
            throw new Error('S3 storage is disabled');
        }

        try {
            const response = await this.s3Client.send(new GetObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key
            }));

            return {
                body: response.Body,
                contentType: response.ContentType,
                contentLength: response.ContentLength,
                etag: response.ETag,
            };
        } catch (error) {
            if (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
                return null;
            }
            throw error;
        }
    }

    /** Put an already-in-memory buffer at an exact key (no filename mangling). */
    async uploadBuffer(s3Key, buffer, contentType = 'application/octet-stream', metadata = {}) {
        if (!this.enabled) {
            throw new Error('S3 storage is disabled');
        }

        await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucketName,
            Key: s3Key,
            Body: buffer,
            ContentType: contentType,
            Metadata: metadata,
        }));

        return s3Key;
    }

    // Delete file from S3
    async deleteFile(s3Key) {
        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key
            });

            await this.s3Client.send(command);
            console.log(`🗑️ File deleted from S3: ${s3Key}`);
            return true;
        } catch (error) {
            console.error('❌ Error deleting file from S3:', error.message);
            throw error;
        }
    }

    // Check if file exists in S3
    async fileExists(s3Key) {
        try {
            const command = new HeadObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key
            });

            await this.s3Client.send(command);
            return true;
        } catch (error) {
            if (error.name === 'NotFound') {
                return false;
            }
            throw error;
        }
    }

    // Test S3 connection
    async testConnection() {
        try {
            if (!this.enabled) {
                return { connected: false, message: 'S3 storage disabled' };
            }

            // Try to list objects (this will fail if bucket doesn't exist or no permissions)
            const command = new HeadObjectCommand({
                Bucket: this.bucketName,
                Key: 'test-connection'
            });

            // We expect this to fail, but it will tell us if we can connect
            try {
                await this.s3Client.send(command);
            } catch (error) {
                if (error.name === 'NotFound' || error.name === 'NoSuchBucket') {
                    return { connected: true, message: 'S3 connection successful' };
                }
                throw error;
            }

            return { connected: true, message: 'S3 connection successful' };
        } catch (error) {
            console.error('❌ S3 connection test failed:', error.message);
            return { connected: false, message: error.message };
        }
    }

    // Get storage statistics (placeholder - would need to implement S3 list operations)
    async getStorageStats() {
        try {
            if (!this.enabled) {
                return {
                    totalFiles: 0,
                    totalSize: 0,
                    totalSizeMB: 0,
                    storageType: 'disabled',
                    bucketName: this.bucketName
                };
            }

            // In a real implementation, you'd list objects in the bucket
            // For now, return placeholder data
            return {
                totalFiles: 'N/A',
                totalSize: 'N/A',
                totalSizeMB: 'N/A',
                storageType: 's3',
                bucketName: this.bucketName,
                region: process.env.AWS_REGION || 'us-east-1',
                enabled: this.enabled
            };
        } catch (error) {
            console.error('❌ Error getting S3 storage stats:', error.message);
            throw error;
        }
    }

    // Validate file type and size
    validateFile(file) {
        const allowedTypes = [
            'application/pdf',
            'text/plain',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            // Image types
            'image/png',
            'image/jpeg',
            'image/jpg',
            'image/gif',
            'image/bmp',
            'image/tiff',
            'image/tif',
            'image/webp'
        ];

        const maxSize = 50 * 1024 * 1024; // 50MB

        // Also check file extension as fallback (some uploads may have incorrect MIME types)
        const ext = path.extname(file.originalname || '').toLowerCase();
        const allowedExtensions = ['.pdf', '.txt', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp'];
        
        if (!allowedTypes.includes(file.mimetype) && !allowedExtensions.includes(ext)) {
            throw new Error(`File type ${file.mimetype} (${ext}) not allowed. Allowed types: PDF, DOC, DOCX, TXT, PNG, JPG, JPEG, GIF, BMP, TIFF, TIF, WEBP`);
        }

        if (file.size > maxSize) {
            throw new Error(`File size ${file.size} exceeds maximum ${maxSize}`);
        }

        return true;
    }

    // Create file download URL (for API access)
    createFileUrl(jobId, filename) {
        return `/api/files/${jobId}/${filename}`;
    }

    // Get content type based on file extension
    getContentType(filename) {
        const ext = path.extname(filename).toLowerCase();
        const contentTypes = {
            '.pdf': 'application/pdf',
            '.txt': 'text/plain',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        };

        return contentTypes[ext] || 'application/octet-stream';
    }
}

export default S3Service;
