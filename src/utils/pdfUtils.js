import fs from 'fs/promises';
import { existsSync } from 'fs';

// Use pdfjs-dist instead of pdf-parse to avoid test file loading issues
// pdf-parse has a known bug where it tries to read test files during module initialization
let pdfjsLib = null;

async function getPdfJs() {
    if (!pdfjsLib) {
        try {
            // Use legacy build for Node.js environments
            pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        } catch (error) {
            throw new Error(`Failed to import pdfjs-dist: ${error.message}`);
        }
    }
    return pdfjsLib;
}

export async function getPdfPageCount(filePath) {
    if (!filePath) {
        console.warn('⚠️ getPdfPageCount: filePath is null or undefined');
        return null;
    }

    try {
        // Check if file exists
        if (!existsSync(filePath)) {
            console.warn(`⚠️ getPdfPageCount: File does not exist at path: ${filePath}`);
            return null;
        }

        // Get pdfjs-dist module (lazy loaded)
        const pdfjs = await getPdfJs();

        // Read file
        const fileBuffer = await fs.readFile(filePath);
        if (!fileBuffer || fileBuffer.length === 0) {
            console.warn(`⚠️ getPdfPageCount: File is empty at path: ${filePath}`);
            return null;
        }

        // Convert Buffer to Uint8Array (required by pdfjs-dist)
        const data = new Uint8Array(fileBuffer);

        // Get getDocument function from pdfjs-dist
        const getDocument = pdfjs.getDocument || (pdfjs.default && pdfjs.default.getDocument) || pdfjs.default;

        if (!getDocument) {
            throw new Error('getDocument not found in pdfjs-dist module');
        }

        // Parse PDF using pdfjs-dist
        const doc = await getDocument({ data }).promise;
        const numPages = doc.numPages;

        // Check if numPages is valid
        if (typeof numPages === 'number' && Number.isFinite(numPages) && numPages > 0) {
            console.log(`✅ getPdfPageCount: Successfully determined page count: ${numPages} for ${filePath}`);
            return numPages;
        } else {
            console.warn(`⚠️ getPdfPageCount: Invalid numPages value: ${numPages} (type: ${typeof numPages}) for ${filePath}`);
            return null;
        }
    } catch (error) {
        console.error(`❌ getPdfPageCount: Error computing PDF page count for ${filePath}:`, {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        return null;
    }
}

