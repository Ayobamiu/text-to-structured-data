import express from 'express';
import mgsDataService from '../services/mgsDataService.js';

const router = express.Router();

/**
 * POST /mgs/counties-by-permit
 * Body: { permitNumbers: string[] }
 * Returns: { counties: Record<string, string> }  (permit -> CNTY_NAME)
 */
router.post('/counties-by-permit', async (req, res) => {
    try {
        const { permitNumbers } = req.body || {};

        if (!Array.isArray(permitNumbers)) {
            return res.status(400).json({
                status: 'error',
                message: 'permitNumbers must be an array',
            });
        }

        const counties = await mgsDataService.getCountyMapByPermitNumbers(
            permitNumbers
        );

        return res.json({
            status: 'success',
            data: { counties },
        });
    } catch (error) {
        console.error('Error resolving MGS counties:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Failed to resolve MGS counties',
        });
    }
});

export default router;
