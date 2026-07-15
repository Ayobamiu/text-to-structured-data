# Section QA Overhaul — Handoff

_Last updated: 2026-07-01. Companion web-repo changes: `web/src/lib/jsonPath.ts`, `web/src/lib/api.ts`, `web/src/components/ui/TabbedDataViewer.tsx`, `web/src/components/registry/SchemaRegistryAdmin.tsx`._

## Problem

Post-extraction QA (`sectionQAService.js`) sent the whole extraction record + page images to `gpt-4o-mini` in one call with a generic prompt. Findings were low-signal:

1. Trivial fields flagged (`total_pages`) while real misses went uncaught.
2. Outright wrong findings (fabricated discrepancies).
3. Type confusion — boolean `false` flagged against a page label "Yes"; enum fields "corrected" to illegal values (`sample_type: "water sample"`).
4. Row-level problems (fabricated/missing table rows) were diagnosable but not fixable — no Apply path.

## Architecture now

**One QA call per top-level schema group** (`lithology_intervals`, `samples_collected`, …), orchestrated by `runGroupedQA` in `src/services/sectionQAService.js`:

- Each call carries the group's **full sub-schema verbatim** (enums/types always visible — the old whole-record prompt truncated schemas > ~6KB via `schemaToPromptBlock`'s size guard, which silently dropped the borehole_log schema entirely; that guard only applies to the legacy fallback path now).
- Plus: the group's extracted data, the **full record as read-only context** (for cross-field checks), page images, and that group's `qa_hints`.
- Calls run at concurrency 3; one failed group degrades to a warning, all-failed throws.
- Legacy single-call path survives only as fallback when no schema is registered for the slug.

**Prompt-caching layout** (cost control): every group call shares a byte-identical prefix — generic system prompt (`buildGroupQACachedSystemPrompt`) → full record + page images (`buildGroupQASharedUserText`) — with the group-specific instruction (`buildGroupQAGroupInstruction`) **last**. OpenAI bills the cached prefix (~all the image tokens) at ~10x cheaper for calls 2..N. The first group call runs alone to warm the cache before the rest fan out (concurrent identical-prefix requests all miss an unwarmed cache). Watch `cached_tokens` in the per-section log line to confirm caching is landing.

**Model**: `QA_MODEL` env var wins over the code default (`gpt-5.5` in `sectionQAService.js`). `.env` currently pins `gpt-5.5`. Per-request override via `model` in the request body still works (`/files/:id/sections/:sectionResultId/qa`).

## Trust model: never believe the model, verify everything

`verifyFindingAgainstRecord(issue, record, rootSchema)` re-checks every finding server-side before it reaches the UI:

- `actual` is **overwritten** with the real value read from the record (`readFieldPath`) — the model routinely misquotes it to manufacture discrepancies.
- **Boolean synonyms**: `qaValuesEqual` treats yes/no/checked/x-style labels as equal to real booleans (drops the "false vs 'No'" false-positive class).
- **`corrected_value`** (typed: string/number/boolean/null) is the applyable answer, distinct from `expected` (verbatim page-evidence quote — e.g. evidence "EOB = 68.0 FEET" ⇒ corrected_value `true` for a boolean `eob`). Comparison is type-strict, not string-coerced.
- **Enum backstop**: an illegal enum correction is normalized (`"Hollow Stem Auger"` → `hollow_stem_auger`) or stripped to null — never surfaced as clickable-but-illegal. (`resolveSchemaForPath` / `extractEnumValues` / `coerceToEnum`.)
- **Row ops** (`add_row`/`update_row`/`delete_row`): array must really exist, `row_index` in range (numeric strings coerced), `row_value` must parse, unknown keys stripped against the item schema, no-op updates and duplicate adds dropped. Also tolerates the model bracketing an index onto `field` (`lithology_intervals[3]`) even though the prompt says bare path — a real production failure where all 5 findings of a run were silently dropped.
- **`overall_quality` + `summary` are computed from verified findings** (`deriveQualityFromFindings`/`buildFindingsSummary`), not the model's self-report — fixes "poor, 5 errors" banners next to 0 findings.

