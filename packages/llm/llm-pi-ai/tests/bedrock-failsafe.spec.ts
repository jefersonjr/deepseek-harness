import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Context, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { bedrockFailsafe, characterCount, fitBedrockRequest } from '../src/bedrock-failsafe.ts'
import type { BedrockExchange, BedrockStream } from '../src/bedrock-failsafe.ts'
import { resolveBedrockConfig } from '../src/bedrock-config.ts'

const context: Context = { systemPrompt: 'Preserve the workspace.', messages: [{ role: 'user', content: 'Answer the question.', timestamp: 0 }] }
const policy = resolveBedrockConfig({ mode: 'failsafe', retryDelayMs: 0 })

function reply(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', api: 'bedrock-converse-stream', provider: 'amazon-bedrock', model: 'test', timestamp: 0,
    content: [{ type: 'text', text }], stopReason,
    usage: {
      input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

function scripted(responses: AssistantMessage[], requests: unknown[], statuses: number[] = []): BedrockStream {
  return async function* (ctx, options) {
    const index = requests.length
    const payload = {
      modelId: 'test', system: [{ text: ctx.systemPrompt }],
      messages: ctx.messages.map(message => ({ role: message.role, content: [{ text: message.content }] })),
      inferenceConfig: { maxTokens: options.maxTokens },
    }
    const transformed = await options.onPayload?.(payload, {} as never)
    requests.push(transformed ?? payload)
    await options.onResponse?.({ status: statuses[index] ?? 200, headers: {} }, {} as never)
    const response = responses[index]!
    yield { type: 'start', partial: response }
    yield { type: 'text_delta', contentIndex: 0, delta: 'unsettled text', partial: response }
    if (response.stopReason === 'error') yield { type: 'error', reason: 'error', error: response }
    else yield { type: 'done', reason: response.stopReason as 'stop', message: response }
  }
}

async function collect(
  stream: BedrockStream, config = policy, options: SimpleStreamOptions = {}, record?: (exchange: BedrockExchange) => void | Promise<void>,
) {
  return Array.fromAsync(bedrockFailsafe(stream, context, options, config, record))
}

describe('Bedrock request character limits', () => {
  it('counts serialized Unicode characters, not bytes or UTF-16 units', () => {
    expect(characterCount('ação😀')).toBe(5)
    const payload = { modelId: 'test', messages: [{ role: 'user', content: [{ text: 'ação😀' }] }] }
    const exact = characterCount(JSON.stringify(payload))
    expect(fitBedrockRequest(payload, exact, policy)).toEqual(payload)
    expect(() => fitBedrockRequest(payload, exact - 1, policy)).toThrowErrorMatchingInlineSnapshot('[LlmError: Bedrock failsafe request needs 76 characters after compaction; maxRequestCharacters is 75. JSON characters: system=0, tools=0, messages=46, other=30. This request was blocked before sending. Check the active agent preset and reduce its instructions/tools or the latest input. Selecting the Bedrock provider alone does not select the compact bedrock agent preset.]')
  })

  it('reports mandatory JSON component sizes without copying their content into the error', () => {
    const payload = {
      modelId: 'test', system: [{ text: 'private-instruction '.repeat(300) }],
      toolConfig: { tools: [{ toolSpec: { name: 'private-tool', inputSchema: { json: { type: 'object' } } } }] },
      messages: [{ role: 'user', content: [{ text: 'private-input😀' }] }],
    }
    expect(() => fitBedrockRequest(payload, 5000, policy)).toThrowErrorMatchingInlineSnapshot('[LlmError: Bedrock failsafe request needs 6211 characters after compaction; maxRequestCharacters is 5000. JSON characters: system=6013, tools=89, messages=55, other=54. This request was blocked before sending. Check the active agent preset and reduce its instructions/tools or the latest input. Selecting the Bedrock provider alone does not select the compact bedrock agent preset.]')
  })

  it('bounds oversized tool output and retains the tool use/result pair and original input', () => {
    const payload = {
      modelId: 'test', system: [{ text: 'Do not delete files.' }], messages: [
        { role: 'user', content: [{ text: 'Inspect this file.' }] },
        { role: 'assistant', content: [{ toolUse: { toolUseId: 'read-1', name: 'read_file', input: { path: 'file' } } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 'read-1', content: [{ text: 'á😀'.repeat(12000) }] } }] },
      ],
    }
    const bounded = fitBedrockRequest(payload, 1500, policy)
    expect(characterCount(JSON.stringify(bounded))).toBeLessThanOrEqual(1500)
    expect(bounded.system).toEqual(payload.system)
    expect(bounded.messages?.slice(0, 2)).toEqual(payload.messages.slice(0, 2))
    expect(bounded.messages?.[2]?.content?.[0]?.toolResult?.toolUseId).toBe('read-1')
    expect(JSON.stringify(bounded)).toContain('[content abbreviated]')
    expect(JSON.stringify(payload)).toContain('á😀'.repeat(12000))
  })

  it('marks abbreviated earlier history without changing the latest user instructions', () => {
    const payload = { modelId: 'test', messages: [
      { role: 'user', content: [{ text: 'old '.repeat(4000) }] },
      { role: 'assistant', content: [{ text: 'previous answer' }] },
      { role: 'user', content: [{ text: 'Do not touch production.' }] },
    ] }
    const bounded = fitBedrockRequest(payload, 1200, policy)
    expect(characterCount(JSON.stringify(bounded))).toBeLessThanOrEqual(1200)
    expect(bounded.messages?.[0]?.content?.at(-1)).toEqual({ text: 'Do not touch production.' })
    expect(JSON.stringify(bounded)).toContain('abbreviated')
  })

  it('refuses irreducible system instructions and tool schemas before sending', async () => {
    const requests: unknown[] = []
    const events = bedrockFailsafe(scripted([reply('must not run')], requests), { ...context, systemPrompt: 'Never remove safeguards. '.repeat(1000) }, {}, policy)
    await expect(Array.fromAsync(events)).rejects.toMatchObject({ code: 'BEDROCK_REQUEST_TOO_LARGE' })
    expect(requests).toEqual([])
  })

  it('preserves binary data and compacts completed operations within one user turn', () => {
    const image = new Uint8Array([1, 2, 3])
    const binary = fitBedrockRequest({ modelId: 'test', messages: [{ role: 'user', content: [{ image: { format: 'png', source: { bytes: image } } }] }] }, 5000, policy)
    expect(binary.messages?.[0]?.content?.[0]?.image?.source?.bytes).toEqual(image)
    const operations = Array.from({ length: 12 }, (_, i) => [
      { role: 'assistant', content: [{ toolUse: { toolUseId: String(i), name: 'cmd', input: { command: 'echo ' + 'x'.repeat(150) } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: String(i), content: [{ text: 'done' }] } }] },
    ]).flat()
    const bounded = fitBedrockRequest({ modelId: 'test', messages: [{ role: 'user', content: [{ text: 'Implement the change.' }] }, ...operations] }, 2000, policy)
    expect(bounded.messages).toHaveLength(3)
    expect(bounded.messages?.[0]?.content?.at(-1)?.text).toBe('Implement the change.')
    expect(bounded.messages?.[1]?.content?.[0]?.toolUse?.toolUseId).toBe('11')
    expect(bounded.messages?.[2]?.content?.[0]?.toolResult?.toolUseId).toBe('11')
  })
})

describe('Bedrock failsafe recovery', () => {
  it('corrects 502 budgets and publishes only the successful reply', async () => {
    const requests: unknown[] = []
    const exchanges: BedrockExchange[] = []
    const failed = { ...reply('partial failure', 'error'), errorMessage: 'Bad Gateway' }
    const events = await collect(scripted([failed, reply('success')], requests, [502, 200]), policy, {}, (exchange) => { exchanges.push(exchange) })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ inferenceConfig: { maxTokens: 1024 } })
    expect(requests[1]).toMatchObject({ inferenceConfig: { maxTokens: 768 } })
    expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe('success')
    expect(exchanges.map(exchange => exchange.phase)).toEqual(['request', 'response', 'request', 'response'])
    expect(exchanges[2]?.limit).toBe(3750)
    expect(exchanges.every(exchange => exchange.characters <= exchange.limit)).toBe(true)
  })

  it('does not retry authentication errors', async () => {
    const requests: unknown[] = []
    await expect(collect(scripted([{ ...reply('', 'error'), errorMessage: '403 Access denied' }], requests, [403]))).rejects.toThrow(/403/)
    expect(requests).toHaveLength(1)
  })

  it('retries a 502 with smaller output when mandatory input exceeds the recovery target', async () => {
    const requests: unknown[] = []
    const failed = { ...reply('', 'error'), errorMessage: '502' }
    const input = { ...context, systemPrompt: 'Keep these instructions. ' + 'x'.repeat(3900) }
    const events = await Array.fromAsync(bedrockFailsafe(scripted([failed, reply('recovered')], requests), input, {}, policy))
    expect(requests).toHaveLength(2)
    expect(characterCount(JSON.stringify(requests[1]))).toBeLessThanOrEqual(5000)
    expect(requests[1]).toMatchObject({ inferenceConfig: { maxTokens: 768 } })
    expect(events.at(-1)?.type).toBe('done')
  })

  it('does not send when the durable request observer fails', async () => {
    const requests: unknown[] = []
    await expect(collect(scripted([reply('must not run')], requests), policy, {}, async () => {
      throw new Error('Persistence unavailable')
    })).rejects.toThrow('Persistence unavailable')
    expect(requests).toEqual([])
  })

  it('stops at the configured gateway retry limit', async () => {
    const requests: unknown[] = []
    const failed = { ...reply('', 'error'), errorMessage: '502' }
    await expect(collect(scripted([failed, failed], requests), resolveBedrockConfig({ mode: 'failsafe', maxRetries: 1, retryDelayMs: 0 }))).rejects.toMatchObject({ code: 'BEDROCK_FAILSAFE_EXHAUSTED' })
    expect(requests).toHaveLength(2)
  })

  it('cancels gateway recovery before another network call', async () => {
    const requests: unknown[] = []
    const abort = new AbortController()
    const failed = { ...reply('', 'error'), errorMessage: '502' }
    await expect(collect(scripted([failed], requests), policy, { signal: abort.signal }, (exchange) => {
      if (exchange.phase === 'response') abort.abort()
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toHaveLength(1)
  })

  it('continues max_tokens using a compact tail and combines usage', async () => {
    const requests: unknown[] = []
    const events = await collect(scripted([reply('First part. ', 'length'), reply('Second part.')], requests))
    const done = events.find(event => event.type === 'done')!
    expect(done.message.content).toEqual([{ type: 'text', text: 'First part. Second part.' }])
    expect(done.message.usage.totalTokens).toBe(60)
    expect(JSON.stringify(requests[1])).toContain('Continue the answer exactly')
    expect(JSON.stringify(requests[1])).toContain('Answer the question.')
  })

  it('never publishes incomplete tool arguments and retries with a smaller-operation instruction', async () => {
    const requests: unknown[] = []
    const incomplete = { ...reply('', 'length'), content: [{ type: 'toolCall' as const, id: 'partial', name: 'cmd', arguments: { command: 'unfinished' } }] }
    const complete = { ...reply('', 'toolUse'), content: [{ type: 'toolCall' as const, id: 'complete', name: 'cmd', arguments: { command: 'echo ready' } }] }
    const events = await collect(scripted([incomplete, complete], requests))
    expect(events.filter(event => event.type === 'toolcall_end').map(event => event.toolCall.id)).toEqual(['complete'])
    expect(JSON.stringify(requests[1])).toContain('were not executed')
  })

  it('does not turn continuation exhaustion into success', async () => {
    const requests: unknown[] = []
    await expect(collect(scripted([reply('unfinished', 'length')], requests), resolveBedrockConfig({ mode: 'failsafe', maxContinuations: 0 }))).rejects.toMatchObject({ code: 'BEDROCK_FAILSAFE_INCOMPLETE' })
    expect(requests).toHaveLength(1)
  })
})
