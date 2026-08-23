/**
 * Public self-serve demo API. No JWT.
 * Capability token (returned once at create) authorizes later reads/export.
 */

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { createJob, addFileToJob, getFileResult } from '../database.js';
import queueService from '../queue.js';
import S3Service from '../s3Service.js';
import { getPdfPageCount } from '../utils/pdfUtils.js';
import { getProcessingEvents } from '../services/processingEventsService.js';
import { getActiveSchema } from '../services/schemaRegistry.js';
import { resolveDemoIdentity } from '../services/demoIdentity.js';
import { notifyDemoEvent, formatDemoSessionEmail, sendLeadDownloadEmail, demoDownloadUrl } from '../services/demoNotify.js';
import { writeDemoWorkbook, listDemoRecords } from '../services/demoExcel.js';
import {
    createDemoSession,
    getValidDemoSession,
    getValidDemoSessionByDownloadToken,
    issueDemoDownloadToken,
    countRecentDemoSessionsByIp,
    updateDemoSession,
    claimDemoNotify,
    generateDemoToken,
    hashDemoToken,
} from '../database/demoSessions.js';
import { PROCESSING_METHODS, DEFAULT_MODELS, getExtendAIConfig } from '../config/processingConfig.js';
import { extractPreviewClientMeta } from '../database/previewAnalytics.js';
import { COMPANY_EMAIL_ERROR, isCompanyEmail } from '../utils/companyEmail.js';
import logger from '../utils/logger.js';

const router = express.Router();
const s3Service = new S3Service();

export const DEMO_MAX_PAGES = 12;
export const DEMO_MAX_BYTES = 25 * 1024 * 1024;
export const DEMO_RATE_PER_HOUR = 3;
const DEMO_QUEUE_PRIORITY = -10; // queue is ORDER BY priority ASC

const SLUG_NAMES = {
    borehole_log: 'Boring log',
    mgs_well_log: 'Well record',
    aquifer_test: 'Aquifer test',
    analytical_results: 'Analytical results',
    well_coordinate_table: 'Well coordinates',
    field_sampling_forms: 'Field sampling',
};

const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: DEMO_MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        const name = (file.originalname || '').toLowerCase();
        if (file.mimetype === 'application/pdf' || name.endsWith('.pdf')) {
            cb(null, true);
        } else {
            cb(new Error('PDF_ONLY'));
        }
    },
});

const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many uploads. Try again in a few minutes.' },
});

const readLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Try again in a few minutes.' },
});

const leadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many email requests. Try again in a few minutes.' },
});

function tokenFromReq(req) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return header.slice(7);
    if (typeof req.query.token === 'string') return req.query.token;
    if (typeof req.headers['x-demo-token'] === 'string') return req.headers['x-demo-token'];
    return null;
}

function displayNameForSlug(slug) {
    if (!slug) return 'Record';
    return SLUG_NAMES[slug] || slug.replace(/_/g, ' ');
}

function classifySummary(detectedSections) {
    const sections = Array.isArray(detectedSections?.sections) ? detectedSections.sections : [];
    if (sections.length === 0) return null;
    const mapped = sections
        .filter((s) => {
            const slug = s.document_type_slug || s.slug;
            return slug && slug !== 'none';
        })
        .map((s) => {
            const slug = s.document_type_slug || s.slug;
            const pages = Array.isArray(s.member_pages)
                ? s.member_pages
                : Array.isArray(s.extraction_pages)
                    ? s.extraction_pages
                    : [];
            return {
                slug,
                displayName: displayNameForSlug(slug),
                pages,
                pageCount: typeof s.page_count === 'number' ? s.page_count : pages.length,
                confidence: typeof s.confidence === 'number' ? s.confidence : null,
            };
        });
    if (mapped.length === 0) return null;
    const bySlug = new Map();
    for (const s of mapped) {
        const prev = bySlug.get(s.slug);
        if (!prev) bySlug.set(s.slug, { ...s });
        else {
            prev.pageCount += s.pageCount;
            prev.pages = [...prev.pages, ...s.pages];
        }
    }
    const types = [...bySlug.values()];
    const headline = types
        .map((t) => `${t.displayName}, ${t.pageCount || t.pages.length} page${(t.pageCount || t.pages.length) === 1 ? '' : 's'}`)
        .join(' · ');
    return { headline, sections: mapped, types };
}

