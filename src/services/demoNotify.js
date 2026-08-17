/**
 * Demo emails: operator follow-up, and the lead's Excel download link.
 * Uses Resend if RESEND_API_KEY is set; otherwise logs.
 */

import logger from '../utils/logger.js';

function notifyTo() {
    return process.env.DEMO_NOTIFY_EMAIL || 'hello@coreextract.app';
}

function notifyFrom() {
    return process.env.DEMO_FROM_EMAIL || 'Core Extract <hello@coreextract.app>';
}

export function demoAppOrigin() {
    const raw = String(process.env.DEMO_APP_URL || '').trim();
    if (raw) return raw.replace(/\/$/, '');
    if (process.env.NODE_ENV !== 'production') return 'http://localhost:3001';
    return 'https://coreextract.app';
}

export function demoDownloadUrl(sessionId, rawToken) {
    const token = encodeURIComponent(String(rawToken || ''));
    return `${demoAppOrigin()}/try/${sessionId}/download?token=${token}`;
}

async function sendResend({ to, subject, text, html }) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
        logger.info({ to, subject, text }, 'demo email (no RESEND_API_KEY — logged only)');
        return { sent: false, logged: true, error: 'RESEND_API_KEY is not set' };
    }

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: notifyFrom(),
                to: Array.isArray(to) ? to : [to],
                subject,
                text,
                ...(html ? { html } : {}),
            }),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            let message = errText || `Resend HTTP ${res.status}`;
            try {
                const parsed = JSON.parse(errText);
                if (parsed?.message) message = parsed.message;
            } catch {
                /* keep raw body */
            }
            logger.warn({ status: res.status, errText, to, subject }, 'demo email Resend failed');
            return { sent: false, error: message };
        }
        return { sent: true };
    } catch (err) {
        logger.warn({ err: err.message, to, subject }, 'demo email threw');
        return { sent: false, error: err.message || 'Email send failed' };
    }
}

export async function notifyDemoEvent(subject, text) {
    const to = notifyTo();
    return sendResend({
        to,
        subject: `[Demo] ${subject}`,
        text: String(text || '').trim(),
    });
}

export async function sendLeadDownloadEmail({ to, filename, url }) {
    const name = filename || 'your file';
    const subject = 'Your Core Extract spreadsheet';
    const text = [
        `Your spreadsheet for ${name} is ready.`,
        '',
        'Open this link from this inbox to download it (that confirms the address):',
        url,
        '',
        'The link expires in 48 hours.',
        '',
        '— Core Extract',
    ].join('\n');
    const html = `
      <p style="font: 15px/1.5 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; color: #171717;">
        Your spreadsheet for <strong>${escapeHtml(name)}</strong> is ready.
      </p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(url)}"
           style="display: inline-block; background: #171717; color: #fff; text-decoration: none; padding: 10px 16px; border-radius: 8px; font: 14px/1.2 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;">
          Download spreadsheet
        </a>
      </p>
      <p style="font: 13px/1.5 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; color: #525252;">
        Opening the link from this inbox confirms the address. It expires in 48 hours.
      </p>
    `;
    const result = await sendResend({ to, subject, text, html });
    if (!result.sent) {
        logger.info({ to, url }, 'demo download link (email not sent)');
    }
    return result;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function formatDemoSessionEmail(session, extra = {}) {
    const lines = [
        `File: ${session.filename || 'unknown'}`,
        `Type: ${session.document_type || extra.documentType || 'pending'}`,
        `Pages: ${session.page_count ?? extra.pageCount ?? '—'}`,
        `Status: ${extra.status || session.status}`,
        `Email: ${session.lead_email || extra.leadEmail || '—'}`,
        `Downloaded: ${session.downloaded_at || extra.downloaded ? 'yes' : 'no'}`,
        `Session: ${session.id}`,
        `IP: ${session.ip_address || '—'}`,
    ];
    if (extra.note) lines.push(`Note: ${extra.note}`);
    return lines.join('\n');
}
