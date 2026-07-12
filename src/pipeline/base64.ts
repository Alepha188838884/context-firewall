import type { PipelineStage } from '../types.js';

// Below this length, a base64-looking run is more likely a short token/hash than an
// embedded binary worth extracting to the artifact store.
const MIN_BASE64_LENGTH = 1024;

// Matched first so we can pull the declared mime type out of the data URI prefix before
// falling back to the generic bare-block pattern below.
const DATA_URI_PATTERN = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})/g;
const BASE64_BLOCK_PATTERN = /[A-Za-z0-9+/]{1024,}={0,2}/g;

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
      applied = true;
      const mime = 'application/base64';
      const handle = store.put(match, { server: ctx.server, tool: ctx.tool, mime });
      return replacement(handle, mime, match.length);
    });

    return { text, applied };
  },
};
