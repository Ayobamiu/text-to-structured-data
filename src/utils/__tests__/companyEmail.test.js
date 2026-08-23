import { describe, it, expect } from 'vitest';
import { isCompanyEmail } from '../companyEmail.js';

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
