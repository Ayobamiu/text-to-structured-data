import express from 'express';
import runQuery from '../nlquery/orchestrator/runQuery.ts';
import { getUserOrganizationIds } from '../utils/organizationHelpers.js';
import { checkJobAccess } from '../utils/accessControl.js';

const router = express.Router();

/**
 * POST /nlquery
 * Body: { question: string, slug?: string, jobId?: string }
 * Returns: { interpreted, spec, columns, rows, rowCount, csv }
 *
 * Translates a natural-language question into a constrained FilterSpec (via Claude),
 * compiles it to scoped, read-only SQL over extracted_records, and returns a table
 * plus the interpreted-filter echo so the user can see exactly what was searched.
 *
 * Tenancy: org scope is ALWAYS derived from the authenticated caller (req.user), never
 * from the request body — RLS is off, so this server-side scope is the only tenancy guard.
 * If jobId is given, membership is checked explicitly before the job is used to scope the query.
 */
router.post('/', async (req, res) => {
    try {
        const { question, slug = 'mgs_well_log', jobId } = req.body || {};
        if (!question || typeof question !== 'string') {
            return res.status(400).json({ status: 'error', message: 'question (string) is required' });
        }

        const organizationIds = await getUserOrganizationIds(req.user);
        if (organizationIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'User must be part of an organization' });
        }

        if (jobId) {
            const hasAccess = await checkJobAccess(jobId, req.user, res);
            if (!hasAccess) return; // checkJobAccess already sent the 403/500
        }

        const scope = { orgId: organizationIds };
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
