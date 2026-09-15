/** AWS profile selection and bounded Bedrock request policy. */
import z from '@deepseek-ai/schemastery'

/** Per-route Amazon Bedrock settings; credentials stay in the AWS profile. */
export interface BedrockConfig {
  /** Normal preserves Bedrock requests; failsafe bounds requests and recovers truncated replies. */
  mode?: 'normal' | 'failsafe'
  /** AWS shared-file profile; omitted uses AWS_PROFILE, then default. */
  profile?: string
  /** AWS region; omitted uses the environment and the selected profile. */
  region?: string
  /** Maximum Unicode characters in each complete serialized JSON request in failsafe mode. */
  maxRequestCharacters?: number
  /** Maximum output tokens per failsafe request, including continuations. */
  maxOutputTokens?: number
  /** Maximum additional requests after a token-limited response. */
  maxContinuations?: number
  /** Maximum corrective retries after HTTP 502 for one request. */
  maxRetries?: number
  /** Initial cancellable retry delay in milliseconds; subsequent waits use exponential backoff. */
  retryDelayMs?: number
  /** Fraction of the previous request and output budgets retained after HTTP 502. */
  recoveryFactor?: number
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
  maxRequestCharacters: z.number().step(1).min(1).default(5000),
  maxOutputTokens: z.number().step(1).min(1).default(1024),
  maxContinuations: z.number().step(1).min(0).max(100).default(8),
  maxRetries: z.number().step(1).min(0).max(10).default(3),
  retryDelayMs: z.number().step(1).min(0).max(60000).default(500),
  recoveryFactor: z.number().min(0.1).max(0.9).default(0.75),
  continuationCharacters: z.number().step(1).min(1).default(768),
  toolResultCharacters: z.number().step(1).min(1).default(1000),
})

/**
 * Resolve and validate a Bedrock route without reading credentials.
 * @param source - route-local options.
 * @returns the complete request policy.
 */
export function resolveBedrockConfig(source: BedrockConfig = {}): ResolvedBedrockConfig {
  const value = BedrockConfigSchema(source) as ResolvedBedrockConfig
  for (const key of ['maxRequestCharacters', 'maxOutputTokens', 'maxContinuations', 'maxRetries', 'retryDelayMs', 'continuationCharacters', 'toolResultCharacters'] as const) {
    if (!Number.isSafeInteger(value[key])) throw new Error(`llm-pi-ai: bedrock.${key} must be a safe integer`)
  }
  for (const key of ['profile', 'region'] as const) {
    if (value[key] !== undefined && value[key].trim().length === 0) {
      throw new Error(`llm-pi-ai: bedrock.${key} must not be empty`)
    }
  }
  return value
}
