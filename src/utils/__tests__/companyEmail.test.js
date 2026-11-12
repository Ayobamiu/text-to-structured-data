import { describe, it, expect } from 'vitest';
import { emailKind, isCompanyEmail, isValidEmail } from '../companyEmail.js';

describe('isCompanyEmail', () => {
    it('accepts company and government domains', () => {
        expect(isCompanyEmail('jane@coreextract.app')).toBe(true);
        expect(isCompanyEmail('geo@michigan.gov')).toBe(true);
        expect(isCompanyEmail('lab@university.edu')).toBe(true);
    });

    it('rejects personal inboxes', () => {
        expect(isCompanyEmail('jane@gmail.com')).toBe(false);
        expect(isCompanyEmail('jane@googlemail.com')).toBe(false);
        expect(isCompanyEmail('jane@yahoo.com')).toBe(false);
        expect(isCompanyEmail('jane@outlook.com')).toBe(false);
        expect(isCompanyEmail('jane@hotmail.com')).toBe(false);
        expect(isCompanyEmail('jane@icloud.com')).toBe(false);
        expect(isCompanyEmail('jane@proton.me')).toBe(false);
    });

    it('rejects invalid addresses', () => {
        expect(isCompanyEmail('')).toBe(false);
        expect(isCompanyEmail('not-an-email')).toBe(false);
    });
});

describe('emailKind', () => {
    it('accepts personal inboxes but tags them', () => {
        expect(emailKind('Jane@Gmail.com ')).toBe('personal');
        expect(emailKind('geo@luke-oil.com')).toBe('company');
    });

    it('returns null for invalid addresses', () => {
        expect(emailKind('nope')).toBe(null);
        expect(isValidEmail('a@b')).toBe(false);
        expect(isValidEmail(`${'a'.repeat(250)}@x.com`)).toBe(false);
    });
});
