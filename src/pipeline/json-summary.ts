import type { PipelineStage } from '../types.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_STRING_LENGTH = 500;
const STRING_KEEP_LENGTH = 200;
const MAX_DEPTH = 6;
const ARRAY_COLLAPSE_THRESHOLD = 10;
const ARRAY_KEEP_COUNT = 5;
const OBJECT_COLLAPSE_THRESHOLD = 20;
const OBJECT_KEEP_COUNT = 5;
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

// Shared by the array-of-records and large-object-of-records homogeneity checks below: sample
// values, and confirm they're plain objects with >=70% Jaccard key overlap with the first
// sample. Good enough to tell "same shape" from "mixed bag" without an exhaustive scan.
function sampledShapesMatch(sample: Json[]): boolean {
  const keySets: Set<string>[] = [];
  for (const el of sample) {
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

// Same-shape check is sampled (first 3 elements) rather than exhaustive - good enough to
// tell "array of records" from "mixed bag" without scanning huge arrays element by element.
function isHomogeneousObjectArray(arr: Json[]): boolean {
  if (arr.length <= ARRAY_COLLAPSE_THRESHOLD) {
    return false;
  }
  return sampledShapesMatch(arr.slice(0, Math.min(SHAPE_SAMPLE_SIZE, arr.length)));
}

// Same idea as isHomogeneousObjectArray, but for a large *object* whose values are all
// same-shaped records (e.g. an API response keyed by ID/version - "versions": { "1.0.0": {...},
// "1.0.1": {...}, ... } - a common real-world shape that a homogeneous-array check alone never
// catches, since the collection here is the object's values, not array elements).
function isHomogeneousValueMap(obj: { [key: string]: Json }): boolean {
  const keys = Object.keys(obj);
  if (keys.length <= OBJECT_COLLAPSE_THRESHOLD) {
    return false;
  }
  const sampleKeys = keys.slice(0, Math.min(SHAPE_SAMPLE_SIZE, keys.length));
  return sampledShapesMatch(sampleKeys.map((k) => obj[k] as Json));
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
    if (isHomogeneousValueMap(value)) {
      const keys = Object.keys(value);
      const result: { [key: string]: Json } = {};
      for (const key of keys.slice(0, OBJECT_KEEP_COUNT)) {
        result[key] = summarize(value[key] as Json, depth + 1, fullHandle);
      }
      const remaining = keys.length - OBJECT_KEEP_COUNT;
      result['…'] = `(${remaining} more keys with same value shape; full data: read_more("${fullHandle}"))`;
      return result;
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
