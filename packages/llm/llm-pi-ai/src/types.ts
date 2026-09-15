/** Durable Bedrock request records; authentication material is never included. */
import type { BedrockExchange } from './bedrock-failsafe.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact bounded request and response records for Bedrock recovery and continuation. */
    'llm/bedrock-exchange': BedrockExchange
  }
}
