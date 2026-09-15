/** Real Loader, AWS shared credentials, SigV4, HTTP transport and event-stream decoding. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { BedrockConfig, BedrockExchange } from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'

const disposals: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  vi.unstubAllEnvs()
})

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** AWS event stream frame; the SDK verifies both CRCs while decoding this fixture. */
function frame(event: string, value: unknown): Buffer {
  const headers = Buffer.concat(Object.entries({ ':event-type': event, ':content-type': 'application/json', ':message-type': 'event' }).map(([key, value]) => {
    const name = Buffer.from(key)
    const content = Buffer.from(value)
    const size = Buffer.alloc(2)
    size.writeUInt16BE(content.length)
    return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), size, content])
  }))
  const payload = Buffer.from(JSON.stringify(value))
  const result = Buffer.alloc(16 + headers.length + payload.length)
  result.writeUInt32BE(result.length)
  result.writeUInt32BE(headers.length, 4)
  result.writeUInt32BE(crc32(result.subarray(0, 8)), 8)
  headers.copy(result, 12)
  payload.copy(result, 12 + headers.length)
  result.writeUInt32BE(crc32(result.subarray(0, -4)), result.length - 4)
  return result
}

type Reply = { status: 502 } | { text: string; stop?: 'max_tokens' | 'end_turn' }
async function endpoint(replies: Reply[]) {
  const requests: { body: string; tokens: number; signed: boolean }[] = []
  async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      if (!(chunk instanceof Uint8Array)) throw new Error('Expected HTTP body bytes')
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const parsed = JSON.parse(body) as { inferenceConfig: { maxTokens: number } }
    requests.push({ body, tokens: parsed.inferenceConfig.maxTokens, signed: req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=TESTPROFILE/') ?? false })
    const reply = replies[requests.length - 1]
    if (reply === undefined || 'status' in reply) {
      res.writeHead(reply === undefined ? 400 : reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: reply === undefined ? 'Unexpected extra attempt' : 'Bad Gateway 502' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
    res.end(Buffer.concat([
      frame('messageStart', { role: 'assistant' }),
      frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: reply.text } }),
      frame('contentBlockStop', { contentBlockIndex: 0 }),
      frame('messageStop', { stopReason: reply.stop ?? 'end_turn' }),
      frame('metadata', { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, metrics: { latencyMs: 1 } }),
    ]))
  }
  const server = createServer((req, res) => {
    void respond(req, res).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  disposals.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an ephemeral TCP listener')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

async function composition(url: string, bedrock: BedrockConfig, withTools = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bedrock-sdk-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  if (withTools) {
    const modules = join(root, 'node_modules', '@deepseek-ai')
    await mkdir(modules, { recursive: true })
    for (const [name, path] of [['dsh-persona', '../../../preset/persona/'], ['dsh-tool-bash', '../../../shell/tool-bash/']] as const) {
      await symlink(fileURLToPath(new URL(path, import.meta.url)), join(modules, name), 'junction')
    }
  }
  const credentials = join(root, 'credentials')
  const config = join(root, 'aws-config')
  await writeFile(credentials, '[default]\naws_access_key_id = TESTPROFILE\naws_secret_access_key = test-only-secret\n', { mode: 0o600 })
  await writeFile(config, '[default]\nregion = us-west-2\n')
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentials)
  vi.stubEnv('AWS_CONFIG_FILE', config)
  vi.stubEnv('AWS_PROFILE', undefined)
  vi.stubEnv('AWS_REGION', undefined)
  vi.stubEnv('AWS_DEFAULT_REGION', undefined)
  vi.stubEnv('AWS_ACCESS_KEY_ID', undefined)
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined)
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'must-not-override-the-profile')
  vi.stubEnv('AWS_BEDROCK_FORCE_HTTP1', '1')
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['llm', LlmRuntime], ['sessions', SessionStore], ['pi', LlmPiAi],
    ['prompt', SystemPrompt], ['tools', ToolRuntime], ['agents', AgentRegistry], ['loop', AgentLoop],
    ['projections', SessionProjectionRegistry], ['presets', AgentPresets], ['subprocess', LocalSubprocessRuntime],
    ['shell', LocalBashExecutor], ['shell-env', ShellEnv],
    ['@deepseek-ai/dsh-persona', Persona], ['@deepseek-ai/dsh-tool-bash', ToolBash],
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (!modules.has(name)) throw new Error(`Unexpected import: ${name}`)
    return modules.get(name)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const rows = [
    { id: 'llm', name: 'llm' },
    { id: 'sessions', name: 'sessions' },
    { id: 'pi', name: 'pi', config: { providers: { 'amazon-bedrock': {
      baseURL: url,
      bedrock,
      models: [{ id: 'anthropic.claude-sonnet-4-5-20250929-v1:0' }],
    } } } },
    ...withTools ? [
      { id: 'prompt', name: 'prompt' }, { id: 'tools', name: 'tools' }, { id: 'agents', name: 'agents' },
      { id: 'projections', name: 'projections' }, { id: 'loop', name: 'loop', config: { agents: [] } },
      { id: 'presets', name: 'presets', config: { default: 'bedrock', includeUserRoot: false } },
      { id: 'subprocess', name: 'subprocess' }, { id: 'shell-env', name: 'shell-env' },
      { id: 'shell', name: 'shell', config: { shell: process.platform === 'win32' ? 'cmd' : 'bash', cwd: root } },
    ] : [],
  ]
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const session = ctx.sessions.create()
  const exchanges: BedrockExchange[] = []
  ctx.on('session/event', (_session, event) => { if (event.type === 'llm/bedrock-exchange') exchanges.push(event.data) })
  return { ctx, session, exchanges }
}

