// Known-provider shorthand for the `llm` config block: instead of specifying `baseUrl` +
// `apiKey` by hand, `provider` picks a preset baseUrl and a default env var to read the API
// key from (see src/config.ts for the resolution rules). Any OpenAI-compatible endpoint not
// listed here can still be configured directly via `baseUrl`.
export const LLM_PROVIDER_PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  orcarouter: { baseUrl: 'https://api.orcarouter.ai/v1', apiKeyEnv: 'ORCAROUTER_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
} as const;

export type LlmProviderName = keyof typeof LLM_PROVIDER_PRESETS;

export const LLM_PROVIDER_NAMES = Object.keys(LLM_PROVIDER_PRESETS) as LlmProviderName[];
