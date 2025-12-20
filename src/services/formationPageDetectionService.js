import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

/**
 * Normalize text by fixing common OCR errors
 * @param {string} text - Text to normalize
 * @returns {string} - Normalized text
 */
function normalizeOCRText(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }

    // Common OCR character substitutions
    const ocrReplacements = {
        // Common digit/letter confusions
        '!': 'I',      // ! -> I (FORMAT!ON -> FORMATION)
        '0': 'O',      // 0 -> O (F0RMATION -> FORMATION)
        '1': 'I',      // 1 -> I (F1RMATION -> FORMATION)
        '5': 'S',      // 5 -> S
        '@': 'A',      // @ -> A
        '$': 'S',      // $ -> S
        '%': 'P',      // % -> P
        '&': 'E',      // & -> E
        '*': 'X',      // * -> X
        '+': 'T',      // + -> T
        '=': 'E',      // = -> E
        '?': 'P',      // ? -> P
        '^': 'A',      // ^ -> A
        '_': '',       // _ -> (remove)
        '|': 'I',      // | -> I
        '~': '-',      // ~ -> -
        '`': "'",      // ` -> '
        // Common letter confusions
        'Ø': 'O',      // Ø -> O
        'ø': 'o',
        'Ø': 'O',
        'Ø': 'O',
    };

    let normalized = text;
    for (const [wrong, correct] of Object.entries(ocrReplacements)) {
        normalized = normalized.replace(new RegExp(wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), correct);
    }

    return normalized;
}

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} - Edit distance
 */
function levenshteinDistance(str1, str2) {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = [];

    // Initialize matrix
    for (let i = 0; i <= len1; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
        matrix[0][j] = j;
    }

    // Fill matrix
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,     // deletion
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j - 1] + 1 // substitution
                );
            }
        }
    }

    return matrix[len1][len2];
}

/**
 * Fuzzy match - check if target string appears in text with OCR errors
 * OPTIMIZED: Uses early exit and limits expensive Levenshtein calculations
 * @param {string} text - Text to search in
 * @param {string} target - Target string to find
 * @param {number} maxDistance - Maximum allowed edit distance (default: 2)
 * @returns {boolean} - True if match found within distance
 */
