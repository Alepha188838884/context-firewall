export interface CompressionPolicy {
  maxOutputTokens: number;
  htmlToMarkdown: boolean;
  stripBase64: boolean;
  jsonSummary: boolean;
  bypass: boolean;
}

export interface StdioDownstreamConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpDownstreamConfig {
  url: string;
  transport?: 'streamable-http';
}

export type DownstreamConfig = StdioDownstreamConfig | HttpDownstreamConfig;

export interface Config {
  downstreams: Record<string, DownstreamConfig>;
  compression?: {
    default?: Partial<CompressionPolicy>;
    perServer?: Record<string, Partial<CompressionPolicy>>;
    perTool?: Record<string, Partial<CompressionPolicy>>;
  };
  report?: {
    enabled?: boolean;
    markdownPath?: string;
  };
}
