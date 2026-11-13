import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'data/schemas/wireline_log.json'), 'utf8'));
const hints = JSON.parse(fs.readFileSync(path.join(root, 'data/classifier-hints/wireline_log.json'), 'utf8'));

type Node = Record<string, any>;

/** Every object node, with its JSON path. */
function objects(node: Node, at = '$'): Array<[string, Node]> {
  if (!node || typeof node !== 'object') return [];
  const out: Array<[string, Node]> = [];
  if (node.type === 'object') out.push([at, node]);
  for (const [k, v] of Object.entries(node.properties || {})) out.push(...objects(v as Node, `${at}.${k}`));
  if (node.items) out.push(...objects(node.items, `${at}[]`));
  for (const alt of node.anyOf || []) out.push(...objects(alt, at));
  return out;
}

describe('wireline_log schema (OpenAI strict mode)', () => {
  it('every object is closed and requires all of its properties', () => {
    const bad = objects(schema).filter(([, o]) =>
      o.additionalProperties !== false ||
      JSON.stringify([...(o.required || [])].sort()) !== JSON.stringify(Object.keys(o.properties || {}).sort())
    );
    expect(bad.map(([p]) => p)).toEqual([]);
  });

  it('has no x-* keys (they are stripped at registration and never reach the model)', () => {
    expect(JSON.stringify(schema)).not.toMatch(/"x-[a-z-]+"\s*:/);
  });

  it('carries the keys the demo quality check and pipeline expect', () => {
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining([
      'well_identification', 'log_runs', 'curves', 'extraction_metadata',
    ]));
  });
});

describe('wireline_log classifier hints', () => {
  it('only uses keys the classifier reads', () => {
    expect(Object.keys(hints).sort()).toEqual(['keep_when', 'record_id_guidance', 'skip_when']);
    expect(hints.keep_when.length).toBeGreaterThan(0);
    expect(typeof hints.record_id_guidance).toBe('string');
  });
});
