/**
 * Data Extraction Page Detection Service
 * 
 * Detects pages containing all data we want to extract:
 * 1. Formation pages (already detected by formation_page_detection)
 * 2. LOG OF OIL, GAS OR TEST WELL pages
 * 3. Well Plugging Record pages
 * 
 * This is a comprehensive detection that combines all relevant page types.
 */

import { heuristicScoreFromMarkdown } from './formationPageDetectionService.js';

// Note: We need to export normalizeOCRText and fuzzyMatch from formationPageDetectionService.js
// For now, we'll duplicate the essential helper functions to avoid circular dependencies

/**
 * Normalize text by fixing common OCR errors
 */
function normalizeOCRText(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }
    const ocrReplacements = {
        '!': 'I', '0': 'O', '1': 'I', '5': 'S', '@': 'A', '$': 'S',
        '%': 'P', '&': 'E', '*': 'X', '+': 'T', '=': 'E', '?': 'P',
        '^': 'A', '_': '', '|': 'I', '~': '-', '`': "'"
    };
    let normalized = text;
    for (const [wrong, correct] of Object.entries(ocrReplacements)) {
        normalized = normalized.replace(new RegExp(wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), correct);
    }
    return normalized;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = [];
    for (let i = 0; i <= len1; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + 1
                );
            }
        }
    }
    return matrix[len1][len2];
}

/**
 * Fuzzy match - check if target string appears in text with OCR errors
 */
