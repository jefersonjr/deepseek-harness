/** AWS profile selection and bounded Bedrock request policy. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Per-route Amazon Bedrock settings; credentials stay in the AWS profile. */
export interface BedrockConfig {
  /** Normal preserves Bedrock requests; failsafe bounds requests and recovers truncated replies. */
  mode?: 'normal' | 'failsafe'
  /** AWS shared-file profile; omitted uses AWS_PROFILE, then default. */
  profile?: string
  /** AWS region; omitted uses the environment and the selected profile. */
  region?: string
  /** Maximum UTF-8 bytes in each complete serialized request in failsafe mode. */
  maxRequestBytes?: number
  /** Maximum output tokens per failsafe request, including continuations. */
  maxOutputTokens?: number
  /** Minimum adaptive output budget; a smaller caller maxTokens remains authoritative. */
  minOutputTokens?: number
  /** Absolute duration of one attempt, including response streaming, in milliseconds. */
  requestDeadlineMs?: number
  /** Total duration of a generation, including retries, continuations and backoff, in milliseconds. */
  totalDeadlineMs?: number
  /** Total network attempts across retries and continuations for one generation. */
  maxTotalAttempts?: number
  /** Lifetime of recovered budgets in this adapter process, per configured route and model. */
  adaptiveTtlMs?: number
  /** Maximum additional requests after a token-limited response. */
  maxContinuations?: number
  /** Maximum corrective retries after a gateway failure, deadline or identified proxy size rejection. */
  maxRetries?: number
  /** Initial cancellable retry delay in milliseconds; subsequent waits use exponential backoff. */
  retryDelayMs?: number
  /** Fraction of the failed request size retained after a proxy size rejection or input recovery. */
  recoveryFactor?: number
  /** Fraction of the output budget retained after a gateway failure or deadline. */
  outputReductionFactor?: number
  /** Case-insensitive pattern for proxy size errors with HTTP 403; AWS authorization errors never qualify. */
  proxySizeErrorPattern?: string
  /** Maximum characters of the preceding response carried into a continuation. */
  continuationCharacters?: number
  /** Maximum characters retained from each tool result when the request needs compaction. */
  toolResultCharacters?: number
}

/** Bedrock configuration with every transport policy default resolved. */
export type ResolvedBedrockConfig = Required<Omit<BedrockConfig, 'profile' | 'region'>> & Pick<BedrockConfig, 'profile' | 'region'>

/** Configuration surface shared by profile persistence and the transport. */
export const BedrockConfigSchema: z<BedrockConfig> = z.object({
  mode: z.union(['normal', 'failsafe']).default('normal'),
  profile: z.string(),
  region: z.string(),
  maxRequestBytes: z.number().step(1).min(1).default(80000),
  maxOutputTokens: z.number().step(1).min(1).default(512),
  minOutputTokens: z.number().step(1).min(1).default(128),
  requestDeadlineMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(75000),
  totalDeadlineMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(600000),
  maxTotalAttempts: z.number().step(1).min(1).max(1000).default(12),
  adaptiveTtlMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(3600000),
  maxContinuations: z.number().step(1).min(0).max(100).default(8),
  maxRetries: z.number().step(1).min(0).max(10).default(3),
  retryDelayMs: z.number().step(1).min(0).max(60000).default(500),
  recoveryFactor: z.number().min(0.1).max(0.9).default(0.75),
  outputReductionFactor: z.number().min(0.1).max(0.9).default(0.5),
  proxySizeErrorPattern: z.string().default('(?:request|payload|body)[\\s\\S]*(?:too large|size limit|exceeds?[^\\n]*(?:size|limit|bytes))'),
  continuationCharacters: z.number().step(1).min(1).default(768),
  toolResultCharacters: z.number().step(1).min(1).default(1000),
})

/**
 * Resolve and validate a Bedrock route without reading credentials.
 * @param source - route-local options.
 * @returns the complete request policy.
 */
export function resolveBedrockConfig(source: BedrockConfig = {}): ResolvedBedrockConfig {
  if ('maxRequestCharacters' in source) {
    throw new Error('llm-pi-ai: bedrock.maxRequestCharacters was replaced by maxRequestBytes (UTF-8 bytes, default 80000); remove the old field and set the byte budget explicitly')
  }
  const value = BedrockConfigSchema(source) as ResolvedBedrockConfig
  for (const key of ['maxRequestBytes', 'maxOutputTokens', 'minOutputTokens', 'requestDeadlineMs', 'totalDeadlineMs', 'maxTotalAttempts', 'adaptiveTtlMs', 'maxContinuations', 'maxRetries', 'retryDelayMs', 'continuationCharacters', 'toolResultCharacters'] as const) {
    if (!Number.isSafeInteger(value[key])) throw new Error(`llm-pi-ai: bedrock.${key} must be a safe integer`)
  }
  if (value.minOutputTokens > value.maxOutputTokens) throw new Error('llm-pi-ai: bedrock.minOutputTokens must not exceed maxOutputTokens')
  if (value.proxySizeErrorPattern.trim().length === 0) throw new Error('llm-pi-ai: bedrock.proxySizeErrorPattern must not be empty')
  try { new RegExp(value.proxySizeErrorPattern, 'i') } catch (cause) {
    throw new Error('llm-pi-ai: bedrock.proxySizeErrorPattern must be a valid regular expression', { cause })
  }
  for (const key of ['profile', 'region'] as const) {
    if (value[key] !== undefined && value[key].trim().length === 0) {
      throw new Error(`llm-pi-ai: bedrock.${key} must not be empty`)
    }
  }
  return value
}
