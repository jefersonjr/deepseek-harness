import { afterEach, expect, it, vi } from 'vitest'
import { BedrockAdaptiveBudgets } from '../src/bedrock-adaptive.ts'
import { resolveBedrockConfig } from '../src/bedrock-config.ts'

afterEach(() => { vi.useRealTimers() })

it('isolates learned budgets by adapter, configured route and model', () => {
  const cache = new BedrockAdaptiveBudgets()
  const route = resolveBedrockConfig()
  cache.remember(route, 'model-a', { requestBytes: 60000, outputTokens: 256 })
  expect(cache.read(route, 'model-a')).toEqual({ requestBytes: 60000, outputTokens: 256 })
  expect(cache.read(route, 'model-b')).toEqual({ requestBytes: 80000, outputTokens: 512 })
  expect(cache.read(resolveBedrockConfig(), 'model-a')).toEqual({ requestBytes: 80000, outputTokens: 512 })
  expect(new BedrockAdaptiveBudgets().read(route, 'model-a')).toEqual({ requestBytes: 80000, outputTokens: 512 })
})

it('expires recovery without extending its lifetime on reads', () => {
  vi.useFakeTimers()
  const cache = new BedrockAdaptiveBudgets()
  const route = resolveBedrockConfig({ adaptiveTtlMs: 100 })
  cache.remember(route, 'model', { requestBytes: 60000, outputTokens: 256 })
  vi.advanceTimersByTime(99)
  expect(cache.read(route, 'model').outputTokens).toBe(256)
  vi.advanceTimersByTime(1)
  expect(cache.read(route, 'model')).toEqual({ requestBytes: 80000, outputTokens: 512 })
})

it('retains the smaller ceilings when concurrent requests finish out of order', () => {
  const cache = new BedrockAdaptiveBudgets()
  const route = resolveBedrockConfig()
  cache.remember(route, 'model', { requestBytes: 40000, outputTokens: 128 })
  cache.remember(route, 'model', { requestBytes: 60000, outputTokens: 256 })
  expect(cache.read(route, 'model')).toEqual({ requestBytes: 40000, outputTokens: 128 })
})
