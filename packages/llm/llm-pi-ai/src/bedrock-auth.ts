/** AWS shared-profile authentication without copying AWS secrets into settings. */
import type { ApiKeyAuth } from '@earendil-works/pi-ai'
import type { BedrockConfig } from './bedrock-config.ts'

/**
 * Prefer an explicitly selected or local default AWS profile over ambient bearer tokens.
 * @param config - route-local AWS profile and region.
 * @param original - installed Bedrock authentication flow.
 * @returns authentication that leaves credential loading and refresh to the AWS SDK.
 */
export function bedrockProfileAuth(config: BedrockConfig, original: ApiKeyAuth): ApiKeyAuth {
  return {
    ...original,
    name: 'AWS profile',
    async resolve({ ctx, credential, signal }) {
      signal.throwIfAborted()
      const profile = config.profile || credential?.env?.AWS_PROFILE || await ctx.env('AWS_PROFILE') || 'default'
      const configuredRegion = config.region || await ctx.env('AWS_REGION') || await ctx.env('AWS_DEFAULT_REGION') || undefined
      const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime')
      const client = new BedrockRuntimeClient({ profile, ...configuredRegion === undefined ? {} : { region: configuredRegion } })
      let region: string
      try {
        region = await client.config.region()
      } finally {
        client.destroy()
      }
      signal.throwIfAborted()
      return {
        auth: {},
        env: {
          AWS_PROFILE: profile,
          AWS_REGION: region,
          AWS_BEARER_TOKEN_BEDROCK: '',
          AWS_BEDROCK_SKIP_AUTH: '',
        },
        source: `AWS profile ${profile}`,
      }
    },
  }
}
