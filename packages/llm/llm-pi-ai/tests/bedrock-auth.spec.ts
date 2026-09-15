import { describe, expect, it } from 'vitest'
import { bedrockProfileAuth } from '../src/bedrock-auth.ts'
import type { BedrockConfig } from '../src/bedrock-config.ts'
import type { ApiKeyAuth, ApiKeyCredential } from '@earendil-works/pi-ai'

async function resolve(config: BedrockConfig, env: Record<string, string> = {}, credential?: ApiKeyCredential) {
  const original: ApiKeyAuth = { name: 'original', resolve: () => { throw new Error('ambient bearer authentication must not run') } }
  return bedrockProfileAuth(config, original).resolve({
    ctx: { env: name => Promise.resolve(env[name]), fileExists: () => Promise.resolve(false) },
    signal: new AbortController().signal,
    ...credential === undefined ? {} : { credential },
  })
}

describe('AWS profile authentication', () => {
  it('uses the default machine profile without requiring an API key', async () => {
    const result = await resolve({ region: 'us-east-1' })
    expect(result).toMatchObject({ auth: {}, env: { AWS_PROFILE: 'default', AWS_REGION: 'us-east-1' } })
  })

  it('honors a route profile ahead of stored and ambient credentials', async () => {
    const result = await resolve({ profile: 'controlled', region: 'sa-east-1' }, {
      AWS_PROFILE: 'ambient', AWS_BEARER_TOKEN_BEDROCK: 'test-ambient-token', AWS_REGION: 'us-west-2',
    }, { type: 'api_key', key: 'test-stored-token', env: { AWS_PROFILE: 'stored' } })
    expect(result?.env).toMatchObject({ AWS_PROFILE: 'controlled', AWS_REGION: 'sa-east-1', AWS_BEARER_TOKEN_BEDROCK: '', AWS_BEDROCK_SKIP_AUTH: '' })
    expect(JSON.stringify(result)).not.toContain('test-')
  })

  it('honors AWS_PROFILE and AWS_REGION without copying access keys', async () => {
    const result = await resolve({}, { AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret' })
    expect(result?.env).toMatchObject({ AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1' })
    expect(JSON.stringify(result)).not.toContain('test-')
  })
})
