/** Bounded Bedrock payloads, corrective gateway retries, and compact continuations. */
import { setTimeout as delay } from 'node:timers/promises'
import type { ConverseStreamCommandInput, Message as BedrockMessage } from '@aws-sdk/client-bedrock-runtime'
import type { AssistantMessage, AssistantMessageEvent, Context as PiContext, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedBedrockConfig } from './bedrock-config.ts'
import type { BedrockBudget } from './bedrock-adaptive.ts'

/** A credential-free record of the exact request and its settled result. */
export interface BedrockExchange {
  /** Requests are recorded before network I/O; responses settle the same attempt. */
  phase: 'request' | 'response'
  /** One-based attempt number within this generation. */
  attempt: number
  /** Additional reply number; zero is the initial reply. */
  continuation: number
  /** Compacted SDK input as JSON; binary fields use wire base64, modelId is included, authentication headers are absent. */
  request: string
  /** Unicode character count of the complete request. */
  characters: number
  /** Legacy character budget, present only in records produced before byte budgeting. */
  limit?: number
  /** UTF-8 bytes of the serialized SDK input; includes URL-bound modelId. */
  bytes?: number
  /** Effective byte ceiling for this attempt; the SDK also checks the final HTTP body. */
  limitBytes?: number
  /** Output token ceiling for this attempt. */
  maxTokens?: number
  /** Elapsed milliseconds through transport settlement, including streaming. */
  durationMs?: number
  /** Milliseconds until the first content delta, when any arrived. */
  firstTokenMs?: number
  /** Reason this attempt failed; absent on a successful response. */
  failure?: 'gateway' | 'deadline' | 'proxy-size' | 'provider' | 'incomplete'
  /** Transport error text when no terminal provider message was available. */
  error?: string
  /** Observed HTTP response status, when the SDK supplies one. */
  status?: number
  /** Provider response, including partial output from a failed attempt. */
  response?: AssistantMessage
}

/** One ordinary pi-ai Bedrock call, with AWS authentication resolved by its provider. */
export type BedrockStream = (context: PiContext, options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>

const COMPACT_INSTRUCTION = 'Keep replies concise. Split large file writes and tool arguments into small complete operations. Never emit a partial tool call.'
const OMITTED = '\n[content abbreviated]\n'

/**
 * Count Unicode characters, including JSON syntax and escapes when passed serialized JSON.
 * @param value - serialized request or text.
 * @returns the number of Unicode code points.
 */
export function characterCount(value: string): number {
  return Array.from(value).length
}

/** Keep both ends of an observation and explicitly mark omitted content. */
function abbreviated(value: string, limit: number): string {
  const chars = Array.from(value)
  if (chars.length <= limit) return value
  const marker = Array.from(OMITTED)
  if (limit <= marker.length) return marker.slice(0, limit).join('')
  const head = Math.ceil((limit - marker.length) / 2)
  const tail = limit - marker.length - head
  return chars.slice(0, head).join('') + OMITTED + (tail > 0 ? chars.slice(-tail).join('') : '')
}

/** Preserve binary content while detaching the request from pi-ai and the session history. */
function clonePayload(value: unknown): ConverseStreamCommandInput {
  if (value === null || typeof value !== 'object' || !('modelId' in value) || !('messages' in value)) {
    throw new LlmError('Bedrock returned an unsupported request representation', 'BEDROCK_PAYLOAD_INVALID')
  }
  return structuredClone(value) as ConverseStreamCommandInput
}

/** Wire JSON for payloads and diagnostic counts; the full SDK input also includes the URL-bound modelId. */
function serialize(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) => value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value)
}

/** Byte totals only: diagnostics must not expose prompt text, tool definitions or message content. */
function requestTooLarge(payload: ConverseStreamCommandInput, total: number, limit: number): LlmError {
  const countField = (key: 'system' | 'toolConfig' | 'messages'): number =>
    payload[key] === undefined ? 0 : Buffer.byteLength(serialize(payload[key]), 'utf8')
  const system = countField('system')
  const tools = countField('toolConfig')
  const messages = countField('messages')
  const other = total - system - tools - messages
  return new LlmError(
    `Bedrock failsafe request needs ${total} UTF-8 bytes after compaction; effective maxRequestBytes is ${limit}.`
    + ` JSON bytes: system=${system}, tools=${tools}, messages=${messages}, other=${other}.`
    + ' This request was blocked before sending. Check the active agent preset and reduce its instructions/tools or the latest input.'
    + ' Selecting the Bedrock provider alone does not select the compact bedrock agent preset.',
    'BEDROCK_REQUEST_TOO_LARGE',
  )
}

function isUserInput(message: BedrockMessage): boolean {
  return message.role === 'user' && (message.content ?? []).some(block => block.toolResult === undefined)
}

