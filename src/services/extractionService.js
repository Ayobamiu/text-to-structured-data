import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import ExtendAIService from './extendAIService.js';
import { extractPagesFromPdf } from './formationPageDetectionService.js';

const PADDLEOCR_FLASK_URL = process.env.PADDLEOCR_FLASK_URL || "http://localhost:5002";
const DEFAULT_EXTRACTION_METHOD = 'paddleocr';
const RETIRED_EXTRACTION_METHODS = new Set(['mineru', 'documentai']);

class ExtractionService {
    constructor(s3Service = null) {
        this.paddleocrFlaskUrl = PADDLEOCR_FLASK_URL;
        this.extendAIService = new ExtendAIService();
        this.s3Service = s3Service; // Will be injected for S3 operations
    }

    /**
     * Extract text from PDF using the specified method
     * @param {string} filePath - Path to the PDF file
     * @param {string} filename - Original filename
     * @param {string} method - Extraction method ('paddleocr' or 'extendai')
     * @param {Object} options - Method-specific options
     * @param {string} s3Key - Optional S3 key if file is in S3 (required for extendai)
     * @param {number[]} selectedPages - Optional array of page numbers to extract (1-indexed, for paddleocr and extendai)
     * @returns {Promise<Object>} Extraction result
     */
    async extractText(filePath, filename, method = DEFAULT_EXTRACTION_METHOD, options = {}, s3Key = null, selectedPages = null) {
        try {
            console.log(`📄 Extracting text using ${method} method for ${filename}`);

            if (RETIRED_EXTRACTION_METHODS.has(method)) {
                throw new Error(
                    `Extraction method "${method}" is retired (legacy FLASK_URL service). Use "paddleocr" or "extendai".`
                );
            }

            // Handle ExtendAI extraction (requires S3 signed URL)
            if (method === 'extendai') {
                return await this.extractWithExtendAI(filename, s3Key, options, selectedPages);
            }

            // Default: PaddleOCR (extract-paddle)
            if (method === 'paddleocr') {
                return await this.extractWithPaddleOCR(filePath, filename, options, selectedPages);
            }

            throw new Error(`Unknown extraction method: ${method}`);

        } catch (error) {
            console.error(`❌ Extraction error with ${method}:`, error.message);
            return {
                success: false,
                error: error.message,
                method: method
            };
        }
    }

    /**
     * Extract text using PaddleOCR Flask service
     * @param {string} filePath - Path to the PDF/image file
     * @param {string} filename - Original filename
     * @param {Object} options - Extraction options
     * @param {number[]} selectedPages - Optional array of page numbers to extract (1-indexed)
     * @returns {Promise<Object>} Extraction result
     */
    async extractWithPaddleOCR(filePath, filename, options = {}, selectedPages = null) {
        try {
            const FormData = (await import('form-data')).default;
            const formData = new FormData();
            formData.append("file", fs.createReadStream(filePath), {
                filename: filename,
                contentType: filename.endsWith('.pdf') ? "application/pdf" : "image/*",
            });

            // Add selected_pages if provided
            if (selectedPages && Array.isArray(selectedPages) && selectedPages.length > 0) {
                formData.append("selected_pages", JSON.stringify(selectedPages));
                console.log(`📄 Extracting selected pages: ${selectedPages.join(', ')}`);
            }

            console.log(`🌐 Calling PaddleOCR Flask service: ${this.paddleocrFlaskUrl}/extract`);
            const response = await axios.post(`${this.paddleocrFlaskUrl}/extract`, formData, {
                headers: {
                    ...formData.getHeaders(),
                },
                timeout: 2 * 1200000, // 40 minutes timeout for large files
            });

            // PaddleOCR Flask service returns storage_data with raw_response field
            const storageData = response.data;

            // Extract raw PaddleOCR response (unconverted) from Flask response
            const rawPaddleOCRResponse = storageData.raw_response || null;

            // Remove raw_response from storageData before conversion to avoid conflicts
            const { raw_response, ...storageDataForConversion } = storageData;

            const converted = this.convertPaddleOCRToStandardFormat(storageDataForConversion, filename);

            // Store the completely raw, unconverted PaddleOCR API response
            converted.raw_data = rawPaddleOCRResponse;

            console.log(`✅ PaddleOCR extraction completed: ${converted.pages.length} pages, ${converted.tables.length} tables`);

            return converted;

        } catch (error) {
            console.error(`❌ PaddleOCR extraction error:`, error.message);
            return {
                success: false,
                error: error.message,
                method: 'paddleocr'
            };
        }
    }