describe('Bedrock through the AWS SDK', () => {
  it('reads default shared profile/region and corrects each 502 before one bounded SDK attempt', async () => {
    const server = await endpoint([{ status: 502 }, { text: 'part one', stop: 'max_tokens' }, { text: ' and two' }])
    const { ctx, session, exchanges } = await composition(server.url, { mode: 'failsafe', retryDelayMs: 1 })
    const result = await assemble(ctx, {
      provider: 'amazon-bedrock', model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', sessionId: session.id,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Answer briefly.' }], source: { kind: 'user' } })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'part one and two' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests.map(request => request.tokens)).toEqual([1024, 768, 768])
    expect(server.requests.every(request => request.signed && Array.from(request.body).length <= 5000)).toBe(true)
    expect(exchanges.filter(event => event.phase === 'request').map(event => event.limit)).toEqual([5000, 3750, 3750])
    expect(exchanges.map(event => event.phase)).toEqual(['request', 'response', 'request', 'response', 'request', 'response'])
    expect(exchanges[0]?.request).not.toContain('test-only-secret')
    expect(server.requests[2]?.body).toContain('part one')
    expect(result.usage?.outputTokens).toBe(4)
  })

  it('keeps Normal payloads and max_tokens unchanged even above the failsafe limit', async () => {
    const server = await endpoint([{ text: 'partial', stop: 'max_tokens' }])
    const { ctx, session, exchanges } = await composition(server.url, { mode: 'normal', maxRequestCharacters: 20 })
    const result = await assemble(ctx, {
      provider: 'amazon-bedrock', model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', sessionId: session.id, maxTokens: 1234,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'ação'.repeat(1500) }], source: { kind: 'user' } })],
    })
    expect(result.finish).toEqual({ kind: 'max-tokens' })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.tokens).toBe(1234)
    expect(Array.from(server.requests[0]!.body).length).toBeGreaterThan(5000)
    expect(server.requests[0]?.body).not.toContain('Split large file writes')
    expect(exchanges).toEqual([])
  })

  it('fits the shipped compact preset and its actual tool schema into 5000 characters', async () => {
    const server = await endpoint([{ text: 'compact preset ready' }])
    const { ctx } = await composition(server.url, { mode: 'failsafe' }, true)
    const handle = await ctx.agents.create({
      sessionId: SessionId('bedrock-preset-test'),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'bedrock') },
    })
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    expect(prompt.tools.map(tool => tool.name)).toEqual([process.platform === 'win32' ? 'cmd' : 'bash'])
    const result = await assemble(ctx, {
      provider: 'amazon-bedrock', model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', sessionId: handle.agent.id,
      system: prompt.sections.map(section => section.text).join('\n'), tools: prompt.tools,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Read the workspace instructions.' }], source: { kind: 'user' } })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(Array.from(server.requests[0]!.body).length).toBeLessThanOrEqual(5000)
    expect(server.requests[0]?.body).not.toContain('"name":"pwsh"')
    await handle.dispose()
  })
})