function fuzzyMatch(text, target, maxDistance = 2) {
    if (!text || !target) return false;
    const textUpper = text.toUpperCase();
    const targetUpper = target.toUpperCase();
    if (textUpper.includes(targetUpper)) return true;

    // Multi-word targets: check words separately first
    if (targetUpper.includes(' ')) {
        const words = targetUpper.split(/\s+/);
        const wordMatches = words.map(word => {
            if (word.length < 3) return true;
            if (textUpper.includes(word)) return true;
            const wordIndex = textUpper.indexOf(word.substring(0, Math.min(3, word.length)));
            if (wordIndex !== -1) {
                const start = Math.max(0, wordIndex - 2);
                const end = Math.min(textUpper.length, wordIndex + word.length + 2);
                const window = textUpper.substring(start, end);
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

    // Single word: sliding window
    const targetLen = targetUpper.length;
    const step = Math.max(1, Math.floor(targetLen / 3));
    for (let i = 0; i <= textUpper.length - targetLen; i += step) {
        const substring = textUpper.substring(i, i + targetLen);
        let charDiff = 0;
        for (let j = 0; j < Math.min(substring.length, targetUpper.length); j++) {
            if (substring[j] !== targetUpper[j]) charDiff++;
            if (charDiff > maxDistance) break;
        }
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
 * Score page for LOG OF OIL, GAS OR TEST WELL detection
 * @param {string} text - Markdown text from a page
 * @returns {number} - Score indicating likelihood of LOG page
 */
function scoreLogOfOilGasPage(text) {
    if (!text || typeof text !== 'string') {
        return 0;
    }

    const t = text.toUpperCase();
    let normalized = null;
    const getNormalized = () => {
        if (normalized === null) {
            normalized = normalizeOCRText(t);
        }
        return normalized;
    };

    let score = 0;

    // Strong title indicators (highest weight)
    const logTitles = [
        'LOG OF OIL. GAS OR TEST WELL',
        'LOG OF OIL, GAS OR TEST WELL',
        'LOG OF OIL GAS OR TEST WELL',
        'LOG OF OIL',
        'LOG OF GAS'
    ];

    for (const title of logTitles) {
        if (fuzzyMatch(t, title, 2)) {
            score += 8;
            break;
        } else {
            const norm = getNormalized();
            if (fuzzyMatch(norm, title, 1)) {
                score += 8;
                break;
            }
        }
    }

    // Department/State indicators
    const deptPhrases = [
        'STATE OF MICHIGAN DEPARTMENT OF CONSERVATION',
        'MICHIGAN DEPARTMENT OF CONSERVATION',
        'MICHIGAN DEPARTMENT',
        'DEPARTMENT OF CONSERVATION'
    ];

    for (const phrase of deptPhrases) {
        if (fuzzyMatch(t, phrase, 3)) {
            score += 5;
            break;
        }
    }

    // Table headers (very specific to LOG pages)
    const tableHeaders = [
        'WATER ZONES',
        'OIL OR GAS ZONES',
        'OIL AND GAS ZONES',
        'CASING AND CEMENTING',
        'STEEL LINES RUN',
        'PERFORATIONS',
        'ACID OR SHOOTING RECORD',
        'ACID OR SHOTING RECORD', // OCR typo variant
        'DEVIATION SURVEY'
    ];

    let tableHeaderCount = 0;
    for (const header of tableHeaders) {
        if (t.includes(header)) {
            tableHeaderCount++;
            score += 4;
        } else if (fuzzyMatch(t, header, 2)) {
            tableHeaderCount++;
            score += 4;
        } else {
            const norm = getNormalized();
            if (norm.includes(header) || fuzzyMatch(norm, header, 1)) {
                tableHeaderCount++;
                score += 4;
            }
        }
    }

    // Bonus for multiple table headers (strong indicator)
    if (tableHeaderCount >= 3) {
        score += 5;
    }

    // Specific field labels
    const fieldLabels = [
        'PERMIT NO',
        'PERMIT NO.',
        'TOTAL DEPTH',
        'COMPLETED IN',
        'NAME OF PRODUCING FORMATION',
        'PRODUCING FORMATION',
        'TOP OF FORMATION',
        'DATE DRILLING BEGUN',
        'DATE DRILLING COMPLETED',
        'DATE WELL COMPLETED',
        'DRILLING CONTRACTOR'
    ];

    let fieldCount = 0;
    for (const field of fieldLabels) {
        if (t.includes(field)) {
            fieldCount++;
            score += 2;
        } else if (fuzzyMatch(t, field, 2)) {
            fieldCount++;
            score += 2;
        }
    }

    // Bonus for multiple fields
    if (fieldCount >= 4) {
        score += 3;
    }

    // Footer indicator
    if (fuzzyMatch(t, 'MI DNR - GEOLOGICAL SURVEY', 3) ||
        fuzzyMatch(t, 'GEOLOGICAL SURVEY', 2)) {
        score += 3;
    }

    // Table column indicators (FROM, TO, AMOUNT, DATE, NO. HOLES, GAL. ACID)
    const hasFrom = t.includes('FROM');
    const hasTo = t.includes('TO');
    const hasAmount = t.includes('AMOUNT') || t.includes('GAL.') || t.includes('GAL ');
    const hasDate = t.includes('DATE');
    const hasHoles = t.includes('NO. HOLES') || t.includes('NO HOLES');

    if (hasFrom && hasTo) {
        score += 3;
    }
    if (hasAmount) {
        score += 2;
    }
    if (hasDate && (hasFrom || hasTo)) {
        score += 2;
    }
    if (hasHoles) {
        score += 2;
    }

    // Numeric density (LOG pages have lots of depth/measurement numbers)
    const numbers = text.match(/\d+/g) || [];
    if (numbers.length > 30) {
        score += 3;
    }
    if (numbers.length > 50) {
        score += 5;
    }

    return score;
}

/**
 * Score page for Well Plugging Record detection
 * @param {string} text - Markdown text from a page
 * @returns {number} - Score indicating likelihood of Plugging Record page
 */
function scoreWellPluggingRecordPage(text) {
    if (!text || typeof text !== 'string') {
        return 0;
    }

    const t = text.toUpperCase();
    let normalized = null;
    const getNormalized = () => {
        if (normalized === null) {
            normalized = normalizeOCRText(t);
        }
        return normalized;
    };

    let score = 0;

    // Strong title indicators (highest weight)
    const pluggingTitles = [
        'WELL PLUGGING RECORD',
        'MICHIGAN DEPARTMENT OF CONSERVATION WELL PLUGGING RECORD',
        'PLUGGING RECORD'
    ];

    for (const title of pluggingTitles) {
        if (fuzzyMatch(t, title, 2)) {
            score += 8;
            break;
        } else {
            const norm = getNormalized();
            if (fuzzyMatch(norm, title, 1)) {
                score += 8;
                break;
            }
        }
    }

    // Subtitle indicator
    if (fuzzyMatch(t, 'TO BE FILED WITHIN THIRTY DAYS AFTER PLUGGING IS COMPLETED', 5) ||
        fuzzyMatch(t, 'FILED WITHIN THIRTY DAYS', 3)) {
        score += 5;
    }

    // Department indicator
    if (fuzzyMatch(t, 'MICHIGAN DEPARTMENT OF CONSERVATION', 3)) {
        score += 4;
    }

    // CASING table headers (very specific to plugging records)
    const casingTableHeaders = [
        'CASING SIZE',
        'WHERE SET',
        'AMOUNT RECOVERED',
        'SHOT OR RIPPED',
        'BRIDGES OR PLUGS',
        'DEPTH PLACED',
        'NUMBER SACKS'
    ];

    let casingHeaderCount = 0;
    for (const header of casingTableHeaders) {
        if (t.includes(header)) {
            casingHeaderCount++;
            score += 3;
        } else if (fuzzyMatch(t, header, 2)) {
            casingHeaderCount++;
            score += 3;
        }
    }

    // Bonus for multiple casing table headers
    if (casingHeaderCount >= 4) {
        score += 4;
    }

    // Specific field labels
    const fieldLabels = [
        'DATE PLUGGING STARTED',
        'DATE PLUGGING COMPLETED',
        'PERMISSION OF DEPARTMENT',
        'PERMISSION OBTAINED',
        'DESCRIBE IN DETAIL HOW WELL WAS PLUGGED',
        'DESCRIBE HOW WELL WAS PLUGGED',
        'WERE TOOLS, TUBING, CASING',
        'LOST OR LEFT IN THE HOLE',
        'SERVICE COMPANY PUMP',
        'SPOT CEMENT',
        'SET BRIDGE PLUGS',
        'WITNESSED PLUGGING',
        'CERTIFICATE',
        'PLUGGING CONT',
        'PLUGGING CONTRACTOR'
    ];

    let fieldCount = 0;
    for (const field of fieldLabels) {
        if (t.includes(field)) {
            fieldCount++;
            score += 2;
        } else if (fuzzyMatch(t, field, 2)) {
            fieldCount++;
            score += 2;
        }
    }

    // Bonus for multiple fields
    if (fieldCount >= 5) {
        score += 3;
    }

    // Plugging-specific vocabulary
    const pluggingTerms = [
        'BRUSH STONE CEMENT',
        'DUMP BAILER',
        'ROTARY MUD',
        'BRIDGE',
        'CEMENTED',
        'FILLED HOLE',
        'CUT PIPE',
        'BELOW SURFACE'
    ];

    let termCount = 0;
    for (const term of pluggingTerms) {
        if (t.includes(term)) {
            termCount++;
            score += 2;
        } else if (fuzzyMatch(t, term, 2)) {
            termCount++;
            score += 2;
        }
    }

    // Bonus for multiple plugging terms
    if (termCount >= 3) {
        score += 3;
    }

    // Numeric density (plugging records have depth measurements, sack counts, etc.)
    const numbers = text.match(/\d+/g) || [];
    if (numbers.length > 20) {
        score += 2;
    }
    if (numbers.length > 40) {
        score += 4;
    }

    return score;
}

/**
 * Comprehensive scoring function that detects all relevant data extraction pages
 * Combines formation detection + LOG page detection + Plugging Record detection
 * @param {string} text - Markdown text from a page
 * @returns {Object} - Score breakdown and total score
 */
export function scoreDataExtractionPage(text) {
    if (!text || typeof text !== 'string') {
        return {
            totalScore: 0,
            formationScore: 0,
            logPageScore: 0,
            pluggingRecordScore: 0,
            detectedTypes: []
        };
    }

    // Use full formation scoring function (includes depth patterns, expanded vocabulary, etc.)
    const formationScore = heuristicScoreFromMarkdown(text);

    // Score for LOG page
    const logPageScore = scoreLogOfOilGasPage(text);

    // Score for Plugging Record
    const pluggingRecordScore = scoreWellPluggingRecordPage(text);

    // Total score (sum of all detections)
    const totalScore = formationScore + logPageScore + pluggingRecordScore;

    // Determine detected types
    // Thresholds: ChatGPT suggests formation ≥ 7, log ≥ 8, plugging ≥ 8
    // Current thresholds are more conservative (10/12/12) - adjust if needed based on testing
    const detectedTypes = [];
    if (formationScore >= 10) { // ChatGPT suggests ≥ 7, but keeping 10 for now
        detectedTypes.push('FORMATION');
    }
    if (logPageScore >= 12) { // ChatGPT suggests ≥ 8, but keeping 12 for now
        detectedTypes.push('LOG_OF_OIL_GAS');
    }
    if (pluggingRecordScore >= 12) { // ChatGPT suggests ≥ 8, but keeping 12 for now
        detectedTypes.push('PLUGGING_RECORD');
    }

    return {
        totalScore,
        formationScore,
        logPageScore,
        pluggingRecordScore,
        detectedTypes
    };
}

/**
 * Classify page based on comprehensive score
 * @param {Object} scoreResult - Result from scoreDataExtractionPage
 * @returns {string} - Classification: 'CONFIDENT_HIT', 'CONFIDENT_MISS', or 'BORDERLINE'
 */
export function classifyDataExtractionPage(scoreResult) {
    const { totalScore, detectedTypes } = scoreResult;

    // If we detected at least one type with high confidence, it's a hit
    if (detectedTypes.length > 0 && totalScore >= 12) {
        return 'CONFIDENT_HIT';
    }

    // If score is very low, it's a miss
    if (totalScore <= 3) {
        return 'CONFIDENT_MISS';
    }

    // Otherwise borderline
    return 'BORDERLINE';
}

/**
 * Score all pages for data extraction relevance
 * @param {Array} pages - Array of page objects with {page_number, text}
 * @returns {Object} - Object with scored pages and confident hits
 */
export function scoreDataExtractionPages(pages) {
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
        const scoreResult = scoreDataExtractionPage(text);
        const classification = classifyDataExtractionPage(scoreResult);

        return {
            page_number: page.page_number,
            totalScore: scoreResult.totalScore,
            formationScore: scoreResult.formationScore,
            logPageScore: scoreResult.logPageScore,
            pluggingRecordScore: scoreResult.pluggingRecordScore,
            detectedTypes: scoreResult.detectedTypes,
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