    /**
     * Convert PaddleOCR storage_data format to standard extraction format
     * @param {Object} storageData - PaddleOCR storage_data response
     * @param {string} filename - Original filename
     * @returns {Object} Standard extraction result format
     */
    convertPaddleOCRToStandardFormat(storageData, filename) {
        const pages = storageData.pages || [];
        const extractionMetadata = storageData.extractionMetadata || {};

        // Combine markdown from all pages
        const markdownParts = [];
        const textParts = [];
        const tables = [];
        const structuredPages = [];

        pages.forEach((page, index) => {
            const pageIndex = page.pageIndex || index;
            const pageMarkdown = page.markdown || {};
            const markdownText = pageMarkdown.text || "";

            markdownParts.push(markdownText);
            textParts.push(markdownText || "");

            // Extract tables from source blocks
            const sourceBlocks = page.sourceBlocks || [];
            sourceBlocks.forEach((block) => {
                const blockLabel = (block.blockLabel || "").toLowerCase();
                if (blockLabel === "table") {
                    let tableContent = block.blockContent || "";
                    if (tableContent.trim()) {
                        // Replace escaped double quotes with single quotes in table content
                        tableContent = tableContent.replace(/\\"/g, "'");

                        tables.push({
                            table_id: tables.length + 1,
                            page: pageIndex + 1, // 1-indexed
                            data: tableContent,
                            bbox: block.blockBbox || [],
                            block_id: block.blockId,
                        });
                    }
                }
            });

            // Build structured page data
            structuredPages.push({
                page_number: pageIndex + 1,
                text: markdownText,
                markdown: markdownText,
                source_blocks: sourceBlocks,
                layout_boxes: page.layoutBoxes || [],
                output_images: page.outputImages || [],
                height: page.pageHeight || 0,
                width: page.pageWidth || 0,
            });
        });

        const fullMarkdown = markdownParts.join("\n\n");
        const fullText = textParts.join("\n\n");

        // Generate OpenAI feed markdown (blocked and unblocked)
        const blockedMarkdown = this.generateOpenAIFeedMarkdown(storageData, true);
        const unblockedMarkdown = this.generateOpenAIFeedMarkdown(storageData, false);

        const extractionTimeSeconds = extractionMetadata.extractionTimeSeconds || extractionMetadata.extraction_time_seconds || 0;

        return {
            success: true,
            text: fullText,
            tables: tables,
            markdown: fullMarkdown,
            pages: structuredPages,
            openai_feed: {
                blocked: blockedMarkdown,
                unblocked: unblockedMarkdown,
            },
            method: 'paddleocr',
            extraction_time_seconds: extractionTimeSeconds,
            extractionTimeSeconds: extractionTimeSeconds, // Also include camelCase version
            metadata: {
                extraction_method: 'paddleocr',
                extraction_time_seconds: extractionTimeSeconds,
                total_pages: pages.length,
                total_tables: tables.length,
                text_length: fullText.length,
                markdown_length: fullMarkdown.length,
                openai_feed_blocked_length: blockedMarkdown.length,
                openai_feed_unblocked_length: unblockedMarkdown.length,
                document_id: storageData.documentId || filename,
                logId: extractionMetadata.logId || null,
                timestamp: extractionMetadata.timestamp || null,
                fileType: extractionMetadata.fileType || null,
            }
        };
    }

    /**
     * Format block content based on its label using markdown syntax
     * @param {string} content - Block text content
     * @param {string} blockLabel - Block label/type (e.g., "header", "footer", "doc_title")
     * @returns {string} Formatted markdown string
     */
    formatBlockContentByLabel(content, blockLabel) {
        if (!content) {
            return "";
        }

        const labelLower = (blockLabel || "").toLowerCase();

        // Apply markdown formatting based on label
        if (labelLower === "doc_title") {
            // Document title - use h1
            return `# ${content}`;
        } else if (labelLower === "header") {
            // Header - use h2
            return `## ${content}`;
        } else if (labelLower === "paragraph_title") {
            // Paragraph/section title - use h3
            return `### ${content}`;
        } else if (labelLower === "figure_title") {
            // Figure caption - use h4
            return `#### ${content}`;
        } else if (labelLower === "footer") {
            // Footer - use italic
            return `*${content}*`;
        } else if (labelLower === "vision_footnote") {
            // Footnote - use smaller text
            return `<small>${content}</small>`;
        } else if (labelLower === "table") {
            // Table - content is already converted to markdown
            return content;
        } else if (labelLower === "number") {
            // Numbers - often formatting or emphasis
            return `**${content}**`;
        } else {
            // Default: "text" or unknown - return as plain text
            return content;
        }
    }

    /**
     * Generate OpenAI feed markdown from storage_data
     * @param {Object} storageData - PaddleOCR storage_data response
     * @param {boolean} blocked - If true, include [BLOCK: id] markers and page headers
     * @returns {string} Formatted markdown string for OpenAI
     */
    generateOpenAIFeedMarkdown(storageData, blocked = false) {
        const pages = storageData.pages || [];
        const lines = [];

        pages.forEach((page) => {
            const pageIndex = page.pageIndex || 0;
            const sourceBlocks = page.sourceBlocks || [];

            if (blocked) {
                // Page header (display page number starting from 1)
                lines.push(`=== PAGE ${pageIndex + 1} ===\n`);
            }

            // Add each block with content
            sourceBlocks.forEach((block) => {
                const blockId = block.blockId || "";
                const blockContent = (block.blockContent || "").trim();
                const blockLabel = block.blockLabel || "";

                if (!blockContent) {
                    return;
                }

                // Block identifier
                if (blocked) {
                    lines.push(`[BLOCK: ${blockId}]\n`);
                }

                // Format content based on block label
                const formattedContent = this.formatBlockContentByLabel(
                    blockContent,
                    blockLabel
                );
                lines.push(formattedContent);

                // Empty line between blocks for readability
                lines.push("");
            });
        });

        return lines.join("\n");
    }

    /**
     * Extract text using ExtendAI with fallback to paddleocr (handled by caller)
     * @param {string} filename - Original filename
     * @param {string} s3Key - S3 key of the file
     * @param {Object} options - Extraction options
     * @param {number[]} selectedPages - Optional array of page numbers to extract (1-indexed)
     * @returns {Promise<Object>} Extraction result
     */
    async extractWithExtendAI(filename, s3Key, options = {}, selectedPages = null) {
        // Try ExtendAI first
        try {
            if (!s3Key || !this.s3Service) {
                throw new Error('S3 key and S3Service required for ExtendAI extraction');
            }

            if (!this.extendAIService.isConfigured()) {
                console.warn('⚠️ ExtendAI not configured, caller should fall back to paddleocr');
                throw new Error('ExtendAI not configured');
            }

            let finalS3Key = s3Key;
            let tempS3Key = null;

            // If selectedPages is provided, filter the PDF first
            if (selectedPages && Array.isArray(selectedPages) && selectedPages.length > 0) {
                console.log(`📄 Filtering PDF to selected pages: ${selectedPages.join(', ')}`);

                try {
                    // Download original PDF from S3
                    const pdfBuffer = await this.s3Service.downloadFile(s3Key);

                    // Extract only selected pages
                    const filteredPdfBuffer = await extractPagesFromPdf(pdfBuffer, selectedPages);
                    console.log(`✅ Extracted ${selectedPages.length} pages into filtered PDF (${filteredPdfBuffer.length} bytes)`);

                    // Upload filtered PDF to S3 temporarily
                    const timestamp = Date.now();
                    const random = Math.random().toString(36).substring(2);
                    const ext = path.extname(filename);
                    const baseName = path.basename(filename, ext);
                    const tempFilename = `${baseName}_filtered_${timestamp}_${random}${ext}`;
                    tempS3Key = `temp/${tempFilename}`;

                    const uploadCommand = new PutObjectCommand({
                        Bucket: this.s3Service.bucketName,
                        Key: tempS3Key,
                        Body: filteredPdfBuffer,
                        ContentType: 'application/pdf',
                        Metadata: {
                            originalS3Key: s3Key,
                            selectedPages: selectedPages.join(','),
                            extractedAt: new Date().toISOString()
                        }
                    });

                    await this.s3Service.s3Client.send(uploadCommand);
                    console.log(`✅ Filtered PDF uploaded to S3: ${tempS3Key}`);

                    // Use filtered PDF for ExtendAI
                    finalS3Key = tempS3Key;
                } catch (filterError) {
                    console.error(`❌ Error filtering PDF pages: ${filterError.message}`);
                    throw new Error(`Failed to filter PDF pages: ${filterError.message}`);
                }
            }

            console.log(`🚀 Attempting ExtendAI extraction for ${filename}${selectedPages ? ` (filtered to ${selectedPages.length} pages)` : ''}`);

            // Generate signed URL and extract with ExtendAI
            const result = await this.extendAIService.extractFromS3(
                finalS3Key,
                filename,
                (key, expiresIn) => this.s3Service.generateSignedUrl(key, expiresIn),
                { returnOcrWords: options.returnOcrWords === true }
            );

            // Clean up temporary filtered PDF if it was created
            if (tempS3Key) {
                try {
                    await this.s3Service.deleteFile(tempS3Key);
                    console.log(`🗑️ Cleaned up temporary filtered PDF: ${tempS3Key}`);
                } catch (cleanupError) {
                    console.warn(`⚠️ Failed to clean up temporary PDF ${tempS3Key}: ${cleanupError.message}`);
                }
            }

            console.log(`✅ ExtendAI extraction successful for ${filename}`);
            return result;

        } catch (extendAIError) {
            // Clean up temporary filtered PDF if it was created (even on error)
            if (tempS3Key) {
                try {
                    await this.s3Service.deleteFile(tempS3Key);
                    console.log(`🗑️ Cleaned up temporary filtered PDF after error: ${tempS3Key}`);
                } catch (cleanupError) {
                    console.warn(`⚠️ Failed to clean up temporary PDF ${tempS3Key}: ${cleanupError.message}`);
                }
            }

            console.warn(`⚠️ ExtendAI extraction failed: ${extendAIError.message}`);
            console.log(`🔄 ExtendAI failed; caller may fall back to paddleocr for ${filename}`);

            return {
                success: false,
                error: `ExtendAI failed: ${extendAIError.message}. Caller may retry with paddleocr.`,
                method: 'extendai',
                fallback_available: true,
                fallback_method: 'paddleocr'
            };
        }
    }

    /**
     * Extract text for a specific subset of original PDF pages, from S3.
     *
     * Used when a reviewer assigns previously-skipped pages to a section and
     * their text was never stored (only `selected_pages` were extracted at
     * ingest). Uses the file's original extraction method so the new text
     * matches the existing pages:
     *   - extendai  → S3-native; filters the PDF to `pages` server-side.
     *   - paddleocr → needs a local file, so the original PDF is downloaded
     *                 from S3 to a temp file, extracted, then cleaned up.
     *
     * The returned result follows the standard shape; its `pages` are numbered
     * 1..k matching the order of `pages` passed in.
     *
     * @param {string} filename
     * @param {string} s3Key
     * @param {string} method - 'extendai' | 'paddleocr'
     * @param {Object} options
     * @param {number[]} pages - original PDF page numbers to extract
     * @returns {Promise<Object>} Extraction result
     */
    async extractScopedText(filename, s3Key, method = DEFAULT_EXTRACTION_METHOD, options = {}, pages = []) {
        if (method === 'extendai') {
            const r = await this.extractWithExtendAI(filename, s3Key, options, pages);
            if (r.success) return r;
            console.warn(`⚠️ ExtendAI scoped extract failed (${r.error}); falling back to paddleocr`);
            method = 'paddleocr';
        }

        // Non-extendai methods need a local file path — download the original
        // PDF from S3 to a temp file, extract, then always clean up.
        if (!this.s3Service || typeof this.s3Service.downloadFile !== 'function') {
            return { success: false, error: 'No S3 service available to download PDF for scoped extraction', method };
        }
        let tmpPath = null;
        try {
            const buffer = await this.s3Service.downloadFile(s3Key);
            tmpPath = path.join(os.tmpdir(), `scoped-${randomUUID()}.pdf`);
            await fs.promises.writeFile(tmpPath, buffer);
            return await this.extractText(tmpPath, filename, method, options, s3Key, pages);
        } catch (error) {
            return { success: false, error: `Scoped extraction failed: ${error.message}`, method };
        } finally {
            if (tmpPath) {
                try { await fs.promises.unlink(tmpPath); } catch { /* best-effort */ }
            }
        }
    }

    /**
     * Extract with fallback: try extendai, fallback to paddleocr
     * @param {string} filePath - Path to local file (for paddleocr fallback)
     * @param {string} filename - Original filename
     * @param {string} s3Key - S3 key (for extendai)
     * @param {Object} options - Extraction options
     * @returns {Promise<Object>} Extraction result
     */
    async extractWithFallback(filePath, filename, s3Key, options = {}) {
        // Try ExtendAI first
        const extendAIResult = await this.extractWithExtendAI(filename, s3Key, options);

        if (extendAIResult.success) {
            return extendAIResult;
        }

        console.log(`📄 Falling back to paddleocr extraction for ${filename}`);
        return await this.extractText(filePath, filename, 'paddleocr', options);
    }

    /**
     * Get available extraction methods
     * @returns {Array<string>} List of available methods
     */
    getAvailableMethods() {
        const methods = ['paddleocr'];
        if (this.extendAIService.isConfigured()) {
            methods.push('extendai');
        }
        return methods;
    }

    /**
     * Get default options for a specific method
     * @param {string} method - Extraction method
     * @returns {Object} Default options for the method
     */
    getDefaultOptions(method) {
        const defaultOptions = {
            extendai: {
                extractTables: true,
                extractImages: false
            },
            paddleocr: {
                extractTables: true,
                extractImages: false
            }
        };

        return defaultOptions[method] || {};
    }
}

export default ExtractionService;
