import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Config, CompressionPolicy, LlmConfig } from './types.js';
import { LLM_PROVIDER_PRESETS, LLM_PROVIDER_NAMES, type LlmProviderName } from './pipeline/llm-presets.js';

const stdioDownstreamSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
});

const httpDownstreamSchema = z.object({
  url: z.string(),
  transport: z.literal('streamable-http').optional(),
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
});

const downstreamSchema = z.union([stdioDownstreamSchema, httpDownstreamSchema]);

const compressionPolicyPartialSchema = z.object({
  maxOutputTokens: z.number().optional(),
  htmlToMarkdown: z.boolean().optional(),
  stripBase64: z.boolean().optional(),
  jsonSummary: z.boolean().optional(),
  bypass: z.boolean().optional(),
  llmSummary: z.boolean().optional(),
});

const llmProviderSchema = z.enum(LLM_PROVIDER_NAMES as [LlmProviderName, ...LlmProviderName[]], {
  errorMap: () => ({
    message: `must be one of: ${LLM_PROVIDER_NAMES.join(', ')}`,
  }),
});

const llmConfigSchema = z.object({
  provider: llmProviderSchema.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  model: z.string(),
  timeoutMs: z.number().positive().optional(),
  maxInputChars: z.number().positive().optional(),
});

type RawLlmConfig = z.infer<typeof llmConfigSchema>;

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
  callToolTimeoutMs: z.number().positive().optional(),
  llm: llmConfigSchema.optional(),
});

export const DEFAULT_POLICY: CompressionPolicy = {
  maxOutputTokens: 2000,
  htmlToMarkdown: true,
  stripBase64: true,
  jsonSummary: true,
  bypass: false,
  llmSummary: false,
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

function resolveLlmConfig(
  raw: RawLlmConfig | undefined,
  path: string,
  onWarn?: (msg: string) => void
): LlmConfig | undefined {
  if (!raw) {
    return undefined;
  }

  const { provider, baseUrl, apiKey, model, timeoutMs, maxInputChars } = raw;

  if (!provider && !baseUrl) {
    throw new Error(
      `Invalid config file "${path}": llm requires either "provider" (one of: ${LLM_PROVIDER_NAMES.join(', ')}) or "baseUrl"`
    );
  }

  if (provider && baseUrl) {
    onWarn?.('llm: both "provider" and "baseUrl" set - using the explicit baseUrl');
  }

  let resolvedBaseUrl: string;
  let resolvedApiKey: string;

  if (baseUrl) {
    if (!apiKey) {
      throw new Error(`Invalid config file "${path}": llm.baseUrl is set but "apiKey" is missing`);
    }
    resolvedBaseUrl = baseUrl;
    resolvedApiKey = apiKey;
  } else {
    const preset = LLM_PROVIDER_PRESETS[provider as LlmProviderName];
    resolvedBaseUrl = preset.baseUrl;
    // Empty string counts as absent for both the explicit apiKey and the env var, so
    // e.g. `"apiKey": ""` falls through to the env var, and an env var set to "" is
    // treated the same as unset.
    const envKey = process.env[preset.apiKeyEnv];
    const candidate = apiKey || envKey;
    if (!candidate) {
      throw new Error(
        `Invalid config file "${path}": llm.provider "${provider}" requires environment variable ${preset.apiKeyEnv} (or an explicit "apiKey")`
      );
    }
    resolvedApiKey = candidate;
  }

  return {
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
    model,
    timeoutMs,
    maxInputChars,
  };
}

export function loadConfig(path: string, onWarn?: (msg: string) => void): Config {
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

  const parsedConfig = result.data;
  const resolvedLlm = resolveLlmConfig(parsedConfig.llm, path, onWarn);
  const config = { ...parsedConfig, llm: resolvedLlm } as Config;

  if (!config.llm) {
    const perServerLlmSummary = Object.values(config.compression?.perServer ?? {}).some(
      (p) => p.llmSummary === true
    );
    const perToolLlmSummary = Object.values(config.compression?.perTool ?? {}).some(
      (p) => p.llmSummary === true
    );
    if (config.compression?.default?.llmSummary === true || perServerLlmSummary || perToolLlmSummary) {
      throw new Error(
        `Invalid config file "${path}": llmSummary is enabled but no top-level "llm" block is configured`
      );
    }
  }

  return config;
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
