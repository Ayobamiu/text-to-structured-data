import pool from '../database.js';

const WELLBORE_EVENT_TYPES = new Set([
    'wellbore_open',
    'wellbore_fullscreen',
    'wellbore_print',
]);

const ALLOWED_EVENT_TYPES = new Set([
    'preview_visit',
    'well_view',
    ...WELLBORE_EVENT_TYPES,
]);

function normalizeEventType(type) {
    const value = String(type || '').trim().toLowerCase();
    if (value === 'preview_page_view') return 'preview_visit';
    if (value === 'wellbore_view') return 'wellbore_open';
    return value;
}

/**
 * @param {import('express').Request} req
 */
export function extractPreviewClientMeta(req) {
    const forwarded = req.headers['x-forwarded-for'];
    let ip = null;
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        ip = forwarded.split(',')[0].trim();
    } else if (Array.isArray(forwarded) && forwarded[0]) {
        ip = String(forwarded[0]).trim();
    } else {
        ip = req.socket?.remoteAddress || req.ip || null;
    }

    if (ip?.startsWith('::ffff:')) {
        ip = ip.slice(7);
    }

    const country =
        req.headers['x-vercel-ip-country'] ||
        req.headers['cf-ipcountry'] ||
        req.headers['x-country-code'] ||
        null;

    const region =
        req.headers['x-vercel-ip-country-region'] ||
        req.headers['cf-region'] ||
        null;

    return {
        ip_address: ip,
        user_agent: req.headers['user-agent'] || null,
        accept_language: req.headers['accept-language'] || null,
        referer: req.headers.referer || req.headers.referrer || null,
        country_code: country ? String(country).slice(0, 8) : null,
        region: region ? String(region).slice(0, 128) : null,
    };
}

/**
 * @param {string} previewId
 * @param {string} clientSessionId
 * @param {ReturnType<typeof extractPreviewClientMeta>} meta
 */
export async function upsertPreviewSession(previewId, clientSessionId, meta) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `INSERT INTO preview_analytics_sessions (
                preview_id, client_session_id, ip_address, user_agent,
                accept_language, referer, country_code, region
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (preview_id, client_session_id) DO UPDATE SET
                last_seen_at = CURRENT_TIMESTAMP,
                ip_address = COALESCE(EXCLUDED.ip_address, preview_analytics_sessions.ip_address),
                user_agent = COALESCE(EXCLUDED.user_agent, preview_analytics_sessions.user_agent),
                accept_language = COALESCE(EXCLUDED.accept_language, preview_analytics_sessions.accept_language),
                referer = COALESCE(EXCLUDED.referer, preview_analytics_sessions.referer),
                country_code = COALESCE(EXCLUDED.country_code, preview_analytics_sessions.country_code),
                region = COALESCE(EXCLUDED.region, preview_analytics_sessions.region)
            RETURNING id`,
            [
                previewId,
                clientSessionId,
                meta.ip_address,
                meta.user_agent,
                meta.accept_language,
                meta.referer,
                meta.country_code,
                meta.region,
            ],
        );
        return result.rows[0].id;
    } finally {
        client.release();
    }
}

/**
 * @param {object} params
 * @param {string} params.previewId
 * @param {string} params.sessionId
 * @param {Array<{ type: string, jobFileId?: string, wellLabel?: string, metadata?: object }>} params.events
 */
