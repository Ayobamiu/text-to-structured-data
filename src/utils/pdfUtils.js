import fs from 'fs/promises';

export async function getPdfPageCount(filePath) {
    if (!filePath) {
        return null;
    }

    try {
        // Use dynamic import to avoid pdf-parse loading test files at module initialization
        const pdfParse = (await import('pdf-parse')).default;
        const data = await fs.readFile(filePath);
        const pdfData = await pdfParse(data);
        if (typeof pdfData?.numpages === 'number' && Number.isFinite(pdfData.numpages)) {
            return pdfData.numpages;
        }
        return null;
    } catch (error) {
        console.warn(`⚠️ Failed to compute PDF page count for ${filePath}:`, error.message);
        return null;
    }
}