function fuzzyMatch(text, target, maxDistance = 2) {
    if (!text || !target) return false;

    const textUpper = text.toUpperCase();
    const targetUpper = target.toUpperCase();
    const targetLen = targetUpper.length;

    // Fast path: Check for exact match first (most common case)
    if (textUpper.includes(targetUpper)) {
        return true;
    }

    // For multi-word targets like "FORMATION RECORD", check words separately first
    // This is much faster than sliding window on the full phrase
    if (targetUpper.includes(' ')) {
        const words = targetUpper.split(/\s+/);
        // Quick check: if all words appear (exact or close), likely a match
        const wordMatches = words.map(word => {
            if (word.length < 3) return true; // Skip very short words

            // Fast exact match check
            if (textUpper.includes(word)) return true;

            // Only do fuzzy match if exact match fails (expensive operation)
            // Limit to checking around likely positions to reduce computation
            const wordIndex = textUpper.indexOf(word.substring(0, Math.min(3, word.length)));
            if (wordIndex !== -1) {
                // Check a small window around the found position
                const start = Math.max(0, wordIndex - 2);
                const end = Math.min(textUpper.length, wordIndex + word.length + 2);
                const window = textUpper.substring(start, end);

                // Check if word appears in this window with fuzzy matching
                for (let i = 0; i <= window.length - word.length; i++) {
                    const sub = window.substring(i, i + word.length);
                    if (levenshteinDistance(sub, word) <= maxDistance) {
                        return true;
                    }
                }
            }
            return false;
        });

        return wordMatches.every(matched => matched);
    }

    // Single word: Use optimized sliding window with early exit
    // Only check every N characters to reduce computation (skip some positions)
    const step = Math.max(1, Math.floor(targetLen / 3)); // Check every 1/3 of target length
    for (let i = 0; i <= textUpper.length - targetLen; i += step) {
        const substring = textUpper.substring(i, i + targetLen);

        // Quick character difference check before expensive Levenshtein
        let charDiff = 0;
        for (let j = 0; j < Math.min(substring.length, targetUpper.length); j++) {
            if (substring[j] !== targetUpper[j]) charDiff++;
            if (charDiff > maxDistance) break; // Early exit
        }

        // Only do full Levenshtein if character diff is promising
        if (charDiff <= maxDistance) {
            const distance = levenshteinDistance(substring, targetUpper);
            if (distance <= maxDistance) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Heuristic scoring function to detect pages with formation data
 * Converted from Python implementation with OCR error handling
 * @param {string} text - Markdown text from a page
 * @returns {number} - Score indicating likelihood of formation data
 */
export function heuristicScoreFromMarkdown(text) {
    if (!text || typeof text !== 'string') {
        return 0;
    }

    const t = text.toUpperCase();
    // Only normalize if we need to (lazy evaluation for performance)
    let normalized = null;
    const getNormalized = () => {
        if (normalized === null) {
            normalized = normalizeOCRText(t);
        }
        return normalized;
    };

    let score = 0;

    // Strong headers - use fuzzy matching for "FORMATION RECORD"
    // Check original first (fast path), then normalized if needed
    if (fuzzyMatch(t, 'FORMATION RECORD', 2)) {
        score += 6;
    } else {
        // Only check normalized if original didn't match
        const norm = getNormalized();
        if (fuzzyMatch(norm, 'FORMATION RECORD', 1)) {
            score += 6;
        }
    }

    // Also check for "FORMATION" alone - use exact match first (faster)
    if (t.includes('FORMATION')) {
        score += 3;
    } else {
        // Only do fuzzy match if exact match fails
        if (fuzzyMatch(t, 'FORMATION', 1)) {
            score += 3;
        } else {
            const norm = getNormalized();
            if (norm.includes('FORMATION') || fuzzyMatch(norm, 'FORMATION', 1)) {
                score += 3;
            }
        }
    }

    // Table indicators - use fast exact match first
    const hasFrom = t.includes('FROM');
    const hasTo = t.includes('TO');
    if (hasFrom && hasTo) {
        score += 4;
    } else {
        // Only check normalized if needed
        const norm = getNormalized();
        if ((hasFrom || norm.includes('FROM')) && (hasTo || norm.includes('TO'))) {
            score += 4;
        }
    }

    // if (t.includes('DEPTH')) {
    //     score += 2;
    // } else {
    //     const norm = getNormalized();
    //     if (norm.includes('DEPTH')) {
    //         score += 2;
    //     }
    // }

    // Geology vocabulary - use exact match first, fuzzy only if needed
    const formations = [
        'TRAVERSE', 'DUNDEE', 'DETROIT', 'SALINA',
        'UTICA', 'TRENTON', 'BASS', 'NIAGARA'
    ];
    formations.forEach(f => {
        // Fast path: exact match
        if (t.includes(f)) {
            score += 2;
        } else {
            // Only do expensive fuzzy match if exact match fails
            if (fuzzyMatch(t, f, 1)) {
                score += 2;
            } else {
                const norm = getNormalized();
                if (norm.includes(f) || fuzzyMatch(norm, f, 1)) {
                    score += 2;
                }
            }
        }
    });

    // Numeric density
    const numbers = text.match(/\d+/g) || [];
    if (numbers.length > 25) {
        score += 3;
    }
    if (numbers.length > 50) {
        score += 5;
    }

    // Markdown corruption penalty
    const hasLongNumbers = numbers.some(n => n.length >= 6);
    if (hasLongNumbers) {
        score -= 1;
    }

    return score;
}

/**
 * Classify page based on score
 * @param {number} score - Heuristic score
 * @returns {string} - Classification: 'CONFIDENT_HIT', 'CONFIDENT_MISS', or 'BORDERLINE'
 */
export function classifyPage(score) {
    if (score >= 10) {
        return 'CONFIDENT_HIT';
    } else if (score <= 3) {
        return 'CONFIDENT_MISS';
    } else {
        return 'BORDERLINE';
    }
}

/**
 * Score all pages and identify pages with formation data
 * @param {Array} pages - Array of page objects with {page_number, text}
 * @returns {Object} - Object with scored pages and confident hits
 */
export function scorePages(pages) {
    if (!Array.isArray(pages) || pages.length === 0) {
        return {
            scoredPages: [],
            confidentHits: [],
            confidentMisses: [],
            borderlines: []
        };
    }

    const scoredPages = pages.map(page => {
        const text = page.text || '';
        const score = heuristicScoreFromMarkdown(text);
        const classification = classifyPage(score);

        return {
            page_number: page.page_number,
            score,
            classification,
            text_length: text.length
        };
    });

    const confidentHits = scoredPages
        .filter(p => p.classification === 'CONFIDENT_HIT')
        .map(p => p.page_number)
        .sort((a, b) => a - b);

    const confidentMisses = scoredPages
        .filter(p => p.classification === 'CONFIDENT_MISS')
        .map(p => p.page_number)
        .sort((a, b) => a - b);

    const borderlines = scoredPages
        .filter(p => p.classification === 'BORDERLINE')
        .map(p => p.page_number)
        .sort((a, b) => a - b);

    return {
        scoredPages,
        confidentHits,
        confidentMisses,
        borderlines,
        summary: {
            total: pages.length,
            confidentHits: confidentHits.length,
            confidentMisses: confidentMisses.length,
            borderlines: borderlines.length
        }
    };
}

/**
 * Extract specific pages from a PDF and create a new PDF
 * @param {Buffer} pdfBuffer - Original PDF file buffer
 * @param {Array<number>} pageNumbers - Array of page numbers to extract (1-indexed)
 * @returns {Promise<Buffer>} - New PDF buffer with extracted pages
 */
export async function extractPagesFromPdf(pdfBuffer, pageNumbers) {
    try {
        // Load the original PDF
        const sourcePdf = await PDFDocument.load(pdfBuffer);
        const totalPages = sourcePdf.getPageCount();

        // Validate page numbers
        const validPageNumbers = pageNumbers
            .filter(num => num >= 1 && num <= totalPages)
            .sort((a, b) => a - b);

        if (validPageNumbers.length === 0) {
            throw new Error('No valid page numbers provided');
        }

        // Create a new PDF
        const newPdf = await PDFDocument.create();

        // Copy pages from source to new PDF
        const copiedPages = await newPdf.copyPages(sourcePdf, validPageNumbers.map(num => num - 1));

        copiedPages.forEach((page) => {
            newPdf.addPage(page);
        });

        // Serialize the PDF to bytes
        const pdfBytes = await newPdf.save();
        return Buffer.from(pdfBytes);
    } catch (error) {
        console.error('❌ Error extracting pages from PDF:', error.message);
        throw error;
    }
}

/**
 * Get PDF file buffer from storage (S3 or local)
 * @param {string} fileId - File ID
 * @param {string} s3Key - S3 key if file is in S3
 * @param {string} storageType - Storage type ('s3' or 'local')
 * @param {string} localFilePath - Local file path (if storageType is 'local')
 * @returns {Promise<Buffer>} - PDF file buffer
 */
async function getPdfBuffer(fileId, s3Key, storageType, localFilePath = null) {
    if (storageType === 's3' && s3Key) {
        // Download from S3
        const s3Client = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });
        const bucketName = process.env.S3_BUCKET_NAME || 'document-extractor-files';

        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: s3Key
        });

        const response = await s3Client.send(command);
        const chunks = [];
        for await (const chunk of response.Body) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    } else if (storageType === 'local' && localFilePath) {
        // Read from local storage
        if (!fs.existsSync(localFilePath)) {
            throw new Error(`Local file not found: ${localFilePath}`);
        }
        return fs.readFileSync(localFilePath);
    } else {
        throw new Error(`Cannot access file: storageType=${storageType}, s3Key=${s3Key}, localFilePath=${localFilePath}`);
    }
}

