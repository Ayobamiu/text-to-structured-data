/**
 * Server-side constraint computation for job files.
 *
 * Produces a `flags` JSONB array that the list endpoint returns directly,
 * eliminating client-side constraint computation at render time.
 *
 * Each flag is: { name, passed, message, severity, emphasis?, details? }
 *
 * Currently only applies to the MGS Michigan Well job.
 *
 * Supports both V1 flat results and V2 per-section envelopes. For V2,
 * constraints are computed against the first record in the envelope
 * (all records in a single-slug MGS file share the same well metadata).
 */

import { getFirstRecord } from '../utils/resultEnvelope.js';

const MGS_MICHIGAN_WELL_JOB_ID = '5667fe82-63e1-47fa-a640-b182b5c5d034';

/**
 * Extract permit number from result data.
 */
function extractPermitFromData(result) {
    if (!result) return null;
    const fields = [
        'permit_number', 'permitNumber', 'permit_no', 'permitNo',
        'permit', 'permit_id', 'permitId', 'well_permit', 'wellPermit',
        'drilling_permit', 'drillingPermit'
    ];
    for (const field of fields) {
        if (result[field] && typeof result[field] === 'string') {
            const cleaned = result[field].replace(/[^0-9]/g, '');
            if (cleaned.length > 0) return cleaned;
        }
        if (result[field] && typeof result[field] === 'number') {
            return String(result[field]);
        }
    }
    return null;
}

/**
 * Extract permit number from filename.
 */
function extractPermitFromFilename(filename) {
    if (!filename) return null;
    const match = filename.match(/(\d+)/);
    return match ? match[1] : null;
}

/**
 * Check formation continuity (no gaps > threshold between consecutive formations).
 */
function checkFormationContinuity(formations) {
    const sorted = [...formations]
        .filter(f => f.from != null && f.to != null)
        .sort((a, b) => (a.from || 0) - (b.from || 0));

    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
        const prevTo = sorted[i - 1].to;
        const currFrom = sorted[i].from;
        if (prevTo != null && currFrom != null) {
            const gap = currFrom - prevTo;
            if (gap > 1) {
                gaps.push({ from: prevTo, to: currFrom, gap });
            }
        }
    }

    return {
        isContinuous: gaps.length === 0,
        gaps,
        message: gaps.length === 0 ? 'Formations are continuous' : `${gaps.length} gap(s) found`,
    };
}

/**
 * Compute constraint flags for a single file.
 *
 * @param {object} params
 * @param {string} params.jobId
 * @param {string} params.filename
 * @param {string} params.processingStatus
 * @param {object|null} params.result - the AI extraction result
 * @param {object|null} params.processingMetadata - includes mgs_expected_county
 * @returns {Array} flags array (empty if not applicable)
 */
