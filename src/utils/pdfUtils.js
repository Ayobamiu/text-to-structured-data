import fs from 'fs/promises';
import { existsSync } from 'fs';
import { PDFDocument } from 'pdf-lib';

/**
 * Read PDF page count using pdf-lib (already a project dependency).
 * Avoids pdfjs-dist Worker setup and the pdf-parse initialization quirks.
 */
export async function getPdfPageCount(filePath) {
    if (!filePath) {
        console.warn('⚠️ getPdfPageCount: filePath is null or undefined');
        return null;
    }

    try {
        if (!existsSync(filePath)) {
            console.warn(`⚠️ getPdfPageCount: File does not exist at path: ${filePath}`);
            return null;
        }

        const fileBuffer = await fs.readFile(filePath);
        if (!fileBuffer || fileBuffer.length === 0) {
            console.warn(`⚠️ getPdfPageCount: File is empty at path: ${filePath}`);
            return null;
        }

        const doc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
        const numPages = doc.getPageCount();

        if (typeof numPages === 'number' && Number.isFinite(numPages) && numPages > 0) {
            console.log(`✅ getPdfPageCount: Successfully determined page count: ${numPages} for ${filePath}`);
            return numPages;
        }

        console.warn(`⚠️ getPdfPageCount: Invalid numPages value: ${numPages} for ${filePath}`);
        return null;
    } catch (error) {
        console.error(`❌ getPdfPageCount: Error computing PDF page count for ${filePath}:`, {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        return null;
    }
}
