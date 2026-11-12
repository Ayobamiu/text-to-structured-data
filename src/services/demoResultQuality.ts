/**
 * How much the demo actually extracted, so the page can offer a human
 * review instead of showing a near-empty record (e.g. a 16-ft log strip the
 * model could not read came back with one field filled).
 *
 * Counts non-empty strings/numbers, skipping booleans, run metadata, and
 * placeholder values the extractor writes when it found nothing.
 */

export type DemoResultQuality = 'empty' | 'thin' | 'ok';

/** Fewer filled fields than this across all records reads as "thin". */
export const THIN_FIELD_THRESHOLD = 6;

const SKIP_KEYS = new Set(['extraction_metadata', 'section_result_id']);
const PLACEHOLDERS = new Set(['', 'unknown', 'not_present', 'null', 'n/a', 'none', '—', '-']);

export function countFilledFields(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? 1 : 0;
  if (typeof value === 'string') return PLACEHOLDERS.has(value.trim().toLowerCase()) ? 0 : 1;
  if (typeof value === 'boolean') return 0;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countFilledFields(v), 0);
  if (typeof value === 'object') {
    let n = 0;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SKIP_KEYS.has(key)) continue;
      n += countFilledFields(v);
    }
    return n;
  }
  return 0;
}

export function assessDemoResult(records: Array<{ data: unknown }>): {
  quality: DemoResultQuality;
  filledFields: number;
} {
  if (!records || records.length === 0) return { quality: 'empty', filledFields: 0 };
  const filledFields = records.reduce((n, r) => n + countFilledFields(r.data), 0);
  if (filledFields === 0) return { quality: 'empty', filledFields };
  return { quality: filledFields < THIN_FIELD_THRESHOLD ? 'thin' : 'ok', filledFields };
}
