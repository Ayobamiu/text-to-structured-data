/**
 * Gold-set review — the read/write side of `gold_labels`.
 *
 * A gold set is the only way to get per-field extraction ACCURACY. Production
 * data cannot supply it: `section_qa_findings` records only errors somebody
 * caught, so there are no negatives and therefore no denominator. What the DB
 * supports on its own is the QA judge's precision (83.7%) — "when it cried
 * wolf, was there a wolf", not "how many wolves did it walk past".
 *
 * Rows are seeded by scripts/goldSetSample.mjs --write with verdict NULL, and
 * this service is what the review panel drives. Two invariants worth keeping:
 *
 *  - NOTHING here writes job_files.result. Gold review judges the extraction,
 *    it never repairs it — that is what the QA apply path is for. Keeping the
 *    two apart is why the panel can't corrupt a result.
 *  - A verdict on an object or array is expanded into one row per seeded leaf
 *    beneath it, never stored against the container. A single verdict on
 *    `well_construction` would collapse five observations into one and no
 *    per-field accuracy could be recovered from it.
 */
import pool, { getFileResult } from '../database.js';
import { getAtFieldPath, serializeExtractedValue } from '../utils/goldSetPaths.mjs';

export type GoldVerdict = 'correct' | 'wrong' | 'missing' | 'unreadable';

export const GOLD_VERDICTS: GoldVerdict[] = ['correct', 'wrong', 'missing', 'unreadable'];

export interface GoldLabel {
    id: string;
    batch: string;
    file_id: string;
    job_id: string | null;
    section_result_id: string;
    slug: string;
    field_path: string;
    /** Frozen at seed time — the value actually being judged. NULL = blank. */
    extracted_value: string | null;
    qa_ran: boolean;
    verdict: GoldVerdict | null;
    true_value: string | null;
    notes: string | null;
    reviewed_by: string | null;
    reviewed_at: string | null;
    /** Live value now, for drift detection. Not a column — computed on read. */
    current_value?: string | null;
    drifted?: boolean;
}

/** A row as it comes back from the table, before drift is computed on top. */
type GoldLabelRow = Omit<GoldLabel, 'current_value' | 'drifted'> & {
    reviewed_by_email?: string | null;
};

const SELECT_COLUMNS = `
    gl.id, gl.batch, gl.file_id, gl.job_id, gl.section_result_id, gl.slug,
    gl.field_path, gl.extracted_value, gl.qa_ran, gl.verdict, gl.true_value,
    gl.notes, gl.reviewed_by, gl.reviewed_at, u.email AS reviewed_by_email
`;

/**
 * Every gold row for a file in a batch, with the live value attached.
 *
 * Drift matters: a re-extraction or an applied QA fix can change the record
 * under a pending row, and a verdict recorded against a value that no longer
 * exists is not evidence about anything. The panel badges these rather than
 * quietly judging stale data.
 */
export async function getGoldLabelsForFile(
    fileId: string,
    batch: string,
): Promise<GoldLabel[]> {
    const { rows } = await pool.query(
        `SELECT ${SELECT_COLUMNS}
           FROM gold_labels gl
           LEFT JOIN users u ON u.id = gl.reviewed_by
          WHERE gl.file_id = $1 AND gl.batch = $2
          ORDER BY gl.section_result_id, gl.field_path`,
        [fileId, batch],
    );
    if (rows.length === 0) return [];

    // One result fetch for the whole file, then walk each row's path.
    let result: Record<string, unknown[]> | null = null;
    try {
        const file = await getFileResult(fileId);
        result = (file?.result ?? null) as Record<string, unknown[]> | null;
    } catch {
        result = null;
    }

    const recordFor = (slug: string, sectionResultId: string): unknown => {
        const list = result?.[slug];
        if (!Array.isArray(list)) return null;
        return list.find(
            (r) => (r as Record<string, unknown>)?.section_result_id === sectionResultId,
        ) ?? null;
    };

    return (rows as GoldLabelRow[]).map((row) => {
        const record = recordFor(row.slug, row.section_result_id);
        const current = record
            ? serializeExtractedValue(getAtFieldPath(record, row.field_path))
            : null;
        return {
            ...row,
            current_value: current,
            drifted: record != null && current !== row.extracted_value,
        };
    });
}

