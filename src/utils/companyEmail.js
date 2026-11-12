/**
 * Email helpers for the public demo. Any valid address is accepted;
 * company vs personal is a tag for the operator, not a gate.
 * Keep in sync with web/src/lib/companyEmail.ts
 */

const PERSONAL_DOMAINS = new Set([
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'yahoo.co.uk',
    'ymail.com',
    'hotmail.com',
    'hotmail.co.uk',
    'outlook.com',
    'outlook.co.uk',
    'live.com',
    'msn.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'aol.com',
    'protonmail.com',
    'proton.me',
    'pm.me',
    'gmx.com',
    'gmx.net',
    'mail.com',
    'inbox.com',
    'yandex.com',
    'yandex.ru',
    'zoho.com',
    'fastmail.com',
    'tutanota.com',
    'tutamail.com',
    'mailinator.com',
    'guerrillamail.com',
]);

export function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
    const value = normalizeEmail(email);
    if (value.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isCompanyEmail(email) {
    const value = normalizeEmail(email);
    if (!isValidEmail(value)) return false;
    const domain = value.split('@')[1] || '';
    if (!domain || domain.includes(' ')) return false;
    return !PERSONAL_DOMAINS.has(domain);
}

/**
 * The demo accepts any address (a Gmail lead beats no lead) and tags it so the
 * operator can qualify it. 'company' | 'personal' | null (invalid).
 */
export function emailKind(email) {
    if (!isValidEmail(email)) return null;
    return isCompanyEmail(email) ? 'company' : 'personal';
}

export const INVALID_EMAIL_ERROR = 'Enter a valid email address.';

export const COMPANY_EMAIL_ERROR =
    'Use a company email — personal inboxes (Gmail, Yahoo, Outlook, iCloud) are not accepted.';
