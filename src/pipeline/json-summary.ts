import type { PipelineStage } from '../types.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_STRING_LENGTH = 500;
const STRING_KEEP_LENGTH = 200;
const MAX_DEPTH = 6;
const ARRAY_COLLAPSE_THRESHOLD = 10;
const ARRAY_KEEP_COUNT = 5;
const SHAPE_SIMILARITY_THRESHOLD = 0.7;
const SHAPE_SAMPLE_SIZE = 3;

function isPlainObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) {
    return 1;
  }
  let intersectionSize = 0;
  for (const key of a) {
    if (b.has(key)) {
      intersectionSize++;
    }
  }
  return intersectionSize / union.size;
}

// Same-shape check is sampled (first 3 elements) rather than exhaustive - good enough to
// tell "array of records" from "mixed bag" without scanning huge arrays element by element.
function isHomogeneousObjectArray(arr: Json[]): boolean {
  if (arr.length <= ARRAY_COLLAPSE_THRESHOLD) {
    return false;
  }

  const sampleCount = Math.min(SHAPE_SAMPLE_SIZE, arr.length);
  const keySets: Set<string>[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const el = arr[i] as Json;
    if (!isPlainObject(el)) {
      return false;
    }
    keySets.push(new Set(Object.keys(el)));
  }

  for (let i = 1; i < keySets.length; i++) {
    if (jaccard(keySets[0], keySets[i]) < SHAPE_SIMILARITY_THRESHOLD) {
      return false;
    }
  }
  return true;
}

function summarize(value: Json, depth: number, fullHandle: string): Json {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, STRING_KEEP_LENGTH)}…[${value.length} chars total]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (depth > MAX_DEPTH) {
      return '…[nested object, depth>6]';
    }
    if (isHomogeneousObjectArray(value)) {
      const kept = value.slice(0, ARRAY_KEEP_COUNT).map((v) => summarize(v, depth + 1, fullHandle));
      const remaining = value.length - ARRAY_KEEP_COUNT;
      return [
        ...kept,
        `…(${remaining} more items with same shape; full data: read_more("${fullHandle}"))`,
      ];
    }
    return value.map((v) => summarize(v, depth + 1, fullHandle));
  }

  if (isPlainObject(value)) {
    if (depth > MAX_DEPTH) {
      return '…[nested object, depth>6]';
    }
    const result: { [key: string]: Json } = {};
    for (const [key, v] of Object.entries(value)) {
      result[key] = summarize(v, depth + 1, fullHandle);
    }
    return result;
  }

  return value;
}

export const jsonSummaryStage: PipelineStage = {
  name: 'jsonSummary',

  apply(input, policy, _store, ctx) {
    if (!policy.jsonSummary) {
      return { text: input.text, applied: false };
    }

    const trimmed = input.text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return { text: input.text, applied: false };
    }

    let parsed: Json;
    try {
      parsed = JSON.parse(trimmed) as Json;
    } catch {
      return { text: input.text, applied: false };
    }

    const summarized = summarize(parsed, 0, ctx.fullHandle);
    const output = JSON.stringify(summarized, null, 1);

    if (output.length >= input.text.length) {
      return { text: input.text, applied: false };
    }

    return { text: output, applied: true };
  },
};