/**
 * Calculate file hash
 */
function calculateFileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Main function to detect formation pages and extract them into a new PDF
 * @param {Object} fileInfo - File information from database
 * @param {Array} pages - Pages array with markdown text
 * @param {string} localFilePath - Optional local file path if storageType is 'local'
 * @returns {Promise<Object>} - Result with extracted PDF info and page scores
 */
export async function detectAndExtractFormationPages(fileInfo, pages, localFilePath = null) {
    try {
        console.log(`🔍 Starting formation page detection for file ${fileInfo.id}`);

        // Score all pages
        const scoringResult = scorePages(pages);
        console.log(`📊 Page scoring complete:`, scoringResult.summary);

        // If no confident hits, return early
        if (scoringResult.confidentHits.length === 0) {
            console.log(`⚠️ No confident formation pages found for file ${fileInfo.id}`);
            return {
                success: false,
                message: 'No confident formation pages found',
                scoringResult
            };
        }

        console.log(`✅ Found ${scoringResult.confidentHits.length} confident formation pages: ${scoringResult.confidentHits.join(', ')}`);

        // Get original PDF buffer
        const pdfBuffer = await getPdfBuffer(
            fileInfo.id,
            fileInfo.s3_key,
            fileInfo.storage_type,
            localFilePath
        );

        // Extract pages
        const extractedPdfBuffer = await extractPagesFromPdf(pdfBuffer, scoringResult.confidentHits);
        console.log(`✅ Extracted ${scoringResult.confidentHits.length} pages into new PDF (${extractedPdfBuffer.length} bytes)`);

        // Generate filename for extracted PDF
        const originalName = path.parse(fileInfo.filename).name;
        const extractedFilename = `${originalName}_formations_${scoringResult.confidentHits.join('-')}.pdf`;

        // Upload extracted PDF to S3 or save locally
        let extractedS3Key = null;
        let extractedStorageType = fileInfo.storage_type;
        let extractedFileHash = null;

        const cloudStorageEnabled = process.env.CLOUD_STORAGE_ENABLED === 'true';
        if (cloudStorageEnabled) {
            try {
                // Upload to S3
                // Generate unique filename
                const timestamp = Date.now();
                const random = Math.random().toString(36).substring(2);
                const ext = path.extname(extractedFilename);
                const baseName = path.basename(extractedFilename, ext);
                const uniqueFilename = `${baseName}_${timestamp}_${random}${ext}`;
                const key = `jobs/${fileInfo.job_id}/extracted/${uniqueFilename}`;

                const s3Client = new S3Client({
                    region: process.env.AWS_REGION || 'us-east-1',
                    credentials: {
                        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                    },
                });
                const bucketName = process.env.S3_BUCKET_NAME || 'document-extractor-files';

                const uploadCommand = new PutObjectCommand({
                    Bucket: bucketName,
                    Key: key,
                    Body: extractedPdfBuffer,
                    ContentType: 'application/pdf',
                    Metadata: {
                        originalFileId: fileInfo.id,
                        extractedPages: scoringResult.confidentHits.join(','),
                        extractedAt: new Date().toISOString()
                    }
                });

                await s3Client.send(uploadCommand);
                extractedS3Key = key;
                extractedFileHash = calculateFileHash(extractedPdfBuffer);
                console.log(`✅ Extracted PDF uploaded to S3: ${key}`);
            } catch (s3Error) {
                console.warn(`⚠️ S3 upload failed, saving locally: ${s3Error.message}`);
                extractedStorageType = 'local';

                // Save locally in uploads/extracted directory
                const uploadsDir = path.join(process.cwd(), 'uploads', 'extracted');
                if (!fs.existsSync(uploadsDir)) {
                    fs.mkdirSync(uploadsDir, { recursive: true });
                }

                const localFilePath = path.join(uploadsDir, extractedFilename);
                fs.writeFileSync(localFilePath, extractedPdfBuffer);
                extractedFileHash = calculateFileHash(extractedPdfBuffer);
                console.log(`✅ Extracted PDF saved locally: ${localFilePath}`);
            }
        } else {
            // Save locally
            const uploadsDir = path.join(process.cwd(), 'uploads', 'extracted');
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }

            const localFilePath = path.join(uploadsDir, extractedFilename);
            fs.writeFileSync(localFilePath, extractedPdfBuffer);
            extractedFileHash = calculateFileHash(extractedPdfBuffer);
            console.log(`✅ Extracted PDF saved locally: ${localFilePath}`);
        }

        return {
            success: true,
            extractedPdf: {
                filename: extractedFilename,
                s3_key: extractedS3Key,
                storage_type: extractedStorageType,
                file_hash: extractedFileHash,
                size: extractedPdfBuffer.length,
                page_count: scoringResult.confidentHits.length,
                extracted_pages: scoringResult.confidentHits
            },
            scoringResult,
            metadata: {
                total_pages: pages.length,
                extracted_pages: scoringResult.confidentHits,
                borderlines: scoringResult.borderlines,
                confident_misses: scoringResult.confidentMisses,
                extraction_timestamp: new Date().toISOString()
            }
        };
    } catch (error) {
        console.error(`❌ Error in formation page detection/extraction: ${error.message}`);
        return {
            success: false,
            error: error.message,
            scoringResult: null
        };
    }
}