export function computeFlags({ jobId, filename, processingStatus, result, processingMetadata }) {
    const flags = [];

    // Only compute for MGS Michigan Well job + completed files with results
    if (processingStatus !== 'completed' || jobId !== MGS_MICHIGAN_WELL_JOB_ID || !result) {
        return flags;
    }

    // Unwrap V2 envelope → flat record so all field accesses below work.
    // For V1 this is a no-op (returns result as-is).
    const record = getFirstRecord(result);

    // --- 0. County name vs MGS inventory ---
    const extractedCounty = record?.county || null;
    const expectedCounty = processingMetadata?.mgs_expected_county || null;

    if (extractedCounty && expectedCounty) {
        const normalizedExtracted = extractedCounty.trim().toLowerCase();
        const normalizedExpected = expectedCounty.trim().toLowerCase();
        const passed = normalizedExtracted === normalizedExpected;

        flags.push({
            name: 'Wrong County Name',
            passed,
            message: passed
                ? `County matches: ${extractedCounty}`
                : `County mismatch: extracted "${extractedCounty}", expected "${expectedCounty}"`,
            severity: passed ? 'info' : 'critical',
            emphasis: 'county',
            details: { extractedCounty, expectedCounty },
        });
    } else if (extractedCounty && !expectedCounty) {
        flags.push({
            name: 'Wrong County Name',
            passed: true,
            message: `County: ${extractedCounty} (no MGS reference to compare)`,
            severity: 'info',
            emphasis: 'county',
            details: { extractedCounty, expectedCounty: null },
        });
    }

    // --- 1. Permit number mismatch ---
    const dataPermit = extractPermitFromData(record);
    const filenamePermit = extractPermitFromFilename(filename);

    if (filenamePermit && dataPermit) {
        const passed = filenamePermit === dataPermit;
        flags.push({
            name: 'Permit Number Match',
            passed,
            message: passed
                ? 'Permit numbers match'
                : `Permit mismatch: filename "${filenamePermit}", data "${dataPermit}"`,
            severity: passed ? 'info' : 'warning',
            details: { filenamePermit, dataPermit },
        });
    }

    // --- 2. API number ---
    const hasApiNumber = !!record?.api_number;
    flags.push({
        name: 'API Number',
        passed: hasApiNumber,
        message: hasApiNumber
            ? `API number: ${record.api_number}`
            : 'API number not found in extracted data',
        severity: hasApiNumber ? 'info' : 'error',
    });

    // --- 3. Elevation ---
    const elevation = record?.elevation;
    const correctElevation = elevation && elevation > 100;
    flags.push({
        name: 'Elevation',
        passed: !!correctElevation,
        message: correctElevation
            ? `Elevation: ${elevation}`
            : elevation
                ? `Elevation (${elevation}) is too low or missing. Expected > 100`
                : 'Elevation is missing',
        severity: correctElevation ? 'info' : 'error',
        details: { elevation: elevation || null },
    });

    // --- 4. Formation count ---
    const formationCount = record?.formations?.length || 0;
    const correctFormationCount = formationCount >= 10;
    flags.push({
        name: 'Formation Count',
        passed: correctFormationCount,
        message: correctFormationCount
            ? `Formation count: ${formationCount}`
            : `Formation count (${formationCount}) is too low. Expected >= 10`,
        severity: correctFormationCount ? 'info' : 'error',
        details: { count: formationCount },
    });

    // --- 5. Measured depth vs last formation depth ---
    const measuredDepth = record?.measured_depth;
    const formations = record?.formations || [];

    if (measuredDepth != null && formations.length > 0) {
        const sortedFormations = [...formations]
            .filter(f => f.to != null)
            .sort((a, b) => (b.to || 0) - (a.to || 0));

        const lastFormation = sortedFormations[0];
        if (lastFormation && lastFormation.to != null) {
            const depthDifference = Math.abs(measuredDepth - lastFormation.to);
            const passed = depthDifference <= 10;
            flags.push({
                name: 'Formation Depth Coverage',
                passed,
                message: passed
                    ? `Measured depth (${measuredDepth}) and last formation depth (${lastFormation.to}) difference: ${depthDifference.toFixed(1)}`
                    : `Difference between measured depth (${measuredDepth}) and last formation depth (${lastFormation.to}) is ${depthDifference.toFixed(1)}. Expected <= 10.`,
                severity: passed ? 'info' : 'error',
                details: { measuredDepth, lastFormationDepth: lastFormation.to, difference: depthDifference },
            });
        }
    } else if (measuredDepth == null) {
        flags.push({
            name: 'Formation Depth Coverage',
            passed: false,
            message: 'Cannot check formation depth coverage - measured depth is missing',
            severity: 'warning',
        });
    } else if (formations.length === 0) {
        flags.push({
            name: 'Formation Depth Coverage',
            passed: false,
            message: 'Cannot check formation depth coverage - no formations found',
            severity: 'warning',
        });
    }

    // --- 6. Formation continuity ---
    if (formations.length > 0) {
        const continuityCheck = checkFormationContinuity(formations);
        if (!continuityCheck.isContinuous) {
            const gapDetails = continuityCheck.gaps
                .map(g => `Gap of ${g.gap} between depth ${g.from} and ${g.to}`)
                .join('; ');
            flags.push({
                name: 'Formation Continuity',
                passed: false,
                message: `Formations are not continuous: ${gapDetails}`,
                severity: 'warning',
                details: { gaps: continuityCheck.gaps, gapCount: continuityCheck.gaps.length },
            });
        } else {
            flags.push({
                name: 'Formation Continuity',
                passed: true,
                message: continuityCheck.message,
                severity: 'info',
            });
        }
    }

    // --- 7. Perforation intervals ---
    const perforationIntervals = record?.perforation_intervals || [];
    const hasPerfs = Array.isArray(perforationIntervals) && perforationIntervals.length > 0;
    flags.push({
        name: 'Perforation Intervals',
        passed: hasPerfs,
        message: hasPerfs
            ? `Perforation intervals: ${perforationIntervals.length}`
            : 'Perforation intervals not found or empty',
        severity: hasPerfs ? 'info' : 'error',
        details: { count: perforationIntervals.length || 0 },
    });

    // --- 8. Pluggings ---
    const pluggings = record?.pluggings || [];
    const hasPluggings = Array.isArray(pluggings) && pluggings.length > 0;
    flags.push({
        name: 'Pluggings',
        passed: hasPluggings,
        message: hasPluggings
            ? `Pluggings: ${pluggings.length}`
            : 'Pluggings not found or empty',
        severity: hasPluggings ? 'info' : 'error',
        details: { count: pluggings.length || 0 },
    });

    // --- 9. Shows depths ---
    const showsDepths = record?.shows_depths || [];
    const hasShows = Array.isArray(showsDepths) && showsDepths.length > 0;
    flags.push({
        name: 'Shows Depths',
        passed: hasShows,
        message: hasShows
            ? `Shows depths: ${showsDepths.length}`
            : 'Shows depths not found or empty',
        severity: hasShows ? 'info' : 'error',
        details: { count: showsDepths.length || 0 },
    });

    // --- 10. Casing ---
    const casing = record?.casing || [];
    const hasCasing = Array.isArray(casing) && casing.length > 0;
    flags.push({
        name: 'Casing',
        passed: hasCasing,
        message: hasCasing
            ? `Casing: ${casing.length}`
            : 'Casing not found or empty',
        severity: hasCasing ? 'info' : 'error',
        details: { count: casing.length || 0 },
    });

    return flags;
}

export default { computeFlags };
