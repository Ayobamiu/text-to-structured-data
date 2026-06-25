import express from 'express';
import runQuery from '../nlquery/orchestrator/runQuery.ts';

const router = express.Router();

/**
 * POST /nlquery
 * Body: { question: string, slug?: string, jobId?: string, orgId?: string }
 * Returns: { interpreted, spec, columns, rows, rowCount, csv }
 *
 * Translates a natural-language question into a constrained FilterSpec (via Claude),
 * compiles it to scoped, read-only SQL over extracted_records, and returns a table
 * plus the interpreted-filter echo so the user can see exactly what was searched.
 */
router.post('/', async (req, res) => {
    try {
        const { question, slug = 'mgs_well_log', jobId, orgId } = req.body || {};
        if (!question || typeof question !== 'string') {
            return res.status(400).json({ status: 'error', message: 'question (string) is required' });
        }

        const scope = {};
        if (orgId) scope.orgId = orgId;
        if (jobId) scope.jobId = jobId;

        const { spec, interpreted, result } = await runQuery({ question, slug, scope });

        return res.json({
            status: 'success',
            data: {
                interpreted,
                spec,
                columns: result.columns,
                rows: result.rows,
                rowCount: result.rowCount,
                csv: result.csv,
            },
        });
    } catch (error) {
        console.error('nlquery error:', error);
        return res.status(500).json({ status: 'error', message: error?.message || 'query failed' });
    }
});

export default router;
