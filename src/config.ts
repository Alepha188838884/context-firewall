import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Config, CompressionPolicy } from './types.js';

const stdioDownstreamSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const httpDownstreamSchema = z.object({
  url: z.string(),
  transport: z.literal('streamable-http').optional(),
});

const downstreamSchema = z.union([stdioDownstreamSchema, httpDownstreamSchema]);

const compressionPolicyPartialSchema = z.object({
  maxOutputTokens: z.number().optional(),
  htmlToMarkdown: z.boolean().optional(),
  stripBase64: z.boolean().optional(),
  jsonSummary: z.boolean().optional(),
  bypass: z.boolean().optional(),
});

const configSchema = z.object({
  downstreams: z
    .record(z.string(), downstreamSchema)
    .refine((obj) => Object.keys(obj).length > 0, {
      message: 'downstreams must contain at least 1 entry',
    }),
  compression: z
    .object({
      default: compressionPolicyPartialSchema.optional(),
      perServer: z.record(z.string(), compressionPolicyPartialSchema).optional(),
      perTool: z.record(z.string(), compressionPolicyPartialSchema).optional(),
    })
    .optional(),
  report: z
    .object({
      enabled: z.boolean().optional(),
      markdownPath: z.string().optional(),
    })
    .optional(),
});

export const DEFAULT_POLICY: CompressionPolicy = {
  maxOutputTokens: 2000,
  htmlToMarkdown: true,
  stripBase64: true,
  jsonSummary: true,
  bypass: false,
};

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnvVars(value: unknown, path: string): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_PATTERN, (_match, name: string) => {
      const envValue = process.env[name];
      if (envValue === undefined) {
        throw new Error(`Missing environment variable "${name}" referenced at ${path || '(root)'}`);
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => expandEnvVars(item, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = expandEnvVars(val, path ? `${path}.${key}` : key);
    }
    return result;
  }
  return value;
}

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config file "${path}" as JSON: ${(err as Error).message}`);
  }

  const expanded = expandEnvVars(parsed, '');

  const result = configSchema.safeParse(expanded);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid config file "${path}": ${details}`);
  }

  return result.data as Config;
}

export function resolvePolicy(config: Config, server: string, tool: string): CompressionPolicy {
  const perToolKey = `${server}/${tool}`;
  return {
    ...DEFAULT_POLICY,
    ...config.compression?.default,
    ...config.compression?.perServer?.[server],
    ...config.compression?.perTool?.[perToolKey],
  };
}