## qa_hints (per-document-type steering, no deploy needed)

`document_types.qa_hints` jsonb, keyed by top-level schema property; mirrors the `classifier_hints` pattern. Shape per group: `{ priority: critical|high|normal|low, ignore: [field,...], notes: "...", skip: true }`. `skip: true` = no call at all (zero cost).

- Registry fns: `getQAHints/setQAHints/clearQAHints` in `schemaRegistry.js` (replace-not-merge, like classifier hints).
- Route: `PUT /registry/document-types/:slug/qa-hints` (admin). UI: "QA hints" tab in SchemaRegistryAdmin.
- **Live state**: `borehole_log` has all 12 groups configured; `extraction_metadata` is `skip: true` → 11 calls/section.

## Row-level fixes end-to-end

New issue types `add_row`/`update_row`/`delete_row` carry `row_index` + `row_value` (JSON-encoded row). Web Apply flow: `insertAtPath`/`removeAtPath`/`setByPath` in `jsonPath.ts`, op-specific button labels + Popconfirm (they change array length/order), row previews in the findings panel. Same review-then-Save flow as scalar Apply — **nothing auto-saves**.

Frontend Apply nuance: `corrected_value === null` from the API means "no usable correction" (SQL NULL), **not** "the answer is null" — Apply falls back to `coerceExpected(expected, current)` in that case. Getting this wrong regressed Apply for all pre-`corrected_value` findings once already.

## DB changes (all applied to the dev DB via `DATABASE_URL=$DEV_DATABASE_URL node migrations/<file>`)

| Migration | What |
|---|---|
| `add_qa_hints_to_document_types.js` | `document_types.qa_hints` jsonb NOT NULL DEFAULT '{}' |
| `add_corrected_value_to_section_qa_findings.js` | `section_qa_findings.corrected_value` jsonb (nullable) |
| `add_row_ops_to_section_qa_findings.js` | `row_index` int + `row_value` jsonb; widens `issue_type` CHECK; **rebuilds the uniqueness constraint as `UNIQUE NULLS NOT DISTINCT (file_id, section_result_id, field_path, issue_type, row_index)`** — plain UNIQUE would break scalar-finding dedupe (NULL ≠ NULL), and without row_index two delete_rows on the same array clobber each other via upsert |

## Gotchas / footguns

- `saveQAFindings` **deletes all `status='open'` findings for the section on every call** (dismissed/accepted survive). Correct for real runs; destructive if you call it as a test harness against live sections — a real open finding was lost this way once. Test against synthetic section IDs only.
- `*.test.js` is **gitignored** (`.gitignore:186`) — `src/services/__tests__/sectionQAService.test.js` must be `git add -f`'d.
- `clearClassifierHints` sets a NOT NULL column to NULL → will throw if ever called (pre-existing bug, flagged separately; `clearQAHints` correctly resets to `'{}'`).
- Two pre-existing failing test *suites* (`queryTranslator*.test.js`) — jest-vs-vitest import issue, unrelated to QA.

## Verify

```bash
cd ai
npx vitest run src/services/__tests__/sectionQAService.test.js   # 63 tests
npx tsc --noEmit
```

Real-world check: run QA on file `1ac7c59b-...` (American Hydrogeology closure report) section `b3964471-...` — known to contain fabricated lithology rows; expect `delete_row` findings with in-range indices and legal enum corrections, and `cached_tokens > 0` on calls 2+ in the log line.

## Open items

- Re-validate on the known-bad sections above with the per-group + caching pipeline (each run costs real gpt-5.5 tokens).
- Cost levers if needed, in order: more `skip: true` groups → batch normal/low-priority groups into one call → model tiering per priority (`model` plumbing already per-call).
- Under discussion: using gpt-5.5 vision **for extraction itself** (image → structured data, bypassing ExtendAI text extraction). Candidate path: add as a new extractor behind the existing `document_types.default_extractor` switch and A/B against extendai using this QA tool as judge. Not started.

