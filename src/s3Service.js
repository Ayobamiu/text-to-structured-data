import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

class S3Service {
    constructor() {
        this.s3Client = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });

        this.bucketName = process.env.S3_BUCKET_NAME || 'document-extractor-files';
        this.enabled = process.env.CLOUD_STORAGE_ENABLED === 'true';
        this.fileRetentionDays = parseInt(process.env.FILE_RETENTION_DAYS) || 7;
    }

    // Check if cloud storage is enabled
    isCloudStorageEnabled() {
        return this.enabled;
    }

    // Generate unique filename with hash
    generateUniqueFilename(originalName) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2);
        const ext = path.extname(originalName);
        const baseName = path.basename(originalName, ext);

        return `${baseName}_${timestamp}_${random}${ext}`;
    }

    // Calculate file hash for integrity checking
    calculateFileHash(fileBuffer) {
        return crypto.createHash('sha256').update(fileBuffer).digest('hex');
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
                    'original-name': originalName,
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

            // Read file buffer
            const fileBuffer = file.buffer || fs.readFileSync(file.path);

            // Calculate file hash
            const fileHash = this.calculateFileHash(fileBuffer);

            // Set expiration date
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + this.fileRetentionDays);

            // Upload to S3
            const uploadCommand = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: fileBuffer,
                ContentType: file.mimetype,
                Metadata: {
                    originalName: file.originalname,
                    jobId: jobId,
                    fileHash: fileHash,
                    uploadedAt: new Date().toISOString(),
                    expiresAt: expiresAt.toISOString()
                }
            });

            await this.s3Client.send(uploadCommand);

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
