/**
 * Work-email gate for the public demo download.
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

export function isCompanyEmail(email) {
    const value = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
    const domain = value.split('@')[1] || '';
    if (!domain || domain.includes(' ')) return false;
    return !PERSONAL_DOMAINS.has(domain);
}

export const COMPANY_EMAIL_ERROR =
    'Use a company email — personal inboxes (Gmail, Yahoo, Outlook, iCloud) are not accepted.';