---

# Production-feedback round (2026-07-12 → 07-13)

Fixes for the five production complaints. Branches (local, committed, not pushed):
**ai `feat/qa-reliability-telemetry`** (4a6a033 → 08377a1), **web `feat/qa-apply-anchor`** (99e52ea → e0bb0c3). Merge ai first; web's bulk-apply works against an old backend but anchors need findings that carry `actual` (all per-group findings do).

## What changed

| Complaint | Fix | Switch |
|---|---|---|
| Apply order corrupted rows (delete 6 → "update 7" hit row 8) | Apply resolves row ops by content anchor (`finding.actual`): match / relocate-if-unique / refuse. Sibling open findings re-indexed after structural applies | always on (it's correctness) |
| Review slower than manual | "Review & apply all (N)" in the findings panel → before/after modal (strikethrough → green), untick to exclude, one confirm, one Save. Stale rows pre-excluded with reason | button appears at ≥2 applyable findings; "mark accepted" checkbox in modal (default ON) |
| Token expensive | Group batching: critical/high `qa_hints` groups keep solo calls, rest share batch calls. Validated: 3/3 recall, 29% cheaper, faster. Savings grow as groups move to `normal` priority | `QA_GROUP_BATCHING` in .env (now `true`); `QA_BATCH_MAX_GROUPS` (default 8); per-request `batchGroups` overrides env |
| 8-section run threw midway | 3-attempt exponential backoff on 429/5xx/timeout per call + global semaphore across sections | `QA_GLOBAL_CONCURRENCY` (default 6) |
| (diagnosis) caching unreliable | Probes proved OpenAI drops big image-bearing prefixes (hit→miss on identical sequential calls). `prompt_cache_key` pinned per section + per-call `qa-call` token log lines. Prefix ≈ 83% of prompt spend ⇒ batching is the deterministic lever | n/a |

`section_qa_runs.tokens` jsonb persists per-run token totals (migration applied 2026-07-13).

## How to test

1. **Anchored apply (the corruption fix)** — section with row findings on one array:
   apply a `delete_row`, then any `update_row`/`delete_row` BELOW it → labels re-number
   live; apply lands on the right row (message notes "row moved from N to M" when
   relocated). Apply the same finding twice → second refuses ("row changed since QA ran").
2. **Bulk apply** — section with ≥2 findings → "Review & apply all" → untick one, confirm
   → JSON updated for ticked only, unticked stays open, applied ones flip to accepted
   (if checkbox on) → Save. Then re-run QA: expect far fewer/no findings.
3. **Batching quality** — before trusting it on a NEW doc type:
   `node scripts/qaReplayHarness.mjs --compare --batch --limit 3` (dry run, ~2x section
   cost) → bar: 100% recall on error-severity, judge extras by eye. Turn off anytime with
   `QA_GROUP_BATCHING=false`.
4. **Batch resilience** — run QA on many sections at once; per-call 429s retry with
   backoff (watch for "attempt 2/3" warnings); total concurrent OpenAI calls capped at 6.
5. **Cost telemetry** — `select section_result_id, qa_model, tokens from section_qa_runs
   order by last_qa_at desc limit 10;` — compare `total_tokens` before/after flipping
   batching; `qa-call` log lines show per-call prompt/cached/completion.

## Judgment calls made without asking (each has an off switch)

- `QA_GROUP_BATCHING=true` in ai/.env — validated 3/3 recall but only on borehole_log; set `false` to revert.
- Bulk-apply modal defaults "mark applied findings as accepted" ON — untick in the modal.
- Batched calls keep full gpt-5.5 (no model tiering yet) — tiering left for after a week of tokens telemetry; harness supports `--model X --compare` when ready.
- Solo-call threshold = `critical|high` priority; tune per doc type via qa_hints priorities (more `normal` = cheaper).