export async function insertPreviewAnalyticsEvents({ previewId, sessionId, events }) {
    if (!events?.length) return 0;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let inserted = 0;

        for (const raw of events) {
            const eventType = normalizeEventType(raw.type);
            if (!ALLOWED_EVENT_TYPES.has(eventType)) continue;

            const jobFileId = raw.jobFileId || raw.job_file_id || null;
            const wellLabel = raw.wellLabel || raw.well_label || null;
            const metadata =
                raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};

            await client.query(
                `INSERT INTO preview_analytics_events (
                    session_id, preview_id, event_type, job_file_id, well_label, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    sessionId,
                    previewId,
                    eventType,
                    jobFileId,
                    wellLabel ? String(wellLabel).slice(0, 512) : null,
                    JSON.stringify(metadata),
                ],
            );
            inserted += 1;
        }

        await client.query(
            `UPDATE preview_analytics_sessions
             SET last_seen_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [sessionId],
        );

        await client.query('COMMIT');
        return inserted;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * @param {string} previewId
 * @param {{ days?: number, sessionLimit?: number, eventLimit?: number }} [opts]
 */
export async function getPreviewAnalyticsReport(previewId, opts = {}) {
    const days = Math.min(Math.max(Number(opts.days) || 30, 1), 365);
    const sessionLimit = Math.min(Math.max(Number(opts.sessionLimit) || 50, 1), 200);
    const eventLimit = Math.min(Math.max(Number(opts.eventLimit) || 100, 1), 500);

    const client = await pool.connect();
    try {
        const since = new Date();
        since.setDate(since.getDate() - days);

        const summaryResult = await client.query(
            `SELECT
                COUNT(DISTINCT s.id)::int AS unique_sessions,
                COUNT(*) FILTER (WHERE e.event_type = 'preview_visit')::int AS preview_visits,
                COUNT(*) FILTER (WHERE e.event_type = 'well_view')::int AS well_views,
                COUNT(*) FILTER (WHERE e.event_type IN ('wellbore_open', 'wellbore_fullscreen', 'wellbore_print'))::int AS wellbore_events,
                COUNT(DISTINCT e.job_file_id) FILTER (WHERE e.job_file_id IS NOT NULL)::int AS unique_wells_viewed,
                COUNT(DISTINCT s.id) FILTER (
                    WHERE EXISTS (
                        SELECT 1 FROM preview_analytics_events we
                        WHERE we.session_id = s.id
                          AND we.event_type IN ('wellbore_open', 'wellbore_fullscreen', 'wellbore_print')
                    )
                )::int AS sessions_using_wellbore
             FROM preview_analytics_sessions s
             LEFT JOIN preview_analytics_events e ON e.session_id = s.id
             WHERE s.preview_id = $1
               AND s.last_seen_at >= $2`,
            [previewId, since],
        );

        const topWellsResult = await client.query(
            `SELECT
                COALESCE(well_label, job_file_id::text, 'unknown') AS well_label,
                job_file_id,
                COUNT(*)::int AS view_count,
                COUNT(DISTINCT session_id)::int AS unique_sessions,
                MAX(created_at) AS last_viewed_at
             FROM preview_analytics_events
             WHERE preview_id = $1
               AND created_at >= $2
               AND event_type IN ('well_view', 'wellbore_open', 'wellbore_fullscreen', 'wellbore_print')
               AND (job_file_id IS NOT NULL OR well_label IS NOT NULL)
             GROUP BY well_label, job_file_id
             ORDER BY view_count DESC
             LIMIT 25`,
            [previewId, since],
        );

        const wellboreBreakdownResult = await client.query(
            `SELECT event_type, COUNT(*)::int AS count
             FROM preview_analytics_events
             WHERE preview_id = $1
               AND created_at >= $2
               AND event_type IN ('wellbore_open', 'wellbore_fullscreen', 'wellbore_print')
             GROUP BY event_type
             ORDER BY count DESC`,
            [previewId, since],
        );

        const sessionsResult = await client.query(
            `SELECT
                s.id,
                s.client_session_id,
                s.ip_address,
                s.country_code,
                s.region,
                s.user_agent,
                s.first_seen_at,
                s.last_seen_at,
                COUNT(e.id)::int AS event_count,
                COUNT(*) FILTER (WHERE e.event_type IN ('wellbore_open', 'wellbore_fullscreen', 'wellbore_print'))::int AS wellbore_event_count
             FROM preview_analytics_sessions s
             LEFT JOIN preview_analytics_events e ON e.session_id = s.id AND e.created_at >= $2
             WHERE s.preview_id = $1
               AND s.last_seen_at >= $2
             GROUP BY s.id
             ORDER BY s.last_seen_at DESC
             LIMIT $3`,
            [previewId, since, sessionLimit],
        );

        const recentEventsResult = await client.query(
            `SELECT
                e.id,
                e.event_type,
                e.job_file_id,
                e.well_label,
                e.metadata,
                e.created_at,
                s.ip_address,
                s.country_code
             FROM preview_analytics_events e
             JOIN preview_analytics_sessions s ON s.id = e.session_id
             WHERE e.preview_id = $1
               AND e.created_at >= $2
             ORDER BY e.created_at DESC
             LIMIT $3`,
            [previewId, since, eventLimit],
        );

        const summary = summaryResult.rows[0] || {};
        const uniqueSessions = summary.unique_sessions || 0;
        const sessionsUsingWellbore = summary.sessions_using_wellbore || 0;

        return {
            periodDays: days,
            since: since.toISOString(),
            summary: {
                uniqueSessions,
                previewVisits: summary.preview_visits || 0,
                wellViews: summary.well_views || 0,
                wellboreEvents: summary.wellbore_events || 0,
                uniqueWellsViewed: summary.unique_wells_viewed || 0,
                sessionsUsingWellbore,
                wellboreAdoptionRate:
                    uniqueSessions > 0
                        ? Math.round((sessionsUsingWellbore / uniqueSessions) * 1000) / 10
                        : 0,
            },
            wellboreBreakdown: wellboreBreakdownResult.rows,
            topWells: topWellsResult.rows,
            sessions: sessionsResult.rows,
            recentEvents: recentEventsResult.rows,
        };
    } finally {
        client.release();
    }
}
