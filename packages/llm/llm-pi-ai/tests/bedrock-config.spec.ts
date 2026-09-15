import { describe, expect, it } from 'vitest'
import { Config, resolveProfiles } from '../src/config.ts'
import { resolveBedrockConfig } from '../src/bedrock-config.ts'

describe('Bedrock profiles', () => {
  it('defaults to normal and exposes a configurable 80000-byte failsafe budget', () => {
    expect(resolveBedrockConfig()).toMatchObject({ mode: 'normal', maxRequestBytes: 80000 })
    expect(resolveBedrockConfig({ mode: 'failsafe', maxRequestBytes: 7200 })).toMatchObject({ mode: 'failsafe', maxRequestBytes: 7200 })
  })

  it('does not add AWS configuration to non-Bedrock providers', () => {
    const raw = Config({ providers: { deepseek: {} } })
    expect(resolveProfiles(raw.providers).get('deepseek')?.bedrock).toBeUndefined()
  })

  it('uses local profile discovery for the built-in Bedrock catalog', () => {
    const profile = resolveProfiles({ 'amazon-bedrock': { bedrock: { profile: 'work', mode: 'failsafe' } } }).get('amazon-bedrock')!
    expect(profile.bedrock).toMatchObject({ profile: 'work', mode: 'failsafe', maxRequestBytes: 80000 })
    expect(profile.apiKeyEnv).toBeUndefined()
    expect(profile.piProvider?.auth.apiKey?.name).toBe('AWS profile')
  })

  it('supports a separately named Bedrock route', () => {
    const profile = resolveProfiles({ 'bedrock-controlled': {
      api: 'bedrock-converse-stream',
      baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      bedrock: { mode: 'failsafe' },
      models: [{ id: 'my-inference-profile' }],
    } }).get('bedrock-controlled')!
    expect(profile.piProvider?.getModels()[0]?.api).toBe('bedrock-converse-stream')
    expect(profile.bedrock?.mode).toBe('failsafe')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte limits: %s', (maxRequestBytes) => {
    expect(() => resolveBedrockConfig({ maxRequestBytes })).toThrow()
  })

  it('refuses Bedrock knobs on a different protocol', () => {
    expect(() => resolveProfiles({ deepseek: { bedrock: { mode: 'failsafe' } } })).toThrow(/without a Bedrock protocol/)
  })
})


it('rejects the removed character setting through the actual profile parser', () => {
  const legacy = { mode: 'failsafe' as const, maxRequestCharacters: 5000 }
  const raw = Config({ providers: { 'amazon-bedrock': { bedrock: legacy } } })
  expect(() => resolveProfiles(raw.providers)).toThrow(/maxRequestCharacters was replaced by maxRequestBytes/)
})

it.each([
  { minOutputTokens: 513 }, { requestDeadlineMs: 0 }, { totalDeadlineMs: 0 },
  { requestDeadlineMs: 2147483648 }, { adaptiveTtlMs: 0 }, { maxTotalAttempts: 0 },
  { outputReductionFactor: 1 }, { proxySizeErrorPattern: '[' }, { proxySizeErrorPattern: ' ' },
])('rejects invalid adaptive limits: %j', (options) => {
  expect(() => resolveBedrockConfig(options)).toThrow()
})