/**
 * Bound an SDK request while preserving system instructions, tool schemas and the latest user input.
 * Older history and tool observations may be explicitly abbreviated. An irreducible request fails before network I/O
 * with byte totals for system, tools, messages and the remaining JSON, without exposing their content.
 * @param value - SDK command input, before serialization.
 * @param limit - UTF-8 byte budget for the whole serialized request.
 * @param policy - limits for retained observations and continuation context.
 * @param retainedUserMessages - latest original input plus any synthetic continuation to preserve.
 * @returns an independently owned request within the budget.
 */
export function fitBedrockRequest(
  value: unknown, limit: number, policy: ResolvedBedrockConfig, retainedUserMessages = 1,
): ConverseStreamCommandInput {
  const payload = clonePayload(value)
  const size = (): number => Buffer.byteLength(serialize(payload), 'utf8')
  if (size() <= limit) return payload
  const messages = payload.messages ?? []
  const userIndices = messages.flatMap((message, index) => isUserInput(message) ? [index] : [])
  const latestUser = userIndices.at(-retainedUserMessages) ?? 0
  const lastToolUse = messages.findLastIndex(message => (message.content ?? []).some(block => block.toolUse !== undefined))
  // Completed tool exchanges between the original input and latest operation
  // otherwise grow without bound during one user turn. Retain its newest pair.
  const older = [...messages.slice(0, latestUser), ...lastToolUse > latestUser + 1 ? messages.slice(latestUser + 1, lastToolUse) : []]
  const current = messages[latestUser]
  if (older.length > 0 && current !== undefined) {
    const history = serialize({ modelId: payload.modelId, messages: older })
    payload.messages = lastToolUse > latestUser + 1
      ? [current, ...messages.slice(lastToolUse)]
      : messages.slice(latestUser)
    current.content = [
      { text: `Earlier conversation data (abbreviated; verify details before acting):\n${abbreviated(history, policy.continuationCharacters)}` },
      ...current.content ?? [],
    ]
  }
  let observationLimit = Math.min(policy.toolResultCharacters, Math.floor(limit / 4))
  while (size() > limit && observationLimit > 0) {
    let changed = false
    for (const message of payload.messages ?? []) {
      for (const block of message.content ?? []) {
        for (const observation of block.toolResult?.content ?? []) {
          if (observation.text !== undefined && characterCount(observation.text) > observationLimit) {
            observation.text = abbreviated(observation.text, observationLimit)
            changed = true
          }
        }
      }
    }
    if (!changed) break
    observationLimit = Math.floor(observationLimit / 2)
  }
  const total = size()
  if (total > limit) throw requestTooLarge(payload, total, limit)
  return payload
}

/** Usage for all paid attempts, including replies whose tool arguments were incomplete. */
function addUsage(total: Usage | undefined, next: Usage): Usage {
  if (total === undefined) return structuredClone(next)
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: total.cost.input + next.cost.input,
      output: total.cost.output + next.cost.output,
      cacheRead: total.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
      total: total.cost.total + next.cost.total,
    },
  }
}

/** Materialize only a settled, successful reply; partial tool arguments never reach the executor. */
function* settledEvents(message: AssistantMessage): Iterable<AssistantMessageEvent> {
  yield { type: 'start', partial: message }
  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === 'text') {
      yield { type: 'text_start', contentIndex, partial: message }
      yield { type: 'text_delta', contentIndex, delta: block.text, partial: message }
      yield { type: 'text_end', contentIndex, content: block.text, partial: message }
    } else if (block.type === 'toolCall') {
      yield { type: 'toolcall_start', contentIndex, partial: message }
      yield { type: 'toolcall_delta', contentIndex, delta: JSON.stringify(block.arguments), partial: message }
      yield { type: 'toolcall_end', contentIndex, toolCall: block, partial: message }
    }
  }
  if (message.stopReason !== 'stop' && message.stopReason !== 'toolUse') {
    throw new LlmError('Bedrock failsafe cannot publish an unfinished reply', 'BEDROCK_FAILSAFE_INCOMPLETE')
  }
  yield { type: 'done', reason: message.stopReason, message }
}

/** Optional per-route/model learning owned by the adapter, not by a global cache. */
export interface BedrockRecovery {
  /** Previously recovered ceilings for this generation. */
  initial: BedrockBudget
  /**
   * Save ceilings only after a corrective reduction succeeds.
   * @param budget - recovered input and output ceilings, excluding an unchanged caller token cap.
   */
  remember(budget: BedrockBudget): void
}

type Failure = NonNullable<BedrockExchange['failure']>
interface AttemptResult {
  reply: AssistantMessage | undefined
  failure: Failure | undefined
  error: string | undefined
  bytes: number
}