/**
 * Record a verdict. `ids` takes more than one so that judging a whole object
 * or array is a single call that writes real per-leaf rows.
 *
 * `true_value` is meaningful for `wrong` and `missing` — both mean the page
 * says something the extraction didn't capture, and that answer is what makes
 * the finding actionable later. `correct` and `unreadable` clear it, so a
 * verdict flipped back cannot leave a contradictory answer behind.
 */
export async function setGoldVerdicts(
    ids: string[],
    fileId: string,
    verdict: GoldVerdict,
    userId: string | null,
    opts: { trueValue?: string | null; notes?: string | null } = {},
): Promise<GoldLabel[]> {
    if (ids.length === 0) return [];
    if (!GOLD_VERDICTS.includes(verdict)) {
        throw new Error(`unknown verdict "${verdict}"`);
    }

    const trueValue = verdict === 'wrong' || verdict === 'missing'
        ? (opts.trueValue ?? null)
        : null;

    const { rows } = await pool.query(
        `UPDATE gold_labels gl
            SET verdict     = $3,
                true_value  = $4,
                notes       = COALESCE($5, gl.notes),
                reviewed_by = $6,
                reviewed_at = NOW(),
                updated_at  = NOW()
          WHERE gl.id = ANY($1::uuid[])
            AND gl.file_id = $2
        RETURNING gl.id, gl.batch, gl.file_id, gl.job_id, gl.section_result_id,
                  gl.slug, gl.field_path, gl.extracted_value, gl.qa_ran,
                  gl.verdict, gl.true_value, gl.notes, gl.reviewed_by, gl.reviewed_at`,
        [ids, fileId, verdict, trueValue, opts.notes ?? null, userId],
    );
    return rows;
}

/** Undo — back to pending, clearing the provenance with it. */
export async function clearGoldVerdicts(ids: string[], fileId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await pool.query(
        `UPDATE gold_labels
            SET verdict = NULL, true_value = NULL,
                reviewed_by = NULL, reviewed_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND file_id = $2`,
        [ids, fileId],
    );
    return rowCount ?? 0;
}

/**
 * Label a field the sample never drew — the reviewer noticed something while
 * hovering around the tree.
 *
 * These land in the reserved `adhoc` batch and are never part of a scored
 * draw. The headline number depends on the sample being the one that was
 * drawn; letting opportunistic labels into it would reintroduce exactly the
 * selection bias the stratification exists to remove.
 */
export async function createAdhocGoldLabel(params: {
    fileId: string;
    jobId: string | null;
    sectionResultId: string;
    slug: string;
    fieldPath: string;
    verdict: GoldVerdict;
    trueValue?: string | null;
    notes?: string | null;
    userId: string | null;
}): Promise<GoldLabel> {
    const { fileId, jobId, sectionResultId, slug, fieldPath, verdict, userId } = params;
    if (!GOLD_VERDICTS.includes(verdict)) {
        throw new Error(`unknown verdict "${verdict}"`);
    }

    // Freeze what is on screen right now — the same thing the seeder does.
    let extractedValue: string | null = null;
    try {
        const file = await getFileResult(fileId);
        const list = (file?.result as Record<string, unknown[]>)?.[slug];
        const record = Array.isArray(list)
            ? list.find((r) => (r as Record<string, unknown>)?.section_result_id === sectionResultId)
            : null;
        if (record) extractedValue = serializeExtractedValue(getAtFieldPath(record, fieldPath));
    } catch {
        extractedValue = null;
    }

    const { rows } = await pool.query(
        `INSERT INTO gold_labels
             (batch, file_id, job_id, section_result_id, slug, field_path,
              extracted_value, verdict, true_value, notes, reviewed_by, reviewed_at)
         VALUES ('adhoc', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (batch, section_result_id, field_path) DO UPDATE
             SET verdict = EXCLUDED.verdict,
                 true_value = EXCLUDED.true_value,
                 notes = EXCLUDED.notes,
                 reviewed_by = EXCLUDED.reviewed_by,
                 reviewed_at = NOW(),
                 updated_at = NOW()
         RETURNING *`,
        [
            fileId, jobId, sectionResultId, slug, fieldPath, extractedValue,
            verdict,
            verdict === 'wrong' || verdict === 'missing' ? (params.trueValue ?? null) : null,
            params.notes ?? null, userId,
        ],
    );
    return rows[0];
}

