import type { ArtifactStore } from './artifacts.js';

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

/**
 * One step in the compression pipeline. Stages run in sequence, each receiving the previous
 * stage's output text.
 */
export interface PipelineStage {
  name: string;
  apply(
    input: { text: string; mimeHint?: 'json' | 'html' | 'text' },
    policy: CompressionPolicy,
    store: ArtifactStore,
    ctx: { server: string; tool: string; fullHandle: string }
  ): { text: string; applied: boolean };
}

export interface CallStats {
  server: string;
  tool: string;
  charsBefore: number;
  charsAfter: number;
  stagesApplied: string[];
  bypassed: 'security' | 'policy' | 'small' | null;
  fullHandle?: string;
}