function publicStatus(processingStatus, extractionStatus) {
    if (processingStatus === 'completed') return 'completed';
    if (processingStatus === 'failed' || extractionStatus === 'failed') return 'failed';
    if (processingStatus === 'processing' || extractionStatus === 'processing') return 'processing';
    return 'queued';
}

async function requireDemoSession(req, res, next) {
    const token = tokenFromReq(req);
    if (!token) {
        return res.status(401).json({ success: false, error: 'Session token required' });
    }
    const session = await getValidDemoSession(req.params.id, token);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found or expired' });
    }
    req.demoSession = session;
    req.demoToken = token;
    next();
}

async function maybeNotifyProgress(session, file) {
    const classification = classifySummary(file?.detected_sections);
    const status = publicStatus(file?.processing_status, file?.extraction_status);
    let updated = session;

    if (classification && !session.document_type) {
        updated = await updateDemoSession(session.id, {
            document_type: classification.types.map((t) => t.slug).join(','),
        }) || updated;
    }

    if (classification && !session.notified_classified_at) {
        const claimed = await claimDemoNotify(session.id, 'notified_classified_at');
        if (claimed) {
            updated = claimed;
            void notifyDemoEvent(
                `${classification.headline} uploaded`,
                formatDemoSessionEmail(claimed, {
                    documentType: classification.headline,
                    note: 'Classified',
                })
            );
        }
    }

    if (status === 'completed' && !session.notified_completed_at) {
        const claimed = await claimDemoNotify(session.id, 'notified_completed_at');
        if (claimed) {
            updated = await updateDemoSession(session.id, { status: 'completed' }) || claimed;
            void notifyDemoEvent(
                `Extraction complete${session.lead_email ? ` · ${session.lead_email}` : ''}`,
                formatDemoSessionEmail(updated, {
                    status: 'completed',
                    documentType: classification?.headline || session.document_type,
                    note: session.lead_email ? `Lead: ${session.lead_email}` : 'No email yet',
                })
            );
        }
    } else if (status === 'failed' && session.status !== 'failed') {
        updated = await updateDemoSession(session.id, { status: 'failed' }) || updated;
        void notifyDemoEvent(
            `Extraction failed · ${session.filename || 'file'}`,
            formatDemoSessionEmail(updated, {
                status: 'failed',
                note: file?.processing_error || file?.extraction_error || 'failed',
            })
        );
    } else if (status === 'processing' && session.status === 'queued') {
        updated = await updateDemoSession(session.id, { status: 'processing' }) || updated;
    }

    return { session: updated, classification, status };
}

function unlinkQuiet(path) {
    if (!path) return;
    fs.unlink(path, () => {});
}