export interface GoldBatchProgress {
    batch: string;
    slug: string;
    fields_total: number;
    fields_done: number;
    sections_total: number;
    sections_done: number;
    files_total: number;
    unreadable: number;
}

/** Batch-wide progress — what the panel shows instead of a score. */
export async function getGoldBatchProgress(batch: string): Promise<GoldBatchProgress | null> {
    const { rows } = await pool.query(
        `SELECT b.batch, b.slug,
                count(l.*)                                        AS fields_total,
                count(l.*) FILTER (WHERE l.verdict IS NOT NULL)   AS fields_done,
                count(DISTINCT l.section_result_id)               AS sections_total,
                count(DISTINCT l.section_result_id) FILTER (
                    WHERE NOT EXISTS (
                        SELECT 1 FROM gold_labels p
                         WHERE p.batch = l.batch
                           AND p.section_result_id = l.section_result_id
                           AND p.verdict IS NULL))                AS sections_done,
                count(DISTINCT l.file_id)                         AS files_total,
                count(l.*) FILTER (WHERE l.verdict = 'unreadable') AS unreadable
           FROM gold_batches b
           LEFT JOIN gold_labels l ON l.batch = b.batch
          WHERE b.batch = $1
          GROUP BY b.batch, b.slug`,
        [batch],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
        batch: r.batch,
        slug: r.slug,
        fields_total: Number(r.fields_total),
        fields_done: Number(r.fields_done),
        sections_total: Number(r.sections_total),
        sections_done: Number(r.sections_done),
        files_total: Number(r.files_total),
        unreadable: Number(r.unreadable),
    };
}

export interface GoldQueueEntry {
    job_id: string | null;
    file_id: string;
    filename: string | null;
    section_result_id: string;
    pending: number;
    total: number;
}

/**
 * The review queue, ordered by file so consecutive sections share an
 * already-loaded PDF. Section order within a file follows the section id, so
 * the queue is stable across reloads.
 *
 * Loading a scanned log is by far the most expensive thing in a review pass —
 * jumping around by section id would reload a PDF per check.
 */
export async function getGoldBatchQueue(batch: string): Promise<GoldQueueEntry[]> {
    const { rows } = await pool.query(
        `SELECT gl.job_id, gl.file_id, jf.filename, gl.section_result_id,
                count(*) FILTER (WHERE gl.verdict IS NULL) AS pending,
                count(*)                                   AS total
           FROM gold_labels gl
           LEFT JOIN job_files jf ON jf.id = gl.file_id
          WHERE gl.batch = $1
          GROUP BY gl.job_id, gl.file_id, jf.filename, gl.section_result_id
          ORDER BY jf.filename NULLS LAST, gl.file_id, gl.section_result_id`,
        [batch],
    );
    // Postgres returns count() as a bigint string — Number() every one of them.
    return (rows as Array<Record<string, string | null>>).map((r) => ({
        job_id: r.job_id,
        file_id: r.file_id as string,
        filename: r.filename,
        section_result_id: r.section_result_id as string,
        pending: Number(r.pending),
        total: Number(r.total),
    }));
}

/** Batches a reviewer can pick from, newest first. */
export async function listGoldBatches(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
        `SELECT b.*,
                count(l.*)                                      AS fields_total,
                count(l.*) FILTER (WHERE l.verdict IS NOT NULL) AS fields_done
           FROM gold_batches b
           LEFT JOIN gold_labels l ON l.batch = b.batch
          GROUP BY b.batch
          ORDER BY b.created_at DESC`,
    );
    return rows;
}
