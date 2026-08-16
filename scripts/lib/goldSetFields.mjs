/**
 * Which fields a gold-set reviewer actually checks, per document type.
 *
 * Not every leaf in the record belongs in a checklist:
 *
 *  - `extraction_metadata.*` is written by the PIPELINE, not read off the page
 *    (extracted_at, source_file, extraction_confidence, depth_encoding). There
 *    is nothing in the PDF to compare them against.
 *  - Coordinates are measured at ~1% fill (latitude_dd/longitude_dd 1%,
 *    easting/northing 2%, coordinate_datum 0% across 2,933 borehole_log
 *    sections). A checklist of blanks buys no accuracy estimate, so they are
 *    out of `core` — use --fields all if you specifically want to confirm the
 *    pipeline is right to leave them empty.
 *  - Booleans that are 100% filled by construction (spt_performed,
 *    well_installed) are cheap to check and stay in: they gate whole sections
 *    of the form, so a wrong one is expensive.
 *
 * `core` targets the fields a customer would notice being wrong, weighted
 * toward ones with enough fill to actually estimate accuracy. Percentages
 * below are measured fill rates as of 2026-08-15 (n=2,933).
 */

export const CORE_FIELDS = {
    borehole_log: [
        // Identity — what the record IS. A wrong id misfiles everything else.
        'site_identification.boring_well_id',        // 100%
        // Who/where
        'document_metadata.firm_name',               // 92%
        'document_metadata.project_name',            // 79%
        'document_metadata.job_number',              // 70%
        'drilling_and_personnel.contractor',         // 76%
        'drilling_and_personnel.geologist_logged_by',// 81%
        'site_identification.state',                 // 81%
        'site_identification.site_address',          // 48%
        'site_identification.location_description',  // 53%
        // When
        'document_metadata.log_date',                // 97%
        'drilling_and_personnel.date_start',         // 92%
        'drilling_and_personnel.date_end',           // 96%
        // Depth + method — the numbers downstream analysis depends on
        'drilling_and_personnel.total_depth_ft',     // 99%
        'drilling_and_personnel.drilling_method',    // 95%
        'drilling_and_personnel.borehole_diameter_in', // 60%
        // Well construction geometry
        'well_construction.well_installed',          // 100%
        'well_construction.screen_from_ft',          // 41%
        'well_construction.screen_to_ft',            // 41%
        'well_construction.casing_to_ft',            // 37%
        'well_construction.grout_to_ft',             // 37%
    ],
};

/**
 * Row-level fields to check inside table arrays. `lithology_intervals` is the
 * formation-tops table — the highest-value table in the document and the one
 * that carries depth geometry.
 *
 * `maxRows` caps how many rows per section land in the checklist: a section
 * can carry 50 lithology rows, and one pathological section would otherwise
 * dominate the sample and skew per-field accuracy toward that one document.
 */
export const CORE_TABLES = {
    borehole_log: [
        { path: 'lithology_intervals', fields: ['depth_from_ft', 'depth_to_ft', 'description'], maxRows: 6 },
    ],
};

/** Leaf prefixes never worth a reviewer's time — pipeline-generated, not extracted. */
export const EXCLUDED_PREFIXES = ['extraction_metadata.', 'section_result_id'];
