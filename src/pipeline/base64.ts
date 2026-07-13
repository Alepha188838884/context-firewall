import type { PipelineStage } from '../types.js';

// Below this length, a base64-looking run is more likely a short token/hash than an
// embedded binary worth extracting to the artifact store.
const MIN_BASE64_LENGTH = 1024;

// Matched first so we can pull the declared mime type out of the data URI prefix before
// falling back to the generic bare-block pattern below.
const DATA_URI_PATTERN = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})/g;
const BASE64_BLOCK_PATTERN = /[A-Za-z0-9+/]{1024,}={0,2}/g;

// Real base64 (of non-trivial binary data) mixes case and digits. A bare run of the base64
// alphabet that lacks that mix - repeated filler ('x'.repeat(N)), long hashes, minified JS
// identifiers - is more likely to be misclassified than to be an actual embedded blob, so it
// is left alone. Data URIs (matched separately above) carry their own "this is base64" signal
// via the `data:...;base64,` prefix and skip this check.
const LONG_SINGLE_CHAR_RUN_PATTERN = /(.)\1{128,}/;

// A single contiguous base64-alphabet run in the multi-megabyte range trips a known V8
// regex-engine limit (RangeError: Maximum call stack size exceeded) inside .replace() - not
// specific to this codebase, just how the backtracking/match bookkeeping scales at that size.
// runPipeline already catches that and falls back to truncate-only, so nothing crashes, but
// skipping this stage above the threshold avoids relying on the exception path at all - the
// truncate fallback was already going to discard content this large anyway.
const MAX_STAGE_INPUT_LENGTH = 2_000_000;

function looksLikeBase64(block: string): boolean {
  const hasUpper = /[A-Z]/.test(block);
  const hasLower = /[a-z]/.test(block);
  const hasDigit = /[0-9]/.test(block);
  if (!hasUpper || !hasLower || !hasDigit) {
    return false;
  }
  const hasBase64Special = /[+/=]/.test(block);
  return hasBase64Special || !LONG_SINGLE_CHAR_RUN_PATTERN.test(block);
}

function replacement(handle: string, mime: string, length: number): string {
  const sizeKB = Math.round(length / 1024);
  return `[binary data removed: ${mime}, ${sizeKB}KB base64 — retrieve: read_more("${handle}")]`;
}

export const stripBase64Stage: PipelineStage = {
  name: 'stripBase64',

  apply(input, policy, store, ctx) {
    if (!policy.stripBase64) {
      return { text: input.text, applied: false };
    }

    if (input.text.length > MAX_STAGE_INPUT_LENGTH) {
      return { text: input.text, applied: false };
    }

    let applied = false;

    // Pass 1: data URIs, so their declared mime type is captured before the generic pass.
    let text = input.text.replace(DATA_URI_PATTERN, (match, mime: string, data: string) => {
      if (data.length < MIN_BASE64_LENGTH) {
        return match;
      }
      applied = true;
      const handle = store.put(data, { server: ctx.server, tool: ctx.tool, mime });
      return replacement(handle, mime, data.length);
    });

    // Pass 2: bare base64 blocks not captured as part of a data URI above.
    text = text.replace(BASE64_BLOCK_PATTERN, (match) => {
      if (!looksLikeBase64(match)) {
        return match;
      }
      applied = true;
      const mime = 'application/base64';
      const handle = store.put(match, { server: ctx.server, tool: ctx.tool, mime });
      return replacement(handle, mime, match.length);
    });

    return { text, applied };
  },
};