router.post('/sessions', createLimiter, (req, res) => {
    upload.single('file')(req, res, async (err) => {
        const tempPath = req.file?.path;
        try {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE' || err.message === 'File too large') {
                    return res.status(400).json({
                        success: false,
                        error: `File is too large. Max ${Math.round(DEMO_MAX_BYTES / (1024 * 1024))} MB.`,
                    });
                }
                if (err.message === 'PDF_ONLY') {
                    return res.status(400).json({ success: false, error: 'Upload a PDF.' });
                }
                return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
            }
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'Drop a PDF to start.' });
            }

            const meta = extractPreviewClientMeta(req);
            const recent = await countRecentDemoSessionsByIp(meta.ip_address);
            if (recent >= DEMO_RATE_PER_HOUR) {
                unlinkQuiet(tempPath);
                return res.status(429).json({
                    success: false,
                    error: 'This machine has reached the demo limit for now. Email hello@coreextract.app and we will run it for you.',
                });
            }

            const isPdf = req.file.mimetype === 'application/pdf' || req.file.originalname?.toLowerCase().endsWith('.pdf');
            if (!isPdf) {
                unlinkQuiet(tempPath);
                return res.status(400).json({ success: false, error: 'Upload a PDF.' });
            }

            const pageCount = await getPdfPageCount(req.file.path);
            if (!pageCount || pageCount < 1) {
                unlinkQuiet(tempPath);
                return res.status(400).json({ success: false, error: 'Could not read that PDF.' });
            }
            if (pageCount > DEMO_MAX_PAGES) {
                unlinkQuiet(tempPath);
                return res.status(400).json({
                    success: false,
                    error: `This demo handles up to ${DEMO_MAX_PAGES} pages. This file has ${pageCount}. Email hello@coreextract.app for the full archive.`,
                });
            }

            const { organizationId, userId } = await resolveDemoIdentity();
            const processingConfig = {
                extraction: { method: 'extendai', options: getExtendAIConfig() },
                processing: {
                    method: PROCESSING_METHODS.OPENAI,
                    model: DEFAULT_MODELS[PROCESSING_METHODS.OPENAI],
                    options: {},
                },
                useVisualClassifier: true,
                usePerSectionExtraction: true,
            };

            const job = await createJob(
                `Demo: ${req.file.originalname}`,
                {},
                'demo',
                userId,
                organizationId,
                'full_extraction',
                processingConfig
            );

            let s3FileInfo = null;
            let uploadStatus = 'success';
            let uploadError = null;
            let storageType = 's3';
            if (s3Service.isCloudStorageEnabled()) {
                try {
                    s3FileInfo = await s3Service.uploadFile(req.file, job.id);
                } catch (s3Error) {
                    logger.warn({ err: s3Error.message }, 'demo S3 upload failed');
                    uploadStatus = 'failed';
                    uploadError = s3Error.message;
                    storageType = 'local';
                }
            } else {
                storageType = 'local';
            }

            const fileRecord = await addFileToJob(
                job.id,
                req.file.originalname,
                req.file.size,
                s3FileInfo?.s3Key || null,
                s3FileInfo?.fileHash || null,
                uploadStatus,
                uploadError,
                storageType,
                pageCount,
                null
            );

            const rawToken = generateDemoToken();
            const session = await createDemoSession({
                tokenHash: hashDemoToken(rawToken),
                jobId: job.id,
                fileId: fileRecord.id,
                filename: req.file.originalname,
                pageCount,
                ipAddress: meta.ip_address,
                userAgent: meta.user_agent,
            });

            await queueService.addFileToQueue(fileRecord.id, job.id, DEMO_QUEUE_PRIORITY);

            void notifyDemoEvent(
                `New upload · ${req.file.originalname} · ${pageCount} pages`,
                formatDemoSessionEmail(session, { pageCount, status: 'queued' })
            );

            unlinkQuiet(tempPath);

            return res.json({
                success: true,
                sessionId: session.id,
                token: rawToken,
                jobId: job.id,
                fileId: fileRecord.id,
                filename: req.file.originalname,
                pageCount,
            });
        } catch (error) {
            unlinkQuiet(tempPath);
            logger.error({ err: error.message }, 'demo session create failed');
            return res.status(500).json({ success: false, error: 'Could not start the demo. Try again.' });
        }
    });
});

router.use(express.json());
router.use(readLimiter);

