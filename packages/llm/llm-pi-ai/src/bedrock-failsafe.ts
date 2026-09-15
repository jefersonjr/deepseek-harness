/** Bounded Bedrock payloads, corrective gateway retries, and compact continuations. */
import { setTimeout as delay } from 'node:timers/promises'
import type { ConverseStreamCommandInput, Message as BedrockMessage } from '@aws-sdk/client-bedrock-runtime'
import type { AssistantMessage, AssistantMessageEvent, Context as PiContext, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ResolvedBedrockConfig } from './bedrock-config.ts'

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
  /** Effective request limit after gateway recovery. */
  limit: number
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

/** Character totals only: diagnostics must not expose prompt text, tool definitions or message content. */
function requestTooLarge(payload: ConverseStreamCommandInput, total: number, limit: number): LlmError {
  const countField = (key: 'system' | 'toolConfig' | 'messages'): number =>
    payload[key] === undefined ? 0 : characterCount(serialize(payload[key]))
  const system = countField('system')
  const tools = countField('toolConfig')
  const messages = countField('messages')
  const other = total - system - tools - messages
  return new LlmError(
    `Bedrock failsafe request needs ${total} characters after compaction; maxRequestCharacters is ${limit}.`
    + ` JSON characters: system=${system}, tools=${tools}, messages=${messages}, other=${other}.`
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
 * with character totals for system, tools, messages and the remaining JSON, without exposing their content.
 * @param value - SDK command input, before serialization.
 * @param limit - character budget for the whole serialized request.
 * @param policy - limits for retained observations and continuation context.
 * @param retainedUserMessages - latest original input plus any synthetic continuation to preserve.
 * @returns an independently owned request within the budget.
 */
export function fitBedrockRequest(
  value: unknown, limit: number, policy: ResolvedBedrockConfig, retainedUserMessages = 1,
): ConverseStreamCommandInput {
  const payload = clonePayload(value)
  const size = (): number => characterCount(serialize(payload))
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

/**
 * Run failsafe requests with bounded retries and continuations; Normal never enters this function.
 * @param stream - ordinary authenticated Bedrock transport.
 * @param original - original request history and tools.
 * @param options - prepared stream options, including the caller's cancellation signal.
 * @param policy - validated failsafe limits.
 * @param record - durable observer for exact transformed requests and settled results.
 * @param progress - resets the caller's idle timer while partial output stays buffered.
 * @returns successful message events after recovery; failure publishes no tool calls or duplicate partial text.
 */
export async function* bedrockFailsafe(
  stream: BedrockStream,
  original: PiContext,
  options: SimpleStreamOptions,
  policy: ResolvedBedrockConfig,
  record: (exchange: BedrockExchange) => void | Promise<void> = () => {},
  progress: () => void = () => {},
): AsyncIterable<AssistantMessageEvent> {
  const systemPrompt = [original.systemPrompt, COMPACT_INSTRUCTION].filter(Boolean).join('\n')
  const { reasoning: _reasoning, thinkingBudgets: _thinkingBudgets, ...boundedOptions } = options
  let context: PiContext = { ...original, systemPrompt }
  let limit = policy.maxRequestCharacters
  let maxTokens = Math.min(options.maxTokens ?? policy.maxOutputTokens, policy.maxOutputTokens)
  let text = ''
  let usage: Usage | undefined
  let attempt = 0
  for (let continuation = 0; continuation <= policy.maxContinuations; continuation++) {
    let reply: AssistantMessage | undefined
    for (let retry = 0; retry <= policy.maxRetries; retry++) {
      options.signal?.throwIfAborted()
      let request = ''
      let status: number | undefined
      let localFailure: Error | undefined
      attempt++
      const events = stream(context, {
        ...boundedOptions,
        cacheRetention: 'none',
        env: { ...options.env, AWS_MAX_ATTEMPTS: '1' },
        maxTokens,
        maxRetries: 0,
        async onPayload(value) {
          try {
            let bounded: ConverseStreamCommandInput
            const retainedInputs = continuation > 0 ? 2 : 1
            try {
              bounded = fitBedrockRequest(value, limit, policy, retainedInputs)
            } catch (error) {
              if (!(error instanceof LlmError) || error.code !== 'BEDROCK_REQUEST_TOO_LARGE' || limit >= policy.maxRequestCharacters) throw error
              // The recovery target cannot erase mandatory input. Keep the hard
              // configured bound and still retry with a smaller output budget.
              bounded = fitBedrockRequest(value, policy.maxRequestCharacters, policy, retainedInputs)
              limit = characterCount(serialize(bounded))
            }
            request = serialize(bounded)
            await record({ phase: 'request', attempt, continuation, request, characters: characterCount(request), limit })
            progress()
            return bounded
          } catch (error) {
            localFailure = error instanceof Error
              ? error
              : new Error(typeof error === 'string' ? error : 'Bedrock request preparation failed', { cause: error })
            throw localFailure
          }
        },
        async onResponse(response, model) {
          status = response.status
          await options.onResponse?.(response, model)
        },
      })
      reply = undefined
      for await (const event of events) {
        progress()
        if (event.type === 'done') reply = event.message
        if (event.type === 'error') reply = event.error
      }
      options.signal?.throwIfAborted()
      if (localFailure !== undefined) throw localFailure
      if (reply === undefined) throw new LlmError('Bedrock stream ended without a terminal response', 'BEDROCK_FAILSAFE_INCOMPLETE')
      usage = addUsage(usage, reply.usage)
      await record({ phase: 'response', attempt, continuation, request, characters: characterCount(request), limit, ...status === undefined ? {} : { status }, response: reply })
      if (reply.stopReason !== 'error' && reply.stopReason !== 'aborted') break
      const gatewayFailure = status === 502 || /\b502\b|\bbad gateway\b/i.test(reply.errorMessage ?? '')
      if (!gatewayFailure || retry === policy.maxRetries) {
        throw new LlmError(reply.errorMessage ?? 'Bedrock request failed', 'BEDROCK_FAILSAFE_EXHAUSTED')
      }
      limit = Math.max(1, Math.floor(limit * policy.recoveryFactor))
      maxTokens = Math.max(1, Math.floor(maxTokens * policy.recoveryFactor))
      await delay(policy.retryDelayMs * 2 ** retry, undefined, { signal: options.signal })
    }
    if (reply === undefined) throw new LlmError('Bedrock returned no reply', 'BEDROCK_FAILSAFE_INCOMPLETE')
    const incompleteTool = reply.stopReason === 'length' && reply.content.some(block => block.type === 'toolCall')
    if (!incompleteTool) {
      text += reply.content.filter(block => block.type === 'text').map(block => block.text).join('')
    }
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
      ...original,
      systemPrompt,
      messages: [...original.messages, { role: 'user', content: instruction, timestamp: Date.now() }],
    }
  }
}