/** A generic 403 does not identify a proxy size limit; AWS authorization must be fixed by the operator. */
function classifyFailure(status: number | undefined, message: string, policy: ResolvedBedrockConfig): Failure {
  if (status === 403) {
    const authorization =
      /access[ _-]?denied|unauthorized|not authorized|invalid.?signature|expired.?token|unrecognized.?client/i.test(message)
    return !authorization && new RegExp(policy.proxySizeErrorPattern, 'i').test(message) ? 'proxy-size' : 'provider'
  }
  const gateway = status === 502 || ((status === undefined || status === 200) && /\b502\b|\bbad gateway\b/i.test(message))
  return gateway ? 'gateway' : 'provider'
}

/** Own one absolute deadline and drain the transport before reporting a retryable outcome. */
async function runAttempt(
  stream: BedrockStream, context: PiContext, options: SimpleStreamOptions, policy: ResolvedBedrockConfig,
  limitBytes: number, maxTokens: number, attempt: number, continuation: number,
  record: (exchange: BedrockExchange) => void | Promise<void>, progress: () => void,
): Promise<AttemptResult> {
  using clock = deadline(options.signal, policy.requestDeadlineMs, 'BEDROCK_ATTEMPT_DEADLINE')
  const started = performance.now()
  let request = ''
  let status: number | undefined
  let firstTokenMs: number | undefined
  let localFailure: Error | undefined
  let reply: AssistantMessage | undefined
  let error: string | undefined
  try {
    const events = stream(context, {
      ...options,
      signal: clock.signal,
      cacheRetention: 'none',
      env: { ...options.env, AWS_MAX_ATTEMPTS: '1', DSH_BEDROCK_MAX_REQUEST_BYTES: String(limitBytes) },
      maxTokens,
      maxRetries: 0,
      async onPayload(value) {
        try {
          clock.signal.throwIfAborted()
          const bounded = fitBedrockRequest(value, limitBytes, policy, continuation > 0 ? 2 : 1)
          request = serialize(bounded)
          await record({ phase: 'request', attempt, continuation, request, characters: characterCount(request), bytes: Buffer.byteLength(request, 'utf8'), limitBytes, maxTokens })
          clock.signal.throwIfAborted()
          progress()
          return bounded
        } catch (cause) {
          if (!clock.signal.aborted) localFailure = cause instanceof Error ? cause : new Error('Bedrock request preparation failed', { cause })
          throw cause
        }
      },
      async onResponse(response, model) {
        status = response.status
        await options.onResponse?.(response, model)
      },
    })
    for await (const event of events) {
      progress()
      if (firstTokenMs === undefined && (event.type === 'text_delta' || event.type === 'toolcall_delta' || event.type === 'thinking_delta')) {
        firstTokenMs = Math.round(performance.now() - started)
      }
      if (event.type === 'done') reply = event.message
      if (event.type === 'error') reply = event.error
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  // Cancellation has already stopped and drained the owned SDK stream. Never
  // turn a caller abort or the total deadline into a fresh network attempt.
  options.signal?.throwIfAborted()
  if (localFailure !== undefined) throw localFailure
  const expired = timeoutOf(clock.signal, 'BEDROCK_ATTEMPT_DEADLINE') !== undefined
  error ??= reply?.errorMessage
  if (expired) error = `Bedrock attempt exceeded requestDeadlineMs (${policy.requestDeadlineMs}ms)`
  const failure = expired ? 'deadline'
    : error !== undefined || reply?.stopReason === 'error' || reply?.stopReason === 'aborted' ? classifyFailure(status, error ?? '', policy)
      : reply === undefined || !['stop', 'toolUse', 'length'].includes(reply.stopReason) ? 'incomplete' : undefined
  const bytes = Buffer.byteLength(request, 'utf8')
  await record({
    phase: 'response', attempt, continuation, request, characters: characterCount(request), bytes, limitBytes, maxTokens,
    durationMs: Math.round(performance.now() - started),
    ...firstTokenMs === undefined ? {} : { firstTokenMs },
    ...status === undefined ? {} : { status },
    ...reply === undefined ? {} : { response: reply },
    ...failure === undefined ? {} : { failure },
    ...error === undefined ? {} : { error },
  })
  return { reply, failure, error, bytes }
}

/**
 * Run bounded Bedrock retries and compact continuations; Normal never enters this function.
 * @param stream - ordinary authenticated Bedrock transport; must settle after its signal aborts.
 * @param original - original request history and tools.
 * @param options - prepared stream options, including the caller's cancellation signal.
 * @param policy - validated failsafe limits.
 * @param record - durable observer for exact transformed requests and settled results.
 * @param progress - resets the caller's idle timer while partial output stays buffered.
 * @param recovery - optional route/model budgets and successful-recovery observer.
 * @returns successful message events after recovery; failure publishes no tool calls or duplicate partial text.
 */
export async function* bedrockFailsafe(
  stream: BedrockStream,
  original: PiContext,
  options: SimpleStreamOptions,
  policy: ResolvedBedrockConfig,
  record: (exchange: BedrockExchange) => void | Promise<void> = () => {},
  progress: () => void = () => {},
  recovery?: BedrockRecovery,
): AsyncIterable<AssistantMessageEvent> {
  using total = deadline(options.signal, policy.totalDeadlineMs, 'BEDROCK_TOTAL_DEADLINE')
  const systemPrompt = [original.systemPrompt, COMPACT_INSTRUCTION].filter(Boolean).join('\n')
  const { reasoning: _reasoning, thinkingBudgets: _thinkingBudgets, ...boundedOptions } = options
  let context: PiContext = { ...original, systemPrompt }
  const budget = { ...recovery?.initial ?? { requestBytes: policy.maxRequestBytes, outputTokens: policy.maxOutputTokens } }
  const floor = Math.min(options.maxTokens ?? policy.minOutputTokens, policy.minOutputTokens)
  let text = ''
  let usage: Usage | undefined
  let attempt = 0
  try {
    for (let continuation = 0; continuation <= policy.maxContinuations; continuation++) {
      let reply: AssistantMessage | undefined
      let reduced = false
      for (let retry = 0; retry <= policy.maxRetries; retry++) {
        total.signal.throwIfAborted()
        if (attempt >= policy.maxTotalAttempts) throw new LlmError('Bedrock failsafe reached maxTotalAttempts across retries and continuations', 'BEDROCK_ATTEMPTS_EXHAUSTED')
        const maxTokens = Math.min(options.maxTokens ?? budget.outputTokens, budget.outputTokens)
        const outcome = await runAttempt(
          stream, context, { ...boundedOptions, signal: total.signal }, policy,
          budget.requestBytes, maxTokens, ++attempt, continuation, record, progress,
        )
        total.signal.throwIfAborted()
        reply = outcome.reply
        if (reply !== undefined) usage = addUsage(usage, reply.usage)
        if (outcome.failure === undefined) {
          if (reduced) recovery?.remember({ ...budget })
          break
        }
        const recoverable = outcome.failure === 'gateway' || outcome.failure === 'deadline' || outcome.failure === 'proxy-size'
        if (!recoverable || retry === policy.maxRetries) {
          throw new LlmError(outcome.error ?? `Bedrock failsafe attempt failed: ${outcome.failure}`, 'BEDROCK_FAILSAFE_EXHAUSTED')
        }
        if (outcome.failure !== 'proxy-size' && maxTokens > floor) {
          budget.outputTokens = Math.max(floor, Math.floor(maxTokens * policy.outputReductionFactor))
        } else {
          // Size rejection targets the actual failed body, not a possibly much
          // larger configured ceiling. Mandatory input never falls back above it.
          budget.requestBytes = Math.max(1, Math.min(budget.requestBytes - 1, Math.floor(outcome.bytes * policy.recoveryFactor)))
        }
        reduced = true
        await delay(policy.retryDelayMs * 2 ** retry, undefined, { signal: total.signal })
      }
      if (reply === undefined) throw new LlmError('Bedrock returned no reply', 'BEDROCK_FAILSAFE_INCOMPLETE')
      const incompleteTool = reply.stopReason === 'length' && reply.content.some(block => block.type === 'toolCall')
      if (!incompleteTool) text += reply.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (reply.stopReason === 'stop' || reply.stopReason === 'toolUse') {
        const completed: AssistantMessage = {
          ...reply,
          content: [...text.length > 0 ? [{ type: 'text' as const, text }] : [], ...reply.content.filter(block => block.type === 'toolCall')],
          usage: usage ?? reply.usage,
        }
        yield* settledEvents(completed)
        return
      }
      if (reply.stopReason !== 'length' || continuation === policy.maxContinuations) {
        throw new LlmError('Bedrock response exceeded the failsafe continuation limit; split the task into smaller operations', 'BEDROCK_FAILSAFE_INCOMPLETE')
      }
      const instruction = incompleteTool
        ? 'The previous tool arguments exceeded the output limit and were not executed. Return a complete smaller tool call; split large writes into separate operations.'
        : `Continue the answer exactly after the trailing text below, without repeating it. Keep this part concise.\n${Array.from(text).slice(-policy.continuationCharacters).join('')}`
      context = {
        ...original, systemPrompt,
        messages: [...original.messages, { role: 'user', content: instruction, timestamp: Date.now() }],
      }
    }
  } catch (cause) {
    if (timeoutOf(total.signal, 'BEDROCK_TOTAL_DEADLINE') !== undefined) {
      throw new LlmError(`Bedrock failsafe exceeded totalDeadlineMs (${policy.totalDeadlineMs}ms)`, 'BEDROCK_TOTAL_DEADLINE', { cause })
    }
    throw cause
  }
}