router.get('/sessions/:id', requireDemoSession, async (req, res) => {
    try {
        const session = req.demoSession;
        const file = session.file_id ? await getFileResult(session.file_id) : null;
        const events = session.file_id ? await getProcessingEvents(session.file_id) : [];
        const { session: updated, classification, status } = await maybeNotifyProgress(session, file);

        const records = [];
        if (file?.result && (status === 'completed' || file.processing_status === 'completed')) {
            const listed = listDemoRecords(file.result);
            const schemaCache = new Map();
            for (const item of listed) {
                let schema = null;
                if (item.slug && !schemaCache.has(item.slug)) {
                    try {
                        const active = await getActiveSchema(item.slug);
                        schemaCache.set(item.slug, active?.schema || null);
                    } catch {
                        schemaCache.set(item.slug, null);
                    }
                }
                schema = item.slug ? schemaCache.get(item.slug) : null;
                const section = classification?.sections?.find((s) => s.slug === item.slug);
                const data = { ...item.record };
                const meta = (data.extraction_metadata && typeof data.extraction_metadata === 'object')
                    ? { ...data.extraction_metadata }
                    : {};
                if (typeof meta.extraction_confidence !== 'number' && typeof section?.confidence === 'number') {
                    meta.extraction_confidence = section.confidence;
                    data.extraction_metadata = meta;
                }
                records.push({
                    slug: item.slug,
                    displayName: displayNameForSlug(item.slug),
                    data,
                    schema,
                    confidence: section?.confidence ?? meta.extraction_confidence ?? null,
                    pages: section?.pages || meta.source_pages || [],
                });
            }
        }

        res.json({
            success: true,
            sessionId: updated.id,
            jobId: updated.job_id,
            fileId: updated.file_id,
            filename: updated.filename,
            pageCount: updated.page_count,
            status,
            documentType: updated.document_type,
            classification,
            events: events.map((e) => ({
                seq: e.seq,
                phase: e.phase,
                status: e.status,
                message: e.message,
                progress: e.progress_current != null
                    ? { current: e.progress_current, total: e.progress_total }
                    : null,
                createdAt: e.created_at,
            })),
            records,
            error: file?.processing_error || file?.extraction_error || null,
            hasLeadEmail: Boolean(updated.lead_email) && isCompanyEmail(updated.lead_email),
            downloaded: Boolean(updated.downloaded_at),
        });
    } catch (error) {
        logger.error({ err: error.message }, 'demo session get failed');
        res.status(500).json({ success: false, error: 'Could not load session' });
    }
});

router.get('/sessions/:id/file', requireDemoSession, async (req, res) => {
    try {
        const file = await getFileResult(req.demoSession.file_id);
        if (!file?.s3_key || !s3Service.isCloudStorageEnabled()) {
            return res.status(404).json({ success: false, error: 'File is not available' });
        }
        const signedUrl = await s3Service.generateSignedUrl(file.s3_key, 3600);
        if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, url: signedUrl, filename: file.filename });
        }
        return res.redirect(signedUrl);
    } catch (error) {
        logger.error({ err: error.message }, 'demo file redirect failed');
        res.status(500).json({ success: false, error: 'Could not load the PDF' });
    }
});

router.get('/sessions/:id/pages/:n/thumbnail.jpg', requireDemoSession, async (req, res) => {
    try {
        const pageNumber = parseInt(req.params.n, 10);
        if (!Number.isInteger(pageNumber) || pageNumber < 1) {
            return res.status(400).json({ success: false, error: 'Invalid page number' });
        }
        const file = await getFileResult(req.demoSession.file_id);
        if (!file?.s3_key) {
            return res.status(400).json({ success: false, error: 'Thumbnails require cloud storage' });
        }
        if (!s3Service.isCloudStorageEnabled()) {
            return res.status(503).json({ success: false, error: 'Cloud storage disabled' });
        }
        const {
            normalizeThumbnailRequest,
            thumbnailKey,
            readThumbnailManifest,
            ensureThumbnails,
        } = await import('../services/thumbnailService.js');
        const { width: widthPx, quality: jpegQuality } = normalizeThumbnailRequest({
            width: req.query.width,
            quality: req.query.q,
        });
        const cacheKey = thumbnailKey(file.s3_key, pageNumber, widthPx, jpegQuality);
        let cached = await s3Service.getObjectStream(cacheKey);
        if (!cached) {
            const manifest = await readThumbnailManifest(s3Service, file.s3_key, widthPx, jpegQuality);
            if (manifest && pageNumber > manifest.pageCount) {
                return res.status(404).json({ success: false, error: `Page ${pageNumber} not found` });
            }
            const { pageCount } = await ensureThumbnails(s3Service, file.s3_key, {
                width: widthPx,
                quality: jpegQuality,
                force: Boolean(manifest),
            });
            if (pageNumber > pageCount) {
                return res.status(404).json({ success: false, error: `Page ${pageNumber} not found` });
            }
            cached = await s3Service.getObjectStream(cacheKey);
            if (!cached) {
                return res.status(404).json({ success: false, error: `Page ${pageNumber} not found` });
            }
        }
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'private, max-age=86400, immutable');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        if (cached.contentLength != null) res.set('Content-Length', String(cached.contentLength));
        cached.body.on('error', (err) => {
            logger.error({ err: err.message }, 'demo thumbnail stream error');
            res.destroy(err);
        });
        res.on('close', () => cached.body.destroy());
        cached.body.pipe(res);
    } catch (error) {
        logger.error({ err: error.message }, 'demo thumbnail failed');
        res.status(500).json({ success: false, error: 'Could not load thumbnail' });
    }
});

