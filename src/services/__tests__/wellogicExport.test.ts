import { describe, it, expect } from 'vitest';
import { formatGrainSize } from '../wellogicExport.ts';

describe('formatGrainSize', () => {
    it('renders fraction + percent pairs as a readable string', () => {
        expect(formatGrainSize([{ percent: 85, fraction: 'sand' }, { percent: 5, fraction: 'silt_clay' }, { percent: 5, fraction: 'fine_gravel' }]))
            .toBe('sand 85%, silt_clay 5%, fine_gravel 5%');
        expect(formatGrainSize([{ percent: 100, fraction: 'sand' }])).toBe('sand 100%');
    });

    it('handles fractions without a percent', () => {
        expect(formatGrainSize([{ fraction: 'sand' }, { fraction: 'gravel', percent: 10 }])).toBe('sand, gravel 10%');
    });

    it('returns empty string for empty/invalid input', () => {
        expect(formatGrainSize([])).toBe('');
        expect(formatGrainSize(null)).toBe('');
        expect(formatGrainSize(undefined)).toBe('');
        expect(formatGrainSize('sand')).toBe('');
    });
});
