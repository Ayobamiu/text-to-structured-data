import { describe, it, expect } from 'vitest';
import { demoAppOrigin, demoDownloadUrl, demoReplyTo } from '../demoNotify.js';

describe('demo download links', () => {
    it('builds a frontend download URL, not a raw API export', () => {
        const url = demoDownloadUrl(
            '11111111-1111-1111-1111-111111111111',
            'abc+def',
        );
        expect(url).toContain('/try/11111111-1111-1111-1111-111111111111/download?token=');
        expect(url).toContain('abc%2Bdef');
        expect(url).not.toContain('/demo/sessions');
        expect(url.startsWith(demoAppOrigin())).toBe(true);
    });

    it('defaults Reply-To to the human inbox, not the send subdomain', () => {
        const prev = process.env.DEMO_REPLY_TO;
        delete process.env.DEMO_REPLY_TO;
        expect(demoReplyTo()).toBe('hello@coreextract.app');
        process.env.DEMO_REPLY_TO = 'ops@coreextract.app';
        expect(demoReplyTo()).toBe('ops@coreextract.app');
        if (prev == null) delete process.env.DEMO_REPLY_TO;
        else process.env.DEMO_REPLY_TO = prev;
    });
});