router.post('/sessions/:id/lead', leadLimiter, requireDemoSession, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const intent = req.body?.intent === 'quote' ? 'quote' : 'download';
        if (!isCompanyEmail(email)) {
            return res.status(400).json({ success: false, error: COMPANY_EMAIL_ERROR });
        }
        const file = await getFileResult(req.demoSession.file_id);
        if (!file?.result) {
            return res.status(409).json({ success: false, error: 'Extraction is not ready yet.' });
        }
        const issued = await issueDemoDownloadToken(req.demoSession.id, email);
        const session = issued.session || req.demoSession;
        const url = demoDownloadUrl(session.id, issued.raw);
        const mailed = await sendLeadDownloadEmail({
            to: email,
            filename: session.filename,
            url,
        });
        if (!mailed.sent) {
            logger.warn({ err: mailed.error, to: email }, 'demo download email not sent');
            return res.status(503).json({
                success: false,
                error: mailed.error || 'Could not send the email. Try again in a moment.',
                ...(process.env.NODE_ENV !== 'production' ? { devDownloadUrl: url } : {}),
            });
        }
        void notifyDemoEvent(
            intent === 'quote'
                ? `Quote request · ${email}`
                : `Download link emailed · ${email}`,
            formatDemoSessionEmail(session, { leadEmail: email, note: intent })
        );
        res.json({
            success: true,
            email,
            emailed: true,
        });
    } catch (error) {
        logger.error({ err: error.message }, 'demo lead failed');
        res.status(500).json({ success: false, error: 'Could not send the download link' });
    }
});

router.get('/sessions/:id/export', async (req, res) => {
    try {
        const raw =
            typeof req.query.download_token === 'string' ? req.query.download_token : '';
        if (!raw) {
            return res.status(401).json({
                success: false,
                error: 'Open the download link we emailed you.',
            });
        }
        const session = await getValidDemoSessionByDownloadToken(req.params.id, raw);
        if (!session) {
            return res.status(403).json({
                success: false,
                error: 'This download link is invalid or expired. Request another from the demo page.',
            });
        }
        if (!session.lead_email || !isCompanyEmail(session.lead_email)) {
            return res.status(403).json({ success: false, error: COMPANY_EMAIL_ERROR });
        }
        const file = await getFileResult(session.file_id);
        if (!file?.result) {
            return res.status(409).json({ success: false, error: 'Extraction is not ready yet.' });
        }
        const buf = await writeDemoWorkbook(file.result, { filename: session.filename });
        await updateDemoSession(session.id, { downloaded_at: new Date() });
        void notifyDemoEvent(
            `Downloaded Excel · ${session.lead_email}`,
            formatDemoSessionEmail(
                { ...session, downloaded_at: new Date() },
                { leadEmail: session.lead_email, downloaded: true }
            )
        );
        const safeName = String(session.filename || 'extract').replace(/[^\w.\-]+/g, '_').replace(/\.pdf$/i, '');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}_extract.xlsx"`);
        res.send(buf);
    } catch (error) {
        logger.error({ err: error.message }, 'demo export failed');
        res.status(500).json({ success: false, error: 'Could not build the spreadsheet' });
    }
});

export default router;
